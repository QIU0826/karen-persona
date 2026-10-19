/**
 * M0：会话持久化测试（原子写、容错、旧格式兼容）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-history-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("history 会话持久化", () => {
  it("首次加载创建空会话，addMessage 后立即可重新加载", async () => {
    const h = await import("./history.js");
    const session = h.loadSession("小雅");
    expect(session.messages).toHaveLength(0);
    expect(session.t3.currentTopic).toBe("");

    h.addMessage(session, "user", "你好");
    h.addMessage(session, "assistant", "嗯。");

    const reloaded = h.loadSession("小雅");
    expect(reloaded.messages).toHaveLength(2);
    expect(reloaded.messages[0].content).toBe("你好");
    expect(reloaded.messages[1].role).toBe("assistant");

    // 没有残留 tmp 文件
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
    expect(files).toContain("小雅-session.json");
  });

  it("损坏的会话文件会备份并重建，而不是崩溃", async () => {
    fs.writeFileSync(path.join(dir, "小雅-session.json"), "{ this is not json", "utf-8");

    const h = await import("./history.js");
    const session = h.loadSession("小雅");

    expect(session.messages).toHaveLength(0);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("旧版会话缺少 t3 字段时自动补齐", async () => {
    fs.writeFileSync(
      path.join(dir, "小雅-session.json"),
      JSON.stringify({
        personaId: "小雅",
        startedAt: 1,
        lastActiveAt: 2,
        messages: [{ role: "user", content: "旧消息", timestamp: 3 }],
      }),
      "utf-8",
    );

    const h = await import("./history.js");
    const session = h.loadSession("小雅");

    expect(session.messages).toHaveLength(1);
    expect(session.t3).toEqual({ currentTopic: "", emotionVector: 0, activeThreads: [] });
  });

  it("超过 200 条时滚动截断并归档", async () => {
    const h = await import("./history.js");
    const session = h.loadSession("小雅");
    for (let i = 0; i < 205; i++) {
      session.messages.push({ role: "user", content: `消息${i}`, timestamp: Date.now() });
    }
    h.addMessage(session, "user", "最后一条");

    expect(session.messages.length).toBe(200);
    const archive = fs.readdirSync(dir).find((f) => f.includes("archive"));
    expect(archive).toBeTruthy();
  });
});
