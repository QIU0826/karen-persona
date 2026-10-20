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

/** 捕获 LLM 调用参数，用于断言 prompt 里注入了什么（不真正发请求） */
const captured = vi.hoisted(() => ({
  chatCalls: [] as Array<Array<{ role: string; content: string }>>,
  chatStreamCalls: [] as Array<Array<{ role: string; content: string }>>,
}));

vi.mock("../ai/chat.js", () => ({
  chat: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
    captured.chatCalls.push(messages);
    return "嗯。";
  }),
  chatStream: async function* (messages: Array<{ role: string; content: string }>) {
    captured.chatStreamCalls.push(messages);
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

describe("M1-1/M1-2 重启恢复与关系成长", () => {
  it("重启后恢复关系亲密度、里程碑与情绪状态", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, persistRuntimeState } = await import("./orchestrator.js");
    const { applyRelationshipEvent, createRelationshipState } = await import(
      "../persona/relationship.js"
    );
    const config: import("../data/store.js").AppConfig = {
      persona: "xiaoya",
      her_name: "小雅",
      your_name: "你",
      location: "上海",
      tags: [],
      message_frequency_limit: 10,
      log_level: "info",
      one_bot_ws_host: "127.0.0.1",
      one_bot_ws_port: 18080,
      one_bot_ws_path: "/onebot/v11/ws",
      allowed_users: [],
    };

    const persona = await loadPersona("xiaoya");
    const state1 = await initConversation(persona, config);
    state1.relationshipState = createRelationshipState(3);
    state1.relationshipState = applyRelationshipEvent(
      state1.relationshipState,
      0.5,
      "测试增长",
      new Date(),
    );
    state1.persona.relationship.closeness = state1.relationshipState.closeness;
    state1.emotionState.vector = 0.42;
    persistRuntimeState(state1);

    // 模拟进程重启：重新加载人设并初始化
    const persona2 = await loadPersona("xiaoya");
    const state2 = await initConversation(persona2, config);

    expect(state2.relationshipState.closeness).toBeCloseTo(3.5, 2);
    expect(state2.persona.relationship.closeness).toBeCloseTo(3.5, 2);
    expect(state2.emotionState.vector).toBeCloseTo(0.42, 2);
    expect(state2.relationshipState.milestones.map((m) => m.id)).toContain("getting-familiar");
  });
});

describe("群聊发图开关（skipPhoto）", () => {
  it("默认会触发主动发图；skipPhoto=true 时跳过（群聊默认行为）", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessage } = await import("./orchestrator.js");
    const photoConfig = (): import("../data/store.js").AppConfig => ({
      persona: "xiaoya",
      her_name: "小雅",
      your_name: "你",
      location: "上海",
      tags: [],
      message_frequency_limit: 10,
      log_level: "info",
      // 测试期覆盖：必定发图、无门槛、无冷却
      photo_share_probability: 1,
      photo_share_min_closeness: 0,
      photo_share_cooldown_minutes: 0,
    });

    const persona = await loadPersona("xiaoya");
    const state = await initConversation(persona, photoConfig());
    const withPhoto = await processMessage(state, "今天天气不错出去走走", { bypassGate: true });
    expect(withPhoto.imageFile ?? withPhoto.imageUrl).toBeTruthy();

    const persona2 = await loadPersona("xiaoya");
    const state2 = await initConversation(persona2, photoConfig());
    const noPhoto = await processMessage(state2, "今天天气不错出去走走", {
      bypassGate: true,
      skipPhoto: true,
    });
    expect(noPhoto.imageFile ?? noPhoto.imageUrl).toBeUndefined();
  });
});

describe("跨轮反重复与用户事实注入", () => {
  const makeConfig = (): import("../data/store.js").AppConfig => ({
    persona: "xiaoya",
    her_name: "小雅",
    your_name: "你",
    location: "上海",
    tags: [],
    message_frequency_limit: 10,
    log_level: "info",
  });

  /** 造两轮「连续同开头」的历史，触发反重复点名 */
  function seedRecentAssistantMessages(
    state: import("./orchestrator.js").ConversationState,
  ): void {
    state.session.messages.push(
      { role: "assistant", content: "哈哈是吗 我记性不太行", timestamp: Date.now() - 60_000 },
      { role: "assistant", content: "哈哈真的假的", timestamp: Date.now() - 30_000 },
    );
  }

  it("processMessage 注入最近回复提醒与用户事实", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessage } = await import("./orchestrator.js");
    const { upsertUserFacts } = await import("../data/user-facts.js");
    const { insertT1Snapshot } = await import("../data/vector.js");

    const persona = await loadPersona("xiaoya");
    const state = await initConversation(persona, makeConfig());
    seedRecentAssistantMessages(state);
    upsertUserFacts(state.owner, [
      { key: "job", value: "在嘉兴做咖啡店", category: "work" },
    ]);
    // 造两条 T1 快照，验证「最近状态弧」注入
    insertT1Snapshot({ content: "旧", emotionVector: 0.1, closeness: 2.9, guilt: 0, summary: "[stream]" });
    insertT1Snapshot({ content: "新", emotionVector: 0.4, closeness: 3.2, guilt: 0, summary: "[stream]" });
    captured.chatCalls.length = 0;

    await processMessage(state, "我今天好累", { bypassGate: true });

    const call = captured.chatCalls.find((messages) =>
      messages[0]?.content.includes("避免重复自己"),
    );
    expect(call).toBeTruthy();
    const system = call![0].content;
    // 默认 openers 模式：只提醒开头，不回放整句（避免模型照抄）
    expect(system).toContain("这个开头你最近连着用了");
    expect(system).not.toContain("哈哈是吗 我记性不太行");
    expect(system).toContain("在嘉兴做咖啡店");
    // T1 状态弧：只注入数值趋势，不引用快照正文
    expect(system).toContain("## 你最近几轮的状态");
    // 同文件较早的用例也会写 T1 快照，这里只断言趋势方向与结构，不断言具体起点
    expect(system).toMatch(/亲密度 \d\.\d{2} → \d\.\d{2}（升温）/);
    expect(system).not.toContain("旧\n");
  });

  it("processMessageStream 也注入用户事实与反重复块（QQ 私聊主路径）", async () => {
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessageStream } = await import("./orchestrator.js");
    const { upsertUserFacts } = await import("../data/user-facts.js");

    const persona = await loadPersona("xiaoya");
    const state = await initConversation(persona, makeConfig());
    seedRecentAssistantMessages(state);
    upsertUserFacts(state.owner, [
      { key: "job", value: "在嘉兴做咖啡店", category: "work" },
    ]);
    const { insertT1Snapshot } = await import("../data/vector.js");
    insertT1Snapshot({ content: "旧", emotionVector: 0.1, closeness: 2.9, guilt: 0, summary: "[stream]" });
    insertT1Snapshot({ content: "新", emotionVector: 0.4, closeness: 3.2, guilt: 0, summary: "[stream]" });
    captured.chatStreamCalls.length = 0;

    for await (const _fragment of processMessageStream(state, "在干嘛", { bypassGate: true })) {
      // 消费完整个流，确保 prompt 已构建
    }

    const call = captured.chatStreamCalls.find((messages) =>
      messages[0]?.content.includes("避免重复自己"),
    );
    expect(call).toBeTruthy();
    const system = call![0].content;
    expect(system).toContain("你确定记得的关于对方的事");
    expect(system).toContain("在嘉兴做咖啡店");
    expect(system).toContain("这个开头你最近连着用了");
    expect(system).toContain("## 你最近几轮的状态");
  });
});
