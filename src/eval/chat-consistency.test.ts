import { describe, expect, it } from "vitest";
import { evaluateConsistency } from "./chat-consistency.js";

const T0 = new Date(2026, 9, 23, 15, 0).getTime();

function msg(content: string, minutes: number) {
  return { role: "assistant", content, timestamp: T0 + minutes * 60_000 };
}

describe("evaluateConsistency", () => {
  it("30 分钟内先忙后闲 → busy_idle", () => {
    const report = evaluateConsistency([
      msg("刚来一桌三个人的，忙死了", 0),
      msg("还好，就是练拉花老散", 12),
    ]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.kind).toBe("busy_idle");
    expect(report.score).toBe(80);
  });

  it("在店/在家混说 → shop_home", () => {
    const report = evaluateConsistency([
      msg("我在店里呢", 0),
      msg("回家躺沙发上了", 6),
    ]);
    expect(report.issues[0]?.kind).toBe("shop_home");
  });

  it("超出 30 分钟窗口/同一句不判矛盾", () => {
    const report = evaluateConsistency([
      msg("店里忙死了", 0),
      msg("现在还好，不忙了", 90),
    ]);
    expect(report.issues).toEqual([]);
    expect(report.score).toBe(100);
  });

  it("空输入/非 assistant 安全", () => {
    expect(evaluateConsistency([])).toMatchObject({ checkedMessages: 0, score: 100 });
  });
});
