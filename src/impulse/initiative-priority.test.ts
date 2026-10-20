/**
 * 意图由头优先级（v0.8.14 真机冒烟驱动）。
 *
 * 冒烟抓到的真问题：
 *  1) 全新会话没有主动历史 → 回复率 0 → 日上限 0 → 永远不主动（死锁）；
 *  2) 计划判定「该发」、日志也写了「到点由头」，但 v0.4 链路判定为 follow_up，
 *     计划被完全忽略（发出去的是不相干的生活流）；
 *  3) 计划已经过了自己的闸门，却还被 v0.4 的随机概率否掉（"这次随机没选中"）。
 *
 * 这里用纯函数把 1、3 的行为锁住（2 是编排层，由 proactive-smoke 的 plan 场景覆盖）。
 */
import { describe, expect, it } from "vitest";
import {
  calibratedDailyCap,
  markInitiativeUsed,
  pickDueInitiative,
  type DailyInitiativePlan,
} from "./initiative-plan.js";

function planWith(): DailyInitiativePlan {
  return {
    day: "2026-10-21",
    createdAt: 0,
    items: [
      {
        topic: "下午被老板叫去谈话，有点闷",
        kind: "life_event",
        windowStart: 19,
        windowEnd: 23,
        urgency: 0.7,
        used: false,
      },
    ],
  };
}

const BASE_SIGNALS = {
  hour: 20,
  closeness: 4,
  sentToday: 0,
  dailyCap: 1,
  minutesSinceLast: null,
  minGapMinutes: 30,
  quietHours: { start: 2, end: 7 },
  userRecentlyReplied: false,
};

describe("意图由头优先级（v0.8.14）", () => {
  it("全新关系（她从没主动过）日上限是 1，不是 0 —— 否则永远死锁", () => {
    const cap = calibratedDailyCap({
      repliesToInitiative: 0,
      hisInitiatives: 0,
      closeness: 1.5,
      hasSentHistory: false,
    });
    expect(cap.cap).toBe(1);
  });

  it("有主动历史但基本不回 → 仍然是 0（不放松原有边界）", () => {
    expect(
      calibratedDailyCap({ repliesToInitiative: 0, hisInitiatives: 0, closeness: 3, hasSentHistory: true }).cap,
    ).toBe(0);
  });

  it("由头到点且闸门都过 → 判定发（不受链路随机概率影响）", () => {
    const decision = pickDueInitiative(planWith(), { ...BASE_SIGNALS });
    expect(decision.action).toBe("send");
  });

  it("由头用过一次后当天不会再选它", () => {
    const used = markInitiativeUsed(planWith(), "下午被老板叫去谈话，有点闷");
    const decision = pickDueInitiative(used, { ...BASE_SIGNALS });
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("no_item_due");
  });

  it("免打扰时段即使由头到点也不发", () => {
    const decision = pickDueInitiative(planWith(), { ...BASE_SIGNALS, hour: 3 });
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("quiet_hours");
  });
});
