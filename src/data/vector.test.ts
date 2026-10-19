/**
 * M0：数据层新装可用性 + 迁移测试。
 *
 * 覆盖 P0-1（data 目录不存在）与 P0-2（历史库缺 embedding 列）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-vec-"));
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

describe("vector 数据层（全新目录）", () => {
  it("自动创建 data 目录与数据库，建表包含 embedding 列", async () => {
    const m = await import("./vector.js");
    expect(fs.existsSync(path.join(dir, "memory.sqlite"))).toBe(false);

    const db = m.getVectorDb();

    expect(fs.existsSync(path.join(dir, "memory.sqlite"))).toBe(true);
    const cols = (db.prepare("PRAGMA table_info(t2_episodes)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("embedding");
    expect(cols).toContain("persona_id");
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(1);
    m.closeVectorDb();
  });

  it("空库 backfill 不报错，写入后可检索且人设隔离", async () => {
    const m = await import("./vector.js");
    const { generateEmbedding } = await import("./embedding.js");

    m.setCurrentPersona("小雅");
    expect(m.backfillEpisodeVectors(generateEmbedding)).toBe(0);

    m.insertEpisodeWithEmbedding(
      "用户说喜欢下雨天",
      "chat",
      generateEmbedding("用户说喜欢下雨天"),
      0.4,
    );
    expect(m.getAllEpisodes(10)).toHaveLength(1);

    const hits = m.searchSimilarEpisodes(generateEmbedding("喜欢下雨"), 5);
    expect(hits.length).toBe(1);
    expect(hits[0].similarity).toBeGreaterThan(0.3);

    // 人设隔离：其他人设查不到
    m.setCurrentPersona("秋瑶");
    expect(m.searchSimilarEpisodes(generateEmbedding("下雨"), 5)).toHaveLength(0);
    expect(m.getAllEpisodes()).toHaveLength(0);
    m.closeVectorDb();
  });

  it("历史库缺 embedding 列时自动迁移，backfill 可补向量", async () => {
    // 模拟旧版本数据库：t2_episodes 没有 embedding 列
    const legacy = new Database(path.join(dir, "memory.sqlite"));
    legacy.exec(`
      CREATE TABLE t1_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL DEFAULT 'unknown',
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE t2_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL DEFAULT 'unknown',
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        strength REAL DEFAULT 1.0,
        half_life_days REAL DEFAULT 30.0,
        emotional_weight REAL DEFAULT 0.0,
        created_at TEXT DEFAULT (datetime('now')),
        last_recalled_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO t2_episodes (persona_id, content, source) VALUES ('小雅', '旧记忆', 'chat');
    `);
    legacy.close();

    const m = await import("./vector.js");
    const { generateEmbedding } = await import("./embedding.js");
    m.setCurrentPersona("小雅");

    const db = m.getVectorDb();
    const cols = (db.prepare("PRAGMA table_info(t2_episodes)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("embedding");

    expect(m.backfillEpisodeVectors(generateEmbedding)).toBe(1);
    expect(m.searchSimilarEpisodes(generateEmbedding("旧记忆"), 5).length).toBe(1);
    m.closeVectorDb();
  });
});
