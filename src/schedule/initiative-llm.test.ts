/**
 * 主动计划序列化/反序列化单测（v0.8.21 覆盖率核对补上的缺口）。
 *
 * 存表用 serializePlan，读回用 deserializePlan——坏数据必须返回 null 而不是抛异常，
 * 否则一次脏数据会让「今日由头」整条链路挂掉。
 */
import { describe, expect, it } from "vitest";
import { deserializePlan, serializePlan } from "./initiative-llm.js";
import type { DailyInitiativePlan } from "../impulse/initiative-plan.js";

const PLAN: DailyInitiativePlan = {
  day: "2026-10-21",
  createdAt: 1_800_000_000_000,
  items: [
    {
      topic: "下午被老板叫去谈话，有点闷",
      kind: "life_event",
      windowStart: 19,
      windowEnd: 23,
      urgency: 0.62,
      used: false,
    },
    {
      topic: "裁员的传闻到底怎么样了",
      kind: "open_thread",
      windowStart: 21,
      windowEnd: 24,
      urgency: 0.41,
      used: true,
    },
  ],
};

describe("serializePlan / deserializePlan", () => {
  it("往返一致（含 used 标记与时间窗）", () => {
    const json = serializePlan(PLAN);
    const back = deserializePlan(json);
    expect(back).toEqual(PLAN);
  });

  it("坏 JSON → null（不抛异常）", () => {
    expect(deserializePlan("{not json")).toBeNull();
    expect(deserializePlan("")).toBeNull();
  });

  it("结构不对（没有 items 数组）→ null", () => {
    expect(deserializePlan(JSON.stringify({ day: "2026-10-21" }))).toBeNull();
    expect(deserializePlan(JSON.stringify({ items: "nope" }))).toBeNull();
    expect(deserializePlan("null")).toBeNull();
  });

  it("items 为空数组是合法计划（当天没有由头）", () => {
    const empty = { day: "2026-10-21", createdAt: 0, items: [] };
    expect(deserializePlan(serializePlan(empty))).toEqual(empty);
  });
});
