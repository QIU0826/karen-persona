/**
 * 事实抽取排队单测：连发多条消息时，节流窗口内的事实不丢。
 * 全部 mock（不联网、不读真实 Key），临时数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

let dir: string;

function completionFor(prompt: string) {
  const facts: Array<{ key: string; value: string; category: string }> = [];
  if (prompt.includes("林哲")) facts.push({ key: "name", value: "林哲", category: "profile" });
  if (prompt.includes("团子")) facts.push({ key: "pet", value: "橘猫叫团子", category: "pet" });
  if (prompt.includes("云南")) facts.push({ key: "plan", value: "下周三去云南出差", category: "plan" });
  return {
    choices: [{ message: { content: JSON.stringify({ facts }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-facts-queue-"));
  process.env.KAREN_DATA_DIR = dir;
  // getChatModel() 需要 Key（mock 后不会真的联网）
  process.env.DEEPSEEK_API_KEY = "sk-test-key";
  vi.resetModules();
  vi.useFakeTimers();
  createMock.mockReset();
  createMock.mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
    const prompt = params.messages.map((message) => message.content).join("\n");
    return completionFor(prompt);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.KAREN_DATA_DIR;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const vector = await import("./vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("extractUserFactsAsync：节流窗口内排队补抽", () => {
  it("连发三条消息时，后两条合并且不丢宠物/计划事实", async () => {
    const mod = await import("./user-facts.js");

    // 第一条立即抽（林哲）
    mod.extractUserFactsAsync("qq:queue", "我叫林哲，在杭州做产品设计。", "你好林哲");
    // 后两条在 1.5s 节流窗口内 → 排队合并
    mod.extractUserFactsAsync("qq:queue", "我养了只橘猫叫团子。", "橘子猫可爱");
    mod.extractUserFactsAsync("qq:queue", "下周三去云南出差。", "出差顺利");

    await vi.advanceTimersByTimeAsync(0);
    expect(createMock).toHaveBeenCalledTimes(1);

    // 等节流窗口结束 → 排队消息合并成一次补抽
    await vi.advanceTimersByTimeAsync(2000);
    expect(createMock.mock.calls.length).toBe(2);

    const prompts = createMock.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(prompts[1]).toContain("团子");
    expect(prompts[1]).toContain("云南");

    const facts = mod.listUserFacts("qq:queue");
    const keys = facts.map((fact) => fact.key).sort();
    expect(keys).toEqual(["name", "pet", "plan"]);
  });

  it("resetFactExtractionThrottle 清空排队，不再补抽", async () => {
    const mod = await import("./user-facts.js");
    mod.extractUserFactsAsync("qq:reset", "我叫林哲，在杭州做产品设计。", "你好");
    mod.extractUserFactsAsync("qq:reset", "我养了只橘猫叫团子。", "可爱");
    mod.resetFactExtractionThrottle();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
