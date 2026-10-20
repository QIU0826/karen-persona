/**
 * 多用户隔离集成测试：会话 / 人格状态 / T2 记忆按 owner 隔离。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-owner-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const v = await import("./vector.js");
    v.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("owner 隔离", () => {
  it("会话文件按 owner 后缀隔离", async () => {
    const history = await import("./history.js");

    const legacy = history.loadSession("小雅");
    history.addMessage(legacy, "user", "主用户的消息");
    history.saveSessionSync(legacy);

    const isolated = history.loadSession("小雅", "-qq-222");
    history.addMessage(isolated, "user", "第二个用户的消息");
    history.saveSessionSync(isolated);

    expect(history.loadSession("小雅").messages.map((m) => m.content)).toEqual(["主用户的消息"]);
    expect(history.loadSession("小雅", "-qq-222").messages.map((m) => m.content)).toEqual([
      "第二个用户的消息",
    ]);
  });

  it("人格状态（亲密度/情绪）按 owner 后缀隔离", async () => {
    const stateStore = await import("./state-store.js");

    const legacy = stateStore.createPersistedPersonaState("小雅", 3);
    legacy.relationship.closeness = 5.5;
    stateStore.savePersonaState(legacy);

    const second = stateStore.createPersistedPersonaState("小雅", 3);
    second.storageKey = "-qq-222";
    second.relationship.closeness = 3.1;
    stateStore.savePersonaState(second);

    expect(stateStore.loadPersonaState("小雅", 3)!.relationship.closeness).toBe(5.5);
    expect(stateStore.loadPersonaState("小雅", 3, "-qq-222")!.relationship.closeness).toBe(3.1);
    expect(stateStore.loadPersonaState("小雅", 3, "-qq-333")).toBeNull();
  });

  it("T2 记忆按存储 persona_id 隔离（检索不会串）", async () => {
    const vector = await import("./vector.js");
    const retriever = await import("./retriever.js");

    vector.setCurrentPersona("xiaoya");
    vector.insertEpisode("主用户说过他喜欢雨天", "chat", 0.2);

    vector.setCurrentPersona("xiaoya@qq-222");
    vector.insertEpisode("第二个用户说过他喜欢晴天", "chat", 0.2);

    vector.setCurrentPersona("xiaoya");
    const legacyMemories = retriever.retrieveRelevantMemories("主用户喜欢雨天", 10);
    expect(legacyMemories.some((m) => m.content.includes("雨天"))).toBe(true);
    expect(legacyMemories.some((m) => m.content.includes("晴天"))).toBe(false);

    vector.setCurrentPersona("xiaoya@qq-222");
    const secondMemories = retriever.retrieveRelevantMemories("第二个用户喜欢晴天", 10);
    expect(secondMemories.some((m) => m.content.includes("晴天"))).toBe(true);
    expect(secondMemories.some((m) => m.content.includes("雨天"))).toBe(false);
  });
});
