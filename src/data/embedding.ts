/**
 * 文本嵌入生成器 — 语义模型（Qwen text-embedding-v3）+ n-gram 确定性回退。
 *
 * 两条路径（写入与检索必须同源，否则余弦比较无意义）：
 * 1. 语义路径（异步）：通义千问 DashScope text-embedding-v3（OpenAI 兼容模式）：
 *    - 复用 QWEN_EMBEDDING_API_KEY / QWEN_VL_API_KEY；
 *    - 显式请求 `dimensions: 768`（与本项目 FLOAT[768] 列宽一致）；
 *    - 失败（无 Key / 网络 / 鉴权 / 维度异常）→ 自动降级 n-gram，并由调用方记录
 *      `model='ngram-v1'`，**绝不把两种向量写进同一空间比较**。
 * 2. n-gram 回退（同步、确定性）：字符 1/2/3-gram FNV-1a 哈希 + 符号投影 + L2 归一化。
 *
 * ⚠️ 真实语义链路需要 Qwen Key 才能验证；本机/CI 默认没有 Qwen Key，
 * 相关测试通过 mock fetch 覆盖，不要在生产断言里假设语义可用。
 */

import { getEmbeddingConfig } from "../ai/router.js";

/** 向量维度（与 t2_episodes.embedding / t2_vec FLOAT[768] 对齐）。 */
export const EMBEDDING_DIM = 768;
/** 本地 n-gram 哈希向量模型标识（也是历史 embedding 列的模型）。 */
export const NGRAM_EMBEDDING_MODEL = "ngram-v1";
/** Qwen 语义向量模型标识（写入 embedding_model/semantic_model 列的值）。 */
export const QWEN_EMBEDDING_MODEL = "qwen-text-embedding-v3";

/** 语义 API 单次请求超时。 */
const EMBEDDING_TIMEOUT_MS = 15_000;
/** 语义 API 失败后的冷却时间：期间直接走 n-gram，避免每条消息都等网络。 */
const API_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** 后台回填每批处理条数。 */
const UPGRADE_BATCH_SIZE = 200;

export interface EmbeddingResult {
  vector: Float32Array;
  /** NGRAM_EMBEDDING_MODEL 或 QWEN_EMBEDDING_MODEL */
  model: string;
  /** true = 配置了语义模型但本次调用失败，已降级 n-gram */
  degraded: boolean;
}

// ── n-gram 哈希（同步回退，算法与 M0 基线一致，不能随意改）────────

/** FNV-1a 32-bit 哈希 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 滑动窗口提取字符 n-gram */
function extractNgrams(text: string, n: number): string[] {
  if (text.length < n) return [];
  const result: string[] = [];
  for (let i = 0; i <= text.length - n; i++) {
    result.push(text.slice(i, i + n));
  }
  return result;
}

/**
 * 将文本转换为 768 维 L2 归一化向量（n-gram 词法哈希，不是语义模型）。
 * 空字符串返回零向量。
 */
export function generateEmbedding(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);

  if (!text || text.trim().length === 0) return vec;

  const ngrams = [
    ...extractNgrams(text, 1), // unigram
    ...extractNgrams(text, 2), // bigram
    ...extractNgrams(text, 3), // trigram
  ];

  for (const ng of ngrams) {
    const h = fnv1a(ng);
    const dim = (h & 0x3ff) % EMBEDDING_DIM; // 低 10 位 → 0-767
    const sign = (h >>> 31) === 0 ? 1 : -1; // 最高位 → 符号
    vec[dim] += sign;
  }

  // L2 归一化
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

// ── 语义 API 可用性状态 ───────────────────────────

type ApiState = "unknown" | "available" | "unavailable";
let apiState: ApiState = "unknown";
let apiRetryAt = 0;
let warnedDegrade = false;
let warnedMrlTruncation = false;
let dimensionsParamRejected = false;

/**
 * 是否配置了语义 embedding（仅检查 Key 与 EMBEDDING_PROVIDER，不发网络请求）。
 * `EMBEDDING_PROVIDER=ngram` 可强制走本地回退（测试/离线/隐私模式）。
 */
export function isSemanticEmbeddingConfigured(): boolean {
  const provider = (process.env.EMBEDDING_PROVIDER || "auto").toLowerCase();
  if (provider === "ngram") return false;
  return getEmbeddingConfig() !== null;
}

/** 当前配置下写入/查询应有的向量模型。 */
export function getConfiguredEmbeddingModel(): string {
  return isSemanticEmbeddingConfigured() ? QWEN_EMBEDDING_MODEL : NGRAM_EMBEDDING_MODEL;
}

/** 重置探测状态（单元测试用；生产无需调用）。 */
export function resetEmbeddingApiState(): void {
  apiState = "unknown";
  apiRetryAt = 0;
  warnedDegrade = false;
  warnedMrlTruncation = false;
  dimensionsParamRejected = false;
}

/**
 * 统一 embedder：有 Qwen Key 时用 text-embedding-v3，否则/失败降级 n-gram。
 * 返回的 model 必须随向量一起落库，检索时只与同 model 的向量比较。
 */
export async function embedText(text: string): Promise<EmbeddingResult> {
  if (!isSemanticEmbeddingConfigured()) {
    return { vector: generateEmbedding(text), model: NGRAM_EMBEDDING_MODEL, degraded: false };
  }
  if (apiState === "unavailable" && Date.now() < apiRetryAt) {
    return { vector: generateEmbedding(text), model: NGRAM_EMBEDDING_MODEL, degraded: true };
  }

  try {
    const vector = await callEmbeddingApi(text);
    apiState = "available";
    return { vector, model: QWEN_EMBEDDING_MODEL, degraded: false };
  } catch (err) {
    apiState = "unavailable";
    apiRetryAt = Date.now() + API_FAILURE_COOLDOWN_MS;
    if (!warnedDegrade) {
      console.log(
        `[Embedding] 语义 embedding 不可用，已降级 n-gram（${describeEmbeddingError(err)}；` +
          `${Math.round(API_FAILURE_COOLDOWN_MS / 60000)} 分钟内不再重试）`
      );
      warnedDegrade = true;
    }
    return { vector: generateEmbedding(text), model: NGRAM_EMBEDDING_MODEL, degraded: true };
  }
}

/**
 * 兼容旧接口：返回语义向量；不可用时返回 n-gram 向量。
 * 新代码请用 embedText() 以拿到 model 标记。
 */
export async function generateSemanticEmbedding(text: string): Promise<Float32Array> {
  return (await embedText(text)).vector;
}

// ── Qwen API 调用 ───────────────────────────────

function describeEmbeddingError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /aborted|timeout/i.test(err.message)) {
      return `请求超时（>${EMBEDDING_TIMEOUT_MS}ms）`;
    }
    return err.message.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

interface EmbeddingApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function requestEmbeddingApi(
  config: EmbeddingApiConfig,
  text: string,
  includeDimensions: boolean
): Promise<Response> {
  return fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      encoding_format: "float",
      // 显式请求 768 维：避免「默认 1024 维被截断」的隐性信息损失。
      ...(includeDimensions ? { dimensions: EMBEDDING_DIM } : {}),
    }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });
}

async function callEmbeddingApi(text: string): Promise<Float32Array> {
  const config = getEmbeddingConfig();
  if (!config) throw new Error("未配置 embedding API Key");

  let includeDimensions = !dimensionsParamRejected;

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await requestEmbeddingApi(config, text, includeDimensions);
    } catch (err) {
      throw new Error(`Embedding 请求失败: ${describeEmbeddingError(err)}`, { cause: err });
    }

    if (response.ok) {
      const data = (await response.json().catch(() => null)) as {
        data?: Array<{ embedding?: number[] }>;
      } | null;
      const embedding = data?.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("Embedding API 返回格式异常（缺少 data[0].embedding）");
      }
      return normalizeToDim(embedding, EMBEDDING_DIM);
    }

    const body = await response.text().catch(() => "");
    // 兼容不支持 dimensions 参数的供应商：去掉参数重试一次（随后按 MRL 前缀截断）
    if (response.status === 400 && includeDimensions && /dimension/i.test(body)) {
      dimensionsParamRejected = true;
      includeDimensions = false;
      continue;
    }
    throw new Error(`Embedding API 返回 ${response.status}: ${body.slice(0, 200)}`);
  }

  throw new Error("Embedding API 去掉 dimensions 参数重试后仍失败");
}

/**
 * 把任意维度的 embedding 规整到目标维度并 L2 归一化。
 *
 * 维度策略（不允许「悄悄丢信息」）：
 * - 正好 targetDim：直接使用；
 * - 大于 targetDim：Qwen text-embedding-v3 支持 MRL 可变维度，按「前缀截断」策略
 *   保留前 targetDim 维（这是 MRL 模型的推荐用法之一），并打印一次显式告警；
 * - 小于 targetDim：直接抛错，由调用方降级 n-gram（补零会造成静默失真，禁止）。
 *
 * 注意：alpha 期 Qwen 返回 1024 维时，旧代码无条件截断且无日志；这里修复为
 * 「优先请求 dimensions=768，失败才 MRL 前缀截断并显式告警」。
 */
export function normalizeToDim(vec: number[], targetDim: number = EMBEDDING_DIM): Float32Array {
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Embedding 向量为空");
  }
  const values = vec.map((v) => Number(v));
  if (!values.every((v) => Number.isFinite(v))) {
    throw new Error("Embedding 向量包含非数值");
  }

  let projected: number[];
  if (values.length === targetDim) {
    projected = values;
  } else if (values.length > targetDim) {
    if (!warnedMrlTruncation) {
      console.log(
        `[Embedding] 供应商返回 ${values.length} 维（期望 dimensions=${targetDim}），` +
          `按 MRL 前缀截断到 ${targetDim} 维并 L2 归一化；如供应商支持 dimensions 参数请检查配置`
      );
      warnedMrlTruncation = true;
    }
    projected = values.slice(0, targetDim);
  } else {
    throw new Error(
      `Embedding 维度不足：返回 ${values.length} 维 < 期望 ${targetDim} 维（拒绝补零，避免静默失真）`
    );
  }

  const result = new Float32Array(targetDim);
  let norm = 0;
  for (let i = 0; i < targetDim; i++) {
    result[i] = projected[i];
    norm += projected[i] * projected[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < targetDim; i++) result[i] /= norm;
  }
  return result;
}

// ── 后台语义升级队列（写入主路径自动接通）──────────

let upgradeQueue: Promise<void> = Promise.resolve();
const queuedUpgrades = new Set<number>();

/**
 * 写入后把 episode 排入后台语义升级队列（fire-and-forget，不阻塞主流程）。
 * 无 Qwen Key 时直接 no-op；失败静默（下次 upgradeEmbeddings 会重试缺失行）。
 */
export function queueSemanticUpgrade(episodeId: number, content: string): void {
  if (!isSemanticEmbeddingConfigured()) return;
  if (queuedUpgrades.has(episodeId)) return;
  queuedUpgrades.add(episodeId);
  upgradeQueue = upgradeQueue
    .then(async () => {
      const result = await embedText(content);
      if (result.model === NGRAM_EMBEDDING_MODEL) return; // 语义不可用，留给显式回填
      // 动态导入避免 embedding ↔ vector 循环依赖
      const { updateEpisodeSemanticEmbedding } = await import("./vector.js");
      updateEpisodeSemanticEmbedding(episodeId, result.vector, result.model);
    })
    .catch((err) => {
      console.log(`[Embedding] 后台语义升级失败(id=${episodeId}): ${describeEmbeddingError(err)}`);
    })
    .finally(() => {
      queuedUpgrades.delete(episodeId);
    });
}

/** 等待后台语义升级队列清空（测试/退出前用）。 */
export function flushSemanticUpgrades(): Promise<void> {
  return upgradeQueue;
}

// ── 幂等回填：旧数据补齐语义向量（不阻塞启动）──────────

/**
 * 后台/手动回填：为还没有 semantic_embedding 的历史 episode 生成语义向量。
 *
 * - 幂等：只处理 semantic_embedding IS NULL 的行；重复调用安全；
 * - 非阻塞：调用方可以 `void startBackgroundEmbeddingUpgrade()`，不应 await 启动流程；
 * - 无 Qwen Key / API 不可用：直接返回 0（不写假数据，避免污染向量空间）；
 * - 语义 API 失败时不会把 n-gram 写进 semantic_embedding 列（列内永远只有同模型向量）。
 */
export async function upgradeEmbeddings(
  progressCb?: (done: number, total: number) => void
): Promise<number> {
  if (!isSemanticEmbeddingConfigured()) {
    console.log("[Embedding] 未配置 Qwen Key（或 EMBEDDING_PROVIDER=ngram），跳过语义回填");
    return 0;
  }

  // 动态导入避免模块循环
  const { countPendingSemanticBackfill, getEpisodesNeedingSemanticEmbedding, updateEpisodeSemanticEmbedding } =
    await import("./vector.js");

  const total = countPendingSemanticBackfill();
  if (total === 0) {
    console.log("[Embedding] 所有历史记忆都已有语义向量，无需回填");
    return 0;
  }

  console.log(`[Embedding] 开始回填语义向量：${total} 条待处理`);
  let done = 0;
  for (;;) {
    const batch = getEpisodesNeedingSemanticEmbedding(UPGRADE_BATCH_SIZE);
    if (batch.length === 0) break;

    let upgradedInBatch = 0;
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const result = await embedText(row.content);
      if (result.model === NGRAM_EMBEDDING_MODEL) {
        // 语义 API 不可用：立即停止，避免用 n-gram 撞进语义列 / 无限循环
        console.log("[Embedding] 语义 API 不可用，回填中止（下次启动/调用会从断点继续，幂等）");
        return done;
      }
      updateEpisodeSemanticEmbedding(row.id, result.vector, result.model);
      done++;
      upgradedInBatch++;
      progressCb?.(done, total);
      // API 限速：每 10 条歇一下（DashScope 默认 QPS 限制）
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 100));
    }

    if (upgradedInBatch === 0) break;
  }

  console.log(`[Embedding] 语义回填完成: ${done}/${total} 条`);
  return done;
}

/**
 * 启动后台回填（不阻塞启动）。由入口（CLI/QQ）在初始化后调用，
 * `void startBackgroundEmbeddingUpgrade()` 即可；无 Key 时立刻返回。
 */
export function startBackgroundEmbeddingUpgrade(): void {
  if (!isSemanticEmbeddingConfigured()) return;
  void upgradeEmbeddings().catch((err) => {
    console.log(`[Embedding] 后台回填异常: ${describeEmbeddingError(err)}`);
  });
}
