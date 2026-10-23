/**
 * 承诺账本（P1-1）：临时 KAREN_DATA_DIR + 真 SQLite，不在生产库上跑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-promise-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vector = await import("./vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function mod() {
  return import("./promise-ledger.js");
}

const NOW = new Date(2026, 9, 23, 15, 0).getTime();

describe("promise ledger", () => {
  it("写入/去重/列出 open 承诺", async () => {
    const ledger = await mod();
    ledger.recordPromises(
      "qq:1",
      "xiaoya",
      [
        { kind: "voice", content: "等会儿给你录", dueAt: NOW + 30 * 60_000, sourceRole: "assistant" },
        { kind: "voice", content: "等会儿给你录", dueAt: NOW + 30 * 60_000, sourceRole: "assistant" },
      ],
      NOW,
    );
    const rows = ledger.listOpenPromises("qq:1", "xiaoya", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "voice", status: "open" });
  });

  it("注入块只写还没兑现的，不写旧原话", async () => {
    const ledger = await mod();
    ledger.recordPromises(
      "qq:1",
      "xiaoya",
      [
        { kind: "voice", content: "等会儿给你录", dueAt: NOW + 30 * 60_000, sourceRole: "assistant" },
        { kind: "event", content: "他明天下午面试", dueAt: NOW - 60_000, sourceRole: "user" },
      ],
      NOW,
    );
    const text = ledger.getPromiseInjection("qq:1", "xiaoya", NOW);
    expect(text).toContain("还没兑现的承诺");
    expect(text).toContain("答应过给他发一条语音");
    expect(text).toContain("他的事");
    expect(text).toContain("已到期");
    expect(text).not.toContain("等会儿给你录");
    expect(text).toContain("不要反复说");
  });

  it("语音/照片发出后可标记 done，不再注入", async () => {
    const ledger = await mod();
    ledger.recordPromises(
      "qq:1",
      "xiaoya",
      [
        { kind: "voice", content: "等会儿给你录", dueAt: NOW + 60_000, sourceRole: "assistant" },
        { kind: "photo", content: "等我拍给你", dueAt: NOW + 60_000, sourceRole: "assistant" },
      ],
      NOW,
    );
    expect(ledger.markPromisesDone("qq:1", "xiaoya", ["voice"], NOW + 120_000)).toBe(1);
    const left = ledger.listOpenPromises("qq:1", "xiaoya", NOW + 120_000);
    expect(left.map((row) => row.kind)).toEqual(["photo"]);
  });

  it("owner 隔离；7 天前的不再列出", async () => {
    const ledger = await mod();
    ledger.recordPromises(
      "qq:1",
      "xiaoya",
      [{ kind: "voice", content: "给你录", dueAt: NOW, sourceRole: "assistant" }],
      NOW,
    );
    expect(ledger.listOpenPromises("qq:2", "xiaoya", NOW)).toEqual([]);

    const later = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(ledger.listOpenPromises("qq:1", "xiaoya", later)).toEqual([]);
  });
});
