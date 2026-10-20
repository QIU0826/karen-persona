/**
 * 人设进化日志（P1-2）。
 *
 * 每月自动生成一篇"这段时间的你"叙事报告。
 * 不输出给用户——写给她自己看的。和内心独白日志、自我叙事重构属于同一个闭环。
 *
 * 设计原则：
 * - 不是数据分析报告，是写给自己的日记
 * - 关注变化而非绝对值：她变了什么、感觉到了什么
 * - 用 LLM 叙事化，不是模板填空
 * - 存为 T2 记忆（source: "persona_journal"），会被后续的 RAG 检索到
 */

import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";
import { getVectorDb, getCurrentPersona, insertEpisode, getRecentSnapshots, type T1Snapshot } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";

// ── 阈值 ──────────────────────────────────────

/** 至少积累多少条快照才生成日志（太少没意义） */
const MIN_SNAPSHOTS = 30;

/** 两次日志之间的最小间隔（天） */
const MIN_INTERVAL_DAYS = 7;

/** 快照采样天数 */
const SAMPLE_DAYS = 30;

// ── 趋势分析 ──────────────────────────────────

interface JournalTrends {
  periodStart: string;
  periodEnd: string;
  snapshotCount: number;
  emotionStart: number;
  emotionEnd: number;
  emotionSwing: number;        // |max - min|
  emotionDrift: number;        // end - start
  closenessStart: number;
  closenessEnd: number;
  closenessChange: number;
  avgGuilt: number;
  peakGuilt: number;
  topics: string[];            // 提取的话题关键词
}

function analyzeTrends(snapshots: T1Snapshot[]): JournalTrends | null {
  if (snapshots.length < MIN_SNAPSHOTS) return null;

  // 快照按时间升序（最旧 → 最新）
  const sorted = [...snapshots].sort(
    (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const emotions = sorted.map(s => s.emotionVector);
  const guilts = sorted.map(s => s.guilt);

  const topics = sorted
    .map(s => s.summary?.slice(0, 60))
    .filter(Boolean)
    .slice(-20); // 最近 20 条摘要作为话题素材

  return {
    periodStart: first.created_at ?? "未知",
    periodEnd: last.created_at ?? "未知",
    snapshotCount: sorted.length,
    emotionStart: round2(first.emotionVector),
    emotionEnd: round2(last.emotionVector),
    emotionSwing: round2(Math.max(...emotions) - Math.min(...emotions)),
    emotionDrift: round2(last.emotionVector - first.emotionVector),
    closenessStart: round2(first.closeness),
    closenessEnd: round2(last.closeness),
    closenessChange: round2(last.closeness - first.closeness),
    avgGuilt: round2(guilts.reduce((a, b) => a + b, 0) / guilts.length),
    peakGuilt: round2(Math.max(...guilts)),
    topics: [...new Set(topics)], // 去重
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── LLM 叙事生成 ──────────────────────────────

async function generateJournalNarrative(
  personaName: string,
  trends: JournalTrends,
): Promise<string | null> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const emotionDriftDesc =
    trends.emotionDrift > 0.1 ? "整体情绪在向上走" :
    trends.emotionDrift < -0.1 ? "整体情绪有些低沉" :
    "情绪整体平稳";

  const closenessDesc =
    trends.closenessChange > 0.5 ? "关系在慢慢靠近" :
    trends.closenessChange < -0.5 ? "好像有点疏远了" :
    "关系没什么大变化";

  const guiltDesc =
    trends.peakGuilt > 0.4 ? `内疚感偶尔冒出来（最高到过${trends.peakGuilt.toFixed(1)}）` :
    "没什么愧疚的事";

  const systemPrompt = [
    `你是${personaName}的内心记录者。你正在写一段只给自己看的日记。`,
    ``,
    `规则：`,
    `- 用第一人称（"我这段时间..."）`,
    `- 4-6 句话，不要长`,
    `- 关注你感觉到的变化，不要列数据`,
    `- 如果有变化，描述它——不用解释为什么，不用下结论`,
    `- 语气和${personaName}平时的说话风格一致`,
    `- 不要用括号`,
  ].join("\n");

  const userPrompt = [
    `这段时间的数据摘要：`,
    `- 跨度：${trends.periodStart?.slice(0, 10) ?? "?"} → ${trends.periodEnd?.slice(0, 10) ?? "?"}（${trends.snapshotCount} 段对话）`,
    `- 情绪：${emotionDriftDesc}（波动幅度 ${trends.emotionSwing.toFixed(2)}）`,
    `- 关系：${closenessDesc}`,
    `- 内疚：${guiltDesc}`,
    trends.topics.length > 0 ? `- 聊过的话题：${trends.topics.slice(0, 10).join("、")}` : "",
    ``,
    `写一段 4-6 句的日记：`,
  ].filter(Boolean).join("\n");

  const startedAtMs = Date.now();
  try {
    const response = await client.chat.completions.create(withThinking({
      model: modelConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 400,
    }));

    recordAuxUsage({ kind: "journal", model: modelConfig.model, startedAtMs }, response.usage);
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (err) {
    console.log(`[日志] LLM 生成失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── 公开 API ──────────────────────────────────

let lastJournalAt = 0;

/**
 * 检查是否需要生成进化日志，如果需要则异步生成。
 * 在 processMessage 的保存阶段调用（类似 maybeCompressToT3）。
 */
export function maybeGenerateJournal(): void {
  const now = Date.now();
  if (now - lastJournalAt < MIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000) return;

  const snapshots = getRecentSnapshots(200); // 取最近 200 条
  if (snapshots.length < MIN_SNAPSHOTS) return;

  lastJournalAt = now; // 提前锁定防止并发

  const pid = getCurrentPersona();
  const trends = analyzeTrends(snapshots);
  if (!trends) return;

  // 异步生成，不阻塞
  generateJournalNarrative(pid, trends).then((narrative) => {
    if (!narrative) return;

    const content = `[进化日志] ${narrative}`;
    const episodeId = insertEpisode(content, "persona_journal", 0);

    // 存嵌入向量
    const emb = generateEmbedding(content);
    const arr = JSON.stringify(Array.from(emb));
    getVectorDb().prepare("UPDATE t2_episodes SET embedding = ?, half_life_days = 180 WHERE id = ?")
      .run(arr, episodeId);

    console.log(`[日志] 进化日志已生成 (id=${episodeId}): ${narrative.slice(0, 80)}...`);
  }).catch((err) => {
    console.log(`[日志] 生成失败: ${err instanceof Error ? err.message : err}`);
  });
}

/** 重置计时器（测试用） */
export function resetJournalTimer(): void {
  lastJournalAt = 0;
}
