/**
 * RAG 检索器（M1-7 记忆检索闭环）。
 *
 * 混合检索 = 向量路 + 关键词路，两路召回后 RRF 融合：
 * - 向量路：
 *   · 同步 `retrieveRelevantMemories` 用 legacy n-gram 空间（无 Qwen Key / 异常时的降级路径）；
 *   · 异步 `retrieveRelevantMemoriesAsync` 有 Qwen Key 时用 text-embedding-v3 语义空间，
 *     无 Key / API 失败时自动降级回 n-gram（两路都只会与**同模型**向量比较）。
 * - 关键词路：FTS5 BM25（中文逐字空格 + unicode61，2 字词可命中）。
 *
 * 融合与过滤：
 * 1. RRF：`score = Σ 1/(60 + rank)`（技术雷达 §2.3 推荐 k=60）；
 * 2. 叠加原公式权重：`relevance = rrf * (60+1) * 衰减强度 * (1 + |情感权重|)`，截断到 [0,1]；
 * 3. 相似度阈值（n-gram 0.10 / 语义 0.35，**初值待标注集标定**）；
 * 4. 内容去重（同内容只留 relevance 最高）；
 * 5. source 过滤：`internal_monologue` 不注入普通 RAG——独白是她的内心活动，不是
 *    「用户说过 / 发生过的对话事实」；注入会让她把独白当对话记忆复述。独白已由
 *    orchestrator 的 style-reference / journal 单独消费；
 * 6. `confidence` 用 relevance（相似度/排名/双路命中）而非仅 strength。
 */
import {
  searchSimilarEpisodes,
  searchSemanticEpisodes,
  searchEpisodesByFts,
  insertEpisodeWithEmbedding,
  insertEpisodeWithSemanticEmbedding,
  applyDecay,
  getVectorDb,
} from "./vector.js";
import {
  embedText,
  generateEmbedding,
  queueSemanticUpgrade,
  upgradeEmbeddings,
  NGRAM_EMBEDDING_MODEL,
} from "./embedding.js";

export interface RetrievedMemory {
  id: number;
  content: string;
  relevance: number; // 0-1 综合相关性分数
  strength: number;
  confidence: "high" | "medium" | "low";
}

/** RRF 常数：score = Σ 1/(K + rank)，k=60 为技术雷达推荐值。 */
const RRF_K = 60;
/** 每路召回候选数相对 limit 的放大倍数（给融合/过滤留余量）。 */
const CANDIDATE_MULTIPLIER = 6;
/** 候选数下限，避免 limit=1 时候选过少。 */
const MIN_CANDIDATES = 12;

/** n-gram 词法空间余弦阈值（不同 query 分布不同；0.10 为经验初值，待标注集标定）。 */
export const MIN_NGRAM_SIMILARITY = 0.1;
/** 语义空间余弦阈值（技术雷达建议 0.35，不同模型分布不同，待标注集标定）。 */
export const MIN_SEMANTIC_SIMILARITY = 0.35;
/** 融合后 relevance 阈值（过滤两路都很弱的噪声）。 */
export const MIN_RELEVANCE = 0.1;

/**
 * 不注入普通 RAG 的来源：内心独白不是「对话事实」；persona_journal/t3_summary
 * 属于她的长期记忆，保留（t3_summary 只在与当前消息相关时才会被检索到）。
 */
const RAG_EXCLUDED_SOURCES = ["internal_monologue"];

interface EpisodeMeta {
  id: number;
  content: string;
  source: string;
  emotional_weight: number;
}

interface VectorCandidate {
  id: number;
  similarity: number;
}

interface FtsCandidate {
  id: number;
  bm25: number;
}

/** 同一内容的去重 key：忽略空白与大小写。 */
function normalizeContentKey(content: string): string {
  return content.replace(/\s+/g, "").toLowerCase();
}

/**
 * confidence 语义修正：用 relevance（相似度/排名/双路命中 + 衰减/情感）而不是仅 strength。
 * - high：强相关且记忆未明显衰减
 * - medium：中等相关
 * - low：弱相关（buildRagContext 不注入）
 */
function confidenceFor(relevance: number, strength: number): "high" | "medium" | "low" {
  if (relevance >= 0.6 && strength >= 0.3) return "high";
  if (relevance >= 0.25) return "medium";
  return "low";
}

/**
 * RRF 融合两路召回 → 过滤/去重/排序 → top limit。
 * minVectorSimilarity：向量路的相似度阈值（n-gram / 语义不同，标定值也不同）。
 */
function fuseHybrid(
  vectorCandidates: VectorCandidate[],
  ftsCandidates: FtsCandidate[],
  limit: number,
  minVectorSimilarity: number
): RetrievedMemory[] {
  const vectorFiltered = vectorCandidates.filter((c) => c.similarity >= minVectorSimilarity);
  if (vectorFiltered.length === 0 && ftsCandidates.length === 0) return [];

  // 两路各自排名（1-based）→ RRF 分数
  const vectorRank = new Map<number, number>();
  vectorFiltered.forEach((c, idx) => vectorRank.set(c.id, idx + 1));
  const ftsRank = new Map<number, number>();
  ftsCandidates.forEach((c, idx) => ftsRank.set(c.id, idx + 1));

  const ids = [...new Set([...vectorRank.keys(), ...ftsRank.keys()])];
  if (ids.length === 0) return [];

  // 一次性取元数据（避免 N 次查询）
  const d = getVectorDb();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .prepare(
      `SELECT id, content, source, emotional_weight FROM t2_episodes WHERE id IN (${placeholders})`
    )
    .all(...ids) as EpisodeMeta[];
  const metaById = new Map(rows.map((row) => [row.id, row]));

  const scored: Array<{
    id: number;
    content: string;
    relevance: number;
    strength: number;
  }> = [];

  for (const id of ids) {
    const meta = metaById.get(id);
    if (!meta) continue;
    // SQL 里已排除，这里是双保险
    if (RAG_EXCLUDED_SOURCES.includes(meta.source)) continue;

    const vRank = vectorRank.get(id);
    const fRank = ftsRank.get(id);
    const rrf =
      (vRank !== undefined ? 1 / (RRF_K + vRank) : 0) +
      (fRank !== undefined ? 1 / (RRF_K + fRank) : 0);

    const decayedStrength = applyDecay(id);
    if (decayedStrength < 0.05) continue;

    // 原公式：相似度 × 衰减强度 × (1 + |情感权重|)；RRF 分数先放大回 ~1 量级
    const relevance = Math.min(
      1,
      rrf * (RRF_K + 1) * decayedStrength * (1 + Math.abs(meta.emotional_weight))
    );
    if (relevance < MIN_RELEVANCE) continue;

    scored.push({ id, content: meta.content, relevance, strength: decayedStrength });
  }

  // 内容去重：同一句话被重复写入时只保留 relevance 最高的
  const byContent = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    const key = normalizeContentKey(item.content);
    const prev = byContent.get(key);
    if (!prev || item.relevance > prev.relevance) byContent.set(key, item);
  }

  return [...byContent.values()]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      confidence: confidenceFor(item.relevance, item.strength),
    }));
}

/**
 * 同步检索（orchestrator 主路径的降级/无 Key 路径）：
 * n-gram 向量 + FTS5 BM25 → RRF。签名保持不变。
 */
export function retrieveRelevantMemories(
  userMessage: string,
  limit: number = 5,
  opts?: { personaId?: string }
): RetrievedMemory[] {
  const fetchK = Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);
  const queryEmbedding = generateEmbedding(userMessage);
  // 显式 personaId 供 Web 控制台等“非当前会话”场景只读检索；默认仍用当前人设
  const personaOpts = {
    excludeSources: RAG_EXCLUDED_SOURCES,
    ...(opts?.personaId ? { personaId: opts.personaId } : {}),
  };

  // 向量路：legacy n-gram 空间（只与 ngram-v1 向量比较）
  const vectorCandidates = searchSimilarEpisodes(queryEmbedding, fetchK, personaOpts);
  // 关键词路：FTS5 BM25（中文 2 字词可命中）
  const ftsCandidates = searchEpisodesByFts(userMessage, fetchK, personaOpts);

  return fuseHybrid(vectorCandidates, ftsCandidates, limit, MIN_NGRAM_SIMILARITY);
}

/**
 * 懒加载回填：本进程第一次成功走语义检索时，后台补历史数据缺失的语义向量。
 * 不阻塞本轮检索；`upgradeEmbeddings` 幂等，失败下次启动/调用可继续。
 */
let lazyBackfillTriggered = false;

function maybeTriggerLazySemanticBackfill(): void {
  if (lazyBackfillTriggered) return;
  lazyBackfillTriggered = true;
  void upgradeEmbeddings().catch((err) => {
    console.log(
      `[Embedding] 懒加载回填异常（不影响检索）: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

/**
 * 异步混合检索（有 Qwen Key 时的语义主路径）：
 * Qwen 语义向量 + FTS5 BM25 → RRF；无 Key / 失败自动降级 n-gram。
 *
 * 首次成功语义检索会懒加载触发历史数据语义回填（后台、不阻塞、幂等）。
 * ⚠️ 真实语义检索需要 Qwen Key 才能验证；本机/CI 默认无 Key，
 * 语义分支通过 mock embedding API 的测试覆盖。
 */
export async function retrieveRelevantMemoriesAsync(
  userMessage: string,
  limit: number = 5
): Promise<RetrievedMemory[]> {
  const fetchK = Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);

  const embeddingResult = await embedText(userMessage);
  const isSemantic = embeddingResult.model !== NGRAM_EMBEDDING_MODEL;
  if (isSemantic) {
    // 历史数据（M1-7 之前写入）没有语义向量：本进程只触发一次后台回填
    maybeTriggerLazySemanticBackfill();
  }

  // 向量路：有语义向量就只用语义空间；降级时用 n-gram 空间（绝不跨空间比较）
  const vectorCandidates = isSemantic
    ? searchSemanticEpisodes(embeddingResult.vector, fetchK, embeddingResult.model, {
        excludeSources: RAG_EXCLUDED_SOURCES,
      })
    : searchSimilarEpisodes(embeddingResult.vector, fetchK, {
        excludeSources: RAG_EXCLUDED_SOURCES,
      });

  const ftsCandidates = searchEpisodesByFts(userMessage, fetchK, {
    excludeSources: RAG_EXCLUDED_SOURCES,
  });

  return fuseHybrid(
    vectorCandidates,
    ftsCandidates,
    limit,
    isSemantic ? MIN_SEMANTIC_SIMILARITY : MIN_NGRAM_SIMILARITY
  );
}

/** 构造 T2 摘要行（保持 M0 格式，便于兼容已有数据与 journal 展示）。 */
function buildEpisodeSummary(userMsg: string, reply: string): string {
  return `[对话] 用户: ${userMsg.slice(0, 100)} | 回复: ${reply.slice(0, 100)}`;
}

/**
 * 将一段对话存入 T2（同步写 legacy n-gram + FTS；有 Qwen Key 时排入后台语义升级队列）。
 * 签名保持 M0 兼容。
 */
export function storeConversationEpisode(
  userMsg: string,
  reply: string,
  emotionalWeight: number = 0
): number {
  const summary = buildEpisodeSummary(userMsg, reply);
  const embedding = generateEmbedding(summary);
  const id = insertEpisodeWithEmbedding(summary, "chat", embedding, emotionalWeight);
  // 后台语义升级：无 Qwen Key 时 no-op；不阻塞主流程；失败留给 upgradeEmbeddings 幂等重试
  queueSemanticUpgrade(id, summary);
  return id;
}

/**
 * 异步写入：有 Qwen Key 时一次性写入 legacy n-gram + 语义向量（同一事务），
 * 供入口改为 await 后使用；无 Key / API 失败时行为等同同步版本。
 */
export async function storeConversationEpisodeAsync(
  userMsg: string,
  reply: string,
  emotionalWeight: number = 0
): Promise<number> {
  const summary = buildEpisodeSummary(userMsg, reply);
  const legacyEmbedding = generateEmbedding(summary);
  const embeddingResult = await embedText(summary);

  if (embeddingResult.model === NGRAM_EMBEDDING_MODEL) {
    return insertEpisodeWithEmbedding(summary, "chat", legacyEmbedding, emotionalWeight);
  }
  return insertEpisodeWithSemanticEmbedding(
    summary,
    "chat",
    legacyEmbedding,
    embeddingResult.vector,
    embeddingResult.model,
    emotionalWeight
  );
}

/**
 * 构建 RAG 增强的 System Prompt 追加内容。
 */
export function buildRagContext(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return "";

  const highConfidence = memories.filter((m) => m.confidence === "high");
  const mediumConfidence = memories.filter((m) => m.confidence === "medium");

  let context = "";

  if (highConfidence.length > 0) {
    // 随机化措辞，避免机械感
    const phrases = ["你突然想起来", "你记得", "你想起来", "你脑子里冒出来"];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    context += `\n${phrase}：\n`;
    for (const m of highConfidence) {
      context += `- ${m.content}\n`;
    }
  }

  if (mediumConfidence.length > 0) {
    const phrases = ["你好像记得", "你隐约记得", "你模模糊糊有点印象", "你是不是记得"];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    context += `\n${phrase}：\n`;
    for (const m of mediumConfidence) {
      context += `- ${m.content}\n`;
    }
  }

  return context;
}
