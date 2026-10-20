/**
 * 记忆相对时间标签单测（纯函数，固定 now，不依赖真实时钟）。
 */
import { describe, expect, it } from "vitest";
import { formatMemoryTime, formatMemoryTimeTag } from "./relative-time.js";

// 本地时区 2026-10-20 12:00
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();

function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0).getTime();
}

describe("formatMemoryTime", () => {
  it("同一天：刚刚/分钟/小时", () => {
    expect(formatMemoryTime(NOW - 30 * 1000, NOW)).toBe("刚刚");
    expect(formatMemoryTime(NOW - 10 * 60 * 1000, NOW)).toBe("10分钟前");
    expect(formatMemoryTime(NOW - 3 * 60 * 60 * 1000, NOW)).toBe("3小时前");
  });

  it("按本地日历日：今天/昨天/前天/N天前", () => {
    expect(formatMemoryTime(at(2026, 10, 20, 1), NOW)).toBe("11小时前");
    expect(formatMemoryTime(at(2026, 10, 19, 23), NOW)).toBe("昨天");
    expect(formatMemoryTime(at(2026, 10, 18, 12), NOW)).toBe("前天");
    expect(formatMemoryTime(at(2026, 10, 16, 12), NOW)).toBe("4天前");
    expect(formatMemoryTime(at(2026, 10, 11, 12), NOW)).toBe("上周");
  });

  it("更久远：周/月/年", () => {
    expect(formatMemoryTime(at(2026, 9, 20, 12), NOW)).toBe("4周前");
    expect(formatMemoryTime(at(2026, 6, 20, 12), NOW)).toBe("4个月前");
    expect(formatMemoryTime(at(2024, 10, 20, 12), NOW)).toBe("2年前");
  });

  it("非法/空/未来时间安全处理", () => {
    expect(formatMemoryTime(null, NOW)).toBe("");
    expect(formatMemoryTime(undefined, NOW)).toBe("");
    expect(formatMemoryTime(0, NOW)).toBe("");
    expect(formatMemoryTime(Number.NaN, NOW)).toBe("");
    expect(formatMemoryTime(NOW + 60_000, NOW)).toBe("刚刚");
  });

  it("formatMemoryTimeTag 只给非空标签加方括号", () => {
    expect(formatMemoryTimeTag(NOW - 2 * 60 * 60 * 1000, NOW)).toBe("[2小时前]");
    expect(formatMemoryTimeTag(null, NOW)).toBe("");
  });
});
