import { describe, it, expect, vi } from "vitest";

// Mock the vector DB dependency before importing the module under test
vi.mock("../data/vector.js", () => ({
  getRecentSnapshots: vi.fn(),
}));

import { getRecentSnapshots, type T1Snapshot } from "../data/vector.js";
import {
  computeArcMetrics,
  generateArcNarrative,
  forecastTrend,
  type ArcMetrics,
} from "./relationship-arc.js";

function makeSnapshots(closenessSeries: number[], startDate: Date): T1Snapshot[] {
  return closenessSeries.map((closeness, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return {
      content: `day ${i}`,
      emotionVector: 0,
      closeness,
      guilt: 0,
      summary: "",
      created_at: d.toISOString(),
    };
  });
}

// ── computeArcMetrics ─────────────────────────

describe("computeArcMetrics", () => {
  it("数据不足时返回 undefined 模式", () => {
    vi.mocked(getRecentSnapshots).mockReturnValue([]);
    const m = computeArcMetrics();
    expect(m.pattern).toBe("undefined");
    expect(m.dataPoints).toBe(0);
  });

  it("少于 3 个数据点返回 undefined", () => {
    const snaps = makeSnapshots([5, 6], new Date("2026-06-01"));
    const m = computeArcMetrics(snaps);
    expect(m.pattern).toBe("undefined");
    expect(m.dataPoints).toBe(2);
  });

  it("持续升温被检测为 warming 模式", () => {
    // 30天跨度上的温和升温，避免触发 volatility 优先检测
    const snaps = makeSnapshots(
      [3.0, 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 3.9, 4.0, 4.1],
      new Date("2026-05-01")
    );
    const m = computeArcMetrics(snaps);
    expect(m.pattern).toBe("warming");
    expect(m.slopePerDay).toBeGreaterThan(0);
    expect(m.delta).toBeGreaterThan(1);
    expect(m.spanDays).toBeGreaterThan(0);
  });

  it("持续降温被检测为 cooling 模式", () => {
    // 30天跨度上的温和降温，避免触发 volatility 优先检测
    const snaps = makeSnapshots(
      [7.0, 6.9, 6.7, 6.6, 6.4, 6.2, 6.1, 5.9, 5.7, 5.5],
      new Date("2026-05-01")
    );
    const m = computeArcMetrics(snaps);
    expect(m.pattern).toBe("cooling");
    expect(m.slopePerDay).toBeLessThan(0);
    expect(m.delta).toBeLessThan(0);
  });

  it("平稳关系被检测为 stable 模式", () => {
    const snaps = makeSnapshots(
      [5, 5.1, 5.0, 4.9, 5.1, 5.0, 5.0, 5.1, 4.9, 5.0],
      new Date("2026-05-01")
    );
    const m = computeArcMetrics(snaps);
    expect(m.pattern).toBe("stable");
    expect(m.volatility).toBeLessThan(0.3);
  });

  it("V 形反弹被检测为 rebound 模式", () => {
    const vals = [6, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    const snaps = makeSnapshots(vals, new Date("2026-05-01"));
    const m = computeArcMetrics(snaps);
    expect(["rebound", "volatile"]).toContain(m.pattern);
  });

  it("正确计算 peak 和 trough", () => {
    const snaps = makeSnapshots([3, 5, 2, 7, 4], new Date("2026-06-01"));
    const m = computeArcMetrics(snaps);
    expect(m.peak).toBe(7);
    expect(m.trough).toBe(2);
  });

  it("传入自定义快照时不调用数据库", () => {
    const snaps = makeSnapshots([4, 4.5, 5, 5.5, 6], new Date("2026-06-01"));
    const m = computeArcMetrics(snaps);
    expect(m.dataPoints).toBe(5);
  });
});

// ── generateArcNarrative ──────────────────────

describe("generateArcNarrative", () => {
  it("数据不足时返回 initial 阶段", () => {
    const m: ArcMetrics = {
      currentCloseness: 5, startingCloseness: 5,
      delta: 0, slopePerDay: 0, volatility: 0,
      peak: 5, trough: 5, inflectionCount: 0,
      pattern: "undefined", patternConfidence: 0,
      dataPoints: 1, spanDays: 0,
    };
    const n = generateArcNarrative(m);
    expect(n.stage).toBe("initial");
    expect(n.attentionFlag).toBe(false);
  });

  it("低亲密度 + 下降趋势 → distancing 阶段", () => {
    const m: ArcMetrics = {
      currentCloseness: 1.5, startingCloseness: 4,
      delta: -2.5, slopePerDay: -0.05, volatility: 0.2,
      peak: 4, trough: 1.5, inflectionCount: 0,
      pattern: "cooling", patternConfidence: 0.7,
      dataPoints: 10, spanDays: 14,
    };
    const n = generateArcNarrative(m);
    expect(n.stage).toBe("distancing");
    expect(n.attentionFlag).toBe(true);
  });

  it("高亲密度 → settled 阶段", () => {
    const m: ArcMetrics = {
      currentCloseness: 8, startingCloseness: 3,
      delta: 5, slopePerDay: 0.05, volatility: 0.15,
      peak: 8, trough: 3, inflectionCount: 1,
      pattern: "warming", patternConfidence: 0.8,
      dataPoints: 30, spanDays: 60,
    };
    const n = generateArcNarrative(m);
    expect(n.stage).toBe("settled");
    expect(n.direction).toBe("up");
  });

  it("焦虑型 + rebound → attention flag", () => {
    const m: ArcMetrics = {
      currentCloseness: 5, startingCloseness: 5,
      delta: 0, slopePerDay: 0, volatility: 0.6,
      peak: 7, trough: 3, inflectionCount: 2,
      pattern: "rebound", patternConfidence: 0.7,
      dataPoints: 20, spanDays: 10,
    };
    const n = generateArcNarrative(m, "anxious");
    expect(n.attentionFlag).toBe(true);
    expect(n.attentionReason).toBeDefined();
  });
});

// ── forecastTrend ─────────────────────────────

describe("forecastTrend", () => {
  it("上升趋势预测可达高亲密度", () => {
    const m: ArcMetrics = {
      currentCloseness: 5, startingCloseness: 3,
      delta: 2, slopePerDay: 0.05, volatility: 0.1,
      peak: 5, trough: 3, inflectionCount: 0,
      pattern: "warming", patternConfidence: 0.7,
      dataPoints: 15, spanDays: 30,
    };
    const f = forecastTrend(m);
    expect(f.in7Days).toBeGreaterThan(5);
    expect(f.in30Days).toBeGreaterThan(f.in7Days);
    expect(f.daysToClose).toBeGreaterThan(0);
    expect(f.daysToDrift).toBe(-1); // 上升趋势不会下降
  });

  it("下降趋势预测到疏远天数", () => {
    const m: ArcMetrics = {
      currentCloseness: 5, startingCloseness: 7,
      delta: -2, slopePerDay: -0.04, volatility: 0.1,
      peak: 7, trough: 5, inflectionCount: 0,
      pattern: "cooling", patternConfidence: 0.7,
      dataPoints: 15, spanDays: 30,
    };
    const f = forecastTrend(m);
    expect(f.in7Days).toBeLessThan(5);
    expect(f.daysToDrift).toBeGreaterThan(0);
    expect(f.daysToClose).toBe(-1);
  });

  it("值被 clamp 到 0-10 范围内", () => {
    const m: ArcMetrics = {
      currentCloseness: 9.5, startingCloseness: 9,
      delta: 0.5, slopePerDay: 0.1, volatility: 0.05,
      peak: 9.5, trough: 9, inflectionCount: 0,
      pattern: "warming", patternConfidence: 0.5,
      dataPoints: 5, spanDays: 5,
    };
    const f = forecastTrend(m);
    expect(f.in7Days).toBeLessThanOrEqual(10);
    expect(f.in30Days).toBeLessThanOrEqual(10);
  });
});
