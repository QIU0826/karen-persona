import { describe, expect, it } from "vitest";
import {
  DEFERRED_IMPULSE_TTL_MS,
  buildDeferredCandidate,
  createDeferredImpulse,
  inQuietHours,
  normalizeDeferredImpulse,
  resolveDeferredImpulse,
  type DeferredImpulse,
} from "./initiative-defer.js";

const NOW = new Date("2026-10-21T08:30:00+08:00").getTime();
const NIGHT = new Date("2026-10-20T23:40:00+08:00").getTime();

function impulse(overrides: Partial<DeferredImpulse> = {}): DeferredImpulse {
  return {
    at: NIGHT,
    source: "因果链",
    description: "店里今天来了个很难缠的客人，你想吐槽",
    intensity: 0.6,
    ...overrides,
  };
}

describe("免打扰判断", () => {
  it("默认 23–7 点跨夜（小时粒度，与 config 一致）", () => {
    expect(inQuietHours(23)).toBe(true);
    expect(inQuietHours(2)).toBe(true);
    expect(inQuietHours(6)).toBe(true);
    expect(inQuietHours(7)).toBe(false);
    expect(inQuietHours(12)).toBe(false);
  });

  it("支持自定义时段，start==end 视为关闭", () => {
    expect(inQuietHours(22, { startHour: 22, endHour: 6 })).toBe(true);
    expect(inQuietHours(21, { startHour: 22, endHour: 6 })).toBe(false);
    expect(inQuietHours(3, { startHour: 23, endHour: 23 })).toBe(false);
  });
});

describe("resolveDeferredImpulse", () => {
  it("没有记录 → none", () => {
    expect(
      resolveDeferredImpulse({
        deferred: null,
        now: NOW,
        hour: 8,
        userLastMessageAt: null,
        lastProactiveSentAt: null,
      }).action
    ).toBe("none");
  });

  it("早上 8:30 且没人打扰 → reuse", () => {
    const result = resolveDeferredImpulse({
      deferred: impulse(),
      now: NOW,
      hour: 8,
      userLastMessageAt: null,
      lastProactiveSentAt: null,
    });
    expect(result.action).toBe("reuse");
    if (result.action === "reuse") expect(result.reason).toBe("morning_pickup");
  });

  it("他之后回了消息 → drop（已经聊上，旧冲动过期）", () => {
    const result = resolveDeferredImpulse({
      deferred: impulse(),
      now: NOW,
      hour: 8,
      userLastMessageAt: NIGHT + 60 * 60 * 1000,
      lastProactiveSentAt: null,
    });
    expect(result).toEqual({ action: "drop", reason: "user_replied_since" });
  });

  it("她之后已经主动发过 → drop", () => {
    const result = resolveDeferredImpulse({
      deferred: impulse(),
      now: NOW,
      hour: 8,
      userLastMessageAt: null,
      lastProactiveSentAt: NIGHT + 30 * 60 * 1000,
    });
    expect(result).toEqual({ action: "drop", reason: "already_sent_since" });
  });

  it("超过 12 小时 → drop（不拿昨天的事硬说）", () => {
    const result = resolveDeferredImpulse({
      deferred: impulse({ at: NOW - DEFERRED_IMPULSE_TTL_MS - 1 }),
      now: NOW,
      hour: 8,
      userLastMessageAt: null,
      lastProactiveSentAt: null,
    });
    expect(result).toEqual({ action: "drop", reason: "stale" });
  });

  it("还在免打扰时段 → wait（等天亮）", () => {
    const result = resolveDeferredImpulse({
      deferred: impulse({ at: new Date("2026-10-21T02:00:00+08:00").getTime() }),
      now: new Date("2026-10-21T05:30:00+08:00").getTime(),
      hour: 5,
      userLastMessageAt: null,
      lastProactiveSentAt: null,
    });
    expect(result).toEqual({ action: "wait", reason: "still_quiet_hours" });
  });

  it("时钟倒退 / 空描述 → drop", () => {
    expect(
      resolveDeferredImpulse({
        deferred: impulse({ at: NOW + 60_000 }),
        now: NOW,
        hour: 8,
        userLastMessageAt: null,
        lastProactiveSentAt: null,
      }).action
    ).toBe("drop");
    expect(
      resolveDeferredImpulse({
        deferred: impulse({ description: "   " }),
        now: NOW,
        hour: 8,
        userLastMessageAt: null,
        lastProactiveSentAt: null,
      }).action
    ).toBe("drop");
  });
});

describe("候选构造与归一化", () => {
  it("补发候选：高优先级、描述不露出系统/延迟字样", () => {
    const candidate = buildDeferredCandidate(impulse());
    expect(candidate.priority).toBe(8);
    expect(candidate.description).toContain("店里今天来了个很难缠的客人");
    expect(candidate.description).not.toMatch(/系统|延迟|被挡|等了一晚上/);
    expect(candidate.description).toContain("昨晚没发出去");
  });

  it("createDeferredImpulse 保留来源/素材/强度", () => {
    const created = createDeferredImpulse(NOW, {
      source: "情绪",
      description: "有点闷，想说说话",
      intensity: 0.4,
    });
    expect(created).toEqual({
      at: NOW,
      source: "情绪",
      description: "有点闷，想说说话",
      intensity: 0.4,
    });
  });

  it("normalizeDeferredImpulse：坏数据回退 null，好数据截断长度", () => {
    expect(normalizeDeferredImpulse(null)).toBeNull();
    expect(normalizeDeferredImpulse({ at: 0, description: "x" })).toBeNull();
    expect(normalizeDeferredImpulse({ at: NOW, description: "  " })).toBeNull();
    const long = normalizeDeferredImpulse({
      at: NOW,
      source: "天气",
      description: "雨".repeat(500),
      intensity: 0.5,
    });
    expect(long).not.toBeNull();
    expect(long!.description.length).toBe(200);
    expect(long!.intensity).toBe(0.5);
  });
});
