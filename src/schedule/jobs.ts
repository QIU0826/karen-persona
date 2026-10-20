/**
 * 记忆 v2 的定时任务（v0.5）：日记忆 / 周汇总 / 巩固。
 *
 * 设计：
 * - **幂等**：每个任务用 (job, period) 记在 `job_runs` 表里，重复调用不会重复消耗 token；
 * - **可补跑**：桥接每次心跳（15 分钟）调 `dueJobs(now)`，机器关机错过的日期会在下次启动后补上；
 * - **纯函数拆开**：prompt 构造、响应解析、日期计算都可单测；LLM 调用由调用方注入（便于 mock 与记账）。
 */
import type { Database } from "better-sqlite3";
import {
  listRecentDigests,
  markJobRun,
  upsertDailyDigest,
  wasJobRun,
  type DailyDigestRow,
} from "../data/memory-v2.js";

// ── 日期工具 ──────────────────────────────────

/** 本地时区的 YYYY-MM-DD（不用 UTC，避免"昨天"错位） */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 相对某天偏移 N 天的 day key */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const base = new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
  base.setDate(base.getDate() + deltaDays);
  return localDayKey(base.getTime());
}

/** 该 day key 对应的周一（ISO 周起点） */
export function weekStartOf(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const base = new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
  const dow = base.getDay(); // 0=周日
  const diff = dow === 0 ? 6 : dow - 1;
  base.setDate(base.getDate() - diff);
  return localDayKey(base.getTime());
}

// ── 日记忆 ────────────────────────────────────

export interface ChatLine {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/** 取某一天的消息（保留原始顺序，最多 N 条，避免超长） */
export function pickDayMessages(messages: ChatLine[], dayKey: string, limit = 80): ChatLine[] {
  const picked = messages.filter((m) => localDayKey(m.timestamp) === dayKey);
  return picked.slice(-limit);
}

export interface DailyDigestPrompt {
  system: string;
  user: string;
}

/**
 * 日记忆压缩 prompt：把一天的对话压成「发生了什么 / 情绪基调 / 未完成话题」。
 * 要求：只写片段里有的内容，不编造；保留具体事实（人名/项目/承诺/计划）。
 */
export function buildDailyDigestPrompt(dayKey: string, messages: ChatLine[]): DailyDigestPrompt {
  const lines = messages
    .map((m) => `${m.role === "user" ? "他" : "你"}：${m.content.replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");
  return {
    system: [
      "你是记忆压缩器。把一天的聊天压成一条「日记忆」，供角色之后回忆。",
      "只输出 JSON，不要解释。",
      '格式：{"summary":"...","mood":"...","events":["..."],"open_threads":["..."]}',
      "要求：",
      "- summary ≤80 字，写清发生了什么（谁说了什么要紧的事），不要写感受套话；",
      "- mood 用 2-6 个字（如 轻松/有点累/小别扭）；",
      "- events 0-4 条，每条 ≤20 字，只写具体事件；",
      "- open_threads 0-3 条，每条 ≤20 字，写还没聊完/答应过的事；",
      "- 只允许写片段里出现过的内容，不要编造；片段里没有就留空数组。",
    ].join("\n"),
    user: `日期：${dayKey}\n片段：\n${lines || "（当天没有聊天）"}`,
  };
}

export interface ParsedDigest {
  summary: string;
  mood?: string;
  events: string[];
  openThreads: string[];
}

function toStr(value: unknown, max = 120): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function toStrArray(value: unknown, maxItems: number, maxLen = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => toStr(v, maxLen))
    .filter((v) => v.length > 0)
    .slice(0, maxItems);
}

/** 解析日记忆的 JSON 响应（容错：允许代码块包裹/前后有说明文字）。 */
export function parseDailyDigest(content: string): ParsedDigest | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const summary = toStr(obj.summary, 200);
  if (!summary) return null;
  return {
    summary,
    mood: toStr(obj.mood, 12) || undefined,
    events: toStrArray(obj.events, 4, 20),
    openThreads: toStrArray(obj.open_threads, 3, 20),
  };
}

export interface RunDailyDigestInput {
  db: Database;
  personaId: string;
  ownerId: string;
  dayKey: string;
  messages: ChatLine[];
  /** 注入的 LLM 调用（返回原始文本）；失败抛错由本函数兜住 */
  chatFn: (prompt: DailyDigestPrompt) => Promise<string>;
  now?: number;
  /** 已经跑过就跳过（幂等） */
  skipIfDone?: boolean;
}

export interface JobResult {
  ok: boolean;
  reason: string;
}

/**
 * 生成并写入某天的日记忆。
 * 当天没有消息 → 不写（也不标记跑过，等有消息再说）。
 */
export async function runDailyDigest(input: RunDailyDigestInput): Promise<JobResult> {
  const period = input.dayKey;
  if (input.skipIfDone !== false && wasJobRun(input.db, "daily_digest", period)) {
    return { ok: false, reason: "already_done" };
  }
  const picked = pickDayMessages(input.messages, input.dayKey);
  if (picked.length === 0) {
    return { ok: false, reason: "no_messages" };
  }
  const prompt = buildDailyDigestPrompt(input.dayKey, picked);
  let raw: string;
  try {
    raw = await input.chatFn(prompt);
  } catch (err) {
    return { ok: false, reason: `chat_failed:${err instanceof Error ? err.name : "unknown"}` };
  }
  const parsed = parseDailyDigest(raw);
  if (!parsed) {
    return { ok: false, reason: "parse_failed" };
  }
  upsertDailyDigest(input.db, {
    personaId: input.personaId,
    ownerId: input.ownerId,
    day: input.dayKey,
    summary: parsed.summary,
    mood: parsed.mood,
    events: parsed.events,
    openThreads: parsed.openThreads,
    now: input.now,
  });
  markJobRun(input.db, "daily_digest", period, input.now);
  return { ok: true, reason: "written" };
}

// ── 周汇总（规则版，先不上 LLM） ────────────────

/** 把一周的日记忆拼成周汇总（规则拼接，避免每周多一次 LLM 调用）。 */
export function buildWeeklySummary(digests: DailyDigestRow[]): string {
  if (digests.length === 0) return "";
  const ordered = [...digests].sort((a, b) => a.day.localeCompare(b.day));
  const threads = new Set<string>();
  for (const d of ordered) {
    try {
      for (const t of JSON.parse(d.open_threads_json ?? "[]") as string[]) {
        if (t) threads.add(t);
      }
    } catch {
      // 忽略坏数据
    }
  }
  const head = ordered.map((d) => `${d.day.slice(5)} ${d.summary}`).join("；");
  const tail = threads.size > 0 ? ` 还没聊完：${[...threads].slice(0, 3).join("、")}。` : "";
  const text = `${head}。${tail}`;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** 写入某周的周汇总（幂等）。 */
export function runWeeklyRollup(input: {
  db: Database;
  personaId: string;
  ownerId: string;
  weekStart: string;
  now?: number;
}): JobResult {
  if (wasJobRun(input.db, "weekly_rollup", input.weekStart)) {
    return { ok: false, reason: "already_done" };
  }
  const digests = listRecentDigests(input.db, input.personaId, input.ownerId, 7).filter((d) =>
    d.day >= input.weekStart,
  );
  const summary = buildWeeklySummary(digests);
  if (!summary) return { ok: false, reason: "no_digests" };
  try {
    input.db
      .prepare(
        `INSERT INTO weekly_rollups (persona_id, owner_id, week_start, summary, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(persona_id, owner_id, week_start) DO UPDATE SET summary = excluded.summary`,
      )
      .run(input.personaId, input.ownerId, input.weekStart, summary, input.now ?? Date.now());
  } catch {
    return { ok: false, reason: "db_failed" };
  }
  markJobRun(input.db, "weekly_rollup", input.weekStart, input.now);
  return { ok: true, reason: "written" };
}

// ── 到期判断 ──────────────────────────────────

export interface DueJobs {
  /** 需要生成日记忆的日期（通常是"昨天"，若漏跑则依次补） */
  dailyDigestDays: string[];
  /** 需要生成周汇总的周起点 */
  weeklyRollupWeeks: string[];
}

/**
 * 计算此刻该补哪些任务。
 *
 * 规则：每天 00:10 之后处理"昨天"；启动补跑最多回看 3 天。
 * 周汇总：周一 00:30 之后处理上一周。
 */
export function computeDueJobs(input: {
  db: Database;
  personaId: string;
  ownerId: string;
  now?: number;
  /** 回看天数（默认 3） */
  lookbackDays?: number;
}): DueJobs {
  const now = input.now ?? Date.now();
  const todayKey = localDayKey(now);
  const hour = new Date(now).getHours();
  const minute = new Date(now).getMinutes();
  const afterDaily = hour > 0 || (hour === 0 && minute >= 10);

  const dailyDigestDays: string[] = [];
  const lookback = Math.max(1, input.lookbackDays ?? 3);
  for (let i = 1; i <= lookback; i++) {
    const dayKey = shiftDayKey(todayKey, -i);
    // 只有"已经过去的那一天"才处理；今天要等 00:10 之后才轮到（那也已经是"昨天"了）
    if (i === 0) continue;
    if (i === 1 && !afterDaily) continue;
    if (wasJobRun(input.db, "daily_digest", dayKey)) continue;
    dailyDigestDays.push(dayKey);
  }

  const weeklyRollupWeeks: string[] = [];
  const weekday = new Date(now).getDay();
  const afterWeekly = weekday === 1 ? hour > 0 || (hour === 0 && minute >= 30) : false;
  if (afterWeekly) {
    const weekStart = weekStartOf(shiftDayKey(todayKey, -7));
    if (!wasJobRun(input.db, "weekly_rollup", weekStart)) weeklyRollupWeeks.push(weekStart);
  }

  return { dailyDigestDays, weeklyRollupWeeks };
}
