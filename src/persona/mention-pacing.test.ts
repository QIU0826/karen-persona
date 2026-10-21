import { describe, expect, it } from "vitest";
import {
  MENTION_MAX_IN_WINDOW,
  MENTION_WINDOW_TURNS,
  buildMentionPacingNote,
  countMentions,
  detectSelfMention,
  isOverMentionBudget,
  recordMention,
} from "./mention-pacing.js";

describe("detectSelfMention（她有没有在讲自己的生活）", () => {
  it("命中人设实体词 → true", () => {
    expect(detectSelfMention("老周今天又念叨水电了", [], ["老周"])).toBe(true);
    expect(detectSelfMention("小雨又跟我吐槽她对象", [], ["小雨", "拉花"])).toBe(true);
  });

  it("内置实体兜底（五花/拉花/吧台）→ true", () => {
    expect(detectSelfMention("五花趴我腿上不下来", [])).toBe(true);
    expect(detectSelfMention("今天拉花总算有点样子", [])).toBe(true);
  });

  it("与当天生活流字面重叠 ≥4 个 2-gram → true", () => {
    const life = ["阿杰进门说今天阴，奶泡机嗡嗡响半天才转"];
    expect(detectSelfMention("奶泡机今天嗡嗡响半天，阿杰进门就说阴天", life)).toBe(true);
  });

  it("纯回应对方、没有自己的生活 → false", () => {
    expect(detectSelfMention("那你今天被说啥了？", [])).toBe(false);
    expect(detectSelfMention("嗯……确实挺难受的", ["阿杰进门说今天阴"])).toBe(false);
  });

  it("空回复 → false", () => {
    expect(detectSelfMention("")).toBe(false);
  });
});

describe("提及预算（6 轮窗口最多 2 次）", () => {
  it("窗口/预算常量", () => {
    expect(MENTION_WINDOW_TURNS).toBe(6);
    expect(MENTION_MAX_IN_WINDOW).toBe(2);
  });

  it("少于预算不超；达到预算即超", () => {
    expect(isOverMentionBudget([])).toBe(false);
    expect(isOverMentionBudget([true])).toBe(false);
    expect(isOverMentionBudget([true, false, true])).toBe(true);
    expect(isOverMentionBudget([false, false, false])).toBe(false);
  });

  it("只看最近窗口（更早的不算）", () => {
    const history = [true, true, false, false, false, false, true, false];
    // 最近 6 轮：[false,false,false,false,true,false] → 1 次
    expect(isOverMentionBudget(history)).toBe(false);
  });

  it("recordMention 追加并截断到窗口", () => {
    let history: boolean[] = [];
    for (let i = 0; i < 10; i++) history = recordMention(history, i % 2 === 0);
    expect(history).toHaveLength(MENTION_WINDOW_TURNS);
    expect(recordMention([true], false)).toEqual([true, false]);
  });

  it("超预算时给抑制提示；未超时为空串", () => {
    expect(buildMentionPacingNote([true, false, true])).toContain("先别再主动提你自己");
    expect(buildMentionPacingNote([true])).toBe("");
    expect(buildMentionPacingNote([])).toBe("");
  });

  it("countMentions 统计", () => {
    expect(countMentions([true, false, true, false])).toBe(2);
  });
});
