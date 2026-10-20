/**
 * 检索增强（DeepSeek 重排）单测。
 *
 * 覆盖：重排顺序生效、模型输出非法/异常/超时全部降级原顺序、关闭开关不调模型、
 * 编号解析容错。全部用 mock chat，不联网。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  chat: vi.fn(async (): Promise<string> => "[]"),
}));

vi.mock("../ai/chat.js", () => ({
  chat: mocked.chat,
  withThinking: <T,>(value: T): T => value,
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-boost-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.KAREN_SEMANTIC_BOOST;
  delete process.env.KAREN_SEMANTIC_BOOST_TIMEOUT_MS;
  mocked.chat.mockReset();
  mocked.chat.mockResolvedValue("[]");
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  delete process.env.KAREN_SEMANTIC_BOOST;
  delete process.env.KAREN_SEMANTIC_BOOST_TIMEOUT_MS;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** 动态加载同一模块图并种入 3 条彼此不同的咖啡记忆。 */
async function seedAndLoad() {
  const embedding = await import("./embedding.js");
  const vector = await import("./vector.js");
  const retriever = await import("./retriever.js");
  const boost = await import("./retrieval-boost.js");

  vector.setCurrentPersona("小雅");
  const contents = [
    "用户说最喜欢喝咖啡，尤其是手冲咖啡",
    "用户说冬天喜欢喝热咖啡",
    "用户说楼下咖啡店排队很久",
  ];
  const ids = contents.map((content) => vector.insertEpisodeWithEmbedding(content, "chat", embedding.generateEmbedding(content)));
  return { vector, retriever, boost, ids, contents };
}

describe("parseRerankOrder", () => {
  it("解析 JSON 数组，容忍包裹文本与越界/重复编号", async () => {
    const { boost } = await seedAndLoad();
    expect(boost.parseRerankOrder("[3,1,2]", 3)).toEqual([3, 1, 2]);
    expect(boost.parseRerankOrder('结果如下：```json\n[2, 2, 99, 0, 1]\n```', 3)).toEqual([2, 1]);
    expect(boost.parseRerankOrder("我不确定", 3)).toBeNull();
    expect(boost.parseRerankOrder("[]", 3)).toBeNull();
    expect(boost.parseRerankOrder("[1]", 0)).toBeNull();
  });
});

describe("retrieveWithLlmBoost", () => {
  it("默认开启：按模型给出的顺序重排候选", async () => {
    const { retriever, boost } = await seedAndLoad();
    const pool = await retriever.retrieveRelevantMemoriesAsync("咖啡", 12);
    expect(pool.length).toBeGreaterThanOrEqual(3);

    mocked.chat.mockResolvedValueOnce("[3,1,2]");
    const logs: string[] = [];
    const result = await boost.retrieveWithLlmBoost("咖啡", 3, { onLog: (line) => logs.push(line) });

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(pool[2].id);
    expect(result[1].id).toBe(pool[0].id);
    expect(result[2].id).toBe(pool[1].id);
    expect(logs.some((line) => line.includes("DeepSeek 重排"))).toBe(true);
  });

  it("模型输出非法 JSON：降级原顺序并记日志", async () => {
    const { retriever, boost } = await seedAndLoad();
    const pool = await retriever.retrieveRelevantMemoriesAsync("咖啡", 12);

    mocked.chat.mockResolvedValueOnce("我不知道（不是 JSON）");
    const logs: string[] = [];
    const result = await boost.retrieveWithLlmBoost("咖啡", 3, { onLog: (line) => logs.push(line) });

    expect(result.map((item) => item.id)).toEqual(pool.slice(0, 3).map((item) => item.id));
    expect(logs.some((line) => line.includes("无有效输出"))).toBe(true);
  });

  it("模型调用抛错：降级原顺序，不影响回复", async () => {
    const { retriever, boost } = await seedAndLoad();
    const pool = await retriever.retrieveRelevantMemoriesAsync("咖啡", 12);

    mocked.chat.mockRejectedValueOnce(new Error("模拟网络错误"));
    const logs: string[] = [];
    const result = await boost.retrieveWithLlmBoost("咖啡", 3, { onLog: (line) => logs.push(line) });

    expect(result.map((item) => item.id)).toEqual(pool.slice(0, 3).map((item) => item.id));
    expect(logs.some((line) => line.includes("重排降级"))).toBe(true);
  });

  it("超时：快速降级原顺序（不阻塞主回复）", async () => {
    const { retriever, boost } = await seedAndLoad();
    const pool = await retriever.retrieveRelevantMemoriesAsync("咖啡", 12);

    process.env.KAREN_SEMANTIC_BOOST_TIMEOUT_MS = "50";
    mocked.chat.mockImplementationOnce(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("[1]"), 300)),
    );
    const logs: string[] = [];
    const startedAt = Date.now();
    const result = await boost.retrieveWithLlmBoost("咖啡", 3, { onLog: (line) => logs.push(line) });
    const elapsed = Date.now() - startedAt;

    expect(result.map((item) => item.id)).toEqual(pool.slice(0, 3).map((item) => item.id));
    expect(logs.some((line) => line.includes("重排降级"))).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("KAREN_SEMANTIC_BOOST=off：完全不调模型，直接返回原顺序", async () => {
    const { retriever, boost } = await seedAndLoad();
    const pool = await retriever.retrieveRelevantMemoriesAsync("咖啡", 12);

    process.env.KAREN_SEMANTIC_BOOST = "off";
    const result = await boost.retrieveWithLlmBoost("咖啡", 3);

    expect(mocked.chat).not.toHaveBeenCalled();
    expect(result.map((item) => item.id)).toEqual(pool.slice(0, 3).map((item) => item.id));
  });

  it("候选过少（<3 条）跳过重排，省一次调用/延迟", async () => {
    const { vector, boost } = await seedAndLoad();
    void vector;
    // seedAndLoad 种了 3 条；这里只用其中 1 条命中，构造候选不足的场景
    const embedding = await import("./embedding.js");
    const solo = await import("./vector.js");
    solo.setCurrentPersona("小雅-单条");
    const content = "用户说最喜欢喝咖啡";
    solo.insertEpisodeWithEmbedding(content, "chat", embedding.generateEmbedding(content));
    // 人设隔离：当前人设只有 1 条
    const result = await boost.retrieveWithLlmBoost("咖啡", 3);
    expect(Array.isArray(result)).toBe(true);
    expect(mocked.chat).not.toHaveBeenCalled();
  });

  it("过短输入（如单个语气词）跳过重排，省一次调用", async () => {
    const { boost } = await seedAndLoad();
    const result = await boost.retrieveWithLlmBoost("嗯", 3);
    expect(Array.isArray(result)).toBe(true);
    expect(mocked.chat).not.toHaveBeenCalled();
  });
});
