import { describe, expect, it } from "vitest";
import {
  QUESTION_HOOK_COOLDOWN_TURNS,
  QUESTION_HOOK_MIN_CLOSENESS,
  buildQuestionHookNote,
  replyAsksQuestion,
  shouldAddQuestionHook,
} from "./question-hook.js";

describe("replyAsksQuestion", () => {
  it("问号或问句语气词结尾 → true", () => {
    expect(replyAsksQuestion("你那边呢？")).toBe(true);
    expect(replyAsksQuestion("你们组长也这样吗")).toBe(true);
    expect(replyAsksQuestion("好的")).toBe(false);
    expect(replyAsksQuestion("")).toBe(false);
  });
});

describe("shouldAddQuestionHook", () => {
  const base = { recentReplies: ["嗯，今天确实挺累的"], userText: "今天加班到八点" };

  it("满足条件且随机命中 → true", () => {
    expect(shouldAddQuestionHook(base, { random: () => 0 })).toBe(true);
  });

  it("随机不命中 → false", () => {
    expect(shouldAddQuestionHook(base, { random: () => 0.99 })).toBe(false);
  });

  it("最近回复里已经有问句 → 冷却不触发", () => {
    const ctx = { ...base, recentReplies: ["今天店里挺忙的", "你吃了吗？"] };
    expect(shouldAddQuestionHook(ctx, { random: () => 0 })).toBe(false);
  });

  it("冷却只看最近 N 条（更早的问句不影响）", () => {
    const ctx = { ...base, recentReplies: ["你吃了吗？", "嗯", "确实"] };
    expect(shouldAddQuestionHook(ctx, { random: () => 0 })).toBe(true);
    expect(QUESTION_HOOK_COOLDOWN_TURNS).toBe(2);
  });

  it("对方在讲糟心事 / 危机轮 → 不追问", () => {
    expect(shouldAddQuestionHook({ ...base, isTroubleTalk: true }, { random: () => 0 })).toBe(false);
    expect(shouldAddQuestionHook({ ...base, isCrisis: true }, { random: () => 0 })).toBe(false);
  });

  it("对方这轮已经在问问题 → 先回答不反抛", () => {
    expect(shouldAddQuestionHook({ ...base, userText: "你在干嘛呢？" }, { random: () => 0 })).toBe(false);
  });

  it("亲密度太低 → 不追问", () => {
    expect(
      shouldAddQuestionHook({ ...base, closeness: QUESTION_HOOK_MIN_CLOSENESS - 1 }, { random: () => 0 }),
    ).toBe(false);
  });

  it("enabled=false / 概率可覆盖", () => {
    expect(shouldAddQuestionHook(base, { random: () => 0, enabled: false })).toBe(false);
    expect(shouldAddQuestionHook(base, { random: () => 0.5, probability: 0.6 })).toBe(true);
    expect(shouldAddQuestionHook(base, { random: () => 0.5, probability: 0.4 })).toBe(false);
  });
});

describe("buildQuestionHookNote", () => {
  it("提示要求具体问题、禁止泛泛问", () => {
    const note = buildQuestionHookNote();
    expect(note).toContain("具体的小问题");
    expect(note).toContain("不要泛泛问");
  });
});
