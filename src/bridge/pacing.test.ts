import { describe, expect, it } from "vitest";
import {
  DEFAULT_NIGHT_SLOWDOWN,
  DEFAULT_TYPING_WPM,
  isNightHour,
  planPacing,
  typingTimeFor,
} from "./pacing.js";

const fixed = (v: number) => () => v;

describe("isNightHour", () => {
  it("23:00–06:00 是深夜", () => {
    for (const h of [23, 0, 3, 5]) expect(isNightHour(h)).toBe(true);
    for (const h of [6, 9, 14, 22]) expect(isNightHour(h)).toBe(false);
  });
});

describe("planPacing：基础", () => {
  it("默认人设下每字耗时在合理区间（≈250ms）", () => {
    const plan = planPacing({ hour: 14 }, fixed(0.5));
    const expected = 60_000 / DEFAULT_TYPING_WPM;
    expect(plan.perCharMs).toBeGreaterThan(expected * 0.8);
    expect(plan.perCharMs).toBeLessThan(expected * 1.2);
    expect(plan.profile).toBe("normal");
  });

  it("打字快的人设明显更快", () => {
    const slow = planPacing({ hour: 14, persona: { typingWpm: 150 } }, fixed(0.5));
    const fast = planPacing({ hour: 14, persona: { typingWpm: 300 } }, fixed(0.5));
    expect(fast.perCharMs).toBeLessThan(slow.perCharMs);
    // 档位是给人看的粗标签（<180 fast / >300 slow），这里只校验慢档：
    // 150 字/分 = 400ms/字，固定落在 slow
    expect(slow.profile).toBe("slow");
  });

  it("深夜更慢，且读到消息到开始打字更久", () => {
    const day = planPacing({ hour: 14 }, fixed(0.5));
    const night = planPacing({ hour: 2 }, fixed(0.5));
    expect(night.perCharMs).toBeGreaterThan(day.perCharMs);
    expect(night.readDelayMs).toBeGreaterThan(day.readDelayMs);
  });

  it("人设可覆盖深夜变慢系数", () => {
    const night = planPacing({ hour: 2, persona: { nightSlowdown: 2 } }, fixed(0.5));
    const day = planPacing({ hour: 14 }, fixed(0.5));
    expect(night.perCharMs / day.perCharMs).toBeGreaterThan(DEFAULT_NIGHT_SLOWDOWN);
  });

  it("开心时打得快，低落时略慢", () => {
    const neutral = planPacing({ hour: 14, emotionVector: 0.05 }, fixed(0.5));
    const happy = planPacing({ hour: 14, emotionVector: 0.8 }, fixed(0.5));
    const sad = planPacing({ hour: 14, emotionVector: -0.8 }, fixed(0.5));
    expect(happy.perCharMs).toBeLessThan(neutral.perCharMs);
    expect(sad.perCharMs).toBeGreaterThan(neutral.perCharMs);
  });

  it("忙的时候不是打字慢，而是很久才开始回", () => {
    const idle = planPacing({ hour: 14, busyness: 0 }, fixed(0.5));
    const busy = planPacing({ hour: 14, busyness: 0.95 }, fixed(0.5));
    expect(busy.readDelayMs).toBeGreaterThan(idle.readDelayMs * 2);
    expect(busy.perCharMs).toBeLessThan(idle.perCharMs);
  });

  it("条间间隔受 burstiness 影响", () => {
    const normal = planPacing({ hour: 14, persona: { burstiness: 1 } }, fixed(0.5));
    const burst = planPacing({ hour: 14, persona: { burstiness: 1.6 } }, fixed(0.5));
    expect(burst.gapMs).toBeLessThan(normal.gapMs);
  });

  it("犹豫是概率事件：随机值高时不触发，低时触发", () => {
    const noHesitate = planPacing({ hour: 14, persona: { hesitation: 0 } }, fixed(0));
    expect(noHesitate.hesitationMs).toBe(0);
    const hesitate = planPacing({ hour: 14, persona: { hesitation: 1 } }, fixed(0.2));
    expect(hesitate.hesitationMs).toBeGreaterThan(500);
  });

  it("每字耗时与上限都被夹住，不会算出负数或离谱值", () => {
    for (const wpm of [100, 400]) {
      for (const random of [0, 1]) {
        const plan = planPacing({ hour: 2, persona: { typingWpm: wpm } }, fixed(random));
        expect(plan.perCharMs).toBeGreaterThanOrEqual(90);
        expect(plan.perCharMs).toBeLessThanOrEqual(420);
        expect(plan.capMs).toBeGreaterThan(0);
      }
    }
  });

  it("可复现：同一随机序列结果一致", () => {
    const a = planPacing({ hour: 21, emotionVector: 0.4, busyness: 0.3 }, fixed(0.33));
    const b = planPacing({ hour: 21, emotionVector: 0.4, busyness: 0.3 }, fixed(0.33));
    expect(a).toEqual(b);
  });
});

describe("typingTimeFor", () => {
  it("按字数线性增长，但不超过单条上限", () => {
    const plan = planPacing({ hour: 14 }, fixed(0.5));
    const short = typingTimeFor("你好呀", plan);
    const long = typingTimeFor("啊".repeat(100), plan);
    expect(short).toBeLessThan(long);
    expect(long).toBeLessThanOrEqual(plan.capMs);
  });

  it("空文本返回 0", () => {
    const plan = planPacing({ hour: 14 }, fixed(0.5));
    expect(typingTimeFor("", plan)).toBe(0);
  });
});
