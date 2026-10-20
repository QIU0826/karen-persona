import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES,
  SIM_MIN_GAP_MINUTES,
  SIM_QUIET_HOURS,
  checkRedlines,
  simulateDay,
} from "./initiative-sim.js";

describe("意图式主动离线模拟（v0.8.13）", () => {
  it("四种关系热度都跑得出来，且产品红线全过", () => {
    const results = DEFAULT_PROFILES.map(simulateDay);
    expect(results.map((r) => r.profile)).toEqual(["热络", "正常", "冷淡", "生疏"]);
    expect(checkRedlines(results)).toEqual([]);
  });

  it("回复率高 → 日上限更高、发得更多；回复率低 → 一条不发", () => {
    const results = DEFAULT_PROFILES.map(simulateDay);
    const by = new Map(results.map((r) => [r.profile, r]));
    expect(by.get("热络")!.cap).toBeGreaterThan(by.get("正常")!.cap);
    expect(by.get("冷淡")!.cap).toBe(0);
    expect(by.get("冷淡")!.sent).toHaveLength(0);
  });

  it("免打扰时段（02:00–07:00）一条都不发", () => {
    for (const r of DEFAULT_PROFILES.map(simulateDay)) {
      for (const item of r.sent) {
        const hour = Math.floor(item.minuteOfDay / 60);
        expect(hour >= SIM_QUIET_HOURS.start && hour < SIM_QUIET_HOURS.end).toBe(false);
      }
    }
  });

  it("同一天两条主动消息至少隔 30 分钟", () => {
    for (const r of DEFAULT_PROFILES.map(simulateDay)) {
      for (let i = 1; i < r.sent.length; i++) {
        expect(r.sent[i]!.minuteOfDay - r.sent[i - 1]!.minuteOfDay).toBeGreaterThanOrEqual(
          SIM_MIN_GAP_MINUTES,
        );
      }
    }
  });

  it("亲密度低时不会发「有点想他」", () => {
    const distant = simulateDay(DEFAULT_PROFILES.find((p) => p.day === "生疏")!);
    expect(distant.sent.some((s) => s.kind === "missing_you")).toBe(false);
  });

  it("每条由头当天只用一次", () => {
    const hot = simulateDay(DEFAULT_PROFILES.find((p) => p.day === "热络")!);
    const topics = hot.sent.map((s) => s.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it("红线检查能抓出违规（自检：故意造一个免打扰时段发送）", () => {
    const bad = simulateDay(DEFAULT_PROFILES[0]!);
    bad.sent.push({ minuteOfDay: 3 * 60, topic: "越界", kind: "life_event" });
    const failures = checkRedlines([bad]);
    expect(failures.some((f) => f.message.includes("免打扰"))).toBe(true);
  });
});
