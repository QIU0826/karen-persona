/**
 * M0：延迟门控的端到端行为测试。
 *
 * 回归点：旧实现里消息门判定 delay 后直接 return，用户消息既不落库也不补回复，
 * 用户看起来就是「消息被吞了」。这里验证：
 * - delay 时用户消息仍会保存
 * - 返回 deferred.delayMs，调用方可安排补回复
 * - 补回复模式（skipUserPersist）不会重复保存
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../ai/chat.js", () => ({
  chat: vi.fn(async () => "嗯。"),
  chatStream: async function* () {
    yield "嗯";
  },
}));

vi.mock("../impulse/message-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../impulse/message-gate.js")>();
  return {
    ...actual,
    decideGate: vi.fn(() => ({ type: "delay", reason: "测试：在忙", resumeAfterMs: 5_000 })),
  };
});

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-pipeline-"));
  process.env.KAREN_DATA_DIR = dir;
});

afterAll(() => {
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("processMessage 延迟门控", () => {
  it("delay 时保存用户消息并返回 deferred", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessage } = await import("./orchestrator.js");
    const config: import("../data/store.js").AppConfig = {
      persona: "xiaoya",
      her_name: "小雅",
      your_name: "你",
      location: "上海",
      tags: [],
      message_frequency_limit: 10,
      log_level: "info",
    };
    const persona = await loadPersona("xiaoya");
    const state = await initConversation(persona, config);

    const result = await processMessage(state, "在吗");

    expect(result.reply).toBe("");
    expect(result.deferred?.delayMs).toBe(5_000);
    expect(state.session.messages.at(-1)?.content).toBe("在吗");
    // 仍在内存的会话状态也应是同一条
    expect(state.session.messages.filter((m) => m.content === "在吗")).toHaveLength(1);
  });

  it("补回复模式（skipUserPersist）不会重复保存用户消息", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessage } = await import("./orchestrator.js");
    const config: import("../data/store.js").AppConfig = {
      persona: "xiaoya",
      her_name: "小雅",
      your_name: "你",
      location: "上海",
      tags: [],
      message_frequency_limit: 10,
      log_level: "info",
    };
    const persona = await loadPersona("xiaoya");
    const state = await initConversation(persona, config);

    await processMessage(state, "第一条"); // delay，保存一次
    await processMessage(state, "第一条", { bypassGate: true, skipUserPersist: true });

    expect(state.session.messages.filter((m) => m.content === "第一条")).toHaveLength(1);
  });
});
