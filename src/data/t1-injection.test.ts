/**
 * T1 快照 → 「最近状态弧」注入单测。
 *
 * 覆盖：空/单条返回空、趋势计算、脱敏（不引用对话正文）、DB 读取与显式 personaId。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-t1-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** 构造一条快照（默认新→旧数组里的元素） */
function snap(closeness: number, emotion: number, guilt = 0) {
  return {
    // content 故意带正文：注入块绝不能回放它
    content: "用户: 这是不该被注入的正文 | Karen: 也不该",
    emotionVector: emotion,
    closeness,
    guilt,
    summary: "[stream]",
  };
}

describe("buildT1ArcContext", () => {
  it("空表/单条快照返回空串（没有弧线可言）", async () => {
    const { buildT1ArcContext } = await import("./t1-injection.js");
    expect(buildT1ArcContext([])).toBe("");
    expect(buildT1ArcContext([snap(3, 0.1)])).toBe("");
  });

  it("按时间正序算趋势，且不引用对话正文", async () => {
    const { buildT1ArcContext } = await import("./t1-injection.js");
    // 新→旧：最新 3.2，最旧 3.0
    const note = buildT1ArcContext([snap(3.2, 0.4), snap(3.1, 0.2), snap(3.0, 0.1)]);
    expect(note).toContain("## 你最近几轮的状态");
    expect(note).toContain("最近 3 轮互动");
    expect(note).toContain("亲密度 3.00 → 3.20（升温）");
    expect(note).toContain("情绪 0.10 → 0.40（往上走）");
    // 脱敏：不出现消息正文
    expect(note).not.toContain("不该被注入");
    expect(note).not.toContain("用户:");
  });

  it("平稳状态不编造涨跌方向", async () => {
    const { buildT1ArcContext } = await import("./t1-injection.js");
    const note = buildT1ArcContext([snap(3, 0.2), snap(3, 0.21), snap(3, 0.2)]);
    expect(note).toContain("亲密度 3.00（平稳）");
    expect(note).toContain("（平稳）");
  });

  it("负债高时才提「还没还清」", async () => {
    const { buildT1ArcContext } = await import("./t1-injection.js");
    expect(buildT1ArcContext([snap(3, 0.2, 0.05), snap(3, 0.2, 0.1)])).not.toContain("负债");
    expect(buildT1ArcContext([snap(3, 0.2, 0.4), snap(3, 0.2, 0.35)])).toContain("负债 0.40（还没还清）");
  });

  it("异常/缺失字段的脏快照被过滤", async () => {
    const { buildT1ArcContext } = await import("./t1-injection.js");
    const dirty = [
      { content: "", emotionVector: Number.NaN, closeness: 3, guilt: 0 },
      snap(3.2, 0.3),
      snap(3.0, 0.1),
    ];
    const note = buildT1ArcContext(dirty as never);
    expect(note).toContain("最近 2 轮互动");
  });
});

describe("getT1ArcContext（DB 读取）", () => {
  it("读当前人设快照；切换人设后显式 personaId 仍能读到", async () => {
    const { insertT1Snapshot, setCurrentPersona } = await import("./vector.js");
    const { getT1ArcContext } = await import("./t1-injection.js");

    setCurrentPersona("小雅");
    insertT1Snapshot({ content: "旧", emotionVector: 0.1, closeness: 3.0, guilt: 0, summary: "[stream]" });
    insertT1Snapshot({ content: "新", emotionVector: 0.4, closeness: 3.2, guilt: 0, summary: "[stream]" });

    const current = getT1ArcContext();
    expect(current).toContain("亲密度 3.00 → 3.20（升温）");

    setCurrentPersona("秋瑶");
    expect(getT1ArcContext()).toBe("");
    expect(getT1ArcContext("小雅")).toContain("## 你最近几轮的状态");
  });
});
