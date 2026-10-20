/**
 * 长跑回归指标汇总单测（纯函数，不联网）。
 */
import { describe, expect, it } from "vitest";
import { LONGRUN_SCENARIO, summarizeLongRun, type LongRunReply } from "./longrun-sim.js";

function row(turn: number, reply: string, latencyMs = 500): LongRunReply {
  return {
    turn,
    label: LONGRUN_SCENARIO[turn - 1]?.label ?? "chat",
    user: LONGRUN_SCENARIO[turn - 1]?.text ?? `第${turn}轮`,
    reply,
    latencyMs,
    logs: [],
  };
}

describe("LONGRUN_SCENARIO", () => {
  it("30 轮混合场景，包含事实/记忆/重复施压", () => {
    expect(LONGRUN_SCENARIO).toHaveLength(30);
    expect(LONGRUN_SCENARIO.filter((turn) => turn.label === "memory").length).toBeGreaterThanOrEqual(4);
    expect(LONGRUN_SCENARIO.filter((turn) => turn.label === "repeat").length).toBeGreaterThanOrEqual(4);
  });
});

describe("summarizeLongRun", () => {
  it("记忆检查按 expect 子串判定；延迟统计正确", () => {
    const replies = [
      row(1, "你好"),
      row(9, "林哲啊，怎么突然问", 1200),
      row(10, "这个我也不知道", 800), // turn 10 期望「咖啡」→ 失败
      row(11, "团子啊，那只橘猫", 400),
    ];
    const metrics = summarizeLongRun(replies);
    expect(metrics.memoryChecks).toHaveLength(3); // 只统计已回复且场景带 expect 的轮次
    const passed = metrics.memoryChecks.filter((check) => check.pass);
    expect(passed.map((check) => check.turn)).toEqual([9, 11]);
    expect(metrics.memoryPassRate).toBeCloseTo(2 / 3, 2);
    expect(metrics.maxLatencyMs).toBe(1200);
    expect(metrics.avgLatencyMs).toBeGreaterThan(0);
  });

  it("质量 flags：括号/逗号结尾/记忆防御/超长行/空回复", () => {
    const replies = [
      row(1, "（点开图片）你这张拍得不错"),
      row(2, "我先去忙一下，"),
      row(3, "是不是又要考我，我记性没那么差"),
      row(4, "这是一句特别特别长的回复内容用来测试超过三十个字的行会不会被标记出来"),
      row(5, ""),
      row(6, "嗯"),
    ];
    const metrics = summarizeLongRun(replies);
    expect(metrics.flags.bracketTurns).toEqual([1]);
    expect(metrics.flags.trailingCommaTurns).toEqual([2]);
    expect(metrics.flags.memoryDeflectionTurns).toEqual([3]);
    expect(metrics.flags.longLineTurns).toContain(4);
    expect(metrics.flags.emptyTurns).toEqual([5]);
  });

  it("复读对用 detectRepetition 统计相邻回复", () => {
    const replies = [row(1, "今天真的好累啊"), row(2, "今天真的好累啊"), row(3, "行吧")];
    const metrics = summarizeLongRun(replies);
    expect(metrics.duplicatePairs).toBe(1);
    expect(metrics.maxRepetitionScore).toBe(1);
    expect(metrics.avgRepetitionScore).toBeGreaterThan(0);
  });

  it("错误轮次不计入空回复/质量统计，但记录在 errors", () => {
    const replies: LongRunReply[] = [
      row(1, "嗯"),
      { turn: 2, label: "chat", user: "x", reply: "", latencyMs: 10, error: "boom", logs: [] },
    ];
    const metrics = summarizeLongRun(replies);
    expect(metrics.errors).toEqual([{ turn: 2, error: "boom" }]);
    expect(metrics.flags.emptyTurns).toEqual([]);
  });
});
