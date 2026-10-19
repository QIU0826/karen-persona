/**
 * 消息门免打扰时段测试（M1-4 基础能力）。
 */
import { describe, expect, it } from "vitest";
import { decideGate, isQuietHour, type GateContext } from "./message-gate.js";

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    personaId: "小雅",
    currentHour: 23,
    isWorkHours: false,
    emotionVector: 0,
    guilt: 0,
    messageType: "text",
    isAvoidedTopic: false,
    isNaturalEnding: false,
    messageCountToday: 0,
    isRapidFollowUp: false,
    isQuickChat: false,
    closeness: 3,
    dailyRhythm: [],
    ...overrides,
  };
}

describe("isQuietHour", () => {
  it("默认 23-7 覆盖跨午夜区间", () => {
    const q = { start: 23, end: 7 };
    expect(isQuietHour(23, q)).toBe(true);
    expect(isQuietHour(0, q)).toBe(true);
    expect(isQuietHour(6.9, q)).toBe(true);
    expect(isQuietHour(7, q)).toBe(false);
    expect(isQuietHour(14, q)).toBe(false);
  });

  it("同 start/end 表示关闭免打扰", () => {
    expect(isQuietHour(3, { start: 7, end: 7 })).toBe(false);
    expect(isQuietHour(3, undefined)).toBe(false);
  });

  it("不跨午夜的区间（如 2-7）", () => {
    expect(isQuietHour(3, { start: 2, end: 7 })).toBe(true);
    expect(isQuietHour(23, { start: 2, end: 7 })).toBe(false);
  });
});

describe("decideGate 免打扰", () => {
  it("23 点在默认免打扰内 → 延迟到早上 7 点", () => {
    const action = decideGate(ctx({ currentHour: 23 }));
    expect(action.type).toBe("delay");
    if (action.type === "delay") {
      expect(action.resumeAfterMs).toBe(8 * 60 * 60 * 1000);
      expect(action.reason).toContain("太晚");
    }
  });

  it("自定义 2-7 点时，23 点正常回复", () => {
    const action = decideGate(ctx({ currentHour: 23, quietHours: { start: 2, end: 7 } }));
    expect(action.type).toBe("reply");
  });

  it("自定义 2-7 点时，凌晨 3 点仍然延迟", () => {
    const action = decideGate(ctx({ currentHour: 3, quietHours: { start: 2, end: 7 } }));
    expect(action.type).toBe("delay");
    if (action.type === "delay") {
      expect(action.resumeAfterMs).toBe(4 * 60 * 60 * 1000);
    }
  });

  it("start == end 时关闭免打扰", () => {
    const action = decideGate(ctx({ currentHour: 3, quietHours: { start: 0, end: 0 } }));
    expect(action.type).toBe("reply");
  });
});
