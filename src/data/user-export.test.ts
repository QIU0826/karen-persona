import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-export-"));
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

describe("exportUserData", () => {
  it("导出会话与 T2 记忆为本地 JSON，并返回计数", async () => {
    const history = await import("./history.js");
    const vector = await import("./vector.js");
    const { exportUserData } = await import("./user-export.js");

    const session = history.loadSession("小雅");
    history.addMessage(session, "user", "你好呀");
    history.addMessage(session, "assistant", "在呢");
    history.saveSessionSync(session);

    vector.setCurrentPersona("xiaoya");
    vector.insertEpisode("用户: 你好呀 | 回复: 在呢", "chat", 0.1);

    const result = exportUserData("xiaoya", "小雅");
    expect(result.counts.messages).toBe(2);
    expect(result.counts.memories).toBe(1);
    expect(fs.existsSync(result.path)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(result.path, "utf-8"));
    expect(payload.session.messages).toHaveLength(2);
    expect(payload.t2Episodes).toHaveLength(1);
    expect(payload.personaId).toBe("xiaoya");
    // 导出文件应仅本人可读
    const mode = fs.statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
