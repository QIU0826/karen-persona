import { describe, expect, it } from "vitest";
import { applyTimeGapToMessages, buildTimeGapNote } from "./time-gap.js";
import type { ConversationSession } from "../data/history.js";

function session(lastAt: number, content = "准备睡觉"): ConversationSession {
  return {
    personaId: "小雅",
    startedAt: 1,
    lastActiveAt: lastAt,
    messages: [{ role: "user", content, timestamp: lastAt }],
    t3: { currentTopic: "", emotionVector: 0, activeThreads: [] },
  };
}

describe("time-gap", () => {
  it("跨夜超过 2 小时：提示先接时间差", () => {
    const note = buildTimeGapNote(session(Date.now() - 9 * 60 * 60 * 1000), "我醒了");
    expect(note).toContain("小时前");
    expect(note).toContain("时间差");
  });

  it("短间隔/当前消息已落库：不提示", () => {
    expect(buildTimeGapNote(session(Date.now() - 10 * 60 * 1000), "嗯")).toBe("");
    const old = Date.now() - 9 * 60 * 60 * 1000;
    expect(buildTimeGapNote(session(old, "准备睡觉"), "准备睡觉")).toBe("");
  });
});

describe("applyTimeGapToMessages", () => {
  it("把时间提示贴到最后一条 user 消息前，不贴 system", () => {
    const old = Date.now() - 9 * 60 * 60 * 1000;
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "准备睡觉" },
      { role: "assistant", content: "晚安" },
      { role: "user", content: "我醒了" },
    ];
    applyTimeGapToMessages(messages, session(old), "我醒了");
    expect(messages[0]!.content).toBe("system");
    expect(messages[1]!.content).toBe("准备睡觉");
    expect(messages[3]!.content).toContain("时间上下文");
    expect(messages[3]!.content).toContain("我醒了");
  });
});
