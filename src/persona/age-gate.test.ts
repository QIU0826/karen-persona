/**
 * 年龄门单测（纯函数）：确认/拒绝识别、动作裁决、文案。
 */
import { describe, expect, it } from "vitest";
import {
  buildAgeConfirmedText,
  buildAgeDeclinedText,
  buildAgeGatePrompt,
  buildAgeGateReminder,
  detectAgeConfirmation,
  detectUnderageDecline,
  evaluateAgeGate,
  shouldEnforceAgeGate,
} from "./age-gate.js";

describe("shouldEnforceAgeGate", () => {
  it("只对 QQ 用户生效；CLI 开发者模式放行；可配置关闭", () => {
    expect(shouldEnforceAgeGate("qq:123", undefined)).toBe(true);
    expect(shouldEnforceAgeGate("qq:123", true)).toBe(true);
    expect(shouldEnforceAgeGate("qq:123", false)).toBe(false);
    expect(shouldEnforceAgeGate("cli:local", true)).toBe(false);
  });
});

describe("detectAgeConfirmation", () => {
  it("识别常见成年确认写法", () => {
    for (const text of ["我成年了", "已成年", "成年了", "满18了", "已满18岁", "18岁", "确认成年", "我18"]) {
      expect(detectAgeConfirmation(text), text).toBe(true);
    }
  });

  it("未成年/否定表达不会被误判为确认", () => {
    for (const text of ["我未成年", "还没成年", "不满18", "未满18岁", "17岁", "十八岁以下"]) {
      expect(detectUnderageDecline(text), text).toBe(true);
      expect(detectAgeConfirmation(text), text).toBe(false);
    }
  });

  it("普通聊天不会被当成确认", () => {
    expect(detectAgeConfirmation("今天好累啊")).toBe(false);
    expect(detectAgeConfirmation("")).toBe(false);
  });
});

describe("evaluateAgeGate", () => {
  const base = { owner: "qq:123", enabled: true, confirmed: false };

  it("已确认/非 QQ/关闭时直接放行", () => {
    expect(evaluateAgeGate({ ...base, text: "你好", confirmed: true })).toBe("pass");
    expect(evaluateAgeGate({ ...base, text: "你好", owner: "cli:local" })).toBe("pass");
    expect(evaluateAgeGate({ ...base, text: "你好", enabled: false })).toBe("pass");
  });

  it("未确认时：拒绝 > 确认 > 追问", () => {
    expect(evaluateAgeGate({ ...base, text: "我未成年" })).toBe("declined");
    expect(evaluateAgeGate({ ...base, text: "我成年了" })).toBe("confirmed");
    expect(evaluateAgeGate({ ...base, text: "你好呀" })).toBe("ask");
  });
});

describe("文案", () => {
  it("确认请求/提醒都要求回复「我成年了」", () => {
    expect(buildAgeGatePrompt()).toContain("18");
    expect(buildAgeGatePrompt()).toContain("我成年了");
    expect(buildAgeGateReminder()).toContain("我成年了");
  });

  it("拒绝文案明确终止且不诱导继续", () => {
    const text = buildAgeDeclinedText();
    expect(text).toContain("18 岁以上");
    expect(text).toContain("不能继续");
  });

  it("确认后回复简短", () => {
    expect(buildAgeConfirmedText()).toContain("继续聊");
  });
});
