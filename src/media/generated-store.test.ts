/**
 * 生成图治理单测（v0.8.21 覆盖率核对补上的缺口）。
 *
 * 之前只有 comfyui.test.ts 间接引用，落盘/清理/统计三条路径没有直接测试。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "karen-gen-store-"));
const ORIGINAL_ENV = process.env.KAREN_DATA_DIR;

beforeEach(() => {
  process.env.KAREN_DATA_DIR = TMP;
  fs.rmSync(path.join(TMP, "generated"), { recursive: true, force: true });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.KAREN_DATA_DIR;
  else process.env.KAREN_DATA_DIR = ORIGINAL_ENV;
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQAAAABJRU5ErkJggg==",
  "base64",
);

describe("generated-store：保存 / 清理 / 统计", () => {
  it("保存生成图：落到按日期分目录、返回真实路径", async () => {
    const store = await import("./generated-store.js");
    const file = store.saveGeneratedImage(PNG, { now: new Date("2026-10-20T12:00:00").getTime() });
    expect(file).toBeTruthy();
    expect(fs.existsSync(file!)).toBe(true);
    expect(file!).toContain("2026-10-20");
    expect(fs.readFileSync(file!).length).toBe(PNG.length);
  });

  it("统计能数出文件数与占用（Web/CI 可见）", async () => {
    const store = await import("./generated-store.js");
    store.saveGeneratedImage(PNG, { now: Date.now() });
    store.saveGeneratedImage(PNG, { now: Date.now() });
    const stats = store.generatedStats();
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("prune 只清超过上限天数的旧图，不碰新的", async () => {
    const store = await import("./generated-store.js");
    const old = store.saveGeneratedImage(PNG, {
      now: Date.now() - 40 * 24 * 60 * 60 * 1000,
    });
    const fresh = store.saveGeneratedImage(PNG, { now: Date.now() });
    const result = store.pruneGenerated();
    expect(result.removedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(old!)).toBe(false);
    expect(fs.existsSync(fresh!)).toBe(true);
  });

  it("purge 清空全部生成图", async () => {
    const store = await import("./generated-store.js");
    store.saveGeneratedImage(PNG, { now: Date.now() });
    const result = store.purgeGenerated();
    expect(result.removedFiles).toBe(1);
    expect(store.generatedStats().files).toBe(0);
  });

  it("空字节 / 空目录不崩", async () => {
    const store = await import("./generated-store.js");
    expect(store.saveGeneratedImage(Buffer.alloc(0))).toBeNull();
    expect(store.generatedStats().files).toBe(0);
  });
});
