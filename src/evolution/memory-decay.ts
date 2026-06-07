/**
 * 记忆代谢（域五）— P2-a 实现。
 *
 * 四个操作：
 * 1. 遗忘曲线（情感强度加权 — 高情感记忆衰减慢）
 * 2. 情绪着色（按当前情绪重新解读过去的记忆）
 * 3. 记忆压缩（三天前的多条快照合并为摘要）
 * 4. 重现触发（低强度记忆 × 话题匹配 → "突然想起来"）
 *
 * 扩展点（预留，当前不激活）：
 * - decayModifier：动机驱动遗忘因子（回避型可能压抑负债相关记忆）
 * - distortionProbability：记忆变形概率（P2-d embedding 就绪后启用）
 */

import { getRecentSnapshots, getVectorDb, type T1Snapshot } from "../data/vector.js";

// ── 接口 ─────────────────────────────────────────

export interface MetabolizedMemory {
  content: string;
  emotionalWeight: number;    // -1 到 1，情绪着色后
  strength: number;           // 0-1，衰减后
  isRediscovery: boolean;     // 是否为重现触发
  decayModifier: number;      // 预留：动机驱动遗忘因子（当前 1.0）
  distortionProbability: number; // 预留：记忆变形概率（当前 0）
}

export interface MetabolismResult {
  fragments: MetabolizedMemory[];
  logs: string[];
}

// ── 遗忘曲线 ────────────────────────────────────

/**
 * 计算衰减：情感强度高的记忆衰减更慢。
 * 公式：decayed = strength × e^(-days / (halfLife × emotionBonus))
 * emotionBonus = 1 + |emotionalWeight| × 2（高情感 bonus 最高 3x）
 */
function applyForgetting(
  strength: number,
  daysSinceRecall: number,
  halfLifeDays: number,
  emotionalWeight: number,
  decayModifier: number = 1.0,
): number {
  const emotionBonus = 1 + Math.abs(emotionalWeight) * 2; // 1~3
  const adjustedHalfLife = halfLifeDays * emotionBonus / decayModifier;
  return strength * Math.exp(-daysSinceRecall / adjustedHalfLife);
}

// ── 情绪着色 ─────────────────────────────────────

/**
 * 按当前情绪重新给记忆打情感标签。
 * 当前情绪正面 → 过去记忆被"暖化"；当前情绪负面 → 过去记忆被"灰化"。
 * 偏移量 = currentEmotion × 0.3（最多偏移 0.3）
 */
function colorByMood(
  snapshots: T1Snapshot[],
  currentEmotion: number,
): Array<{ snapshot: T1Snapshot; coloredWeight: number }> {
  const moodShift = Math.max(-0.3, Math.min(0.3, currentEmotion * 0.3));
  return snapshots.map(s => ({
    snapshot: s,
    coloredWeight: Math.max(-1, Math.min(1, (s.emotionVector || 0) + moodShift)),
  }));
}

// ── 记忆压缩 ─────────────────────────────────────

/**
 * 将三天前的 T1 快照合并为摘要。
 * 每 N 条连续快照合并为一条粗粒度记忆。
 */
function compressSnapshots(
  snapshots: T1Snapshot[],
  nowMs: number,
): Array<{ content: string; emotionalWeight: number; count: number }> {
  const threeDaysAgo = nowMs - 3 * 24 * 3600 * 1000;
  const old = snapshots.filter(s => {
    if (!s.created_at) return false; // 无时间戳的快照跳过压缩
    const ts = new Date(s.created_at).getTime();
    return ts < threeDaysAgo;
  });

  if (old.length < 3) return [];

  // 简单合并：每 5 条压缩为一条
  const compressed: Array<{ content: string; emotionalWeight: number; count: number }> = [];
  for (let i = 0; i < old.length; i += 5) {
    const batch = old.slice(i, i + 5);
    const avgEmotion = batch.reduce((sum, s) => sum + (s.emotionVector || 0), 0) / batch.length;
    const summaries = batch.map(s => s.summary).filter(Boolean).join("；");
    compressed.push({
      content: `那几天和他聊得挺多的。模糊记得：${summaries || "说了一些琐事"}`,
      emotionalWeight: Math.round(avgEmotion * 100) / 100,
      count: batch.length,
    });
  }

  return compressed;
}

// ── 重现触发 ─────────────────────────────────────

/**
 * 低强度记忆 × 随机概率 → "突然想起来"。
 * strength 在 0.1-0.4 之间的记忆有概率被重新激活。
 * 匹配话题关键词时概率翻倍。
 */
function triggerRediscovery(
  fragments: MetabolizedMemory[],
  topicKeywords: string[],
): MetabolizedMemory | null {
  const candidates = fragments.filter(
    f => f.strength > 0.1 && f.strength < 0.4 && !f.isRediscovery,
  );

  if (candidates.length === 0) return null;

  // 话题匹配加分
  for (const c of candidates) {
    const matchedKeyword = topicKeywords.some(kw =>
      c.content.includes(kw),
    );
    const baseProb = 0.05;
    const matchProb = matchedKeyword ? baseProb * 2 : baseProb;
    if (Math.random() < matchProb) {
      return {
        ...c,
        isRediscovery: true,
        strength: 0.6, // 重现后强度回升
        content: `突然想起来……${c.content}`,
      };
    }
  }

  return null;
}

// ── 主入口 ───────────────────────────────────────

export interface MetabolismOptions {
  currentEmotion: number;        // -1 到 1
  topicKeywords: string[];       // 当前话题关键词
  nowMs?: number;
}

/**
 * 执行一轮记忆代谢。
 * 在 initConversation 时调用（每天一次或每次启动对话时）。
 */
export function metabolizeMemories(opts: MetabolismOptions): MetabolismResult {
  const logs: string[] = [];
  const now = opts.nowMs ?? Date.now();
  const db = getVectorDb();

  // 1. 遗忘：对 T2 批量应用衰减（带情感加权）
  const allT2 = db.prepare(
    `SELECT id, content, strength, half_life_days, emotional_weight, last_recalled_at
     FROM t2_episodes WHERE strength > 0.01`
  ).all() as Array<{
    id: number; content: string; strength: number;
    half_life_days: number; emotional_weight: number; last_recalled_at: string;
  }>;

  let decayedCount = 0;
  for (const row of allT2) {
    const daysSince = (now - new Date(row.last_recalled_at).getTime()) / (1000 * 3600 * 24);
    const newStrength = applyForgetting(
      row.strength, daysSince, row.half_life_days, row.emotional_weight,
    );
    if (Math.abs(newStrength - row.strength) > 0.001) {
      db.prepare(`UPDATE t2_episodes SET strength = ?, last_recalled_at = datetime('now') WHERE id = ?`)
        .run(Math.max(0, Math.min(1, newStrength)), row.id);
      decayedCount++;
    }
  }
  if (decayedCount > 0) logs.push(`[代谢] 遗忘衰减: ${decayedCount} 条`);

  // 2. 情绪着色：读取 T1 快照
  const snapshots = getRecentSnapshots(30);
  const colored = colorByMood(snapshots, opts.currentEmotion);
  const moodShifted = colored.filter(c => Math.abs(c.coloredWeight - (c.snapshot.emotionVector || 0)) > 0.05);
  if (moodShifted.length > 0) logs.push(`[代谢] 情绪着色: ${moodShifted.length} 条`);

  // 3. 压缩
  const compressed = compressSnapshots(snapshots, now);
  if (compressed.length > 0) {
    for (const c of compressed) {
      db.prepare(
        `INSERT INTO t2_episodes (content, source, strength, emotional_weight, half_life_days)
         VALUES (?, 'memory_compression', 0.4, ?, 90.0)`
      ).run(c.content, c.emotionalWeight);
    }
    logs.push(`[代谢] 压缩: ${compressed.length} 条摘要（覆盖 ${compressed.reduce((s, c) => s + c.count, 0)} 条旧快照）`);
  }

  // 4. 重现触发
  const fragments: MetabolizedMemory[] = colored.map(c => ({
    content: c.snapshot.content,
    emotionalWeight: c.coloredWeight,
    strength: 0.5, // 默认中等强度
    isRediscovery: false,
    decayModifier: 1.0,
    distortionProbability: 0,
  }));

  const rediscovered = triggerRediscovery(fragments, opts.topicKeywords);
  if (rediscovered) {
    fragments.push(rediscovered);
    logs.push(`[代谢] 重现触发: ${rediscovered.content.slice(0, 60)}`);
  }

  return { fragments, logs };
}
