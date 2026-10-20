import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-stickers-"));
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

/** 最小 PNG（1×1）用于测试嗅探与落盘 */
function tinyPng(seed = 0): Buffer {
  return Buffer.from(
    `89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489${(seed % 256)
      .toString(16)
      .padStart(2, "0")}00000000`,
    "hex",
  );
}

describe("collectSticker：采集与去重", () => {
  it("第一次采集落盘 + 入库，重复采集只返回 duplicate", async () => {
    const s = await import("./sticker-library.js");
    const bytes = tinyPng(1);
    const first = s.collectSticker({ ownerId: "qq:1", bytes, source: "inbound" });
    expect(first).toMatchObject({ ok: true, reason: "saved" });
    const second = s.collectSticker({ ownerId: "qq:1", bytes, source: "inbound" });
    expect(second).toMatchObject({ ok: true, reason: "duplicate" });

    const list = s.listCollectedStickers("qq:1");
    expect(list).toHaveLength(1);
    expect(fs.existsSync(list[0].file)).toBe(true);
    expect(list[0].mime).toBe("image/png");
  });

  it("空内容 / 超大文件被拒", async () => {
    const s = await import("./sticker-library.js");
    expect(s.collectSticker({ ownerId: "qq:1", bytes: Buffer.alloc(0) }).reason).toBe("empty");
    const huge = Buffer.alloc(s.MAX_STICKER_BYTES + 1);
    expect(s.collectSticker({ ownerId: "qq:1", bytes: huge }).reason).toBe("too_large");
  });

  it("不同 owner 互不可见（同一张图各存一份记录）", async () => {
    const s = await import("./sticker-library.js");
    const bytes = tinyPng(2);
    s.collectSticker({ ownerId: "qq:1", bytes });
    s.collectSticker({ ownerId: "qq:2", bytes });
    expect(s.listCollectedStickers("qq:1")).toHaveLength(1);
    expect(s.listCollectedStickers("qq:2")).toHaveLength(1);
  });

  it("落盘目录跟着 KAREN_DATA_DIR 走，且在 data 目录下", async () => {
    const s = await import("./sticker-library.js");
    s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(3) });
    const dirPath = s.stickerDir();
    expect(dirPath.startsWith(dir)).toBe(true);
    expect(fs.readdirSync(dirPath).length).toBeGreaterThan(0);
  });
});

describe("pickCollectedSticker：挑选", () => {
  it("没有收藏时返回 null（调用方回退内置贴纸）", async () => {
    const s = await import("./sticker-library.js");
    expect(s.pickCollectedSticker({ ownerId: "qq:1", emotion: "happy" })).toBeNull();
  });

  it("情绪匹配的优先", async () => {
    const s = await import("./sticker-library.js");
    s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(11), emotion: "happy", tags: ["happy"] });
    s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(12), emotion: "sad", tags: ["sad"] });
    const picked = s.pickCollectedSticker({ ownerId: "qq:1", emotion: "happy", random: () => 0 });
    expect(picked?.emotion).toBe("happy");
  });

  it("用得少的优先，最近用过的可被排除", async () => {
    const s = await import("./sticker-library.js");
    const a = s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(21), emotion: "happy" });
    const b = s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(22), emotion: "happy" });
    s.markStickerUsed(a.id!, Date.now());
    s.markStickerUsed(a.id!, Date.now());
    const picked = s.pickCollectedSticker({ ownerId: "qq:1", emotion: "happy", random: () => 0 });
    expect(picked?.id).toBe(b.id);

    const excluded = s.pickCollectedSticker({
      ownerId: "qq:1",
      emotion: "happy",
      excludeIds: [b.id!],
      random: () => 0,
    });
    expect(excluded?.id).toBe(a.id);
  });
});

describe("purge 与库容", () => {
  it("purge 删除记录与文件", async () => {
    const s = await import("./sticker-library.js");
    s.collectSticker({ ownerId: "qq:1", bytes: tinyPng(31) });
    const list = s.listCollectedStickers("qq:1");
    const file = list[0].file;
    expect(fs.existsSync(file)).toBe(true);

    const removed = s.purgeCollectedStickers("qq:1");
    expect(removed).toBe(1);
    expect(s.listCollectedStickers("qq:1")).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("库容上限常量合理（不超过 500，单文件 ≤2MB）", async () => {
    const s = await import("./sticker-library.js");
    expect(s.MAX_COLLECTED_STICKERS).toBeLessThanOrEqual(500);
    expect(s.MAX_STICKER_BYTES).toBe(2 * 1024 * 1024);
  });
});
