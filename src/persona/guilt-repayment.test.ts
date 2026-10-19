import { describe, it, expect } from "vitest";
import {
  createGuiltState,
  incurGuilt,
  attemptRepayment,
  confirmRepayment,
  dailyDecay,
  resentmentEffect,
} from "./guilt-repayment.js";

// ── createGuiltState ────────────────────────

describe("createGuiltState", () => {
  it("初始化为零负债、零委屈", () => {
    const s = createGuiltState();
    expect(s.guilt).toBe(0);
    expect(s.resentment).toBe(0);
    expect(s.pendingRepayment).toBeNull();
  });
});

// ── incurGuilt ──────────────────────────────

describe("incurGuilt", () => {
  it("制造负债并累积", () => {
    const s = createGuiltState();
    const s1 = incurGuilt(s, 0.3, "规则突破");
    expect(s1.guilt).toBeCloseTo(0.3, 2);

    const s2 = incurGuilt(s1, 0.2, "再次突破");
    expect(s2.guilt).toBeCloseTo(0.5, 2);
  });

  it("负债不超过 1", () => {
    const s = { ...createGuiltState(), guilt: 0.9 };
    const result = incurGuilt(s, 0.3, "测试");
    expect(result.guilt).toBe(1);
  });

  it("不修改原始状态", () => {
    const s = createGuiltState();
    incurGuilt(s, 0.5, "测试");
    expect(s.guilt).toBe(0);
  });
});

// ── attemptRepayment ────────────────────────

describe("attemptRepayment", () => {
  it("有负债时记录偿还尝试", () => {
    const s = { ...createGuiltState(), guilt: 0.3 };
    const result = attemptRepayment(s, "主动说对不起");
    expect(result.pendingRepayment).not.toBeNull();
    expect(result.pendingRepayment!.action).toBe("主动说对不起");
    expect(result.pendingRepayment!.confirmed).toBe("pending");
  });

  it("负债 < 0.05 时不记录偿还（无需偿还）", () => {
    const s = { ...createGuiltState(), guilt: 0.02 };
    const result = attemptRepayment(s, "不用道歉");
    expect(result.pendingRepayment).toBeNull();
  });
});

// ── confirmRepayment ────────────────────────

describe("confirmRepayment", () => {
  it("接受偿还：大幅消解 guilt + 降低 resentment", () => {
    const s = {
      ...createGuiltState(),
      guilt: 0.8,
      pendingRepayment: { attempted: true, action: "道歉", timestamp: Date.now(), confirmed: "pending" as const, unnoticedCount: 0 },
    };
    const result = confirmRepayment(s, "accepted");
    expect(result.guilt).toBeLessThan(0.8);
    expect(result.resentment).toBe(0);
    expect(result.pendingRepayment).toBeNull();
  });

  it("拒绝偿还：加深 guilt + resentment", () => {
    const s = {
      ...createGuiltState(),
      guilt: 0.3,
      pendingRepayment: { attempted: true, action: "道歉", timestamp: Date.now(), confirmed: "pending" as const, unnoticedCount: 0 },
    };
    const result = confirmRepayment(s, "rejected");
    expect(result.guilt).toBeGreaterThan(0.3);
    expect(result.resentment).toBeGreaterThan(0);
    expect(result.pendingRepayment).toBeNull();
  });

  it("未被注意：表面消解一点 guilt 但 resentment 积累", () => {
    const s = {
      ...createGuiltState(),
      guilt: 0.4,
      pendingRepayment: { attempted: true, action: "默默关心", timestamp: Date.now(), confirmed: "pending" as const, unnoticedCount: 0 },
    };
    const result = confirmRepayment(s, "unnoticed");
    expect(result.guilt).toBeLessThan(0.4);
    expect(result.resentment).toBeGreaterThan(0);
    expect(result.pendingRepayment!.confirmed).toBe("unnoticed");
    expect(result.pendingRepayment!.unnoticedCount).toBe(1);
  });

  it("无待处理偿还时返回原状态", () => {
    const s = createGuiltState();
    const result = confirmRepayment(s, "accepted");
    expect(result).toEqual(s);
  });
});

// ── dailyDecay ──────────────────────────────

describe("dailyDecay", () => {
  it("guilt 每天自然衰减 0.02", () => {
    const s = { ...createGuiltState(), guilt: 0.5 };
    const result = dailyDecay(s);
    expect(result.guilt).toBeCloseTo(0.48, 2);
  });

  it("resentment 不自然衰减", () => {
    const s = { ...createGuiltState(), resentment: 0.5 };
    const result = dailyDecay(s);
    expect(result.resentment).toBe(0.5);
  });
});

// ── resentmentEffect ────────────────────────

describe("resentmentEffect", () => {
  it("低 resentment 无可见影响", () => {
    const s = { ...createGuiltState(), resentment: 0.1 };
    const effect = resentmentEffect(s);
    expect(effect.replyDelay).toBe(false);
    expect(effect.passiveAggressive).toBe(false);
    expect(effect.withdrawal).toBe(false);
  });

  it("中等 resentment → 回复变慢", () => {
    const s = { ...createGuiltState(), resentment: 0.4 };
    const effect = resentmentEffect(s);
    expect(effect.replyDelay).toBe(true);
    expect(effect.passiveAggressive).toBe(false);
  });

  it("高 resentment → 全部可见影响", () => {
    const s = { ...createGuiltState(), resentment: 0.8 };
    const effect = resentmentEffect(s);
    expect(effect.replyDelay).toBe(true);
    expect(effect.passiveAggressive).toBe(true);
    expect(effect.withdrawal).toBe(true);
  });
});
