/**
 * M0：消息门上下文测试。
 *
 * 回归点：流式路径曾把 messageCountToday=0 / isRapidFollowUp=false 写死，
 * 导致「工作时段延迟」分支永不触发。这里验证共享上下文的行为。
 */
import { describe, expect, it } from "vitest";
import type { ConversationState } from "./orchestrator.js";
import { buildGateContext } from "./orchestrator.js";

const NOW = new Date("2026-10-19T15:00:00+08:00");

function makeState(messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>) {
  return {
    persona: {
      name: "小雅",
      hardRules: { triggerWords: [{ word: "前任" }] },
      world: { dailyRhythm: [] },
      relationship: { closeness: 3 },
    },
    config: {
      quiet_hours_start: 23,
      quiet_hours_end: 7,
    },
    emotionState: { vector: 0 },
    guiltState: { guilt: 0 },
    session: { messages },
  } as unknown as ConversationState;
}

const todayAt = (hour: number, minute = 0) => {
  const d = new Date(NOW);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

describe("buildGateContext", () => {
  it("统计当天用户消息数（不含历史日期）", () => {
    const state = makeState([
      { role: "user", content: "昨天", timestamp: todayAt(10) - 24 * 3600 * 1000 },
      { role: "user", content: "今天1", timestamp: todayAt(9) },
      { role: "user", content: "今天2", timestamp: todayAt(10) },
      { role: "assistant", content: "回复", timestamp: todayAt(10) },
    ]);
    const ctx = buildGateContext(state, "今天3", NOW);
    expect(ctx.messageCountToday).toBe(2);
  });

  it("识别 5 分钟内的连续消息", () => {
    const state = makeState([
      { role: "user", content: "在吗", timestamp: todayAt(14, 58) },
      { role: "user", content: "问你个事", timestamp: todayAt(14, 59) },
    ]);
    expect(buildGateContext(state, "快回", NOW).isRapidFollowUp).toBe(true);
  });

  it("刚回完一句就紧跟的第二句算连续跟进（当前消息也要计入间隔）", () => {
    const state = makeState([
      { role: "user", content: "在干嘛", timestamp: todayAt(14, 58) },
      { role: "assistant", content: "在忙", timestamp: todayAt(14, 58) + 3_000 },
      { role: "user", content: "忙什么？", timestamp: todayAt(14, 59) },
      { role: "assistant", content: "整理东西", timestamp: todayAt(14, 59) + 3_000 },
    ]);
    // 上一条用户消息在 1 分钟前（<5min）→ 当前这条也算快速跟进
    const ctx = buildGateContext(state, "啥呀？忘记你是干什么的了", NOW);
    expect(ctx.isRapidFollowUp).toBe(true);
    // messageCountToday 仍只统计已落库的消息（当前消息由调用方写入）
    expect(ctx.messageCountToday).toBe(2);
  });

  it("识别短问句快聊与自然收尾", () => {
    const state = makeState([]);
    expect(buildGateContext(state, "在吗？", NOW).isQuickChat).toBe(true);
    expect(buildGateContext(state, "嗯", NOW).isNaturalEnding).toBe(true);
    expect(buildGateContext(state, "今天发生了一件特别长的事情", NOW).isQuickChat).toBe(false);
  });

  it("识别回避话题与消息类型", () => {
    const state = makeState([]);
    expect(buildGateContext(state, "你前任最近怎么样", NOW).isAvoidedTopic).toBe(true);
    expect(buildGateContext(state, "[图片] 你看", NOW).messageType).toBe("image");
    expect(buildGateContext(state, "[语音] 听得到吗", NOW).messageType).toBe("voice");
    expect(buildGateContext(state, "普通消息", NOW).messageType).toBe("text");
  });
});
