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

/**
 * 取某一天的消息（保留原始顺序，最多 N 条，避免超长）。
 *
 * v0.8.16：原来是 `slice(-limit)`，只留**最后** N 条——真实冒烟发现一天 >80 条时，
 * **早上说的关键事实（下周三去上海见客户、签星潮合同）被整段丢掉**，日记忆只剩下午闲聊。
 * 改成「保头 + 保尾」：前 1/4 与后 3/4，中间超出部分丢弃（日记忆里用一条省略号提示）。
 */
export function pickDayMessages(messages: ChatLine[], dayKey: string, limit = 80): ChatLine[] {
  const picked = messages.filter((m) => localDayKey(m.timestamp) === dayKey);
  if (picked.length <= limit) return picked;
  // 省略提示行本身占 1 条，所以头尾只取 limit-1 条（保证返回总数不超上限）
  const bodyLimit = Math.max(2, limit - 1);
  const headCount = Math.max(2, Math.floor(bodyLimit / 4));
  const tailCount = bodyLimit - headCount;
  const head = picked.slice(0, headCount);
  const tail = picked.slice(-tailCount);
  // 中间省略的部分用一条合成行提示，避免模型以为一天只有这些内容
  const omitted = picked.length - head.length - tail.length;
  if (omitted <= 0) return [...head, ...tail];
  const gap: ChatLine = {
    role: "user",
    content: `（中间还有 ${omitted} 条消息省略）`,
    timestamp: head[head.length - 1]!.timestamp + 1,
  };
  return [...head, gap, ...tail];
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
export const WEEKLY_SUMMARY_MAX_CHARS = 400;
/** 每周最多纳入几天（按日记忆最近 7 条） */
export const WEEKLY_MAX_DAYS = 7;
/** 未完成话题最多保留几条、每条最多多少字 */
const WEEKLY_MAX_THREADS = 3;
const WEEKLY_THREAD_CHARS = 24;

/**
 * 周汇总文本（纯拼接，不调模型）。
 *
 * v0.8.18：原来是「拼完再 slice(0,400)」——真实冒烟用 7 天各约 100 字的日记忆跑，
 * 结果**「还没聊完」整段被截掉**（那正是她一周后该记得的"什么没做完"，也是主动由头的原料），
 * 最后一天也被截成半句。
 *
 * 现在改成先给尾部（未完成话题）留预算，再按天均分剩余预算：
 * - 每一天都保留（覆盖整周，不漏天）；
 * - 每条日记忆按配额截短（超出加省略号），不会出现"最后一天被砍掉"；
 * - 总长严格 ≤ WEEKLY_SUMMARY_MAX_CHARS。
 */
export function buildWeeklySummary(digests: DailyDigestRow[]): string {
  if (digests.length === 0) return "";
  const ordered = [...digests].sort((a, b) => a.day.localeCompare(b.day)).slice(-WEEKLY_MAX_DAYS);

  // 1) 先算尾部（未完成话题）：去重、截短、最多 3 条
  const threads: string[] = [];
  for (const d of ordered) {
    try {
      for (const raw of JSON.parse(d.open_threads_json ?? "[]") as string[]) {
        const text = String(raw ?? "").replace(/\s+/g, " ").trim();
        if (!text || threads.includes(text)) continue;
        threads.push(
          Array.from(text).length > WEEKLY_THREAD_CHARS
            ? `${Array.from(text).slice(0, WEEKLY_THREAD_CHARS).join("")}…`
            : text,
        );
      }
    } catch {
      // 忽略坏数据
    }
  }
  const tail =
    threads.length > 0 ? ` 还没聊完：${threads.slice(0, WEEKLY_MAX_THREADS).join("、")}。` : "";
  const tailChars = Array.from(tail).length;

  // 2) 每天预留「MM-DD 」前缀 6 字 + 分号 1 字；剩余预算均分给日记忆正文
  const dayCount = ordered.length;
  const prefixChars = 6;
  const separators = Math.max(1, dayCount - 1);
  const bodyBudget = Math.max(
    dayCount * 12,
    WEEKLY_SUMMARY_MAX_CHARS - tailChars - dayCount * prefixChars - separators,
  );
  const perDay = Math.max(12, Math.floor(bodyBudget / dayCount));

  const head = ordered
    .map((d) => {
      const chars = Array.from((d.summary ?? "").replace(/\s+/g, " ").trim());
      const body = chars.length > perDay ? `${chars.slice(0, perDay).join("")}…` : chars.join("");
      return `${d.day.slice(5)} ${body}`;
    })
    .join("；");

  let text = `${head}。${tail}`;
  // 3) 兜底：极端情况下（每天都很短、话题很多）再收一次，优先保留尾部
  if (Array.from(text).length > WEEKLY_SUMMARY_MAX_CHARS) {
    const keep = WEEKLY_SUMMARY_MAX_CHARS - tailChars - 1;
    const headChars = Array.from(head);
    text = `${headChars.slice(0, Math.max(0, keep)).join("")}…${tail}`;
  }
  return text;
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
