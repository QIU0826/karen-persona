/**
 * 动态风格参考（P1-2）
 *
 * 按内心状态标签检索她自己的历史片段（对话 + 独白），
 * 作为"此刻可能会如何表达"的风格参考。
 *
 * 与 static few-shot 的本质区别：
 * - few-shot: "你以后就这么演"（规范性约束，固化行为）
 * - 风格参考: "你曾经在这种心情下这样表达过自己"（记忆触发，用过去影响现在）
 *
 * 注入 prompt 时标注来源和置信度，让 LLM 自行决定是否参考。
 */
import { getVectorDb } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";

// ── 类型 ──────────────────────────────────────

export interface StyleReference {
  /** 片段内容 */
  content: string;
  /** 来源：独白 or 对话 */
  source: "internal_monologue" | "chat";
  /** 情绪匹配度 */
  affinity: "high" | "medium";
  /** 距今天数 */
  daysAgo: number;
}

export interface StyleRefParams {
  /** 当前情绪向量 */
  emotionVector: number;
  /** 当前负债 */
  guilt: number;
  /** 当前内心模式 */
  mode: string;
  /** 当前用户输入（用于语义匹配） */
  userInput: string;
}

// ── 检索 ──────────────────────────────────────

/**
 * 从她的记忆库中检索风格参考。
 * 搜索范围：独白 + 对话，按情绪状态相似度排序。
 * 返回 1-2 条最佳匹配。
 */
export function retrieveStyleReference(params: StyleRefParams): StyleReference[] {
  const d = getVectorDb();

  // 查最近的有嵌入的记忆（含独白和对话），强度 > 0.2
  const rows = d.prepare(
    `SELECT id, content, source, strength, emotional_weight, created_at, embedding
     FROM t2_episodes
     WHERE source IN ('internal_monologue', 'chat')
       AND strength > 0.2
       AND embedding IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 100`
  ).all() as Array<{
    id: number; content: string; source: string; strength: number;
    emotional_weight: number; created_at: string; embedding: string;
  }>;

  if (rows.length === 0) return [];

  // 用当前状态描述做语义检索
  const stateDesc = modeLabel(params.mode, params.emotionVector, params.guilt);
  const queryEmb = Array.from(generateEmbedding(stateDesc));

  // 计算每条记忆的综合匹配分
  const scored = rows.map((row) => {
    const emb = JSON.parse(row.embedding) as number[];
    const semanticSim = cosineSim(queryEmb, emb);           // 语义相似度
    const emotionAffinity = 1 - Math.abs(params.emotionVector - row.emotional_weight) / 2; // 情绪接近度
    const recencyBoost = Math.exp(-daysSince(row.created_at) / 14); // 新近度 14天半衰期

    const score = semanticSim * 0.4 + emotionAffinity * 0.4 + recencyBoost * 0.2;
    return {
      content: row.content,
      source: row.source as "internal_monologue" | "chat",
      emotional_weight: row.emotional_weight,
      affinity: score > 0.5 ? "high" as const : "medium" as const,
      daysAgo: Math.round(daysSince(row.created_at)),
      score,
    };
  });

  // 按得分排序，取前 2 条
  return scored
    .filter((s) => s.affinity === "high")
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ content, source, affinity, daysAgo }) => ({
      content,
      source,
      affinity,
      daysAgo,
    }));
}

// ── Prompt 注入 ───────────────────────────────

/**
 * 将风格参考注入 system prompt。
 * 不指定"你应该这么做"，只提供"你过去是这样表达的"。
 */
export function buildStyleContext(refs: StyleReference[]): string {
  if (refs.length === 0) return "";

  const lines: string[] = [];
  lines.push("\n## 你过去类似状态下的片段（仅供参考，不是剧本）");

  for (const ref of refs) {
    const label = ref.source === "internal_monologue" ? "内心独白" : "对话";
    const timeAgo = ref.daysAgo === 0 ? "今天" : `${ref.daysAgo}天前`;
    lines.push(`- [${label} · ${timeAgo}] ${ref.content}`);
  }

  lines.push("这些是你自己过去的表达，不是必须模仿的模板。你现在可以一样，也可以不同。");
  return lines.join("\n");
}

// ── 工具函数 ──────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, dot);
}

function daysSince(dateStr: string): number {
  return (Date.now() - new Date(dateStr + "Z").getTime()) / (1000 * 60 * 60 * 24);
}

function modeLabel(mode: string, emotion: number, guilt: number): string {
  const emotionWord = emotion > 0.3 ? "开心" : emotion < -0.3 ? "低落" : "平静";
  const guiltWord = guilt > 0.2 ? `负债${guilt.toFixed(1)}` : "";
  return `[${mode} ${emotionWord} ${guiltWord}]`.trim();
}
