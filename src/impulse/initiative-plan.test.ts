import { describe, expect, it } from "vitest";
import {
  buildDailyPlanPrompt,
  buildLifeSignals,
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

describe("calibratedDailyCap：冷启动不死锁（v0.8.14 真机冒烟抓到）", () => {
  it("从没主动过（hasSentHistory=false）→ 先试探 1 条，而不是 0", () => {
    const result = calibratedDailyCap({
      repliesToInitiative: 0,
      hisInitiatives: 0,
      closeness: 2,
      hasSentHistory: false,
    });
    expect(result.cap).toBe(1);
    expect(result.reason).toContain("试探");
  });

  it("有主动历史但基本不回 → 仍然收敛到 0（不放松原有的边界）", () => {
    const result = calibratedDailyCap({
      repliesToInitiative: 0,
      hisInitiatives: 0,
      closeness: 3,
      hasSentHistory: true,
    });
    expect(result.cap).toBe(0);
  });

  it("不传 hasSentHistory 时保持旧行为（老调用方不破坏）", () => {
    const result = calibratedDailyCap({ repliesToInitiative: 0, hisInitiatives: 0, closeness: 2 });
    expect(result.cap).toBe(0);
  });
});

describe("buildLifeSignals：把「她自己的生活」变成主动由头线索（v0.9.4）", () => {
  const world = {
    socialCircle: [{ name: "小雨", relation: "大学闺蜜", influence: "最近在谈恋爱" }],
    dailyRhythm: [
      { activity: "咖啡店工作", day: "每天", time: "08:00-17:00" },
      { activity: "瑜伽课", day: "周三", time: "18:00" },
    ],
    goals: [{ goal: "学会拉花", progress: "在练郁金香" }],
    stressSources: ["店里生意不太好"],
  };

  it("工作时间能取到「这会儿在做什么」", () => {
    const signals = buildLifeSignals({ world, hour: 10, weekday: 1, random: () => 0 });
    expect(signals[0]).toBe("这会儿在咖啡店工作");
  });

  it("非工作时间不会误报「在上班」", () => {
    const signals = buildLifeSignals({ world, hour: 22, weekday: 1, random: () => 0 });
    expect(signals.some((text) => text.includes("咖啡店工作"))).toBe(false);
  });

  it("周三 17 点会提示「等会儿要瑜伽课」", () => {
    const signals = buildLifeSignals({ world, hour: 17, weekday: 3, random: () => 0 });
    expect(signals.some((text) => text.includes("瑜伽课"))).toBe(true);
  });

  it("包含目标/压力源/朋友（她的世界），且总条数 ≤4", () => {
    const signals = buildLifeSignals({ world, hour: 10, weekday: 1, random: () => 0 });
    expect(signals.some((text) => text.includes("拉花"))).toBe(true);
    expect(signals.some((text) => text.includes("店里生意"))).toBe(true);
    expect(signals.some((text) => text.includes("小雨"))).toBe(true);
    expect(signals.length).toBeLessThanOrEqual(4);
  });

  it("天气/情绪作为补充；空世界也不崩", () => {
    const withWeather = buildLifeSignals({
      world: null,
      hour: 9,
      weekday: 5,
      weather: { condition: "小雨", temperature: 18 },
      random: () => 0,
    });
    expect(withWeather).toContain("外面小雨，18度");
    expect(buildLifeSignals({ world: null, hour: 9, weekday: 5 })).toEqual([]);
  });

  it("随机源可复现（不同 index 选不同目标）", () => {
    const many = {
      ...world,
      goals: [
        { goal: "攒钱去日本", progress: "三分之一" },
        { goal: "学会拉花", progress: "练郁金香" },
      ],
    };
    const first = buildLifeSignals({ world: many, hour: 22, weekday: 1, random: () => 0 });
    const second = buildLifeSignals({ world: many, hour: 22, weekday: 1, random: () => 0.99 });
    expect(first.join("|")).not.toBe(second.join("|"));
  });
});

describe("buildDailyPlanPrompt：必须要求她分享自己的生活（v0.9.4）", () => {
  it("prompt 里明确要求至少一条她自己的事、不要全在问他", () => {
    const prompt = buildDailyPlanPrompt({
      herName: "小雅",
      userName: "阿哲",
      day: "2026-10-21",
      closeness: 3,
      lifeSignals: ["这会儿在咖啡店工作", "最近在学会拉花（在练郁金香）"],
    });
    expect(prompt.system).toContain("至少 1 条必须是她自己的生活");
    expect(prompt.system).toContain("不能三条全都是在问他");
    expect(prompt.user).toContain("她自己的生活");
    expect(prompt.user).toContain("咖啡店工作");
  });
});
