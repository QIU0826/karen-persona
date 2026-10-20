import { describe, it, expect } from "vitest";
import {
  TYPING_BASE_MS,
  TYPING_CAP_DAY_MS,
  TYPING_CAP_NIGHT_MS,
  TYPING_NIGHT_FACTOR,
  computeTypingDelay,
  isNightHour,
} from "./humanizer.js";

describe("isNightHour：夜间判定", () => {
  it("23:00–06:00 是夜间", () => {
    for (const h of [23, 0, 3, 5]) expect(isNightHour(h)).toBe(true);
  });
  it("白天不是夜间", () => {
    for (const h of [6, 9, 14, 20, 22]) expect(isNightHour(h)).toBe(false);
  });
});

describe("computeTypingDelay：打字时长", () => {
  const day = 14;
  const night = 2;
  const fixedRandom = () => 0;

  it("短句在 0.3–1.2s 之间（白天）", () => {
    const d = computeTypingDelay(5, day, fixedRandom);
    expect(d).toBeGreaterThanOrEqual(TYPING_BASE_MS);
    expect(d).toBeLessThan(1200);
  });

  it("同一句话夜间明显更慢（约 1.35 倍）", () => {
    const d = computeTypingDelay(10, day, fixedRandom);
    const n = computeTypingDelay(10, night, fixedRandom);
    expect(n).toBeCloseTo(d * TYPING_NIGHT_FACTOR, 5);
    expect(n).toBeGreaterThan(d);
  });

  it("字数越多越慢（单调不减）", () => {
    let prev = 0;
    for (const chars of [1, 3, 6, 10, 15, 20]) {
      const d = computeTypingDelay(chars, day, fixedRandom);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("长句封顶：白天 3s，夜间 4.2s", () => {
    expect(computeTypingDelay(200, day, fixedRandom)).toBe(TYPING_CAP_DAY_MS);
    expect(computeTypingDelay(200, night, fixedRandom)).toBe(TYPING_CAP_NIGHT_MS);
  });

  it("夜间永远不慢于白天（同输入下）", () => {
    for (const r of [0, 0.3, 0.7, 1]) {
      for (const chars of [0, 8, 40]) {
        const dayMs = computeTypingDelay(chars, day, () => r);
        const nightMs = computeTypingDelay(chars, night, () => r);
        expect(nightMs).toBeGreaterThanOrEqual(dayMs);
      }
    }
  });

  it("空文本也有一点固定开销，但不超过 0.6s", () => {
    const d = computeTypingDelay(0, day, fixedRandom);
    expect(d).toBeGreaterThanOrEqual(TYPING_BASE_MS);
    expect(d).toBeLessThan(600);
  });

  it("负数/小数输入不会算出 NaN 或负值", () => {
    expect(computeTypingDelay(-5, day, fixedRandom)).toBeGreaterThan(0);
    expect(Number.isFinite(computeTypingDelay(3.7, day, fixedRandom))).toBe(true);
  });
});
