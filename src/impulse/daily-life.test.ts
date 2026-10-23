import { describe, expect, it } from "vitest";
import {
  DAILY_LIFE_MAX_CHARS,
  buildDailyLifePrompt,
  buildLifeHistoryInjection,
  dailyLifeToSignals,
  deserializeDailyLife,
  formatDailyLife,
  parseDailyLife,
  pickLifeEvent,
  serializeDailyLife,
  type DailyLifeEvent,
} from "./daily-life.js";

const WORLD = {
  socialCircle: [{ name: "小雨", relation: "大学闺蜜" }],
  dailyRhythm: [{ activity: "咖啡店工作", day: "每天", time: "08:00-17:00" }],
  goals: [{ goal: "学会拉花", progress: "在练郁金香" }],
  stressSources: ["店里生意不太好"],
};

describe("buildDailyLifePrompt（v0.9.6）", () => {
  it("包含她的世界设定与星期；要求恰好 3 条、禁止新增人物", () => {
    const prompt = buildDailyLifePrompt({
      herName: "小雅",
      day: "2026-10-21",
      weekday: 3,
      world: WORLD,
      weather: { condition: "小雨", temperature: 18 },
    });
    expect(prompt.system).toContain("恰好 3 条");
    expect(prompt.system).toContain("不要新增任何人物或地点");
    expect(prompt.system).toContain("不要重复最近 2–3 天");
    expect(prompt.system).toContain("tomorrow");
    expect(prompt.user).toContain("周三");
    expect(prompt.user).toContain("咖啡店工作");
    expect(prompt.user).toContain("学会拉花");
    expect(prompt.user).toContain("小雨");
    expect(prompt.user).toContain("小雨，18 度");
  });

  it("带上最近几天与昨天计划，避免每天重播", () => {
    const prompt = buildDailyLifePrompt({
      herName: "小雅",
      day: "2026-10-24",
      weekday: 6,
      world: WORLD,
      recentDays: [
        { day: "2026-10-23", events: [{ hour: 9, kind: "work", text: "老周说流水又降了" }] },
        { day: "2026-10-22", events: [{ hour: 15, kind: "goal", text: "练拉花郁金香" }] },
      ],
      yesterdayTomorrow: "周末想去海边",
    });
    expect(prompt.system).toContain("老周算账");
    expect(prompt.user).toContain("2026-10-23");
    expect(prompt.user).toContain("老周说流水又降了");
    expect(prompt.user).toContain("周末想去海边");
  });

  it("没有 world/天气也能构造（不崩）", () => {
    const prompt = buildDailyLifePrompt({ herName: "小雅", day: "2026-10-21", weekday: 1 });
    expect(prompt.system.length).toBeGreaterThan(0);
    expect(prompt.user).toContain("（无）");
  });
});

describe("parseDailyLife", () => {
  it("解析正常 JSON，按 hour 排序，截断超长 text", () => {
    const plan = parseDailyLife(
      JSON.stringify({
        events: [
          { hour: 20, kind: "cat", text: "五花又把毛球踢到床底下" },
          { hour: 9, kind: "work", text: "早班来了个熟客点了两杯拿铁" },
          { hour: 15, kind: "goal", text: "拉花郁金香终于有点样子了" },
        ],
      }),
      "2026-10-21",
    );
    expect(plan?.events.map((event) => event.hour)).toEqual([9, 15, 20]);
    expect(plan?.events[0]?.kind).toBe("work");
  });

  it("解析 tomorrow 明天计划（截断/空值兼容）", () => {
    const plan = parseDailyLife(
      JSON.stringify({
        events: [{ hour: 9, kind: "work", text: "早班来了个熟客" }],
        tomorrow: "  周末去海边走走  ",
      }),
      "2026-10-21",
    );
    expect(plan?.tomorrowPlan).toBe("周末去海边走走");
    expect(
      parseDailyLife(JSON.stringify({ events: [{ hour: 9, kind: "work", text: "x" }], tomorrow: "" }), "2026-10-21")
        ?.tomorrowPlan,
    ).toBeUndefined();
  });

  it("容错：代码块包裹 / 未知 kind / hour 越界 / 空 text 过滤", () => {
    const plan = parseDailyLife(
      "```json\n" +
        JSON.stringify({
          events: [
            { hour: 99, kind: "unknown", text: "店里打烊晚了半小时" },
            { hour: -3, kind: "work", text: "  " },
          ],
        }) +
        "\n```",
      "2026-10-21",
    );
    expect(plan?.events).toHaveLength(1);
    expect(plan?.events[0]?.hour).toBe(23);
    expect(plan?.events[0]?.kind).toBe("small");
  });

  it("最多保留 3 条；所有 text 为空时返回 null", () => {
    const many = parseDailyLife(
      JSON.stringify({
        events: [1, 2, 3, 4, 5].map((i) => ({ hour: i, kind: "small", text: `第${i}件小事` })),
      }),
      "2026-10-21",
    );
    expect(many?.events).toHaveLength(3);
    expect(parseDailyLife(JSON.stringify({ events: [{ text: "" }] }), "2026-10-21")).toBeNull();
    expect(parseDailyLife("不是 JSON", "2026-10-21")).toBeNull();
  });
});

describe("序列化 / 反序列化", () => {
  const plan = {
    day: "2026-10-21",
    createdAt: 1700000000000,
    events: [{ hour: 9, kind: "work" as const, text: "店里来了个熟客" }],
  };

  it("roundtrip 保持内容", () => {
    const restored = deserializeDailyLife(serializeDailyLife(plan));
    expect(restored?.day).toBe("2026-10-21");
    expect(restored?.events).toEqual(plan.events);
  });

  it("tomorrow 与 told 一起 roundtrip", () => {
    const withMeta = {
      day: "2026-10-21",
      createdAt: 1700000000000,
      events: [{ hour: 9, kind: "work" as const, text: "店里来了个熟客", told: true }],
      tomorrowPlan: "想去海边",
    };
    const restored = deserializeDailyLife(serializeDailyLife(withMeta));
    expect(restored?.tomorrowPlan).toBe("想去海边");
    expect(restored?.events[0]?.told).toBe(true);
  });

  it("坏数据返回 null，不抛异常", () => {
    expect(deserializeDailyLife("{")).toBeNull();
    expect(deserializeDailyLife(JSON.stringify({ day: "x" }))).toBeNull();
    expect(deserializeDailyLife(JSON.stringify({ events: [{ text: "  " }] }))).toBeNull();
  });
});

describe("formatDailyLife / pickLifeEvent / dailyLifeToSignals", () => {
  const events: DailyLifeEvent[] = [
    { hour: 9, kind: "work", text: "早班来了个熟客" },
    { hour: 14, kind: "cat", text: "五花把毛球踢到床底" },
    { hour: 20, kind: "goal", text: "拉花终于有点样子" },
  ];

  it("格式化带小时前缀", () => {
    expect(formatDailyLife(events)).toBe("09:00 早班来了个熟客；14:00 五花把毛球踢到床底；20:00 拉花终于有点样子");
  });

  it("只在已发生的条目里挑；都还没到时取第一条", () => {
    // 15 点时 9/14 点的两件都已发生 → 随机取其中一条（避免每轮都说同一句）
    expect([9, 14]).toContain(pickLifeEvent(events, 15)?.hour ?? -1);
    expect(pickLifeEvent(events, 9)?.hour).toBe(9);
    expect(pickLifeEvent(events, 7)?.hour).toBe(9);
    expect(pickLifeEvent([], 12)).toBeNull();
  });

  it("同一时段多条时随机源可复现", () => {
    const same = [
      { hour: 10, kind: "work" as const, text: "A" },
      { hour: 10, kind: "work" as const, text: "B" },
    ];
    expect(pickLifeEvent(same, 12, () => 0)?.text).toBe("A");
    expect(pickLifeEvent(same, 12, () => 0.99)?.text).toBe("B");
  });

  it("优先挑还没讲过的事件（P1-2）", () => {
    const withTold: DailyLifeEvent[] = [
      { hour: 9, kind: "work", text: "已经讲过的", told: true },
      { hour: 14, kind: "cat", text: "还没讲过的" },
    ];
    expect(pickLifeEvent(withTold, 15, () => 0)?.text).toBe("还没讲过的");
  });

  it("buildLifeHistoryInjection：近两天用过去时 + 今天已发生 + 明天计划", () => {
    const text = buildLifeHistoryInjection({
      today: [
        { hour: 9, kind: "work", text: "早班来了个熟客" },
        { hour: 20, kind: "goal", text: "晚上练拉花" },
      ],
      recent: [{ day: "2026-10-22", events: [{ hour: 15, kind: "goal", text: "练拉花郁金香" }], tomorrowPlan: "周末去海边" }],
      nowHour: 15,
      todayDay: "2026-10-23",
      todayTomorrow: "想去看电影",
    });
    expect(text).toContain("回忆，不是现在");
    expect(text).toContain("2026-10-22");
    expect(text).toContain("练拉花郁金香");
    expect(text).toContain("已经发生");
    expect(text).toContain("早班来了个熟客");
    expect(text).toContain("想去看电影");
    expect(text).not.toContain("晚上练拉花");
    expect(text).toContain("过去时");
  });

  it("转成信号句就是事件原文，且长度受控", () => {
    expect(dailyLifeToSignals(events)).toEqual(["早班来了个熟客", "五花把毛球踢到床底", "拉花终于有点样子"]);
    expect(DAILY_LIFE_MAX_CHARS).toBe(24);
  });
});
