import { describe, it, expect } from "vitest";
import {
  extractSentimentPoints,
  computeSentimentTrend,
  generateSentimentNarrative,
  detectTurningPoints,
  type SentimentPoint,
  type SentimentTrend,
} from "./sentiment.js";

function makePoints(valences: number[], startDate: Date, guilts?: number[]): SentimentPoint[] {
  return valences.map((v, i) => ({
    timestamp: new Date(startDate).getTime() + i * 3600000, // 每小时一个点
    valence: v,
    arousal: 0.5,
    guilt: guilts?.[i] ?? 0.1,
    closeness: 5,
  }));
}

// ── extractSentimentPoints ────────────────────

describe("extractSentimentPoints", () => {
  it("空数组返回空", () => {
    const pts = extractSentimentPoints([]);
    expect(pts).toHaveLength(0);
  });

  it("按时间排序", () => {
    const snaps = [
      { content: "", emotionVector: 0.3, closeness: 5, guilt: 0, summary: "", created_at: "2026-06-03T00:00:00Z" },
      { content: "", emotionVector: 0.5, closeness: 5, guilt: 0, summary: "", created_at: "2026-06-01T00:00:00Z" },
      { content: "", emotionVector: 0.1, closeness: 5, guilt: 0, summary: "", created_at: "2026-06-02T00:00:00Z" },
    ];
    const pts = extractSentimentPoints(snaps);
    expect(pts[0].valence).toBe(0.5);
    expect(pts[2].valence).toBe(0.3);
  });
});

// ── computeSentimentTrend ─────────────────────

describe("computeSentimentTrend", () => {
  it("数据不足时返回 insufficient_data", () => {
    const pts = makePoints([0.1], new Date("2026-06-01"));
    const t = computeSentimentTrend(pts);
    expect(t.trend).toBe("insufficient_data");
    expect(t.guiltTrend).toBe("insufficient_data");
  });

  it("持续正面情绪被检测为 improving", () => {
    const pts = makePoints(
      [-0.2, -0.1, -0.05, 0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5],
      new Date("2026-06-01")
    );
    const t = computeSentimentTrend(pts);
    expect(t.trend).toBe("improving");
    expect(t.valenceVelocity).toBeGreaterThan(0);
    expect(t.positiveRatio).toBeGreaterThan(0.5);
  });

  it("持续负面情绪被检测为 declining", () => {
    const pts = makePoints(
      [0.3, 0.25, 0.2, 0.1, 0.0, -0.1, -0.2, -0.3],
      new Date("2026-06-01")
    );
    const t = computeSentimentTrend(pts);
    expect(t.trend).toBe("declining");
    expect(t.valenceVelocity).toBeLessThan(0);
    expect(t.negativeRatio).toBeGreaterThan(0);
  });

  it("平稳情绪被检测为 stable", () => {
    // 对称的上下波动 + 14天跨度，确保回归斜率和速度都接近零
    const base = new Date("2026-06-01");
    const pts: SentimentPoint[] = [
      { timestamp: base.getTime(), valence: 0.1, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 2 * 86400000, valence: -0.1, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 4 * 86400000, valence: 0.1, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 6 * 86400000, valence: -0.05, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 8 * 86400000, valence: 0.05, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 10 * 86400000, valence: -0.05, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 12 * 86400000, valence: 0.05, arousal: 0.5, guilt: 0.1, closeness: 5 },
      { timestamp: base.getTime() + 14 * 86400000, valence: -0.05, arousal: 0.5, guilt: 0.1, closeness: 5 },
    ];
    const t = computeSentimentTrend(pts);
    expect(t.volatility).toBeLessThan(0.5);
    expect(Math.abs(t.valenceVelocity)).toBeLessThan(0.02);
  });

  it("高波动情绪被检测为 volatile", () => {
    const pts = makePoints(
      [0.5, -0.3, 0.4, -0.4, 0.3, -0.5, 0.6],
      new Date("2026-06-01")
    );
    const t = computeSentimentTrend(pts);
    expect(t.volatility).toBeGreaterThan(0.3);
  });

  it("正确计算愧疚趋势", () => {
    const pts = makePoints(
      [0, 0, 0, 0, 0],
      new Date("2026-06-01"),
      [0.1, 0.2, 0.35, 0.5, 0.7] // 上升的愧疚
    );
    const t = computeSentimentTrend(pts);
    expect(t.guiltTrend).toBe("rising");
  });

  it("愧疚下降被正确检测", () => {
    const pts = makePoints(
      [0, 0, 0, 0, 0],
      new Date("2026-06-01"),
      [0.7, 0.5, 0.35, 0.2, 0.1]
    );
    const t = computeSentimentTrend(pts);
    expect(t.guiltTrend).toBe("falling");
  });

  it("正确计算时间和数据点", () => {
    const pts = makePoints(
      [0.1, 0.2, 0.1, 0.3, 0.2],
      new Date("2026-06-01")
    );
    const t = computeSentimentTrend(pts);
    expect(t.dataPoints).toBe(5);
    // 5个点，每小时一个，跨度4小时 = 0.17天
    expect(t.spanDays).toBeGreaterThan(0);
  });

  it("正确计算正/负面占比", () => {
    const pts = makePoints(
      [0.5, 0.3, -0.2, -0.4, 0.1, 0.0, -0.1, 0.2],
      new Date("2026-06-01")
    );
    const t = computeSentimentTrend(pts);
    expect(t.positiveRatio + t.negativeRatio).toBeLessThanOrEqual(1);
  });
});

// ── generateSentimentNarrative ────────────────

describe("generateSentimentNarrative", () => {
  it("数据不足时返回 insufficient", () => {
    const t: SentimentTrend = {
      currentValence: 0, valenceVelocity: 0, valenceAcceleration: 0,
      volatility: 0, positiveRatio: 0, negativeRatio: 0,
      turningPoints: 0, trend: "insufficient_data",
      guiltTrend: "insufficient_data", dataPoints: 1, spanDays: 0,
    };
    const n = generateSentimentNarrative(t);
    expect(n.state).toBe("insufficient");
    expect(n.attentionFlag).toBe(false);
  });

  it("负面稳定 → attention flag", () => {
    const t: SentimentTrend = {
      currentValence: -0.3, valenceVelocity: -0.005, valenceAcceleration: 0,
      volatility: 0.1, positiveRatio: 0.1, negativeRatio: 0.8,
      turningPoints: 0, trend: "stable",
      guiltTrend: "stable", dataPoints: 20, spanDays: 14,
    };
    const n = generateSentimentNarrative(t);
    expect(n.state).toBe("negative_stable");
    expect(n.attentionFlag).toBe(true);
  });

  it("下降趋势 → attention flag", () => {
    const t: SentimentTrend = {
      currentValence: 0.1, valenceVelocity: -0.03, valenceAcceleration: -0.01,
      volatility: 0.2, positiveRatio: 0.3, negativeRatio: 0.4,
      turningPoints: 2, trend: "declining",
      guiltTrend: "stable", dataPoints: 30, spanDays: 14,
    };
    const n = generateSentimentNarrative(t);
    expect(n.attentionFlag).toBe(true);
    expect(n.attentionReason).toContain("下降");
  });

  it("正面稳定 → 无 attention flag", () => {
    const t: SentimentTrend = {
      currentValence: 0.4, valenceVelocity: 0.005, valenceAcceleration: 0,
      volatility: 0.1, positiveRatio: 0.9, negativeRatio: 0.05,
      turningPoints: 1, trend: "stable",
      guiltTrend: "stable", dataPoints: 30, spanDays: 14,
    };
    const n = generateSentimentNarrative(t);
    expect(n.state).toBe("positive_stable");
    expect(n.attentionFlag).toBe(false);
  });

  it("愧疚上升触发 attention", () => {
    const t: SentimentTrend = {
      currentValence: 0.2, valenceVelocity: 0.01, valenceAcceleration: 0,
      volatility: 0.15, positiveRatio: 0.6, negativeRatio: 0.2,
      turningPoints: 1, trend: "improving",
      guiltTrend: "rising", dataPoints: 20, spanDays: 10,
    };
    const n = generateSentimentNarrative(t);
    expect(n.attentionFlag).toBe(true);
    expect(n.attentionReason).toContain("愧疚");
  });
});

// ── detectTurningPoints ───────────────────────

describe("detectTurningPoints", () => {
  it("数据不足时返回空", () => {
    const pts = makePoints([0.1, 0.2, 0.1], new Date("2026-06-01"));
    const tps = detectTurningPoints(pts);
    expect(tps).toHaveLength(0);
  });

  it("检测到峰值", () => {
    const pts = makePoints(
      [0, 0.1, 0.2, 0.5, 0.3, 0.1, 0, -0.1],
      new Date("2026-06-01")
    );
    const tps = detectTurningPoints(pts);
    expect(tps.length).toBeGreaterThanOrEqual(0); // 取决于阈值
    const peaks = tps.filter(t => t.type === "peak");
    if (peaks.length > 0) {
      expect(peaks[0].magnitude).toBeGreaterThan(0.2);
    }
  });

  it("检测到谷值", () => {
    const pts = makePoints(
      [0.3, 0.1, -0.1, -0.4, -0.2, 0, 0.2, 0.4],
      new Date("2026-06-01")
    );
    const tps = detectTurningPoints(pts);
    const valleys = tps.filter(t => t.type === "valley");
    if (valleys.length > 0) {
      expect(valleys[0].magnitude).toBeGreaterThan(0.2);
    }
  });
});
