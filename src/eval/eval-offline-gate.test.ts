import { describe, expect, it } from "vitest";
import { THRESHOLDS, buildAnchorCheck, buildMemoryChecks } from "../../scripts/eval-offline.js";

/** 一组达标的指标（与当前实测接近） */
function goodMetrics() {
  return {
    factsHitRate: 1,
    factsHits: 40,
    total: 40,
    recallAt1: 0.475,
    recallAt3: 0.8,
    recallAt8: 0.975,
    mergedHitRate: 1,
    mergedHits: 40,
  };
}

describe("离线守门：达标路径", () => {
  it("全部达标时 4 项记忆检查都 ok", () => {
    const checks = buildMemoryChecks(goodMetrics(), { passed: true, mergedHit: true });
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});

describe("离线守门：真的会失败（不是摆设）", () => {
  it("facts 命中率掉到阈值以下 → 失败", () => {
    const m = goodMetrics();
    m.factsHitRate = THRESHOLDS.factsHitRate - 0.01;
    m.factsHits = 37;
    const checks = buildMemoryChecks(m, { passed: true, mergedHit: true });
    expect(checks[0].ok).toBe(false);
  });

  it("recall@8 掉到阈值以下 → 失败", () => {
    const m = goodMetrics();
    m.recallAt8 = THRESHOLDS.recallAt8 - 0.05;
    const checks = buildMemoryChecks(m, { passed: true, mergedHit: true });
    expect(checks[1].ok).toBe(false);
  });

  it("合并命中率不够 → 失败", () => {
    const m = goodMetrics();
    m.mergedHitRate = THRESHOLDS.mergedHitRate - 0.02;
    const checks = buildMemoryChecks(m, { passed: true, mergedHit: true });
    expect(checks[2].ok).toBe(false);
  });

  it("anti-forget 回归 FAIL → 失败", () => {
    const checks = buildMemoryChecks(goodMetrics(), { passed: false, mergedHit: false });
    expect(checks[3].ok).toBe(false);
  });

  it("anti-forget 缺失（没跑）也算失败（不允许静默跳过）", () => {
    const checks = buildMemoryChecks(goodMetrics(), null);
    expect(checks[3].ok).toBe(false);
  });
});

describe("离线守门：锚点金标结构", () => {
  it("30 条且两类齐全 → ok", () => {
    const cases = [
      ...Array.from({ length: 17 }, () => ({ expect: { anchor: true, kind: "promise" } })),
      ...Array.from({ length: 13 }, () => ({ expect: { anchor: false } })),
    ];
    expect(buildAnchorCheck(cases).ok).toBe(true);
  });

  it("条数不足 → 失败", () => {
    const cases = Array.from({ length: 5 }, () => ({ expect: { anchor: true } }));
    expect(buildAnchorCheck(cases).ok).toBe(false);
  });

  it("只有一类（全该记）→ 失败", () => {
    const cases = Array.from({ length: 30 }, () => ({ expect: { anchor: true } }));
    expect(buildAnchorCheck(cases).ok).toBe(false);
  });

  it("kind 非法 → 失败", () => {
    const cases = [
      ...Array.from({ length: 17 }, () => ({ expect: { anchor: true, kind: "不存在的类型" } })),
      ...Array.from({ length: 13 }, () => ({ expect: { anchor: false } })),
    ];
    expect(buildAnchorCheck(cases).ok).toBe(false);
  });
});
