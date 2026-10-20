/**
 * AI 披露：文案人设名 + 补发判断（老用户 session 非空但从未确认披露）。
 */
import { describe, expect, it } from "vitest";
import {
  buildAboutText,
  buildFirstContactDisclosure,
  shouldSendDisclosure,
} from "./disclosure.js";

describe("shouldSendDisclosure", () => {
  it("开启且从未确认过 → 发送", () => {
    expect(shouldSendDisclosure({ enabled: true })).toBe(true);
    expect(shouldSendDisclosure({ enabled: true, acknowledgedAt: null })).toBe(true);
  });

  it("已确认过 / 配置关闭 → 不发送", () => {
    expect(shouldSendDisclosure({ enabled: true, acknowledgedAt: 1_700_000_000_000 })).toBe(false);
    expect(shouldSendDisclosure({ enabled: false })).toBe(false);
  });
});

describe("披露文案", () => {
  it("默认人设名小雅；可传其他人设名避免说错人", () => {
    const fallback = buildFirstContactDisclosure();
    expect(fallback).toContain("我是小雅");
    expect(fallback).toContain("AI 扮演的虚拟角色");
    expect(fallback).toContain("发送给 AI 服务");
    const other = buildFirstContactDisclosure({ herName: "秋瑶", ageGate: true });
    expect(other).toContain("我是秋瑶");
    expect(other).not.toContain("我是小雅");
    expect(other).toContain("18 岁");
    expect(other).toContain("我成年了");
  });

  it("/about 使用当前人设名", () => {
    expect(buildAboutText()).toContain("当前人设：小雅");
    expect(buildAboutText({ herName: "苏迟" })).toContain("当前人设：苏迟");
  });
});
