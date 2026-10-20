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
  buildT3SummaryPrompts,
  COMPRESSION_BATCH_SIZE,
  COMPRESSION_MAX_AGE_MS,
  COMPRESSION_MIN_COUNT,
  countUncompressedEpisodes,
  shouldCompressT3,
  type RawEpisode,
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

describe("buildT3SummaryPrompts（摘要质量规则）", () => {
  const episodes: RawEpisode[] = [
    {
      id: 1,
      content: "用户说他在做一个咖啡品牌包装项目，卡在排版。",
      source: "chat",
      emotional_weight: 0.3,
      created_at: "2026-10-18 10:00:00",
    },
    {
      id: 2,
      content: "用户说下个月想去云南，但还没定路线。",
      source: "chat",
      emotional_weight: 0.2,
      created_at: "2026-10-19 09:00:00",
    },
  ];

  it("prompt 包含「具体事实/未完成话题/不编造」规则", () => {
    const { system, user } = buildT3SummaryPrompts(episodes, "小雅");
    expect(system).toContain("保留具体事实");
    expect(system).toContain("保留未完成的话题");
    expect(system).toContain("不要编造");
    expect(system).toContain("第一人称");
    expect(system).toContain("3-5 句");
    expect(user).toContain("咖啡品牌包装项目");
    expect(user).toContain("云南");
  });

  it("日期范围取首尾片段；超过 60 条片段只喂前 60 条", () => {
    const many: RawEpisode[] = Array.from({ length: 70 }, (_, index) => ({
      id: index + 1,
      content: `片段 ${index}`,
      source: "chat",
      emotional_weight: 0,
      created_at: `2026-09-${String((index % 28) + 1).padStart(2, "0")} 10:00:00`,
    }));
    const { user, startDate, endDate } = buildT3SummaryPrompts(many, "小雅");
    expect(startDate).toBe("2026-09-01");
    expect(endDate).toBe("2026-09-14");
    // 前 60 条进入 prompt，第 61+ 条不出现
    expect(user).toContain("片段 59");
    expect(user).not.toContain("片段 60");
  });
});
