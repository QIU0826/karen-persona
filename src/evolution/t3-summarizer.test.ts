/**
 * T3 压缩触发条件单测（纯函数，不调 LLM、不读写真实数据）。
 *
 * 原有问题：阈值 80 条太高，线上 0 条摘要；这里验证「40 条即压 / 20 条+隔天兜底」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPRESSION_BATCH_SIZE,
  COMPRESSION_MAX_AGE_MS,
  COMPRESSION_MIN_COUNT,
  countUncompressedEpisodes,
  shouldCompressT3,
} from "./t3-summarizer.js";

let dbDir: string;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-t3-"));
  process.env.KAREN_DATA_DIR = dbDir;
});

afterAll(() => {
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const NOW = Date.UTC(2026, 9, 20, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("shouldCompressT3", () => {
  it("常量符合设计：40 条一批、时间兜底 1 天、最少 20 条", () => {
    expect(COMPRESSION_BATCH_SIZE).toBe(40);
    expect(COMPRESSION_MIN_COUNT).toBe(20);
    expect(COMPRESSION_MAX_AGE_MS).toBe(DAY);
  });

  it("未压缩 ≥40 条：立即压缩（与上次摘要无关）", () => {
    expect(
      shouldCompressT3({ uncompressedCount: 40, lastSummaryAtMs: null, nowMs: NOW }),
    ).toBe(true);
    expect(
      shouldCompressT3({ uncompressedCount: 60, lastSummaryAtMs: NOW - 1000, nowMs: NOW }),
    ).toBe(true);
  });

  it("39 条且从未摘要：不压（避免小样本硬压）", () => {
    expect(
      shouldCompressT3({ uncompressedCount: 39, lastSummaryAtMs: null, nowMs: NOW }),
    ).toBe(false);
  });

  it("20–39 条且距上次摘要 ≥1 天：时间兜底触发", () => {
    expect(
      shouldCompressT3({ uncompressedCount: 20, lastSummaryAtMs: NOW - DAY - 1, nowMs: NOW }),
    ).toBe(true);
    expect(
      shouldCompressT3({ uncompressedCount: 25, lastSummaryAtMs: NOW - DAY, nowMs: NOW }),
    ).toBe(true);
  });

  it("20–39 条但距上次摘要不足 1 天：不触发（等攒够或隔天）", () => {
    expect(
      shouldCompressT3({ uncompressedCount: 25, lastSummaryAtMs: NOW - DAY + 60_000, nowMs: NOW }),
    ).toBe(false);
  });

  it("少于 20 条：即使很久没摘要也不压", () => {
    expect(
      shouldCompressT3({ uncompressedCount: 19, lastSummaryAtMs: NOW - 10 * DAY, nowMs: NOW }),
    ).toBe(false);
  });
});

describe("countUncompressedEpisodes（DB）", () => {
  it("只统计未压缩的普通片段；标记 t3_compressed 后不再计入（防止反复压缩）", async () => {
    const { insertEpisode, setCurrentPersona, getVectorDb } = await import("../data/vector.js");
    setCurrentPersona("小雅");
    insertEpisode("用户说今天加班到很晚", "chat", 0.2);
    insertEpisode("用户说周末想去爬山", "chat", 0.1);
    insertEpisode("用户说家里的猫又拆家了", "chat", 0.3);
    // 独白不是压缩对象
    insertEpisode("[独白] 今天有点想他", "internal_monologue", 0);

    expect(countUncompressedEpisodes()).toBe(3);

    // 模拟已压缩一条：降强度 + 打标记
    const db = getVectorDb();
    db.prepare(
      `UPDATE t2_episodes
          SET strength = strength * 0.3, t3_compressed = 1
        WHERE id = (SELECT id FROM t2_episodes WHERE source = 'chat' ORDER BY id ASC LIMIT 1)`,
    ).run();

    expect(countUncompressedEpisodes()).toBe(2);
  });
});
