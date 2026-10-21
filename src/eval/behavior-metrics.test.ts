import { describe, expect, it } from "vitest";
import {
  aggregateBehaviorMetrics,
  computeBehaviorMetrics,
  countDuplicatePairs,
  countRepeatedOpeners,
  formatRangeNumber,
  formatRangePercent,
  isQuestionReply,
  normalizeReply,
} from "./behavior-metrics.js";

describe("normalizeReply", () => {
  it("去掉标点/空白/大小写差异", () => {
    expect(normalizeReply("嗯… 我在听，你呢？")).toBe("嗯我在听你呢");
    expect(normalizeReply("ABC 123")).toBe("abc123");
    expect(normalizeReply("")).toBe("");
  });
});

describe("countDuplicatePairs（完全重复的回复）", () => {
  it("标点/空白不同视为重复", () => {
    expect(countDuplicatePairs(["嗯我在听。", "嗯 我在听"])).toBe(1);
    expect(countDuplicatePairs(["嗯我在听", "你说吧"])).toBe(0);
  });

  it("三条相同 → 3 对", () => {
    expect(countDuplicatePairs(["好", "好。", "好！"])).toBe(3);
  });

  it("空回复不参与重复统计", () => {
    expect(countDuplicatePairs(["", "  ", "好"])).toBe(0);
  });
});

describe("countRepeatedOpeners（开头 4 字复读感）", () => {
  it("开头四字相同算一对", () => {
    expect(countRepeatedOpeners(["今天店里真的冷清", "今天店里客人好少"])).toBe(1);
    expect(countRepeatedOpeners(["今天店里冷清", "外面下雨了"])).toBe(0);
  });

  it("不足 4 字的不参与", () => {
    expect(countRepeatedOpeners(["嗯嗯", "嗯嗯"])).toBe(0);
  });
});

describe("isQuestionReply", () => {
  it("问号或常见问句结尾 → true", () => {
    expect(isQuestionReply("你吃了吗")).toBe(true);
    expect(isQuestionReply("你那边呢？")).toBe(true);
    expect(isQuestionReply("好的呀")).toBe(false);
    expect(isQuestionReply("")).toBe(false);
  });
});

describe("computeBehaviorMetrics", () => {
  it("汇总提及率/字数/问句率/重复对", () => {
    const metrics = computeBehaviorMetrics(
      ["今天店里冷清", "今天店里冷清。", "你吃了吗", ""],
      [true, true, false, false],
    );
    expect(metrics.replies).toBe(4);
    expect(metrics.mentionRate).toBe(0.5);
    expect(metrics.duplicatePairs).toBe(1);
    expect(metrics.questionRate).toBeCloseTo(1 / 3, 5);
    expect(metrics.avgChars).toBeGreaterThan(0);
  });

  it("空输入不崩", () => {
    const metrics = computeBehaviorMetrics([], []);
    expect(metrics.mentionRate).toBe(0);
    expect(metrics.avgChars).toBe(0);
    expect(metrics.replies).toBe(0);
  });
});

describe("aggregateBehaviorMetrics / 格式化", () => {
  const runs = [
    computeBehaviorMetrics(["a", "b"], [true, false]),
    computeBehaviorMetrics(["a", "a"], [false, false]),
  ];

  it("聚合出均值与范围", () => {
    const agg = aggregateBehaviorMetrics(runs);
    expect(agg.mentionRate.mean).toBeCloseTo(0.25, 5);
    expect(agg.mentionRate.min).toBeCloseTo(0, 5);
    expect(agg.mentionRate.max).toBeCloseTo(0.5, 5);
    expect(agg.duplicatePairs.mean).toBeCloseTo(0.5, 5);
  });

  it("空运行列表返回全 0", () => {
    const agg = aggregateBehaviorMetrics([]);
    expect(agg.mentionRate).toEqual({ mean: 0, min: 0, max: 0 });
  });

  it("格式化百分比与数值范围", () => {
    expect(formatRangePercent({ mean: 0.33, min: 0.17, max: 0.5 })).toBe("33%（17%–50%）");
    expect(formatRangeNumber({ mean: 18.7, min: 12, max: 24.5 })).toBe("18.7（12.0–24.5）");
  });
});
