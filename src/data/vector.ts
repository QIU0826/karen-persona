/**
 * T1-T2 向量存储（sqlite-vec）。
 * Phase 2: 基础向量读写和检索。
 * Phase 3+: 线性衰减、漂移更新。
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dbPath, ensureDataDir } from "./paths.js";

let db: Database.Database | null = null;

/** 当前 schema 版本（PRAGMA user_version）。修改表结构时 +1 并补迁移。 */
const SCHEMA_VERSION = 1;

let currentPersona: string | null = null;

/** 设置当前活跃人设 ID（写入和读取时自动过滤） */
export function setCurrentPersona(personaId: string): void {
  currentPersona = personaId;
}

export function getCurrentPersona(): string {
  return currentPersona ?? "unknown";
}

export function getVectorDb(): Database.Database {
  if (db) return db;
  ensureDataDir();
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  initTables(db);
  migrate(db);
  return db;
}

function initTables(db: Database.Database): void {
  // T1: 人格快照表（每次对话后写入一条）
  db.exec(`
    CREATE TABLE IF NOT EXISTS t1_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL DEFAULT 'unknown',
      content TEXT NOT NULL,
      emotion_vector REAL DEFAULT 0,
      closeness REAL DEFAULT 3,
      guilt REAL DEFAULT 0,
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      strength REAL DEFAULT 1.0
    )
  `);

  // T2: 经历向量表
  db.exec(`
    CREATE TABLE IF NOT EXISTS t2_episodes (
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
    )
  `);

  // 迁移：旧表补 persona_id 列
  migrateAddColumn(db, "t1_snapshots", "persona_id", "TEXT NOT NULL DEFAULT 'unknown'");
  migrateAddColumn(db, "t2_episodes", "persona_id", "TEXT NOT NULL DEFAULT 'unknown'");

  // 向量索引表
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(
      id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `);
}

function migrateAddColumn(db: Database.Database, table: string, column: string, def: string): void {
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  } catch {
    // 并发场景下表结构可能刚被其他进程改过 → 忽略
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * 幂等迁移。修复历史库缺失 embedding 列的问题（新库建表已包含）。
 * 同时创建检索所需索引、写入 schema 版本。
 */
function migrate(db: Database.Database): void {
  // v1：t2_episodes.embedding（历史库缺失会导致 backfill/检索直接报错）
  migrateAddColumn(db, "t2_episodes", "embedding", "TEXT");
  migrateAddColumn(db, "t2_episodes", "last_recalled_at", "TEXT");

  // 索引尽力而为：历史库可能缺列，不应让启动失败
  for (const stmt of [
    "CREATE INDEX IF NOT EXISTS idx_t2_persona_strength ON t2_episodes(persona_id, strength DESC)",
    "CREATE INDEX IF NOT EXISTS idx_t2_persona_created ON t2_episodes(persona_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_t1_persona_created ON t1_snapshots(persona_id, created_at DESC)",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // 老库列不齐时跳过
    }
  }

  const current = Number(db.pragma("user_version", { simple: true })) || 0;
  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

// ── T1 记忆快照（P1-c）──────────────────────────

export interface T1Snapshot {
  content: string;
  emotionVector: number;
  closeness: number;
  guilt: number;
  summary: string;
  created_at?: string;
}

/** 写入一条 T1 人格快照 */
export function insertT1Snapshot(snap: T1Snapshot): number {
  const d = getVectorDb();
  const r = d.prepare(
    `INSERT INTO t1_snapshots (persona_id, content, emotion_vector, closeness, guilt, summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(getCurrentPersona(), snap.content, snap.emotionVector, snap.closeness, snap.guilt, snap.summary);
  return Number(r.lastInsertRowid);
}

/** 获取当前人设最近 N 条 T1 快照 */
export function getRecentSnapshots(limit: number = 20): T1Snapshot[] {
  const d = getVectorDb();
  return d.prepare(
    `SELECT content, emotion_vector as emotionVector, closeness, guilt, summary, created_at
     FROM t1_snapshots
     WHERE persona_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(getCurrentPersona(), limit) as T1Snapshot[];
}

// ── T2 经历记忆 ──────────────────────────────────

/** 向 T2 插入一条经历，返回 ID */
export function insertEpisode(
  content: string,
  source: string = "chat",
  emotionalWeight: number = 0
): number {
  const d = getVectorDb();
  const result = d.prepare(
    `INSERT INTO t2_episodes (persona_id, content, source, strength, emotional_weight, half_life_days)
     VALUES (?, ?, ?, 1.0, ?, 30.0)`
  ).run(getCurrentPersona(), content, source, emotionalWeight);
  return Number(result.lastInsertRowid);
}

/** 更新 T2 记忆强度（艾宾浩斯衰减或强化） */
export function updateStrength(id: number, newStrength: number): void {
  getVectorDb().prepare(
    `UPDATE t2_episodes SET strength = ?, last_recalled_at = datetime('now') WHERE id = ?`
  ).run(Math.max(0, Math.min(1, newStrength)), id);
}

/** 关键词搜索当前人设的 T2 */
export function searchEpisodesByKeyword(
  keyword: string,
  limit: number = 5
): Array<{ id: number; content: string; strength: number; emotional_weight: number }> {
  const d = getVectorDb();
  return d.prepare(
    `SELECT id, content, strength, emotional_weight
     FROM t2_episodes
     WHERE persona_id = ? AND content LIKE ?
     ORDER BY strength DESC, last_recalled_at DESC
     LIMIT ?`
  ).all(getCurrentPersona(), `%${keyword}%`, limit) as Array<{
    id: number; content: string; strength: number; emotional_weight: number;
  }>;
}

/** 获取当前人设所有 T2 记忆 */
export function getAllEpisodes(
  limit: number = 50
): Array<{ id: number; content: string; strength: number; half_life_days: number; created_at: string; last_recalled_at: string }> {
  const d = getVectorDb();
  return d.prepare(
    `SELECT id, content, strength, half_life_days, created_at, last_recalled_at
     FROM t2_episodes
     WHERE persona_id = ? AND strength > 0.05
     ORDER BY strength DESC
     LIMIT ?`
  ).all(getCurrentPersona(), limit) as Array<{
    id: number; content: string; strength: number; half_life_days: number;
    created_at: string; last_recalled_at: string;
  }>;
}

/** 计算衰减后的记忆强度 */
export function applyDecay(id: number): number {
  const d = getVectorDb();
  const row = d.prepare(
    `SELECT strength, half_life_days, last_recalled_at FROM t2_episodes WHERE id = ?`
  ).get(id) as { strength: number; half_life_days: number; last_recalled_at: string } | undefined;
  if (!row) return 0;

  const daysSinceRecall =
    (Date.now() - new Date(row.last_recalled_at).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = row.strength * Math.exp(-daysSinceRecall / row.half_life_days);
  updateStrength(id, decayed);
  return decayed;
}

/** 批量应用衰减到所有 T2 记忆 */
export function applyGlobalDecay(): number {
  const d = getVectorDb();
  const result = d.prepare(
    `UPDATE t2_episodes
     SET strength = strength * exp(
       -(julianday('now') - julianday(last_recalled_at)) / half_life_days
     )
     WHERE strength > 0.01`
  ).run();
  return result.changes;
}

/** 归档已衰减到接近零的记忆 */
export function archiveDecayedEpisodes(): number {
  const d = getVectorDb();
  return d.prepare(
    `DELETE FROM t2_episodes WHERE strength < 0.05`
  ).run().changes;
}

// ── 向量嵌入操作（JSON 存储 + JS 余弦相似度）───────

const DIM = 768;

/** 将嵌入存为 JSON 数组字符串 */
export function updateEpisodeEmbedding(episodeId: number, embedding: Float32Array): void {
  const d = getVectorDb();
  const arr = Array.from(embedding);
  d.prepare("UPDATE t2_episodes SET embedding = ? WHERE id = ?").run(JSON.stringify(arr), episodeId);
}

/** 写入一条 episode 时同步存储嵌入 */
export function insertEpisodeWithEmbedding(
  content: string,
  source: string,
  embedding: Float32Array,
  emotionalWeight: number = 0,
): number {
  const d = getVectorDb();
  const arr = JSON.stringify(Array.from(embedding));
  const result = d.prepare(
    `INSERT INTO t2_episodes (persona_id, content, source, strength, emotional_weight, half_life_days, embedding)
     VALUES (?, ?, ?, 1.0, ?, 30.0, ?)`
  ).run(getCurrentPersona(), content, source, emotionalWeight, arr);
  return Number(result.lastInsertRowid);
}

/** 余弦相似度（向量需 L2 归一化） */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i];
  // L2 归一化后 ||a||=||b||=1，点积即余弦相似度
  return dot;
}

/** JS 层 KNN：加载所有活跃 episode 的嵌入，计算余弦相似度 */
export function searchSimilarEpisodes(
  queryEmbedding: Float32Array,
  k: number = 10,
): Array<{ id: number; similarity: number }> {
  const d = getVectorDb();
  const rows = d.prepare(
    `SELECT id, embedding FROM t2_episodes
     WHERE persona_id = ? AND strength > 0.05 AND embedding IS NOT NULL`
  ).all(getCurrentPersona()) as Array<{ id: number; embedding: string }>;

  if (rows.length === 0) return [];

  const query = Array.from(queryEmbedding);
  const scored = rows.map((row) => {
    const emb = JSON.parse(row.embedding) as number[];
    return { id: row.id, similarity: cosineSimilarity(query, emb) };
  });

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

/** 一次性回填：为已有 episodes 生成嵌入（幂等） */
export function backfillEpisodeVectors(embedFn: (text: string) => Float32Array): number {
  const d = getVectorDb();
  const missing = d.prepare(
    `SELECT id, content FROM t2_episodes
     WHERE persona_id = ? AND strength > 0.05 AND embedding IS NULL`
  ).all(getCurrentPersona()) as Array<{ id: number; content: string }>;

  if (missing.length === 0) return 0;

  const updateStmt = d.prepare("UPDATE t2_episodes SET embedding = ? WHERE id = ?");
  const tx = d.transaction((rows: Array<{ id: number; content: string }>) => {
    for (const row of rows) {
      const vec = embedFn(row.content);
      updateStmt.run(JSON.stringify(Array.from(vec)), row.id);
    }
    return rows.length;
  });

  return tx(missing);
}

export function closeVectorDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
