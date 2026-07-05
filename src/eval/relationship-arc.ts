/**
 * 关系弧线追踪（域十 维度二）。
 * 追踪亲密度随时间的变化轨迹，检测弧线模式，产出可量化指标。
 *
 * 设计原则：
 * - 不依赖 LLM 判断（零成本、确定性）
 * - 基于 T1 快照时间序列做数值分析
 * - 输出人类可读的弧线叙事
 */
import { getRecentSnapshots, type T1Snapshot } from "../data/vector.js";

// ── 弧线模式 ──────────────────────────────────

export type ArcPattern =
  | "warming"        // 持续升温（斜率 > 0.02/天，持续 7+ 天）
  | "cooling"        // 持续降温（斜率 < -0.02/天，持续 7+ 天）
  | "stable"         // 平稳（波动 < 0.3，持续 7+ 天）
  | "volatile"       // 波动大（标准差 > 0.5，短期剧烈变化）
  | "rebound"        // 先降后升（V 形反弹）
  | "estrangement"   // 先升后降后持续走低
  | "undefined";     // 数据不足

export interface ArcMetrics {
  /** 当前亲密度 */
  currentCloseness: number;
  /** 起始亲密度（最早快照） */
  startingCloseness: number;
  /** 净变化 */
  delta: number;
  /** 变化率（每天） */
  slopePerDay: number;
  /** 波动性（标准差） */
  volatility: number;
  /** 最高点 */
  peak: number;
  /** 最低点 */
  trough: number;
  /** 拐点数量（方向变化次数） */
  inflectionCount: number;
  /** 当前弧线模式 */
  pattern: ArcPattern;
  /** 模式置信度 0-1 */
  patternConfidence: number;
  /** 数据点数量 */
  dataPoints: number;
  /** 时间跨度（天） */
  spanDays: number;
}

export interface ArcNarrative {
  /** 一句话概括 */
  summary: string;
  /** 弧线阶段 */
  stage: "approaching" | "bonding" | "settled" | "drifting" | "distancing" | "reconnecting" | "initial";
  /** 趋势方向 */
  direction: "up" | "down" | "flat" | "volatile";
  /** 建议关注 */
  attentionFlag: boolean;
  /** 注意力由头 */
  attentionReason?: string;
}

// ── 计算弧线指标 ──────────────────────────────

export function computeArcMetrics(snapshots?: T1Snapshot[]): ArcMetrics {
  const snaps = snapshots ?? getRecentSnapshots(100);
  const sorted = [...snaps].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
  );

  if (sorted.length < 3) {
    return {
      currentCloseness: sorted[sorted.length - 1]?.closeness ?? 0,
      startingCloseness: sorted[0]?.closeness ?? 0,
      delta: 0, slopePerDay: 0, volatility: 0,
      peak: 0, trough: 0, inflectionCount: 0,
      pattern: "undefined", patternConfidence: 0,
      dataPoints: sorted.length, spanDays: 0,
    };
  }

  const values = sorted.map(s => s.closeness);
  const current = values[values.length - 1];
  const start = values[0];
  const delta = current - start;

  const firstDate = new Date(sorted[0].created_at ?? 0);
  const lastDate = new Date(sorted[sorted.length - 1].created_at ?? 0);
  const spanMs = lastDate.getTime() - firstDate.getTime();
  const spanDays = Math.max(1, spanMs / (1000 * 60 * 60 * 24));

  const slopePerDay = delta / spanDays;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const volatility = Math.sqrt(variance);

  const peak = Math.max(...values);
  const trough = Math.min(...values);

  // 拐点检测：一阶差分的符号变化
  let inflectionCount = 0;
  let prevSign: number | null = null;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (Math.abs(diff) < 0.05) continue;
    const sign = Math.sign(diff);
    if (prevSign !== null && sign !== 0 && sign !== prevSign) {
      inflectionCount++;
    }
    if (sign !== 0) prevSign = sign;
  }

  const { pattern, confidence } = classifyPattern(
    slopePerDay, volatility, values, spanDays
  );

  return {
    currentCloseness: current,
    startingCloseness: start,
    delta: Math.round(delta * 100) / 100,
    slopePerDay: Math.round(slopePerDay * 10000) / 10000,
    volatility: Math.round(volatility * 100) / 100,
    peak, trough, inflectionCount,
    pattern, patternConfidence: confidence,
    dataPoints: sorted.length,
    spanDays: Math.round(spanDays * 10) / 10,
  };
}

function classifyPattern(
  slope: number,
  volatility: number,
  values: number[],
  spanDays: number,
): { pattern: ArcPattern; confidence: number } {
  if (values.length < 3 || spanDays < 1) {
    return { pattern: "undefined", confidence: 0 };
  }

  // 波动性优先判断
  if (volatility > 0.5 && spanDays >= 3) {
    // 检查是否为 V 形反弹
    const mid = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, mid);
    const secondHalf = values.slice(mid);
    const firstSlope = (firstHalf[firstHalf.length - 1] - firstHalf[0]) / Math.max(1, firstHalf.length);
    const secondSlope = (secondHalf[secondHalf.length - 1] - secondHalf[0]) / Math.max(1, secondHalf.length);

    if (firstSlope < -0.03 && secondSlope > 0.03) {
      return { pattern: "rebound", confidence: 0.7 };
    }
    if (firstSlope > 0.03 && secondSlope < -0.03) {
      return { pattern: "estrangement", confidence: 0.7 };
    }
    return { pattern: "volatile", confidence: 0.6 };
  }

  // 趋势判断
  if (slope > 0.03 && spanDays >= 7) {
    return { pattern: "warming", confidence: Math.min(0.9, 0.5 + spanDays / 30) };
  }
  if (slope > 0.01 && spanDays >= 3) {
    return { pattern: "warming", confidence: 0.5 };
  }

  if (slope < -0.03 && spanDays >= 7) {
    return { pattern: "cooling", confidence: Math.min(0.9, 0.5 + spanDays / 30) };
  }
  if (slope < -0.01 && spanDays >= 3) {
    return { pattern: "cooling", confidence: 0.5 };
  }

  if (Math.abs(slope) <= 0.01 && volatility <= 0.3) {
    return { pattern: "stable", confidence: Math.min(0.9, 0.5 + spanDays / 14) };
  }

  return { pattern: "stable", confidence: 0.3 };
}

// ── 弧线叙事 ──────────────────────────────────

export function generateArcNarrative(metrics: ArcMetrics, attachmentStyle?: string): ArcNarrative {
  const { currentCloseness, delta, slopePerDay, volatility, pattern, spanDays, dataPoints } = metrics;

  if (dataPoints < 3) {
    return {
      summary: "关系才刚刚开始，还没有足够的数据来看出轨迹。",
      stage: "initial",
      direction: "flat",
      attentionFlag: false,
    };
  }

  let stage: ArcNarrative["stage"];
  let direction: ArcNarrative["direction"];
  let attentionFlag = false;
  let attentionReason: string | undefined;

  // 阶段判定
  if (currentCloseness < 2) {
    stage = "distancing";
    attentionFlag = true;
  } else if (currentCloseness < 4 && slopePerDay < 0) {
    stage = "drifting";
  } else if (currentCloseness < 4) {
    stage = "approaching";
  } else if (currentCloseness < 7 && slopePerDay > 0.02) {
    stage = "bonding";
  } else if (currentCloseness >= 7) {
    stage = "settled";
  } else {
    stage = "settled";
  }

  // 方向
  if (Math.abs(slopePerDay) < 0.005) {
    direction = "flat";
  } else if (slopePerDay > 0) {
    direction = "up";
  } else if (volatility > 0.5) {
    direction = "volatile";
  } else {
    direction = "down";
  }

  // 注意力标记
  if (pattern === "cooling" && spanDays >= 7) {
    attentionFlag = true;
    attentionReason = `亲密度在过去 ${Math.round(spanDays)} 天内持续下降 (${(delta < 0 ? "" : "+")}${delta.toFixed(1)})`;
  }
  if (pattern === "estrangement") {
    attentionFlag = true;
    attentionReason = "关系出现先升后降的疏远模式";
  }
  if (volatility > 0.6 && currentCloseness >= 4) {
    attentionFlag = true;
    attentionReason = `亲密度波动较大 (σ=${volatility.toFixed(2)})，关系不够稳定`;
  }
  if (pattern === "rebound" && attachmentStyle === "anxious") {
    attentionFlag = true;
    attentionReason = "V 形反弹对焦虑型依恋可能是关系焦虑的信号";
  }

  // 叙事文本
  const directionWord =
    direction === "up" ? "上升" :
    direction === "down" ? "下降" :
    direction === "volatile" ? "波动" : "平稳";

  const patternWord: Record<ArcPattern, string> = {
    warming: "持续升温",
    cooling: "逐渐降温",
    stable: "平稳发展",
    volatile: "起伏不定",
    rebound: "触底反弹",
    estrangement: "渐行渐远",
    undefined: "数据不足",
  };

  const summary = [
    `亲密度从 ${metrics.startingCloseness} → ${currentCloseness}`,
    `(${directionWord}，${patternWord[pattern]})`,
    `，${Math.round(spanDays)} 天内净变化 ${(delta >= 0 ? "+" : "")}${delta.toFixed(1)}`,
  ].join("");

  return { summary, stage, direction, attentionFlag, attentionReason };
}

// ── 趋势预测（简单线性外推）───────────────────

export interface TrendForecast {
  /** 预测 7 天后的亲密度 */
  in7Days: number;
  /** 预测 30 天后的亲密度 */
  in30Days: number;
  /** 按当前速率到达 closeness=8 需要的天数（-1 表示无法到达） */
  daysToClose: number;
  /** 按当前速率降到 closeness=3 需要的天数（-1 表示不会降到） */
  daysToDrift: number;
}

export function forecastTrend(metrics: ArcMetrics): TrendForecast {
  const { currentCloseness, slopePerDay } = metrics;

  const clamp = (v: number) => Math.max(0, Math.min(10, Math.round(v * 10) / 10));

  const daysToClose = slopePerDay > 0.001
    ? Math.round((8 - currentCloseness) / slopePerDay)
    : -1;

  const daysToDrift = slopePerDay < -0.001
    ? Math.round((3 - currentCloseness) / slopePerDay)
    : -1;

  return {
    in7Days: clamp(currentCloseness + slopePerDay * 7),
    in30Days: clamp(currentCloseness + slopePerDay * 30),
    daysToClose,
    daysToDrift,
  };
}
