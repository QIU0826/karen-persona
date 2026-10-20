import { describe, expect, it } from "vitest";
import {
  batchCases,
  formatAnchorEvalReport,
  loadAnchorGold,
  runAnchorEvalLive,
  summarize,
  type AnchorEvalItemResult,
} from "./anchor-eval.js";

describe("loadAnchorGold", () => {
  it("金标集结构合法（含该记与不该记两类、kind 都在合法集内）", () => {
    const cases = loadAnchorGold();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const positives = cases.filter((c) => c.expect.anchor).length;
    expect(positives).toBeGreaterThan(0);
    expect(positives).toBeLessThan(cases.length);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});

describe("batchCases", () => {
  it("每批不超过 12 条（与生产上限一致）", () => {
    const cases = loadAnchorGold();
    const batches = batchCases(cases);
    expect(batches.every((b) => b.length <= 12)).toBe(true);
    expect(batches.flat()).toHaveLength(cases.length);
  });
});

function item(patch: Partial<AnchorEvalItemResult>): AnchorEvalItemResult {
  return { id: "x", expected: true, decided: true, content: "c", ...patch };
}

describe("summarize", () => {
  it("全对时 accuracy/precision/recall 都是 1", () => {
    const s = summarize([
      item({ expected: true, decided: true }),
      item({ expected: false, decided: false }),
    ]);
    expect(s.accuracy).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
  });

  it("全判该记 → recall 1、precision 下降", () => {
    const s = summarize([
      item({ expected: true, decided: true }),
      item({ expected: false, decided: true }),
    ]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(0.5);
    expect(s.accuracy).toBe(0.5);
    expect(s.falsePositives).toBe(1);
  });

  it("全判不该记 → precision 1（无正例）、recall 0", () => {
    const s = summarize([
      item({ expected: true, decided: false }),
      item({ expected: false, decided: false }),
    ]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0);
    expect(s.falseNegatives).toBe(1);
  });

  it("kind 准确率只看双方都判该记的条目", () => {
    const s = summarize([
      item({ expected: true, decided: true, expectedKind: "promise", decidedKind: "promise" }),
      item({ expected: true, decided: true, expectedKind: "loss", decidedKind: "conflict" }),
      item({ expected: false, decided: false }),
    ]);
    expect(s.kindAccuracy).toBe(0.5);
  });
});

describe("runAnchorEvalLive", () => {
  it("用假模型验证映射与统计（不联网）", async () => {
    const cases = loadAnchorGold().slice(0, 3);
    const result = await runAnchorEvalLive({
      cases,
      chatFn: async () =>
        JSON.stringify({
          items: [
            { index: 0, anchor: true, kind: "promise", summary: "约定" },
            { index: 1, anchor: true, kind: "loss", summary: "事件" },
            { index: 2, anchor: false, kind: "shared_experience", summary: "闲聊" },
          ],
        }),
    });
    expect(result.items).toHaveLength(3);
    expect(result.summary.total).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("模型返回 null 时记为批次失败（不静默当成「不该记」）", async () => {
    const cases = loadAnchorGold().slice(0, 2);
    const result = await runAnchorEvalLive({ cases, chatFn: async () => null });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.items.every((i) => !i.decided)).toBe(true);
  });
});

describe("formatAnchorEvalReport", () => {
  it("报告含指标表与误判明细", () => {
    const cases = loadAnchorGold().slice(0, 2);
    const result = {
      items: [
        { id: "a", expected: true, decided: false, content: "内容A" },
        { id: "b", expected: false, decided: false, content: "内容B" },
      ],
      summary: { ...summarize([]), total: 2, accuracy: 0.5, recall: 0, precision: 1, kindAccuracy: 1 },
      errors: [],
    };
    const md = formatAnchorEvalReport(result, { model: "deepseek-flash", startedAt: "2026-10-20" });
    expect(md).toContain("# 锚点复筛评测报告");
    expect(md).toContain("准确率");
    expect(md).toContain("误判明细");
    expect(md).toContain("内容A");
    expect(cases).toBeDefined();
  });
});
