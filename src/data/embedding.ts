/**
 * 文本嵌入生成器 — 混合方案。
 *
 * 主路径（异步）：
 * - 使用通义千问 DashScope text-embedding-v3（OpenAI 兼容模式）
 * - 复用 QWEN_VL_API_KEY，无需额外配置
 * - 失败时自动降级到 n-gram 哈希
 *
 * 同步回退（确定性）：
 * - 字符 n-gram FNV-1a 哈希 + 签名随机投影
 * - 零外部依赖，中文友好，人设无关
 *
 * 算法（n-gram）：
 * 1. 提取 unigram/bigram/trigram
 * 2. FNV-1a 哈希 → 低 10 位选维度(0-767)，最高位定符号(+1/-1)
 * 3. 累加后 L2 归一化
 */

const DIM = 768;

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
 * 将文本转换为 768 维 L2 归一化向量。
 * 空字符串返回零向量。
 */
export function generateEmbedding(text: string): Float32Array {
  const vec = new Float32Array(DIM);

  if (!text || text.trim().length === 0) return vec;

  const ngrams = [
    ...extractNgrams(text, 1), // unigram
    ...extractNgrams(text, 2), // bigram
    ...extractNgrams(text, 3), // trigram
  ];

  for (const ng of ngrams) {
    const h = fnv1a(ng);
    const dim = (h & 0x3ff) % DIM; // 低 10 位 → 0-767
    const sign = (h >>> 31) === 0 ? 1 : -1; // 最高位 → 符号
    vec[dim] += sign;
  }

  // L2 归一化
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < DIM; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

// ── 语义嵌入（异步，P1-3）────────────────────────

import { getEmbeddingConfig } from "../ai/router.js";

let embeddingApiChecked = false;
let embeddingApiAvailable = false;

/**
 * 尝试生成语义嵌入。
 * 优先使用通义千问 text-embedding-v3，失败则降级到 n-gram 哈希。
 */
export async function generateSemanticEmbedding(text: string): Promise<Float32Array> {
  if (!embeddingApiChecked) {
    embeddingApiAvailable = await checkEmbeddingApi();
    embeddingApiChecked = true;
  }

  if (embeddingApiAvailable) {
    try {
      return await callEmbeddingApi(text);
    } catch {
      // 降级：临时失败不改变可用性标记
    }
  }

  return generateEmbedding(text);
}

async function checkEmbeddingApi(): Promise<boolean> {
  const config = getEmbeddingConfig();
  if (!config) {
    console.log("[Embedding] 未配置 QWEN API Key，使用 n-gram 哈希");
    return false;
  }

  try {
    await callEmbeddingApi("test");
    console.log("[Embedding] 通义千问 text-embedding-v3 可用");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Embedding] 通义千问 embedding API 不可用 (${msg})，使用 n-gram 哈希`);
    return false;
  }
}

async function callEmbeddingApi(text: string): Promise<Float32Array> {
  const config = getEmbeddingConfig();
  if (!config) throw new Error("未配置 embedding API Key");

  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding API 返回 ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>;
  };

  const emb = data.data?.[0]?.embedding;
  if (!emb || !Array.isArray(emb)) {
    throw new Error("Embedding API 返回格式异常");
  }

  return normalizeToDim(emb, DIM);
}

function normalizeToDim(vec: number[], targetDim: number): Float32Array {
  const result = new Float32Array(targetDim);
  if (vec.length === targetDim) {
    for (let i = 0; i < targetDim; i++) result[i] = vec[i];
  } else if (vec.length > targetDim) {
    // 截断（取前 targetDim 维）
    for (let i = 0; i < targetDim; i++) result[i] = vec[i];
  } else {
    // 补零（实际场景不应该发生）
    for (let i = 0; i < vec.length; i++) result[i] = vec[i];
  }

  // L2 归一化
  let norm = 0;
  for (let i = 0; i < targetDim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < targetDim; i++) result[i] /= norm;
  }

  return result;
}

/**
 * 后台回填：用语义嵌入重新处理旧的 n-gram 嵌入。
 * 调用此函数后，所有已有 episode 将获得语义嵌入。
 */
export async function upgradeEmbeddings(
  progressCb?: (done: number, total: number) => void,
): Promise<number> {
  if (!embeddingApiChecked) {
    embeddingApiAvailable = await checkEmbeddingApi();
    embeddingApiChecked = true;
  }

  if (!embeddingApiAvailable) {
    console.log("[Embedding] API 不可用，跳过后台回填");
    return 0;
  }

  // 需要动态导入以避免循环依赖
  const { getVectorDb } = await import("./vector.js");

  const d = getVectorDb();
  const rows = d.prepare(
    `SELECT id, content FROM t2_episodes WHERE strength > 0.05 AND embedding IS NOT NULL`
  ).all() as Array<{ id: number; content: string }>;

  if (rows.length === 0) return 0;

  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const emb = await callEmbeddingApi(rows[i].content);
      const arr = JSON.stringify(Array.from(emb));
      d.prepare("UPDATE t2_episodes SET embedding = ? WHERE id = ?").run(arr, rows[i].id);
      count++;
      if (progressCb) progressCb(i + 1, rows.length);
    } catch {
      // 保留原有 n-gram 嵌入
    }
    // API 调用限速：每 100ms 一条
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`[Embedding] 回填完成: ${count}/${rows.length} 条`);
  return count;
}
