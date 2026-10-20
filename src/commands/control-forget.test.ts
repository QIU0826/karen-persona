/**
 * /forget：按关键词删除 T2 记忆（先预览，--yes 才删）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-forget-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const vector = await import("../data/vector.js");
  const control = await import("./control.js");
  vector.setCurrentPersona("xiaoya");
  vector.insertEpisode("店里认识的呀 你老坐吧台", "chat", 0.2);
  vector.insertEpisode("用户喜欢下雨天", "chat", 0.3);
  const replies: string[] = [];
  const deps = {
    reply: (text: string) => replies.push(text),
    persist: vi.fn(),
    exportData: vi.fn(),
  };
  return { vector, control, replies, deps };
}

describe("/forget", () => {
  it("默认只预览，不删除", async () => {
    const { vector, control, replies, deps } = await setup();
    const handled = await control.handleControlCommand("/forget 店里", {} as never, deps);
    expect(handled).toBe(true);
    expect(replies[0]).toContain("找到 1 条包含「店里」的记忆");
    expect(replies[0]).toContain("你老坐吧台");
    expect(replies[0]).toContain("--yes");
    // 仍然存在
    expect(vector.searchEpisodesByKeyword("店里", 10)).toHaveLength(1);
  });

  it("带 --yes 才真正删除匹配记忆，不误删其他记忆", async () => {
    const { vector, control, replies, deps } = await setup();
    await control.handleControlCommand("/forget 店里 --yes", {} as never, deps);
    expect(replies[0]).toContain("已删除 1 条");
    expect(vector.searchEpisodesByKeyword("店里", 10)).toHaveLength(0);
    expect(vector.searchEpisodesByKeyword("下雨", 10)).toHaveLength(1);
  });

  it("无匹配 / 无参数都给出明确提示", async () => {
    const { control, replies, deps } = await setup();
    await control.handleControlCommand("/forget 不存在 --yes", {} as never, deps);
    expect(replies[0]).toContain("没有找到包含「不存在」的记忆");
    await control.handleControlCommand("/forget", {} as never, deps);
    expect(replies[1]).toContain("用法：/forget 关键词");
    await control.handleControlCommand("/forget --yes", {} as never, deps);
    expect(replies[2]).toContain("用法：/forget 关键词");
  });

  it("多用户：/forget 只操作本 state 的存储 persona，不受全局 current persona 影响", async () => {
    const { vector, control, replies, deps } = await setup();
    // 给 xiaoya 留一条；把全局 current 切到 suchi（模拟刚处理过其他用户）
    vector.setCurrentPersona("xiaoya");
    vector.insertEpisode("xiaoya 的私密记忆 雨天", "chat", 0.3);
    vector.setCurrentPersona("suchi");
    const state = { storagePersona: "xiaoya" };
    await control.handleControlCommand("/forget 私密 --yes", state as never, deps);
    expect(replies[0]).toContain("已删除 1 条");
    expect(vector.searchEpisodesByKeyword("私密", 10, "xiaoya")).toHaveLength(0);
  });
});
