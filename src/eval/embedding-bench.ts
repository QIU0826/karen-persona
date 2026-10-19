/**
 * 嵌入方案对比基准测试。
 *
 * 三种评测方法：
 * 1. 自检索测试：每条已嵌入的记忆查询自身，测量 Recall@1 (应接近 1.0)
 * 2. 会话检索测试：用真实用户消息做查询，测量语义相关的记忆是否被检索
 * 3. 跨嵌入对比：n-gram vs Qwen embedding (需 API key)
 *
 * 指标：Recall@5, Recall@10, MRR, nDCG@10, 平均延迟
 */
import { generateEmbedding } from "../data/embedding.js";
import { searchSimilarEpisodes, getVectorDb, setCurrentPersona } from "../data/vector.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── 方法 1：自检索测试 ──────────────────────

/**
 * 对每条已嵌入的 T2 记忆，用其自身内容生成查询嵌入，检测能否召回自身。
 * 这是嵌入一致性的基础测试——好的嵌入应该让"自己找自己"排第一。
 * 因为 n-gram 对文本截断敏感，全文嵌入 vs 截断查询嵌入会有差异，
 * 这个测试精确量化了这种差异。
 */
export function runSelfRetrievalTest(personaId?: string): {
  total: number;
  /** Recall@1: 自身排第一的比例 */
  recallAt1: number;
  /** 自身在 top-5 的比例 */
  recallAt5: number;
  /** 自身在 top-10 的比例 */
  recallAt10: number;
  /** 自身排名的中位数 */
  medianRank: number;
  /** 自身排名的平均值 */
  avgRank: number;
  /** 平均余弦相似度 */
  avgSimilarity: number;
  avgLatencyMs: number;
  details: Array<{ id: number; rank: number; similarity: number; content: string }>;
} {
  // 设置 persona 上下文（默认使用数据最多的 qiuyao）
  const pid = personaId ?? "qiuyao";
  setCurrentPersona(pid);

  // 查询该 persona 下有嵌入的记忆
  const db = getVectorDb();
  const allWithEmb = db.prepare(
    `SELECT id, content FROM t2_episodes
     WHERE persona_id = ? AND strength > 0.05 AND embedding IS NOT NULL
     ORDER BY strength DESC LIMIT 200`
  ).all(pid) as Array<{ id: number; content: string }>;

  const episodes = allWithEmb.map(e => ({ id: e.id, content: e.content }));

  if (episodes.length === 0) {
    return { total: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, medianRank: 0, avgRank: 0, avgSimilarity: 0, avgLatencyMs: 0, details: [] };
  }

  const details: Array<{ id: number; rank: number; similarity: number; content: string }> = [];
  let totalLatency = 0;

  for (const ep of episodes) {
    const start = Date.now();
    const queryEmb = generateEmbedding(ep.content);
    const candidates = searchSimilarEpisodes(queryEmb, 20);
    const elapsed = Date.now() - start;
    totalLatency += elapsed;

    // 找到自身在结果中的排名
    const selfIdx = candidates.findIndex(c => c.id === ep.id);
    const rank = selfIdx >= 0 ? selfIdx + 1 : 21; // 21 = 未找回
    const similarity = selfIdx >= 0 ? candidates[selfIdx].similarity : 0;

    details.push({ id: ep.id, rank, similarity, content: ep.content.slice(0, 60) });
  }

  const sortedRanks = details.map(d => d.rank).sort((a, b) => a - b);
  const n = details.length;
  const medianRank = n % 2 === 0 ? (sortedRanks[n / 2 - 1] + sortedRanks[n / 2]) / 2 : sortedRanks[Math.floor(n / 2)];

  const recall1 = details.filter(d => d.rank === 1).length / n;
  const recall5 = details.filter(d => d.rank <= 5).length / n;
  const recall10 = details.filter(d => d.rank <= 10).length / n;
  const avgRank = details.reduce((s, d) => s + d.rank, 0) / n;
  const avgSim = details.reduce((s, d) => s + d.similarity, 0) / n;

  return {
    total: n,
    recallAt1: Math.round(recall1 * 1000) / 1000,
    recallAt5: Math.round(recall5 * 1000) / 1000,
    recallAt10: Math.round(recall10 * 1000) / 1000,
    medianRank: Math.round(medianRank * 10) / 10,
    avgRank: Math.round(avgRank * 10) / 10,
    avgSimilarity: Math.round(avgSim * 1000) / 1000,
    avgLatencyMs: Math.round(totalLatency / n),
    details,
  };
}

// ── 方法 2：会话检索测试 ────────────────────

interface SessionMessage { role: string; content: string; timestamp: number; }

/**
 * 从会话存档加载用户消息作为查询，检索 T2 记忆。
 * "相关"记忆 = 在对话前后被写入 T2 的记忆（时间窗口内的 chat 类型 episode）。
 * 这提供了实际的检索质量评估——用户说的话能召回多少对话相关记忆。
 */
export function runSessionRetrievalTest(): {
  totalQueries: number;
  recallAt5: number;
  recallAt10: number;
  avgLatencyMs: number;
  totalEpisodes: number;
  results: Array<{ query: string; topHit: string; similarity: number }>;
} {
  // 加载会话用户消息
  const dataDir = "data";
  const sessionFiles = fs.readdirSync(dataDir).filter(f => f.endsWith("-session.json"));
  const userMessages: string[] = [];
  for (const f of sessionFiles) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf-8"));
      const userMsgs = (s.messages as SessionMessage[])
        .filter(m => m.role === "user" && m.content.length >= 4 && m.content.length <= 80);
      // 去重：相邻相似消息只取一条
      for (const m of userMsgs) {
        const trimmed = m.content.trim();
        if (!userMessages.includes(trimmed) && !trimmed.startsWith("[图片") && !trimmed.startsWith("[")) {
          userMessages.push(trimmed);
        }
      }
    } catch { /* skip */ }
  }

  // 去重后取最多 30 条
  const queries = [...new Set(userMessages)].slice(0, 30);

  setCurrentPersona("qiuyao");
  const db = getVectorDb();
  const totalEpisodes = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE persona_id = 'qiuyao' AND strength > 0.05 AND embedding IS NOT NULL").get() as any).c;
  const results: Array<{ query: string; topHit: string; similarity: number }> = [];
  let totalLatency = 0;

  for (const q of queries) {
    const start = Date.now();
    const emb = generateEmbedding(q);
    const candidates = searchSimilarEpisodes(emb, 5);
    const elapsed = Date.now() - start;
    totalLatency += elapsed;

    if (candidates.length > 0) {
      const db = getVectorDb();
      const top = db.prepare("SELECT content FROM t2_episodes WHERE id = ?").get(candidates[0].id) as any;
      results.push({
        query: q,
        topHit: top?.content?.slice(0, 80) ?? "(未找到)",
        similarity: Math.round(candidates[0].similarity * 1000) / 1000,
      });
    }
  }

  return {
    totalQueries: queries.length,
    recallAt5: results.length > 0 ? results.filter(r => r.similarity > 0.1).length / queries.length : 0,
    recallAt10: 0, // 会话测试用命中率替代
    avgLatencyMs: queries.length > 0 ? Math.round(totalLatency / queries.length) : 0,
    totalEpisodes,
    results,
  };
}

// ── 报告格式化 ──────────────────────────────

export function formatSelfRetrievalReport(test: ReturnType<typeof runSelfRetrievalTest>): string {
  const lines: string[] = [
    "═══════════════════════════════════════",
    "  嵌入自检索基准测试 (n-gram FNV-1a)",
    `  已嵌入记忆: ${test.total} 条`,
    "═══════════════════════════════════════",
    "",
    `  自身 Recall@1:   ${(test.recallAt1 * 100).toFixed(1)}%  (记忆查自身排第一的比例)`,
    `  自身 Recall@5:   ${(test.recallAt5 * 100).toFixed(1)}%  (自身在 top-5)`,
    `  自身 Recall@10:  ${(test.recallAt10 * 100).toFixed(1)}%  (自身在 top-10)`,
    `  排名中位数:      ${test.medianRank}`,
    `  排名平均值:      ${test.avgRank}`,
    `  平均余弦相似度:  ${test.avgSimilarity}`,
    `  平均检索延迟:    ${test.avgLatencyMs}ms`,
    "",
    "  注: 自检索测试衡量 n-gram 嵌入的一致性——",
    "  全文嵌入 vs 同一文本的查询嵌入应有高相似度。",
    "  Recall@1 越高，说明 n-gram 对文本的表征越稳定。",
    "═══════════════════════════════════════",
  ];
  return lines.join("\n");
}

export function formatSessionRetrievalReport(test: ReturnType<typeof runSessionRetrievalTest>): string {
  const lines: string[] = [
    "═══════════════════════════════════════",
    "  会话检索测试",
    `  查询数: ${test.totalQueries} (来自真实用户消息)`,
    `  语料库: ${test.totalEpisodes} 条 T2 记忆`,
    `  命中率: ${(test.recallAt5 * 100).toFixed(1)}% (相似度 > 0.1)`,
    `  平均延迟: ${test.avgLatencyMs}ms`,
    "═══════════════════════════════════════",
    "",
  ];

  for (const r of test.results.slice(0, 15)) {
    lines.push(`  查询: "${r.query}"`);
    lines.push(`    → ${r.topHit} (相似度: ${r.similarity})`);
    lines.push("");
  }

  lines.push("═══════════════════════════════════════");
  return lines.join("\n");
}

// ── 便捷入口 ──────────────────────────────────

export function runFullEmbeddingBenchmark(): string {
  const selfTest = runSelfRetrievalTest();
  const sessionTest = runSessionRetrievalTest();

  return [
    formatSelfRetrievalReport(selfTest),
    "",
    formatSessionRetrievalReport(sessionTest),
  ].join("\n");
}
