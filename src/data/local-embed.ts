/**
 * 本地向量服务客户端（v0.5）。
 *
 * 背景：换成本地模型（Qwen3-Embedding-0.6B）后，检索从"关键词 + 每轮 LLM 重排"变成
 * 真正的语义检索；模型跑在独立进程（services/embed），这里只做 HTTP 调用。
 *
 * 设计约束：
 * - **永不阻塞聊天**：超时 2.5s；服务不可用 → 返回 null，调用方降级回字符 n-gram；
 * - **失败冷却**：一次失败后 60s 内不重试，避免每轮都等超时；
 * - **只认 768 维**：与现有 t2_vec(FLOAT[768]) 对齐，维度不符视为不可用（避免写入脏向量）；
 * - 健康探测结果缓存 60s，避免每轮都打 /health。
 */

/** 落库时写入 semantic_model 的标记（换了模型必须换标记，否则会跨模型比较） */
export const LOCAL_EMBEDDING_MODEL = "local-qwen3-embedding-0.6b";

export const DEFAULT_LOCAL_EMBED_URL = "http://127.0.0.1:18083";
/** 与 t2_vec 的 FLOAT[768] 对齐 */
export const LOCAL_EMBEDDING_DIM = 768;

const HEALTH_TIMEOUT_MS = 800;
const EMBED_TIMEOUT_MS = 2_500;
const FAILURE_COOLDOWN_MS = 60_000;

type LocalState = "unknown" | "ok" | "down";

let state: LocalState = "unknown";
let checkedAt = 0;
let retryAt = 0;
let warned = false;

/** 服务地址（可用 KAREN_EMBED_URL 覆盖，测试里直接改 env） */
export function localEmbedUrl(): string {
  const env = process.env.KAREN_EMBED_URL?.trim();
  return env && env.length > 0 ? env.replace(/\/+$/, "") : DEFAULT_LOCAL_EMBED_URL;
}

/**
 * 是否允许使用本地向量。**显式开启**，避免测试/离线环境被网络探测干扰：
 * - 开启：`KAREN_EMBED=on` 或设置 `KAREN_EMBED_URL`；
 * - 关闭：`KAREN_EMBED=off` 或 `EMBEDDING_PROVIDER=ngram`（优先级更高）。
 */
export function isLocalEmbeddingEnabled(): boolean {
  if ((process.env.KAREN_EMBED ?? "").toLowerCase() === "off") return false;
  const provider = (process.env.EMBEDDING_PROVIDER ?? "auto").toLowerCase();
  if (provider === "ngram") return false;
  const on = (process.env.KAREN_EMBED ?? "").toLowerCase();
  return on === "on" || on === "1" || on === "true" || Boolean(process.env.KAREN_EMBED_URL?.trim());
}

/** 重置探测状态（单测用） */
export function resetLocalEmbeddingState(): void {
  state = "unknown";
  checkedAt = 0;
  retryAt = 0;
  warned = false;
}

export interface LocalEmbedHealth {
  ok: boolean;
  model?: string;
  dim?: number;
}

/** 探测服务（结果缓存 60s；失败进入冷却）。 */
export async function probeLocalEmbedding(force = false): Promise<LocalEmbedHealth> {
  const now = Date.now();
  if (!force) {
    if (state === "ok" && now - checkedAt < FAILURE_COOLDOWN_MS) return { ok: true };
    if (state === "down" && now < retryAt) return { ok: false };
  }
  try {
    const res = await fetch(`${localEmbedUrl()}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
    const json = (await res.json()) as { ok?: boolean; model?: string; dim?: number };
    state = json.ok ? "ok" : "down";
    checkedAt = now;
    return { ok: state === "ok", model: json.model, dim: json.dim };
  } catch {
    state = "down";
    retryAt = now + FAILURE_COOLDOWN_MS;
    if (!warned) {
      console.log("[Embedding] 本地向量服务不可用，已降级 n-gram（60s 内不重试）");
      warned = true;
    }
    return { ok: false };
  }
}

interface EmbedResponse {
  vectors?: number[][];
  dim?: number;
}

function toFloat32(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i];
  return out;
}

/**
 * 批量嵌入。失败/维度不符/服务不可用 → null（调用方降级）。
 * mode=query 时服务端会加检索任务指令（Qwen3 官方建议）。
 */
export async function embedLocalBatch(
  texts: string[],
  mode: "query" | "document" = "document",
): Promise<Float32Array[] | null> {
  if (!isLocalEmbeddingEnabled() || texts.length === 0) return null;
  if (state === "down" && Date.now() < retryAt) return null;
  if (state !== "ok") {
    const health = await probeLocalEmbedding();
    if (!health.ok) return null;
  }
  try {
    const res = await fetch(`${localEmbedUrl()}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: texts.map((t) => t.slice(0, 2000)), mode }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const json = (await res.json()) as EmbedResponse;
    const vectors = json.vectors ?? [];
    if (vectors.length !== texts.length) return null;
    if (vectors.some((v) => v.length !== LOCAL_EMBEDDING_DIM)) {
      console.log(
        `[Embedding] 本地向量维度不是 ${LOCAL_EMBEDDING_DIM}（收到 ${vectors[0]?.length ?? 0}），忽略`,
      );
      return null;
    }
    checkedAt = Date.now();
    state = "ok";
    return vectors.map(toFloat32);
  } catch {
    state = "down";
    retryAt = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  }
}

/** 单条嵌入（检索 query 用 mode="query"）。 */
export async function embedLocal(
  text: string,
  mode: "query" | "document" = "document",
): Promise<Float32Array | null> {
  const out = await embedLocalBatch([text], mode);
  return out ? out[0] : null;
}
