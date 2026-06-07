/**
 * RAG 检索器。
 * Phase 2: 关键词匹配 + 衰减加权。
 * Phase 3+: 接入嵌入模型做语义检索。
 */
import { searchSimilarEpisodes, insertEpisodeWithEmbedding, applyDecay, getVectorDb } from "./vector.js";
import { generateEmbedding } from "./embedding.js";

export interface RetrievedMemory {
  id: number;
  content: string;
  relevance: number; // 0-1 综合相关性分数
  strength: number;
  confidence: "high" | "medium" | "low";
}

/**
 * 检索与当前消息语义相关的 T2 记忆。
 * 使用字符 n-gram 嵌入 + 余弦相似度替换旧版关键词 LIKE。
 * 综合分数 = 余弦相似度 × 衰减后强度 × (1 + 情感权重绝对值)
 */
export function retrieveRelevantMemories(
  userMessage: string,
  limit: number = 5
): RetrievedMemory[] {
  const embedding = generateEmbedding(userMessage);
  const candidates = searchSimilarEpisodes(embedding, limit * 3);

  if (candidates.length === 0) return [];

  const d = getVectorDb();
  const results: RetrievedMemory[] = [];

  for (const { id, similarity } of candidates) {
    const decayedStrength = applyDecay(id);
    if (decayedStrength < 0.05) continue;

    const episode = d.prepare(
      "SELECT content, emotional_weight FROM t2_episodes WHERE id = ?"
    ).get(id) as { content: string; emotional_weight: number } | undefined;

    if (!episode) continue;

    // 余弦相似度 [-1,1] → 截断负值为 0
    const simScore = Math.max(0, similarity);
    const relevance = simScore * decayedStrength * (1 + Math.abs(episode.emotional_weight));

    const confidence: "high" | "medium" | "low" =
      decayedStrength > 0.7 ? "high" :
      decayedStrength > 0.3 ? "medium" : "low";

    results.push({ id, content: episode.content, relevance, strength: decayedStrength, confidence });
  }

  return results
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

/**
 * 将一段对话存入 T2。
 * Phase 2: 在每次 AI 回复后调用。
 * Phase 4+: 由记忆代谢模块控制粒度。
 */
export function storeConversationEpisode(
  userMsg: string,
  reply: string,
  emotionalWeight: number = 0
): number {
  const summary = `[对话] 用户: ${userMsg.slice(0, 100)} | 回复: ${reply.slice(0, 100)}`;
  const embedding = generateEmbedding(summary);
  return insertEpisodeWithEmbedding(summary, "chat", embedding, emotionalWeight);
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
