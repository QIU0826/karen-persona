/**
 * M1-7 记忆 schema v2 迁移测试。
 *
 * 覆盖：旧库（M0 schema + 旧 t2_vec + 无 FTS）自动升级、幂等、模型标记回填、
 * 派生索引重建；新库重复打开不重复建表/丢数据。
 *
 * 全部使用 KAREN_DATA_DIR 临时目录，不触碰仓库 data/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEmbedding } from "./embedding.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-migration-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function dbFile(): string {
  return path.join(dir, "memory.sqlite");
}

/**
 * 构造 M0 时代的旧库：
 * - t2_episodes 有 embedding 列但没有 embedding_model / semantic_*；
 * - t2_vec 是旧 schema (id INTEGER PRIMARY KEY, embedding FLOAT[768]) 且 0 行；
 * - 没有 t2_fts 表。
 */
function createLegacyDb(rows: Array<{ persona: string; content: string; source: string }>): void {
  const legacy = new Database(dbFile());
  legacy.pragma("journal_mode = WAL");
  sqliteVec.load(legacy);
  legacy.exec(`
    CREATE TABLE t1_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL DEFAULT 'unknown',
      content TEXT NOT NULL,
      emotion_vector REAL DEFAULT 0,
      closeness REAL DEFAULT 3,
      guilt REAL DEFAULT 0,
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      strength REAL DEFAULT 1.0
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
      last_recalled_at TEXT DEFAULT (datetime('now')),
      embedding TEXT
    );
    CREATE VIRTUAL TABLE t2_vec USING vec0(
      id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );
  `);
  const insert = legacy.prepare(
    `INSERT INTO t2_episodes (persona_id, content, source, embedding) VALUES (?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(row.persona, row.content, row.source, JSON.stringify(Array.from(generateEmbedding(row.content))));
  }
  legacy.close();
}

function t2Columns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(t2_episodes)").all() as Array<{ name: string }>).map((c) => c.name);
}

function vecColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(t2_vec)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("schema v2 迁移", () => {
  it("旧库升级：补列 + 回填 embedding_model + 重建 FTS/vec（派生索引），不丢业务数据", async () => {
    createLegacyDb([
      { persona: "小雅", content: "用户说最喜欢喝咖啡", source: "chat" },
      { persona: "小雅", content: "外面下雨了记得带伞", source: "chat" },
    ]);

    const m = await import("./vector.js");
    const db = m.getVectorDb();
    m.setCurrentPersona("小雅");

    // v2 列
    const cols = t2Columns(db);
    expect(cols).toContain("embedding_model");
    expect(cols).toContain("semantic_embedding");
    expect(cols).toContain("semantic_model");

    // 历史 ngram 向量回填模型标记
    const models = db.prepare("SELECT DISTINCT embedding_model FROM t2_episodes").all() as Array<{
      embedding_model: string;
    }>;
    expect(models.map((row) => row.embedding_model)).toEqual(["ngram-v1"]);

    // 旧 t2_vec 被替换成带 metadata 的新 schema（旧表本来就是 0 行的派生索引）
    const vCols = vecColumns(db);
    expect(vCols).toEqual(
      expect.arrayContaining(["id", "embedding", "persona_id", "source", "embedding_model"])
    );
    expect(m.getIndexStats().vecRows).toBe(0);

    // 老记忆的语义列仍为空（等待 upgradeEmbeddings 幂等回填，不静默写假向量）
    expect(m.getIndexStats().semanticEpisodes).toBe(0);

    // FTS5 索引为存量数据重建：中文 2 字词可命中
    expect(m.isFtsIndexAvailable()).toBe(true);
    expect(m.getIndexStats().ftsRows).toBe(2);
    expect(m.searchEpisodesByFts("咖啡").length).toBe(1);
    expect(m.searchEpisodesByFts("下雨").length).toBe(1);

    expect(Number(db.pragma("user_version", { simple: true }))).toBe(m.SCHEMA_VERSION);
    expect(m.getAllEpisodes()).toHaveLength(2);

    // 幂等：关掉重开不会重复建表 / 丢数据 / 破坏索引
    m.closeVectorDb();
    vi.resetModules();
    const m2 = await import("./vector.js");
    const db2 = m2.getVectorDb();
    m2.setCurrentPersona("小雅");
    expect(m2.getAllEpisodes()).toHaveLength(2);
    expect(m2.getIndexStats().ftsRows).toBe(2);
    expect(t2Columns(db2).filter((c) => c === "semantic_embedding")).toHaveLength(1);
    expect(m2.searchEpisodesByFts("咖啡").length).toBe(1);
    m2.closeVectorDb();
  });

  it("全新库重复打开：schema 幂等、数据不丢、FTS 不重复", async () => {
    const m = await import("./vector.js");
    m.setCurrentPersona("小雅");
    m.insertEpisodeWithEmbedding("用户说喜欢下雨天", "chat", generateEmbedding("用户说喜欢下雨天"), 0.4);
    m.closeVectorDb();

    vi.resetModules();
    const m2 = await import("./vector.js");
    m2.setCurrentPersona("小雅");
    expect(m2.getAllEpisodes()).toHaveLength(1);

    // 再开一次（同一模块内二次 getVectorDb 也应是幂等的）
    expect(m2.getAllEpisodes()).toHaveLength(1);
    expect(m2.getIndexStats().ftsRows).toBe(1);
    expect(m2.searchEpisodesByFts("下雨").length).toBe(1);
    m2.closeVectorDb();
  });

  it("新写入记录 ngram 模型标记；语义列保持为空（有 Key 时由后台队列/回填填充）", async () => {
    const m = await import("./vector.js");
    m.setCurrentPersona("小雅");
    const id = m.insertEpisodeWithEmbedding(
      "用户说今天加班很累",
      "chat",
      generateEmbedding("用户说今天加班很累"),
      0.2
    );

    const db = m.getVectorDb();
    const row = db
      .prepare(
        "SELECT embedding, embedding_model, semantic_embedding, semantic_model FROM t2_episodes WHERE id = ?"
      )
      .get(id) as {
      embedding: string | null;
      embedding_model: string | null;
      semantic_embedding: string | null;
      semantic_model: string | null;
    };
    expect(row.embedding).not.toBeNull();
    expect(row.embedding_model).toBe("ngram-v1");
    expect(row.semantic_embedding).toBeNull();
    expect(row.semantic_model).toBeNull();
    m.closeVectorDb();
  });
});
