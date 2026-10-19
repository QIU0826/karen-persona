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
