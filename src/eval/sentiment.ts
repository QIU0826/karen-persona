/**
 * 情感趋势分析（域十 维度三）。
 * 基于 T1 快照中的情绪向量时间序列做数值分析——不使用关键词匹配。
 *
 * 设计原则：
 * - 纯向量数学（情绪向量已有 -1..1 维度，无需 NLP）
 * - 检测趋势、转折点、情绪漂移
 * - 与人格引擎的情绪状态机共享同一套向量体系
 */
import { getRecentSnapshots, type T1Snapshot } from "../data/vector.js";
import { computeArcMetrics, generateArcNarrative, forecastTrend, type ArcMetrics, type ArcNarrative, type TrendForecast } from "./relationship-arc.js";

// ── 情绪向量维度约定 ──────────────────────────
// 当前系统使用标量 emotion_vector（-1 ~ 1），
// 其中 -1 = 负面，0 = 中性，+1 = 正面。
// 本模块同时兼容多维向量（valence/arousal/dominance）的扩展。

export interface SentimentPoint {
  timestamp: number;
  valence: number;    // -1..1 愉悦度
  arousal: number;    //  0..1 唤醒度（暂从快照推断，无独立维度时用 0.5）
  guilt: number;      //  0..1 愧疚度
  closeness: number;  //  1..10 亲密度
}

export interface SentimentTrend {
  /** 当前情绪值（EMA 平滑后） */
  currentValence: number;
  /** 情绪变化速度（每天） */
  valenceVelocity: number;
  /** 情绪变化加速度 */
  valenceAcceleration: number;
  /** 情绪波动性（标准差） */
  volatility: number;
  /** 正面情绪占比 */
  positiveRatio: number;
  /** 负面情绪占比 */
  negativeRatio: number;
  /** 情绪转折点数量 */
  turningPoints: number;
  /** 趋势标签 */
  trend: "improving" | "declining" | "stable" | "volatile" | "insufficient_data";
  /** 愧疚趋势 */
  guiltTrend: "rising" | "falling" | "stable" | "insufficient_data";
  /** 数据点数 */
  dataPoints: number;
  /** 时间跨度（天） */
  spanDays: number;
}

export interface SentimentNarrative {
  /** 一句话情绪概括 */
  summary: string;
  /** 情绪状态 */
  state: "positive_stable" | "negative_stable" | "mixed" | "shifting_positive" | "shifting_negative" | "insufficient";
  /** 是否需要关注 */
  attentionFlag: boolean;
  /** 关注原因 */
  attentionReason?: string;
}

// ── 从 T1 快照提取情绪时间序列 ─────────────────

export function extractSentimentPoints(snapshots?: T1Snapshot[]): SentimentPoint[] {
  const snaps = snapshots ?? getRecentSnapshots(200);
  return snaps
    .filter(s => s.created_at)
    .map(s => ({
      timestamp: new Date(s.created_at!).getTime(),
      valence: s.emotionVector,
      arousal: 0.5, // 当前快照无独立 arousal 维度，使用中性默认
      guilt: s.guilt,
      closeness: s.closeness,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ── 计算情感趋势指标 ──────────────────────────

export function computeSentimentTrend(points?: SentimentPoint[]): SentimentTrend {
  const pts = points ?? extractSentimentPoints();

  if (pts.length < 3) {
    return {
      currentValence: pts[pts.length - 1]?.valence ?? 0,
      valenceVelocity: 0,
      valenceAcceleration: 0,
      volatility: 0,
      positiveRatio: 0,
      negativeRatio: 0,
      turningPoints: 0,
      trend: "insufficient_data",
      guiltTrend: "insufficient_data",
      dataPoints: pts.length,
      spanDays: 0,
    };
  }

  const valences = pts.map(p => p.valence);
  const guilts = pts.map(p => p.guilt);

  // EMA 平滑后的当前值 (α=0.3)
  const ema = (series: number[], alpha: number): number => {
    let result = series[0];
    for (let i = 1; i < series.length; i++) {
      result = alpha * series[i] + (1 - alpha) * result;
    }
    return result;
  };
  const currentValence = Math.round(ema(valences, 0.3) * 1000) / 1000;

  // 速度：线性回归斜率
  const spanMs = pts[pts.length - 1].timestamp - pts[0].timestamp;
  const spanDays = Math.max(1, spanMs / (1000 * 60 * 60 * 24));

  const n = valences.length;
  const tMean = (n - 1) / 2;
  const vMean = valences.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - tMean) * (valences[i] - vMean);
    den += (i - tMean) ** 2;
  }
  const velocityPerIndex = den > 0 ? num / den : 0;
  const valenceVelocity = Math.round((velocityPerIndex * n) / spanDays * 10000) / 10000;

  // 加速度：速度的二阶差分
  let accel = 0;
  if (n >= 5) {
    const firstHalf = valences.slice(0, Math.floor(n / 2));
    const secondHalf = valences.slice(Math.floor(n / 2));
    const v1 = (firstHalf[firstHalf.length - 1] - firstHalf[0]) / Math.max(1, firstHalf.length);
    const v2 = (secondHalf[secondHalf.length - 1] - secondHalf[0]) / Math.max(1, secondHalf.length);
    accel = (v2 - v1) / Math.max(1, spanDays / 2);
  }
  const valenceAcceleration = Math.round(accel * 10000) / 10000;

  // 波动性
  const variance = valences.reduce((sum, v) => sum + (v - vMean) ** 2, 0) / n;
  const volatility = Math.round(Math.sqrt(variance) * 1000) / 1000;

  // 正/负面占比
  const positiveCount = valences.filter(v => v > 0.1).length;
  const negativeCount = valences.filter(v => v < -0.1).length;
  const positiveRatio = Math.round((positiveCount / n) * 100) / 100;
  const negativeRatio = Math.round((negativeCount / n) * 100) / 100;

  // 转折点：符号变化次数
  let turningPoints = 0;
  let prevSign: number | null = null;
  for (let i = 1; i < valences.length; i++) {
    const diff = valences[i] - valences[i - 1];
    if (Math.abs(diff) < 0.05) continue;
    const sign = Math.sign(diff);
    if (prevSign !== null && sign !== 0 && sign !== prevSign) {
      turningPoints++;
    }
    if (sign !== 0) prevSign = sign;
  }

  // 趋势标签
  let trend: SentimentTrend["trend"];
  if (valenceVelocity > 0.01 && volatility < 0.3) {
    trend = "improving";
  } else if (valenceVelocity > 0.01) {
    trend = "improving";
  } else if (valenceVelocity < -0.01 && volatility < 0.3) {
    trend = "declining";
  } else if (valenceVelocity < -0.01) {
    trend = "declining";
  } else if (volatility > 0.4) {
    trend = "volatile";
  } else {
    trend = "stable";
  }

  // 愧疚趋势
  const gFirst = guilts.slice(0, Math.floor(guilts.length / 3)).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(guilts.length / 3));
  const gLast = guilts.slice(-Math.floor(guilts.length / 3)).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(guilts.length / 3));
  const guiltDelta = gLast - gFirst;
  let guiltTrend: SentimentTrend["guiltTrend"];
  if (Math.abs(guiltDelta) < 0.03) {
    guiltTrend = "stable";
  } else if (guiltDelta > 0) {
    guiltTrend = "rising";
  } else {
    guiltTrend = "falling";
  }

  return {
    currentValence,
    valenceVelocity,
    valenceAcceleration,
    volatility,
    positiveRatio,
    negativeRatio,
    turningPoints,
    trend,
    guiltTrend,
    dataPoints: n,
    spanDays: Math.round(spanDays * 10) / 10,
  };
}

// ── 情感叙事 ──────────────────────────────────

export function generateSentimentNarrative(trend: SentimentTrend): SentimentNarrative {
  if (trend.dataPoints < 3) {
    return {
      summary: "对话还不够多，暂时看不出情绪轨迹。",
      state: "insufficient",
      attentionFlag: false,
    };
  }

  let state: SentimentNarrative["state"];
  let attentionFlag = false;
  let attentionReason: string | undefined;

  if (trend.currentValence > 0.2 && Math.abs(trend.valenceVelocity) < 0.01) {
    state = "positive_stable";
  } else if (trend.currentValence < -0.2 && Math.abs(trend.valenceVelocity) < 0.01) {
    state = "negative_stable";
    attentionFlag = true;
    attentionReason = "情绪持续偏低，可能需要关注";
  } else if (trend.valenceVelocity > 0.02) {
    state = "shifting_positive";
  } else if (trend.valenceVelocity < -0.02) {
    state = "shifting_negative";
    attentionFlag = true;
    attentionReason = `情绪呈下降趋势 (${(trend.valenceVelocity >= 0 ? "+" : "")}${trend.valenceVelocity.toFixed(3)}/天)`;
  } else if (trend.volatility > 0.4) {
    state = "mixed";
  } else {
    state = "positive_stable";
  }

  // 愧疚持续上升 → 关注
  if (trend.guiltTrend === "rising" && trend.spanDays >= 5) {
    attentionFlag = true;
    attentionReason = (attentionReason ? attentionReason + "；" : "") + "愧疚度持续上升，可能存在未偿还的负债";
  }

  // 负面情绪占比高
  if (trend.negativeRatio > 0.5 && trend.spanDays >= 7) {
    attentionFlag = true;
    attentionReason = (attentionReason ? attentionReason + "；" : "") +
      `过去 ${Math.round(trend.spanDays)} 天内 ${Math.round(trend.negativeRatio * 100)}% 的对话情绪偏负面`;
  }

  const velocityDesc =
    trend.valenceVelocity > 0.02 ? "明显上升" :
    trend.valenceVelocity > 0.005 ? "轻微上升" :
    trend.valenceVelocity < -0.02 ? "明显下降" :
    trend.valenceVelocity < -0.005 ? "轻微下降" : "基本平稳";

  const summary = [
    `情绪基线 ${trend.currentValence.toFixed(2)}`,
    `，趋势 ${velocityDesc}`,
    `(${Math.round(trend.spanDays)} 天，${trend.dataPoints} 次对话)`,
    trend.turningPoints >= 3 ? `，${trend.turningPoints} 次情绪转折` : "",
  ].join("");

  return { summary, state, attentionFlag, attentionReason };
}

// ── 情绪转折点检测 ────────────────────────────

export interface TurningPoint {
  index: number;
  timestamp: number;
  valence: number;
  type: "peak" | "valley" | "inflection";
  magnitude: number; // 转折幅度
}

export function detectTurningPoints(points: SentimentPoint[]): TurningPoint[] {
  if (points.length < 5) return [];

  const valences = points.map(p => p.valence);
  const results: TurningPoint[] = [];

  for (let i = 2; i < valences.length - 2; i++) {
    const left = valences[i - 2] + valences[i - 1];
    const right = valences[i + 1] + valences[i + 2];
    const center = valences[i] * 2;

    // 局部峰值
    if (center > left && center > right) {
      const magnitude = Math.abs(valences[i] - (valences[i - 2] + valences[i + 2]) / 2);
      if (magnitude > 0.2) {
        results.push({
          index: i,
          timestamp: points[i].timestamp,
          valence: valences[i],
          type: "peak",
          magnitude: Math.round(magnitude * 100) / 100,
        });
      }
    }

    // 局部谷值
    if (center < left && center < right) {
      const magnitude = Math.abs(valences[i] - (valences[i - 2] + valences[i + 2]) / 2);
      if (magnitude > 0.2) {
        results.push({
          index: i,
          timestamp: points[i].timestamp,
          valence: valences[i],
          type: "valley",
          magnitude: Math.round(magnitude * 100) / 100,
        });
      }
    }
  }

  return results;
}

// ── 聚合报告 ──────────────────────────────────

export interface EvalReport {
  arc: ArcMetrics;
  arcNarrative: ArcNarrative;
  sentiment: SentimentTrend;
  sentimentNarrative: SentimentNarrative;
  turningPoints: TurningPoint[];
  forecast: TrendForecast;
  timestamp: string;
}

export function generateEvalReport(attachmentStyle?: string): EvalReport {
  const snaps = getRecentSnapshots(200);
  const points = extractSentimentPoints(snaps);

  const arc = computeArcMetrics(snaps);
  const arcNarrative = generateArcNarrative(arc, attachmentStyle);
  const sentiment = computeSentimentTrend(points);
  const sentimentNarrative = generateSentimentNarrative(sentiment);
  const turningPoints = detectTurningPoints(points);
  const forecast = forecastTrend(arc);

  return {
    arc,
    arcNarrative,
    sentiment,
    sentimentNarrative,
    turningPoints,
    forecast,
    timestamp: new Date().toISOString(),
  };
}
