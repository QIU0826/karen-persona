import { describe, expect, it } from "vitest";
import {
  buildDailyPlanPrompt,
  calibratedDailyCap,
  isInWindow,
  markInitiativeUsed,
  parseDailyPlan,
  pickDueInitiative,
  type DailyInitiativePlan,
  type InitiativeSignals,
} from "./initiative-plan.js";

function plan(items: DailyInitiativePlan["items"] = []): DailyInitiativePlan {
  return { day: "2026-10-20", createdAt: Date.now(), items };
}

function signals(patch: Partial<InitiativeSignals> = {}): InitiativeSignals {
  return {
    hour: 10,
    closeness: 6,
    sentToday: 0,
    dailyCap: 2,
    minutesSinceLast: null,
    minGapMinutes: 30,
    quietHours: { start: 2, end: 7 },
    userRecentlyReplied: false,
    ...patch,
  };
}

describe("isInWindow", () => {
  it("普通时间窗", () => {
    expect(isInWindow(10, 9, 12)).toBe(true);
    expect(isInWindow(8, 9, 12)).toBe(false);
  });
  it("跨天时间窗（22→2）", () => {
    expect(isInWindow(23, 22, 2)).toBe(true);
    expect(isInWindow(1, 22, 2)).toBe(true);
    expect(isInWindow(12, 22, 2)).toBe(false);
  });
  it("start==end 视为全天", () => {
    expect(isInWindow(5, 0, 0)).toBe(true);
  });
});

describe("buildDailyPlanPrompt / parseDailyPlan", () => {
  it("prompt 带上线索并要求 2-3 条、只写片段内的事", () => {
    const p = buildDailyPlanPrompt({
      herName: "小雅",
      userName: "你",
      day: "2026-10-20",
      closeness: 6.2,
      lifeSignals: ["店里来了只橘猫"],
      openThreads: ["他想换工作"],
    });
    expect(p.user).toContain("小雅");
    expect(p.user).toContain("店里来了只橘猫");
    expect(p.user).toContain("他想换工作");
    expect(p.system).toContain("2–3 条");
    expect(p.system).toContain("不要编造");
  });

  it("解析正常 JSON（容忍代码块）", () => {
    const content = '```json\n{"items":[{"topic":"猫又赖着不走","kind":"life_event","urgency":0.7,"window_start":9,"window_end":12}]}\n```';
    const parsed = parseDailyPlan(content, "2026-10-20");
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0].topic).toContain("猫");
    expect(parsed?.items[0].kind).toBe("life_event");
  });

  it("最多取 3 条、非法 kind 降级、越界数值被夹住", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      topic: `话题${i}`,
      kind: "weird",
      urgency: 99,
      window_start: -5,
      window_end: 99,
    }));
    const parsed = parseDailyPlan(JSON.stringify({ items }), "2026-10-20")!;
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[0].kind).toBe("life_event");
    expect(parsed.items[0].urgency).toBe(1);
    expect(parsed.items[0].windowStart).toBe(0);
    expect(parsed.items[0].windowEnd).toBe(23);
  });

  it("坏 JSON / 空 items 返回 null", () => {
    expect(parseDailyPlan("nope", "d")).toBeNull();
    expect(parseDailyPlan('{"items":[]}', "d")).toBeNull();
  });
});

describe("pickDueInitiative：护栏", () => {
  const duePlan = plan([
    { topic: "猫又来了", kind: "life_event", urgency: 0.8, windowStart: 9, windowEnd: 12 },
  ]);

  it("没有计划 → skip", () => {
    expect(pickDueInitiative(null, signals()).action).toBe("skip");
  });

  it("免打扰时段不发", () => {
    expect(pickDueInitiative(duePlan, signals({ hour: 3 })).action).toBe("skip");
  });

  it("到单日上限不发", () => {
    expect(pickDueInitiative(duePlan, signals({ sentToday: 2 })).action).toBe("skip");
  });

  it("距上次太近不发", () => {
    expect(pickDueInitiative(duePlan, signals({ minutesSinceLast: 10 })).action).toBe("skip");
  });

  it("他刚回过消息，不另起话题", () => {
    expect(pickDueInitiative(duePlan, signals({ userRecentlyReplied: true })).action).toBe("skip");
  });

  it("不在时间窗内不发", () => {
    expect(pickDueInitiative(duePlan, signals({ hour: 20 })).action).toBe("skip");
  });

  it("到点则发，挑 urgency 最高的", () => {
    const p = plan([
      { topic: "低优先", kind: "life_event", urgency: 0.3, windowStart: 9, windowEnd: 12 },
      { topic: "高优先", kind: "mood_share", urgency: 0.9, windowStart: 9, windowEnd: 12 },
    ]);
    const decision = pickDueInitiative(p, signals());
    expect(decision.action).toBe("send");
    if (decision.action === "send") expect(decision.item.topic).toBe("高优先");
  });

  it("亲密度低时不发「有点想他」", () => {
    const p = plan([
      { topic: "有点想他", kind: "missing_you", urgency: 1, windowStart: 9, windowEnd: 12 },
      { topic: "猫来了", kind: "life_event", urgency: 0.5, windowStart: 9, windowEnd: 12 },
    ]);
    const decision = pickDueInitiative(p, signals({ closeness: 2 }));
    if (decision.action === "send") expect(decision.item.kind).toBe("life_event");
  });

  it("用过的由头当天不再发", () => {
    const used = markInitiativeUsed(duePlan, "猫又来了");
    expect(pickDueInitiative(used, signals()).action).toBe("skip");
  });
});

describe("calibratedDailyCap", () => {
  it("他基本不回且不熟 → 0 条", () => {
    expect(calibratedDailyCap({ repliesToInitiative: 1, hisInitiatives: 0, closeness: 3 }).cap).toBe(0);
  });
  it("回得少 → 1 条", () => {
    expect(calibratedDailyCap({ repliesToInitiative: 3, hisInitiatives: 1, closeness: 6 }).cap).toBe(1);
  });
  it("聊得热络 → 3 条", () => {
    expect(calibratedDailyCap({ repliesToInitiative: 9, hisInitiatives: 6, closeness: 8 }).cap).toBe(3);
  });
  it("正常 → 2 条", () => {
    expect(calibratedDailyCap({ repliesToInitiative: 6, hisInitiatives: 1, closeness: 6 }).cap).toBe(2);
  });
  it("上限不超过 3、不低于 0", () => {
    const extreme = calibratedDailyCap({ repliesToInitiative: 100, hisInitiatives: 100, closeness: 99 });
    expect(extreme.cap).toBeLessThanOrEqual(3);
    expect(extreme.cap).toBeGreaterThanOrEqual(0);
  });
});
