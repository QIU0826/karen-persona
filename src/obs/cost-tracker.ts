/**
 * LLM 成本统计（可观测最小闭环，M1-9）。
 *
 * 数据落 SQLite（复用 getVectorDb 的 data/memory.sqlite，懒建 llm_usage 表，
 * 零新依赖）。每次 ai/chat.ts 拿到 usage 时记录一行；同时供 /health 的
 * cost_today 与 /cost 的 7 日摘要使用。
 *
 * 价格（DeepSeek 官方，元 / 百万 tokens）——数组顺序为 [低峰, 高峰]：
 *   flash：缓存命中 0.02 / 0.04；缓存未命中 1 / 2；输出 4 / 8
 *   pro  ：缓存命中 0.15 / 0.30；缓存未命中 4.5 / 9；输出 13.5 / 27
 *
 * 峰谷规则：北京时间（UTC+8）工作日 09:00-12:00、14:00-18:00 为高峰，
 * 其余时间半价；周末按低峰。**节假日无法用零依赖可靠判断，按工作日近似**
 * （即节假日白天可能按高峰计费，偏保守/高估），这是已知近似。
 *
 * 计费口径：
 * - reasoning tokens 已包含在 completion_tokens 内（按输出计费），不重复计算；
 * - 缓存命中 token 来自 `prompt_cache_hit_tokens`，未命中 = prompt - hit；
 * - provider 不返回 usage 时不记录（不估算、不造假数据）。
 *
 * 覆盖范围：
 * - 主路径：ai/chat.ts 的 chat / chatStream（kind = chat / chatStream）；
 * - 旁路调用经 ai/aux-usage.ts 统一记账（kind = fact_extraction / monologue /
 *   t3_summary / her_view / journal / narrative / vision / photo_query），
 *   所以 cost_today 不再只是「下限」，按用途的拆分见 /cost 的 by_kind。
 */
import { getVectorDb } from "../data/vector.js";
import { dbPath } from "../data/paths.js";
import { createLogger } from "./logger.js";

const log = createLogger("cost");

/** 北京时间相对 UTC 的偏移（无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 用量用途（用于 /cost 的按用途拆分）：
 * - chat / chatStream：主对话；
 * - 其余：旁路 LLM 调用，经 ai/aux-usage.ts 统一记录。
 */
export type LlmUsageKind =
  | "chat"
  | "chatStream"
  | "fact_extraction"
  | "monologue"
  | "t3_summary"
  | "her_view"
  | "journal"
  | "narrative"
  | "vision"
  | "photo_query"
  | "daily_digest"
  | "initiative_plan"
  | "anchor_refine"
  | "memory_eval"
  | "other";

export interface LlmUsageInput {
  /** 实际请求的模型名，例如 deepseek-flash / deepseek-v4-pro */
  model: string;
  kind?: LlmUsageKind;
  promptTokens?: number;
  completionTokens?: number;
  /** prompt_cache_hit_tokens（DeepSeek 扩展字段） */
  cachedTokens?: number;
  /** prompt_cache_miss_tokens（不传则按 prompt - cached 计算） */
  cacheMissTokens?: number;
  /** completion_tokens_details.reasoning_tokens（已包含在 completion 内） */
  reasoningTokens?: number;
  latencyMs?: number;
  /** 记录时间（epoch ms，默认 now；测试/回放可传固定值） */
  at?: number;
}

export interface CostBreakdown {
  costCny: number;
  peak: boolean;
  tier: "flash" | "pro";
  promptTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  completionTokens: number;
}

export interface TodayCostSummary {
  date: string;
  calls: number;
  cost_cny: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
}

export interface CostDayBucket extends TodayCostSummary {}

export interface CostModelBucket {
  model: string;
  calls: number;
  cost_cny: number;
}

/** 按用途拆分（chat / fact_extraction / monologue / t3_summary / ...）。 */
export interface CostKindBucket {
  kind: LlmUsageKind;
  calls: number;
  cost_cny: number;
}

export interface CostReport {
  generated_at: string;
  window_days: number;
  total: Omit<TodayCostSummary, "date">;
  by_day: CostDayBucket[];
  by_model: CostModelBucket[];
  by_kind: CostKindBucket[];
}

// ── 价格表 ──────────────────────────────────────

interface PriceTier {
  /** 缓存命中输入 [低峰, 高峰]，元/百万 tokens */
  cacheHit: readonly [number, number];
  /** 缓存未命中输入 [低峰, 高峰] */
  cacheMiss: readonly [number, number];
  /** 输出 [低峰, 高峰] */
  output: readonly [number, number];
}

/** DeepSeek V4.1-Flash 价格（元/百万 tokens，[低峰, 高峰]）。 */
const FLASH_PRICE: PriceTier = {
  cacheHit: [0.02, 0.04],
  cacheMiss: [1, 2],
  output: [4, 8],
};

/** DeepSeek V4-Pro 价格（元/百万 tokens，[低峰, 高峰]）。 */
const PRO_PRICE: PriceTier = {
  cacheHit: [0.15, 0.3],
  cacheMiss: [4.5, 9],
  output: [13.5, 27],
};

/** 按模型名判断价格档位（包含 pro → pro，其余一律按 flash；旧别名 v4-flash 也命中 flash）。 */
export function resolvePriceTier(model: string): "flash" | "pro" {
  return /pro/i.test(model) ? "pro" : "flash";
}

function priceTier(model: string): PriceTier {
  return resolvePriceTier(model) === "pro" ? PRO_PRICE : FLASH_PRICE;
}

/**
 * 是否高峰时段（北京时间工作日 09:00-12:00 / 14:00-18:00）。
 * 节假日无法判断，按工作日近似（见文件头注释）。
 */
export function isPeakTime(at: number = Date.now()): boolean {
  const beijing = new Date(at + BEIJING_OFFSET_MS);
  const weekday = beijing.getUTCDay(); // 0=周日, 6=周六
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

function roundCny(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 计算单次调用成本（元）。纯函数，便于单测。
 * 参数 token 数可为 0；负数按 0 处理；cached 自动夹到 prompt 以内。
 */
export function computeCostCny(input: {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheMissTokens?: number;
  at?: number;
}): number {
  return computeCostBreakdown(input).costCny;
}

function computeCostBreakdown(input: {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheMissTokens?: number;
  at?: number;
}): CostBreakdown {
  const promptTokens = Math.max(0, Math.round(input.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(input.completionTokens ?? 0));
  const cachedTokens = Math.min(promptTokens, Math.max(0, Math.round(input.cachedTokens ?? 0)));
  const uncachedTokens =
    input.cacheMissTokens !== undefined
      ? Math.min(promptTokens, Math.max(0, Math.round(input.cacheMissTokens)))
      : promptTokens - cachedTokens;

  const at = input.at ?? Date.now();
  const peak = isPeakTime(at);
  const index = peak ? 1 : 0;
  const prices = priceTier(input.model);

  const costCny =
    (cachedTokens * prices.cacheHit[index] +
      uncachedTokens * prices.cacheMiss[index] +
      completionTokens * prices.output[index]) /
    1_000_000;

  return {
    costCny: roundCny(costCny),
    peak,
    tier: resolvePriceTier(input.model),
    promptTokens,
    cachedTokens,
    uncachedTokens,
    completionTokens,
  };
}

// ── SQLite 懒建表 / 写入 ────────────────────────

// 建表缓存按「当前 SQLite 文件路径」记录：测试/评测会在同一进程切换 KAREN_DATA_DIR，
// 进程级布尔会导致第二个库缺表（实测出现 "no such table: llm_usage" 警告）。
let tableReadyForPath: string | null = null;

function ensureTable(): void {
  const currentPath = dbPath();
  if (tableReadyForPath === currentPath) return;
  const db = getVectorDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      peak INTEGER NOT NULL DEFAULT 0,
      cost_cny REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
  `);
  tableReadyForPath = currentPath;
}

/**
 * 记录一次 LLM 调用并返回成本（元）。
 * 出错只打 warn（成本统计绝不能影响对话主流程）。
 */
export function recordLlmUsage(input: LlmUsageInput): number {
  const at = input.at ?? Date.now();
  const breakdown = computeCostBreakdown({ ...input, at });
  const totalTokens = breakdown.promptTokens + breakdown.completionTokens;
  const kind = input.kind ?? "chat";
  const reasoningTokens = Math.max(0, Math.round(input.reasoningTokens ?? 0));
  const latencyMs = Math.max(0, Math.round(input.latencyMs ?? 0));

  try {
    ensureTable();
    getVectorDb()
      .prepare(
        `INSERT INTO llm_usage
           (created_at, model, kind, prompt_tokens, completion_tokens, cached_tokens,
            reasoning_tokens, total_tokens, latency_ms, peak, cost_cny)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        at,
        String(input.model),
        kind,
        breakdown.promptTokens,
        breakdown.completionTokens,
        breakdown.cachedTokens,
        reasoningTokens,
        totalTokens,
        latencyMs,
        breakdown.peak ? 1 : 0,
        breakdown.costCny
      );
    log.debug("llm.usage_recorded", {
      model: input.model,
      cost_cny: breakdown.costCny,
      peak: breakdown.peak,
      latency_ms: latencyMs,
    });
    return breakdown.costCny;
  } catch (err) {
    log.warn("llm.usage_record_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ── 北京时间日界工具 ────────────────────────────

/** 某时刻所在北京时间自然日的 00:00（返回 epoch ms）。 */
function beijingDayStart(at: number): number {
  const shifted = new Date(at + BEIJING_OFFSET_MS);
  const startOfDayUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  return startOfDayUtc - BEIJING_OFFSET_MS;
}

/** 北京时间日期键：YYYY-MM-DD。 */
function beijingDateKey(at: number): string {
  const shifted = new Date(at + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface UsageAggregateRow {
  created_at: number;
  model: string;
  kind: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost_cny: number;
}

function queryUsageRows(start: number, end: number): UsageAggregateRow[] {
  ensureTable();
  return getVectorDb()
    .prepare(
      `SELECT created_at, model, kind, prompt_tokens, completion_tokens, cached_tokens,
              reasoning_tokens, cost_cny
       FROM llm_usage
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`
    )
    .all(start, end) as UsageAggregateRow[];
}

function emptyDayBucket(date: string): CostDayBucket {
  return {
    date,
    calls: 0,
    cost_cny: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
  };
}

// ── 对外摘要 ────────────────────────────────────

/** 今日（北京时间自然日）成本摘要。 */
export function getTodayCostSummary(at: number = Date.now()): TodayCostSummary {
  const start = beijingDayStart(at);
  const end = start + DAY_MS;
  try {
    const rows = queryUsageRows(start, end);
    const bucket = emptyDayBucket(beijingDateKey(at));
    for (const row of rows) {
      bucket.calls += 1;
      bucket.cost_cny += row.cost_cny;
      bucket.prompt_tokens += row.prompt_tokens;
      bucket.completion_tokens += row.completion_tokens;
      bucket.cached_tokens += row.cached_tokens;
      bucket.reasoning_tokens += row.reasoning_tokens;
    }
    bucket.cost_cny = roundCny(bucket.cost_cny);
    return bucket;
  } catch (err) {
    log.warn("cost.today_summary_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyDayBucket(beijingDateKey(at));
  }
}

/**
 * 最近 N 天成本报告（含今天，按北京时间自然日；缺失日期补 0）。
 * /cost 端点默认 days=7。
 */
export function getCostReport(days: number = 7, at: number = Date.now()): CostReport {
  const windowDays = Math.max(1, Math.min(31, Math.round(days)));
  const todayStart = beijingDayStart(at);
  const start = todayStart - (windowDays - 1) * DAY_MS;
  const end = todayStart + DAY_MS;

  const byDay: CostDayBucket[] = [];
  const dayIndex = new Map<string, CostDayBucket>();
  for (let i = 0; i < windowDays; i++) {
    const date = beijingDateKey(start + i * DAY_MS);
    const bucket = emptyDayBucket(date);
    byDay.push(bucket);
    dayIndex.set(date, bucket);
  }

  const modelIndex = new Map<string, CostModelBucket>();
  const kindIndex = new Map<string, CostKindBucket>();
  const total = {
    calls: 0,
    cost_cny: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
  };

  try {
    const rows = queryUsageRows(start, end);
    for (const row of rows) {
      const key = beijingDateKey(row.created_at);
      const bucket = dayIndex.get(key);
      if (bucket) {
        bucket.calls += 1;
        bucket.cost_cny += row.cost_cny;
        bucket.prompt_tokens += row.prompt_tokens;
        bucket.completion_tokens += row.completion_tokens;
        bucket.cached_tokens += row.cached_tokens;
        bucket.reasoning_tokens += row.reasoning_tokens;
      }

      total.calls += 1;
      total.cost_cny += row.cost_cny;
      total.prompt_tokens += row.prompt_tokens;
      total.completion_tokens += row.completion_tokens;
      total.cached_tokens += row.cached_tokens;
      total.reasoning_tokens += row.reasoning_tokens;

      const modelKey = String(row.model);
      const modelBucket = modelIndex.get(modelKey) ?? { model: modelKey, calls: 0, cost_cny: 0 };
      modelBucket.calls += 1;
      modelBucket.cost_cny += row.cost_cny;
      modelIndex.set(modelKey, modelBucket);

      const kindKey = String(row.kind ?? "chat");
      const kindBucket = kindIndex.get(kindKey) ?? {
        kind: kindKey as LlmUsageKind,
        calls: 0,
        cost_cny: 0,
      };
      kindBucket.calls += 1;
      kindBucket.cost_cny += row.cost_cny;
      kindIndex.set(kindKey, kindBucket);
    }
  } catch (err) {
    log.warn("cost.report_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const bucket of byDay) bucket.cost_cny = roundCny(bucket.cost_cny);
  total.cost_cny = roundCny(total.cost_cny);

  return {
    generated_at: new Date(at).toISOString(),
    window_days: windowDays,
    total,
    by_day: byDay,
    by_model: [...modelIndex.values()]
      .map((bucket) => ({ ...bucket, cost_cny: roundCny(bucket.cost_cny) }))
      .sort((a, b) => b.cost_cny - a.cost_cny),
    by_kind: [...kindIndex.values()]
      .map((bucket) => ({ ...bucket, cost_cny: roundCny(bucket.cost_cny) }))
      .sort((a, b) => b.cost_cny - a.cost_cny),
  };
}
