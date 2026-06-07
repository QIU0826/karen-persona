import { describe, it, expect } from "vitest";
import {
  createEmotionState,
  adjustEmotion,
  naturalRecover,
  calculateImpulseIntensity,
  describeEmotion,
} from "./emotion.js";

// ── createEmotionState ──────────────────────

describe("createEmotionState", () => {
  it("默认基线为 0，初始化中性状态", () => {
    const s = createEmotionState();
    expect(s.vector).toBe(0);
    expect(s.baseline).toBe(0);
    expect(s.arousal).toBe(0.1);
    expect(s.lastUpdated).toBeGreaterThan(0);
  });

  it("支持自定义基线", () => {
    const s = createEmotionState(0.3);
    expect(s.vector).toBe(0.3);
    expect(s.baseline).toBe(0.3);
  });
});

// ── adjustEmotion ───────────────────────────

describe("adjustEmotion", () => {
  it("正向偏移增加情绪向量", () => {
    const s = createEmotionState();
    const result = adjustEmotion(s, 0.3, "测试");
    expect(result.vector).toBeCloseTo(0.3, 2);
    expect(result.arousal).toBeGreaterThan(0.1);
  });

  it("负向偏移减少情绪向量", () => {
    const s = createEmotionState(0.2);
    const result = adjustEmotion(s, -0.5, "测试");
    expect(result.vector).toBeCloseTo(-0.3, 2);
  });

  it("向量不超过 ±1 范围", () => {
    const s = createEmotionState(0.8);
    const up = adjustEmotion(s, 0.5, "测试");
    expect(up.vector).toBeLessThanOrEqual(1);

    const low = createEmotionState(-0.8);
    const down = adjustEmotion(low, -0.5, "测试");
    expect(down.vector).toBeGreaterThanOrEqual(-1);
  });

  it("不修改原始对象（不可变性）", () => {
    const s = createEmotionState();
    const originalVector = s.vector;
    adjustEmotion(s, 0.5, "测试");
    expect(s.vector).toBe(originalVector);
  });
});

// ── naturalRecover ──────────────────────────

describe("naturalRecover", () => {
  it("向量渐近回归基线", () => {
    const s = { ...createEmotionState(0), vector: 0.5, baseline: 0, arousal: 0.5, lastUpdated: Date.now() };
    const result = naturalRecover(s);
    expect(result.vector).toBeLessThan(0.5);
    expect(result.vector).toBeGreaterThan(0);
    expect(result.arousal).toBeLessThan(0.5);
  });

  it("离基线足够近时不变化", () => {
    const s = { ...createEmotionState(), vector: 0.005, baseline: 0, arousal: 0.1, lastUpdated: Date.now() };
    const result = naturalRecover(s);
    expect(result.vector).toBe(0.005);
    expect(result.arousal).toBe(0.1);
  });

  it("负向量也向基线回归", () => {
    const s = { ...createEmotionState(0), vector: -0.4, baseline: 0, arousal: 0.3, lastUpdated: Date.now() };
    const result = naturalRecover(s);
    expect(result.vector).toBeGreaterThan(-0.4);
  });
});

// ── calculateImpulseIntensity ───────────────

describe("calculateImpulseIntensity", () => {
  it("向量与基线无偏差时冲动为零", () => {
    const s = createEmotionState(0.3);
    const intensity = calculateImpulseIntensity(s, 5);
    expect(intensity).toBe(0);
  });

  it("情绪偏离大 + 高 arousal → 高冲动", () => {
    const s = { ...createEmotionState(0), vector: 0.8, baseline: 0, arousal: 0.9, lastUpdated: Date.now() };
    const intensity = calculateImpulseIntensity(s, 8);
    expect(intensity).toBeGreaterThan(0.3);
  });

  it("亲密度缩放冲动值", () => {
    const s = { ...createEmotionState(0), vector: 0.7, baseline: 0, arousal: 0.6, lastUpdated: Date.now() };
    const low = calculateImpulseIntensity(s, 2);
    const high = calculateImpulseIntensity(s, 9);
    expect(high).toBeGreaterThan(low);
  });

  it("冲动值不超过 1", () => {
    const s = { ...createEmotionState(0), vector: 1, baseline: -1, arousal: 1, lastUpdated: Date.now() };
    const intensity = calculateImpulseIntensity(s, 10);
    expect(intensity).toBeLessThanOrEqual(1);
  });
});

// ── describeEmotion ─────────────────────────

describe("describeEmotion", () => {
  it("低 arousal 为平静", () => {
    expect(describeEmotion({ vector: 0.8, baseline: 0, arousal: 0.05, lastUpdated: 0 })).toBe("平静");
  });

  it("正向高 arousal 为兴奋", () => {
    expect(describeEmotion({ vector: 0.7, baseline: 0, arousal: 0.8, lastUpdated: 0 })).toBe("兴奋");
  });

  it("负向高 arousal 为崩溃", () => {
    expect(describeEmotion({ vector: -0.6, baseline: 0, arousal: 0.7, lastUpdated: 0 })).toBe("崩溃");
  });

  it("负向低 arousal 为低落", () => {
    expect(describeEmotion({ vector: -0.6, baseline: 0, arousal: 0.3, lastUpdated: 0 })).toBe("低落");
  });
});
