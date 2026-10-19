/**
 * M1-2 关系成长规则测试。
 *
 * 原则：只由结构性事件驱动（深度对话/连续互动/主动分享），有每日上限，可解释。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DAILY_GAIN,
  applyRelationshipEvent,
  createRelationshipState,
  evaluateRelationshipEvent,
  latestMilestone,
  touchInteraction,
} from "./relationship.js";

const TODAY = new Date("2026-10-19T21:00:00+08:00");
const YESTERDAY = new Date("2026-10-18T21:00:00+08:00");

const deepInput = {
  userText: "今天店里来了个客人，说他以前也在这里打过工，聊了好久，突然有点感慨",
  replyText: "嗯。有些人就是会突然出现一下。",
  complexity: "complex" as const,
  guilt: 0,
  now: TODAY,
};

describe("evaluateRelationshipEvent", () => {
  it("深度对话 + 连续互动 + 主动分享会产生关系增长", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-18" };
    const result = evaluateRelationshipEvent(state, deepInput);
    expect(result).not.toBeNull();
    // 0.03（深度对话）+ 0.02（连续互动）+ 0.015（分享）≈ 0.065
    expect(result!.delta).toBeCloseTo(0.065, 3);
    expect(result!.reason).toContain("更深");
  });

  it("普通短消息不产生关系变化", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, {
      ...deepInput,
      userText: "在吗",
      replyText: "嗯。",
      complexity: "simple",
    });
    expect(result).toBeNull();
  });

  it("愧疚/冲突状态下不推进关系", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, { ...deepInput, guilt: 0.5 });
    expect(result).toBeNull();
  });

  it("每日增长上限生效", () => {
    const state = { ...createRelationshipState(3), dailyGainDay: "2026-10-19", dailyGain: MAX_DAILY_GAIN };
    expect(evaluateRelationshipEvent(state, deepInput)).toBeNull();
  });

  it("每日上限会裁剪事件增量", () => {
    const state = {
      ...createRelationshipState(3),
      lastInteractionDay: "2026-10-18",
      dailyGainDay: "2026-10-19",
      dailyGain: 0.09,
    };
    const result = evaluateRelationshipEvent(state, deepInput);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeCloseTo(0.01, 3);
  });
});

describe("applyRelationshipEvent", () => {
  it("跨过阈值时记录里程碑，并同步亲密度", () => {
    const state = createRelationshipState(3.4);
    const next = applyRelationshipEvent(state, 0.2, "深度对话", TODAY);
    expect(next.closeness).toBeCloseTo(3.6, 2);
    expect(next.milestones.map((m) => m.id)).toContain("getting-familiar");
    expect(latestMilestone(next)?.title).toBe("开始熟络起来");
  });

  it("亲密度不会超过 10", () => {
    const state = createRelationshipState(9.95);
    const next = applyRelationshipEvent(state, 1, "测试", TODAY);
    expect(next.closeness).toBe(10);
  });

  it("事件历史最多保留 200 条", () => {
    let state = createRelationshipState(3);
    for (let i = 0; i < 210; i++) {
      state = applyRelationshipEvent(state, 0, `事件${i}`, new Date(TODAY.getTime() + i * 1000));
    }
    expect(state.events.length).toBe(200);
  });
});

describe("touchInteraction", () => {
  it("昨天聊过今天再来 → 连续天数 +1", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-18", interactionStreak: 2 };
    const next = touchInteraction(state, TODAY);
    expect(next.interactionStreak).toBe(3);
    expect(next.lastInteractionDay).toBe("2026-10-19");
  });

  it("同一天重复 touch 不会重复累计", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-19", interactionStreak: 4 };
    const next = touchInteraction(state, TODAY);
    expect(next.interactionStreak).toBe(4);
  });
});
