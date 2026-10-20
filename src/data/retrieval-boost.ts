/**
 * 检索增强（A 方案，非 embedding）：用 DeepSeek 对「初步召回的候选记忆」做一次相关性重排。
 *
 * 背景：DeepSeek 官方没有 embeddings 接口（见 docs/DEEPSEEK_CAPABILITY_AUDIT.md §7），
 * 拿不到真语义向量；但实测（docs/SEMANTIC_BOOST_EVAL.md，20 条记忆金标）：
 *   - 现有 n-gram + FTS5 基线 T2 recall@1/3/8 = 55%/80%/85%；
 *   - 在基线候选（top12）上加一次 DeepSeek 重排后 = **95%/95%/95%**；
 *   - 平均一次重排 ~0.7s，单轮成本约 ¥0.0001–0.0002（flash、≤500 prompt tokens）。
 *   - 再加「查询改写」没有进一步提升（90%），只增加延迟/成本，所以生产只做重排。
 *
 * 设计：
 * - 默认开启；`KAREN_SEMANTIC_BOOST=off` 关闭（故障/延迟敏感场景）；
 * - **本地真向量启用时默认关闭**（v0.5）：实测「本地向量 + 不重排」17-18/20 优于
 *   「ngram/本地 + 重排」16/20，还省掉每轮 ~664ms 与 ¥0.00025；
 *   需要时可 `KAREN_SEMANTIC_BOOST=on` 强制打开；
 * - 超时/解析失败/无 Key/模型异常一律**降级为原顺序**，绝不影响主回复；
 * - 用 `chat()`（带 usage 记账/重试/脱敏日志），复杂度 simple；
 * - 重排结果不足时用原顺序补齐，保证不会因为重排漏掉候选。
 */
import { chat } from "../ai/chat.js";
import { retrieveRelevantMemoriesAsync, type RetrievedMemory } from "./retriever.js";
import { isLocalEmbeddingEnabled } from "./local-embed.js";

/** 关闭开关：off/0/false/disable 均视为关闭；默认开启。 */
export const SEMANTIC_BOOST_ENV = "KAREN_SEMANTIC_BOOST";
/** 重排超时（ms）：超过则降级原顺序，可用 env 覆盖（测试注入小值）。 */
export const SEMANTIC_BOOST_TIMEOUT_ENV = "KAREN_SEMANTIC_BOOST_TIMEOUT_MS";
export const DEFAULT_BOOST_TIMEOUT_MS = 2_500;
/** 送进重排器的候选数（比最终注入的 8 条多留余量）。 */
export const BOOST_POOL_SIZE = 12;
/** 候选少于这个数时不值得重排（1-2 条怎么排都差不多，省一次调用/1s 延迟）。 */
export const MIN_BOOST_POOL_SIZE = 3;

export type BoostMode = "off" | "rerank";

/** 读取当前增强模式（默认 rerank）。 */
export function resolveBoostMode(): BoostMode {
  const raw = (process.env[SEMANTIC_BOOST_ENV] ?? "").trim().toLowerCase();
  if (["off", "0", "false", "disable", "disabled", "no"].includes(raw)) return "off";
  // 本地真向量在跑：语义召回已经够准，默认不再额外花一次 LLM 重排
  const forcedOn = ["on", "1", "true", "enable", "enabled", "yes"].includes(raw);
  if (isLocalEmbeddingEnabled() && !forcedOn) return "off";
  return "rerank";
}

/** 读取超时配置（非法/过小回退默认）。 */
export function resolveBoostTimeoutMs(): number {
  const raw = Number((process.env[SEMANTIC_BOOST_TIMEOUT_ENV] ?? "").trim());
  if (!Number.isFinite(raw) || raw < 50) return DEFAULT_BOOST_TIMEOUT_MS;
  return Math.min(10_000, Math.floor(raw));
}

/**
 * 解析模型返回的重排编号（1-based）。兼容 ```json 包裹、多余文本；
 * 非法编号/越界/重复会被过滤；一个有效编号都没有时返回 null（视为失败 → 降级）。
 */
export function parseRerankOrder(raw: string, candidateCount: number): number[] | null {
  if (!raw || candidateCount <= 0) return null;
  const match = raw.match(/\[[\d,\s]*\]/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set<number>();
    const order: number[] = [];
    for (const value of parsed) {
      const rank = Number(value);
      if (!Number.isInteger(rank) || rank < 1 || rank > candidateCount || seen.has(rank)) continue;
      seen.add(rank);
      order.push(rank);
    }
    return order.length > 0 ? order : null;
  } catch {
    return null;
  }
}

/** 构造重排 prompt（不含任何用户身份信息之外的隐私内容——都是本地记忆片段）。 */
function buildRerankPrompt(userInput: string, pool: RetrievedMemory[]): string {
  const lines = pool.map((memory, index) => {
    const text = memory.content.replace(/\s+/g, " ").slice(0, 90);
    return `[${index + 1}] ${text}`;
  });
  return [
    `用户此刻说：${userInput.slice(0, 200)}`,
    "",
    `下面是初步召回的 ${pool.length} 条记忆（编号 + 内容）。请判断哪些记忆与用户此刻的话真正相关，`,
    `按相关度从高到低输出最多 ${Math.min(pool.length, 8)} 个编号，用 JSON 数组表示，例如 [3,1,5]。`,
    "都不相关输出 []。只输出 JSON 数组，不要解释。",
    "",
    ...lines,
  ].join("\n");
}

async function rerankWithLlm(userInput: string, pool: RetrievedMemory[]): Promise<number[] | null> {
  const raw = await chat(
    [
      { role: "system", content: "你是记忆检索的重排器。只输出 JSON 数组，不要解释。" },
      { role: "user", content: buildRerankPrompt(userInput, pool) },
    ],
    undefined,
    { complexity: "simple" },
  );
  return parseRerankOrder(raw, pool.length);
}

class BoostTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BoostTimeoutError(`重排超时(${timeoutMs}ms)`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface BoostOptions {
  /** 日志回调：orchestrator 的 logs（非流式）或 console（流式）。 */
  onLog?: (line: string) => void;
}

/**
 * 检索 + DeepSeek 重排（默认路径）。
 *
 * 1. 先用现有混合检索取 top12 候选（无 Key 时是 n-gram+FTS5，有 Qwen Key 时语义路径）；
 * 2. 让 Flash 对候选做一次相关性重排；
 * 3. 取前 limit 条，其余按原顺序补位；任何失败都返回原顺序前 limit 条。
 */
export async function retrieveWithLlmBoost(
  userInput: string,
  limit: number = 8,
  options: BoostOptions = {},
): Promise<RetrievedMemory[]> {
  const poolSize = Math.max(limit + 4, BOOST_POOL_SIZE);
  const pool = await retrieveRelevantMemoriesAsync(userInput, poolSize);
  const fallback = pool.slice(0, Math.max(1, limit));

  if (resolveBoostMode() === "off") return fallback;
  if (pool.length < MIN_BOOST_POOL_SIZE || userInput.trim().length < 2) return fallback;

  const timeoutMs = resolveBoostTimeoutMs();
  const startedAt = Date.now();
  try {
    const order = await withTimeout(rerankWithLlm(userInput, pool), timeoutMs);
    if (!order) {
      options.onLog?.(`[检索+] 重排无有效输出，保留原顺序（${Date.now() - startedAt}ms）`);
      return fallback;
    }
    const byRank = new Map<number, RetrievedMemory>();
    pool.forEach((memory, index) => byRank.set(index + 1, memory));
    const ordered: RetrievedMemory[] = [];
    const seen = new Set<number>();
    for (const rank of order) {
      const memory = byRank.get(rank);
      if (!memory || seen.has(memory.id)) continue;
      seen.add(memory.id);
      ordered.push(memory);
    }
    // 重排只决定"相关项的顺序"；未选中的按原顺序补位，避免漏召回
    for (const memory of pool) {
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      ordered.push(memory);
    }
    const result = ordered.slice(0, Math.max(1, limit));
    options.onLog?.(
      `[检索+] DeepSeek 重排 ${pool.length}→${result.length}（${Date.now() - startedAt}ms，模式 rerank）`,
    );
    return result;
  } catch (err) {
    options.onLog?.(
      `[检索+] 重排降级: ${err instanceof Error ? err.message : String(err)}（保留原顺序）`,
    );
    return fallback;
  }
}
