import { describe, expect, it } from "vitest";
import {
  applyDimEvent,
  behaviorNote,
  createRelationshipDims,
  derivePhase,
  describeDims,
} from "./relationship-dims.js";

const T0 = new Date(2026, 9, 20, 12).getTime();

describe("createRelationshipDims", () => {
  it("按亲密度给出合理初值（五个维度都在 0-10）", () => {
    const dims = createRelationshipDims(5, T0);
    for (const v of [dims.intimacy, dims.trust, dims.reciprocity, dims.dependency]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(10);
    }
    expect(dims.tension).toBe(0);
  });

  it("低亲密度不会被算出负数/超界", () => {
    const dims = createRelationshipDims(-3, T0);
    expect(dims.intimacy).toBe(0);
  });
});

describe("applyDimEvent", () => {
  const base = createRelationshipDims(4, T0);

  it("深聊提升亲密与信任", () => {
    const next = applyDimEvent(base, "deep_talk", { now: T0 });
    expect(next.intimacy).toBeGreaterThan(base.intimacy);
    expect(next.trust).toBeGreaterThan(base.trust);
  });

  it("冲突顶高张力并降低信任", () => {
    const next = applyDimEvent(base, "conflict", { now: T0 });
    expect(next.tension).toBeGreaterThan(0);
    expect(next.trust).toBeLessThan(base.trust);
  });

  it("道歉能降低张力（和好）", () => {
    const hurt = applyDimEvent(base, "conflict", { now: T0 });
    const repaired = applyDimEvent(hurt, "apology", { now: T0 });
    expect(repaired.tension).toBeLessThan(hurt.tension);
  });

  it("关心提升互惠，忽略降低互惠", () => {
    expect(applyDimEvent(base, "care", { now: T0 }).reciprocity).toBeGreaterThan(base.reciprocity);
    expect(applyDimEvent(base, "neglect", { now: T0 }).reciprocity).toBeLessThan(base.reciprocity);
  });

  it("张力随时间自然回落", () => {
    const hurt = applyDimEvent(base, "conflict", { now: T0 });
    const later = applyDimEvent(hurt, "care", { now: T0 + 10 * 3_600_000 });
    expect(later.tension).toBeLessThan(hurt.tension);
  });

  it("所有维度始终夹在 0-10（连续冲突也不会变负/超过 10）", () => {
    let dims = base;
    for (let i = 0; i < 20; i++) dims = applyDimEvent(dims, "conflict", { now: T0 });
    const numericKeys = ["intimacy", "trust", "tension", "reciprocity", "dependency"] as const;
    for (const key of numericKeys) {
      expect(dims[key]).toBeGreaterThanOrEqual(0);
      expect(dims[key]).toBeLessThanOrEqual(10);
    }
  });

  it("强度参数放大/缩小效果", () => {
    const weak = applyDimEvent(base, "deep_talk", { now: T0, intensity: 0.2 });
    const strong = applyDimEvent(base, "deep_talk", { now: T0, intensity: 2 });
    expect(strong.intimacy).toBeGreaterThan(weak.intimacy);
  });
});

describe("derivePhase", () => {
  const dims = createRelationshipDims(4, T0);

  it("初识 → 陌生/开始熟悉", () => {
    expect(["stranger", "acquaintance"]).toContain(derivePhase(createRelationshipDims(1, T0)));
  });

  it("高亲密高信任高依赖 → 很依赖", () => {
    const attached = { intimacy: 8, trust: 7, tension: 0, reciprocity: 7, dependency: 6, updatedAt: T0 };
    expect(derivePhase(attached)).toBe("attached");
  });

  it("张力很高 → 别扭", () => {
    const strained = { ...dims, tension: 7 };
    expect(derivePhase(strained)).toBe("strained");
  });

  it("刚吵完但张力不高 → 修复中", () => {
    const repairing = { ...dims, tension: 3.5 };
    expect(derivePhase(repairing, { recentConflict: true })).toBe("repairing");
  });
});

describe("describeDims / behaviorNote", () => {
  const dims = createRelationshipDims(5, T0);

  it("describeDims 带四个维度，张力高才提", () => {
    expect(describeDims(dims)).toContain("亲密");
    expect(describeDims(dims)).not.toContain("张力");
    expect(describeDims({ ...dims, tension: 4 })).toContain("张力");
  });

  it("别扭时行为提示是「话少、不主动」", () => {
    expect(behaviorNote({ ...dims, tension: 7 }, "strained")).toContain("不会主动");
  });

  it("互惠很低时提示「不主动追着问」", () => {
    const low = { ...dims, reciprocity: 1 };
    expect(behaviorNote(low, "close")).toContain("不主动");
  });

  it("很亲近且无张力时提示放松", () => {
    const warm = { ...dims, intimacy: 8, trust: 7, tension: 0 };
    expect(behaviorNote(warm, "attached")).toContain("放松");
  });

  it("普通状态不瞎提示", () => {
    expect(behaviorNote(dims, "acquaintance")).toBe("");
  });
});
