/**
 * 跨轮重复评测的纯函数单测（不联网、不调模型、不读 .env）。
 */
import { describe, expect, it } from "vitest";
import { REPETITION_SCENARIO, summarizeRepetition } from "./repetition-eval.js";

describe("summarizeRepetition", () => {
  it("场景定义稳定：连续 6 轮同类型问题", () => {
    expect(REPETITION_SCENARIO).toHaveLength(6);
    expect(REPETITION_SCENARIO[0]).toBe("在干嘛");
  });

  it("统计问句收尾与套话命中（AI 味辅助指标）", () => {
    const metrics = summarizeRepetition("test", [
      "在忙呢，是不是又加班？",
      "确实，早点睡吗？",
    ]);
    expect(metrics.questionReplies).toBe(2);
    expect(metrics.formulaicHits).toBeGreaterThanOrEqual(3);
  });

  it("连续复读给出的复读对/相似度都高", () => {
    const metrics = summarizeRepetition("test", [
      "今天真的好累啊",
      "今天真的好累啊",
      "我记性不太行",
    ]);
    expect(metrics.turns).toBe(3);
    expect(metrics.duplicatePairs).toBe(1);
    expect(metrics.maxScore).toBe(1);
    expect(metrics.pairs[0]).toMatchObject({ from: 0, to: 1, duplicate: true, kind: "exact" });
  });

  it("正常换说法时复读对为 0、平均相似度低", () => {
    const metrics = summarizeRepetition("test", [
      "猫咪又踩我脸叫我起床",
      "今天下雨了 店里没人",
      "我晚上煮了面",
    ]);
    expect(metrics.duplicatePairs).toBe(0);
    expect(metrics.avgScore).toBeLessThan(0.3);
  });

  it("连续同开头词计入 openerRepeats", () => {
    const metrics = summarizeRepetition("test", ["哈哈是吗", "哈哈真的假的", "行吧"]);
    expect(metrics.openerRepeats).toBeGreaterThanOrEqual(1);
  });

  it("只有一条回复时指标为 0", () => {
    const metrics = summarizeRepetition("test", ["嗯"]);
    expect(metrics).toMatchObject({ turns: 1, duplicatePairs: 0, avgScore: 0, maxScore: 0 });
  });
});
