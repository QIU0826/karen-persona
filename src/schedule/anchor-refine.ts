/**
 * 锚点二次筛选（v0.8.4）。
 *
 * 现状：锚点只靠关键词 + 情绪强度打分（阈值 0.75）自动入库——
 * 这会两头都错：**该记的漏**（重要的生活事件不带关键词，比如"我妈住院了"），
 * **不该记的进**（一句情绪化的"烦死了"分数也不低）。
 *
 * 这里补一层 LLM 复筛：每天挑出「边界候选」（显著度 0.45–0.75 且当天还没进锚点），
 * 让模型判断哪些真的值得长期记住，并给出更准确的类型与一句话摘要。
 *
 * 成本控制：
 * - 每天最多一次（`job_runs` 记账，幂等）；
 * - 候选 <2 条直接跳过（不值得花一次调用）；
 * - 候选最多 12 条，内容截断到 120 字。
 */
import type { Database } from "better-sqlite3";
import { addAnchor, findAnchorBySummary, type AnchorKind } from "../data/memory-v2.js";

/** 候选门槛：低于这个显著度的日常闲聊不值得复筛 */
/**
 * 已判定「不值得记」的 episode 用这个值标记 anchor_id（v0.8.17）。
 * 目的：被否掉的候选不再反复进候选池——否则 job_runs 守卫一旦丢失，同一批边界记忆会被再问一遍。
 * 只影响复筛的候选筛选（只认 anchor_id 为 NULL 的行）。
 */
export const REFINE_REJECTED_SENTINEL = -1;

export const REFINE_MIN_SALIENCE = 0.45;
/** 已经超过自动入库阈值的不用复筛 */
export const REFINE_MAX_SALIENCE = 0.75;
/** 单次最多送多少条候选给模型 */
export const REFINE_MAX_CANDIDATES = 12;
/** 候选正文截断长度 */
const SNIPPET_CHARS = 120;

export interface RefineCandidate {
  id: number;
  content: string;
  salience: number;
  createdAt: number;
}

export interface AnchorVerdict {
  index: number;
  anchor: boolean;
  kind: AnchorKind;
  summary: string;
}

export const VALID_ANCHOR_KINDS: AnchorKind[] = [
  "first_meet",
  "confession",
  "conflict",
  "makeup",
  "promise",
  "secret",
  "shared_experience",
  "loss",
];

/** 构造复筛 prompt（纯函数）。 */
export function buildAnchorRefinePrompt(input: {
  day: string;
  herName: string;
  userName: string;
  candidates: RefineCandidate[];
}): { system: string; user: string } {
  const system = [
    "你在帮一个角色判断：昨天聊到的事里，哪些值得长期记住（写进「锚点记忆」，永不忘记）。",
    "只输出 JSON，不要解释。",
    '格式：{"items":[{"index":0,"anchor":true,"kind":"promise","summary":"约好周末一起去看电影"}]}',
    "规则：",
    "- 值得记：承诺/约定、关系变化(表白/和好/吵架)、重大生活事件(生病/搬家/换工作/失去)、说过的秘密、第一次做的事；",
    "- 不值得记：日常闲聊、天气、心情抱怨、一次性玩笑、重复的日常；",
    "- summary 用第三人称一句话，≤24 字，必须能在原文里找到依据，不要脑补；",
    "- kind 只能取：first_meet/confession/conflict/makeup/promise/secret/shared_experience/loss；",
    "- 每条候选都必须给一个判断（anchor true 或 false）。",
  ].join("\n");

  const user = [
    `时间：${input.day}；她的名字：${input.herName}；对方：${input.userName}`,
    "候选（编号从 0 开始）：",
    ...input.candidates.map((c, i) => `${i}. [显著度${c.salience.toFixed(2)}] ${c.content}`),
  ].join("\n");
  return { system, user };
}

/** 解析复筛结果（容错：代码块、多余字段、非法 kind、越界 index）。 */
export function parseAnchorVerdicts(
  content: string,
  candidateCount: number,
): AnchorVerdict[] {
  if (!content) return [];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  const rawItems = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) return [];

  const verdicts: AnchorVerdict[] = [];
  for (const raw of rawItems) {
    const obj = raw as Record<string, unknown>;
    const index = Number(obj.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue;
    const anchor = obj.anchor === true;
    const kind = VALID_ANCHOR_KINDS.includes(obj.kind as AnchorKind)
      ? (obj.kind as AnchorKind)
      : "shared_experience";
    const summary = typeof obj.summary === "string" ? obj.summary.replace(/\s+/g, " ").trim() : "";
    // 没有摘要的条目一律丢掉（收或不收都无法使用）
    if (!summary) continue;
    verdicts.push({ index, anchor, kind, summary: summary.slice(0, 40) });
  }
  return verdicts;
}

/** 选出当天值得复筛的候选（边界显著度、还没进锚点）。 */
export function selectRefineCandidates(
  rows: Array<{ id: number; content: string; salience: number | null; anchor_id: number | null; created_at: number }>,
): RefineCandidate[] {
  return rows
    .filter((r) => r.anchor_id === null || r.anchor_id === undefined)
    .map((r) => ({
      id: r.id,
      content: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
      salience: Number(r.salience ?? 0),
      createdAt: r.created_at,
    }))
    .filter((c) => c.content.length > 0 && c.salience >= REFINE_MIN_SALIENCE && c.salience < REFINE_MAX_SALIENCE)
    .slice(0, REFINE_MAX_CANDIDATES);
}

export interface AnchorRefineResult {
  ok: boolean;
  reason: "done" | "no_candidates" | "llm_failed" | "parse_failed" | "db_failed";
  candidates: number;
  created: number;
}

/**
 * 跑一次复筛：查候选 → LLM 判断 → 写锚点。
 * 幂等由调用方（job_runs）保证；这里只做一次完整动作。
 */
export async function runAnchorRefine(input: {
  db: Database;
  personaId: string;
  ownerId: string;
  day: string;
  chatFn: (prompt: { system: string; user: string }) => Promise<string | null>;
  herName?: string;
  userName?: string;
  now?: number;
}): Promise<AnchorRefineResult> {
  const now = input.now ?? Date.now();
  const bounds = dayBounds(input.day);
  let rows: Array<{ id: number; content: string; salience: number | null; anchor_id: number | null; created_at: number }>;
  try {
    rows = input.db
      .prepare(
        `SELECT id, content, salience, anchor_id, created_at FROM t2_episodes
         WHERE persona_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY salience DESC LIMIT 60`,
      )
      .all(input.personaId, bounds.start, bounds.end) as typeof rows;
  } catch {
    return { ok: false, reason: "db_failed", candidates: 0, created: 0 };
  }

  const candidates = selectRefineCandidates(rows);
  // 候选太少不值得花一次调用
  if (candidates.length < 2) {
    return { ok: true, reason: "no_candidates", candidates: candidates.length, created: 0 };
  }

  const raw = await input.chatFn(
    buildAnchorRefinePrompt({
      day: input.day,
      herName: input.herName ?? "她",
      userName: input.userName ?? "你",
      candidates,
    }),
  );
  if (!raw) return { ok: false, reason: "llm_failed", candidates: candidates.length, created: 0 };

  const verdicts = parseAnchorVerdicts(raw, candidates.length);
  if (verdicts.length === 0) {
    return { ok: true, reason: "parse_failed", candidates: candidates.length, created: 0 };
  }

  let created = 0;
  for (const verdict of verdicts) {
    const candidate = candidates[verdict.index];
    if (!candidate) continue;
    if (!verdict.anchor) {
      // 判定"不值得记"：打哨兵，避免下次再拿同一条去问模型（省一次调用、也避免判断摇摆）
      try {
        input.db
          .prepare("UPDATE t2_episodes SET anchor_id = ? WHERE id = ? AND persona_id = ?")
          .run(REFINE_REJECTED_SENTINEL, candidate.id, input.personaId);
      } catch {
        // 标记失败不影响其它条目
      }
      continue;
    }
    // v0.8.17：先看是否已存在同 summary 的锚点——已存在只是"复述强化"，不算新建
    // （否则日志会写"新增 N 条"，实际一条没建，误导排查）。
    const before = findAnchorBySummary(input.db, input.personaId, input.ownerId, verdict.summary);
    const id = addAnchor(input.db, {
      personaId: input.personaId,
      ownerId: input.ownerId,
      kind: verdict.kind,
      summary: verdict.summary,
      quote: candidate.content.slice(0, 200),
      strength: Math.max(0.5, candidate.salience),
      now,
    });
    if (id !== null && before === null) created += 1;
    // 回写 episode.anchor_id：即使 job_runs 守卫丢失，第二天也不会再为同一件事花一次 LLM 调用
    if (id !== null) {
      try {
        input.db
          .prepare("UPDATE t2_episodes SET anchor_id = ? WHERE id = ? AND persona_id = ?")
          .run(id, candidate.id, input.personaId);
      } catch {
        // 回写失败不影响已建的锚点
      }
    }
  }
  return { ok: true, reason: "done", candidates: candidates.length, created };
}

/**
 * 把 YYYY-MM-DD 转成 t2_episodes 用的文本时间边界。
 * 注意：真实库 t2_episodes.created_at 是 TEXT（`YYYY-MM-DD HH:MM:SS`），
 * 按字符串字典序比较即可（同格式天然有序），不能当毫秒数比。
 */
export function dayBounds(day: string): { start: string; end: string } {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(y, (m ?? 1) - 1, (d ?? 1) + 1);
  const endDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(
    next.getDate(),
  ).padStart(2, "0")}`;
  return { start: `${day} 00:00:00`, end: `${endDay} 00:00:00` };
}
