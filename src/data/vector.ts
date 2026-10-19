/**
 * T1-T2 记忆存储 + 向量索引（sqlite-vec）+ 全文索引（FTS5 BM25）。
 *
 * ── 数据模型（schema v2，M1-7 记忆检索闭环）─────────────────────────
 * t2_episodes 里同时存在两个**互不混比**的向量空间：
 * - embedding + embedding_model      legacy n-gram 空间（ngram-v1，JSON 数组）。
 *   保留此列是为了 src/evolution/style-reference.ts 与 eval 基准继续可用；
 *   同步检索（无 Qwen Key / 降级路径）只读这一列。
 * - semantic_embedding + semantic_model  语义空间（Qwen text-embedding-v3，JSON 数组）。
 *   异步检索只读这一列，且要求 semantic_model 与查询向量模型一致。
 * t2_vec 只索引语义向量，并用 embedding_model metadata 列过滤，杜绝跨模型 KNN；
 * t2_fts 是与人设/模型无关的中文全文索引（逐字空格 + unicode61，2 字词可命中）。
 *
 * ── 迁移策略（PRAGMA user_version 1 → 2）────────────────────────────
 * - 只增列 / 建派生索引表；**不删除、不覆写 t2_episodes 里的历史向量与内容**；
 * - 旧 t2_vec 只有 (id, embedding)，M0 建表后从未写入过（0 行），可安全 DROP 重建；
 * - t2_vec / t2_fts 都是派生索引，可由 rebuildVecIndex() / rebuildFtsIndex() 从
 *   t2_episodes 重建；
 * - 建议升级前备份：`cp data/memory.sqlite data/memory.sqlite.bak`；迁移幂等，可重复执行。
 *
 * ── sqlite-vec / FTS5 不可用时的回退 ──────────────────────────────
 * sqlite-vec 加载失败 → vecAvailable=false，语义检索回退到 JS 余弦（读 JSON 列）；
 * FTS5 建表失败 → ftsAvailable=false，混合检索退化为向量单路。均不阻塞启动。
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dbPath, ensureDataDir } from "./paths.js";
import { EMBEDDING_DIM, NGRAM_EMBEDDING_MODEL } from "./embedding.js";

let db: Database.Database | null = null;

/** 当前 schema 版本（PRAGMA user_version）。修改表结构时 +1 并补迁移。 */
const SCHEMA_VERSION = 2;

/** sqlite-vec 扩展是否可用（不可用时 KNN 回退 JS 余弦）。 */
let vecAvailable = false;
/** FTS5 是否可用（不可用时混合检索退化为向量单路）。 */
let ftsAvailable = false;
/** 索引写入失败只告警一次，避免每条记忆刷日志。 */
let warnedVecWriteFailure = false;

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
  vecAvailable = loadVecExtension(db);
  initTables(db);
  migrate(db);
  return db;
}

function loadVecExtension(database: Database.Database): boolean {
  try {
    sqliteVec.load(database);
    return true;
  } catch (err) {
    console.log(
      `[向量] sqlite-vec 扩展加载失败，KNN 回退 JS 余弦: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export function isVecIndexAvailable(): boolean {
  getVectorDb();
  return vecAvailable;
}

export function isFtsIndexAvailable(): boolean {
  getVectorDb();
  return ftsAvailable;
}

function initTables(database: Database.Database): void {
  // T1: 人格快照表（每次对话后写入一条）
  database.exec(`
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

  // T2: 经历向量表（新库直接带 v2 列；旧库由 migrate() 补列）
  database.exec(`
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
      embedding TEXT,
      embedding_model TEXT,
      semantic_embedding TEXT,
      semantic_model TEXT
    )
  `);
}

function migrateAddColumn(database: Database.Database, table: string, column: string, def: string): void {
  if (hasColumn(database, table, column)) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  } catch {
    // 并发场景下表结构可能刚被其他进程改过 → 忽略
  }
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return !!row;
}

/**
 * 幂等迁移。
 * v1：t2_episodes.embedding / last_recalled_at（M0 历史库缺列修复）
 * v2：embedding_model + semantic_embedding + semantic_model、t2_fts、t2_vec 新 schema
 */
function migrate(database: Database.Database): void {
  // ── v1 ──
  migrateAddColumn(database, "t2_episodes", "embedding", "TEXT");
  migrateAddColumn(database, "t2_episodes", "last_recalled_at", "TEXT");
  migrateAddColumn(database, "t1_snapshots", "persona_id", "TEXT NOT NULL DEFAULT 'unknown'");

  // ── v2：模型标记 + 语义向量列 ──
  migrateAddColumn(database, "t2_episodes", "embedding_model", "TEXT");
  migrateAddColumn(database, "t2_episodes", "semantic_embedding", "TEXT");
  migrateAddColumn(database, "t2_episodes", "semantic_model", "TEXT");

  // 历史 embedding 全部来自 n-gram（generateSemanticEmbedding 在接通前从未被调用）。
  // 只回填 NULL，不覆盖已有标记；幂等。
  try {
    database
      .prepare(
        `UPDATE t2_episodes
         SET embedding_model = ?
         WHERE embedding IS NOT NULL AND embedding_model IS NULL`
      )
      .run(NGRAM_EMBEDDING_MODEL);
  } catch {
    // 老库异常时不让启动失败
  }

  // 索引尽力而为：历史库可能缺列，不应让启动失败
  for (const stmt of [
    "CREATE INDEX IF NOT EXISTS idx_t2_persona_strength ON t2_episodes(persona_id, strength DESC)",
    "CREATE INDEX IF NOT EXISTS idx_t2_persona_created ON t2_episodes(persona_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_t1_persona_created ON t1_snapshots(persona_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_t2_semantic_model ON t2_episodes(persona_id, semantic_model)",
  ]) {
    try {
      database.exec(stmt);
    } catch {
      // 老库列不齐时跳过
    }
  }

  ensureFtsTable(database);
  ensureVecTable(database);

  const current = Number(database.pragma("user_version", { simple: true })) || 0;
  if (current !== SCHEMA_VERSION) {
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

// ── FTS5（中文逐字空格 + unicode61）──────────────────

/**
 * 中文 FTS5 分词预处理：CJK 字符逐字拆开、拉丁字母/数字保持成词，用空格连接。
 *
 * 为什么不用 trigram：SQLite FTS5 的 trigram 对中文 2 字词（咖啡/下雨/上海）MATCH 返回 0；
 * 逐字空格 + unicode61 可让 2 字词命中（实测 SQLite 3.53.2）。
 */
export function tokenizeForFts(text: string): string {
  if (!text) return "";
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]|[a-zA-Z0-9]+/g);
  if (!matches || matches.length === 0) return "";
  return matches.map((token) => token.toLowerCase()).join(" ");
}

function ensureFtsTable(database: Database.Database): void {
  try {
    database.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS t2_fts USING fts5(tokens, tokenize='unicode61')`
    );
    ftsAvailable = true;
  } catch (err) {
    ftsAvailable = false;
    console.log(
      `[记忆] FTS5 不可用，混合检索退化为向量单路: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // 已有 t2_episodes 但 FTS 索引缺失/落后（老库首次升级）→ 一次性重建。
  // 行数相等时是 O(1) 的 count 查询，不会每次启动都重建。
  try {
    const episodeCount = Number(
      (database.prepare(`SELECT COUNT(*) AS c FROM t2_episodes`).get() as { c: number }).c
    );
    const ftsCount = Number(
      (database.prepare(`SELECT COUNT(*) AS c FROM t2_fts`).get() as { c: number }).c
    );
    if (ftsCount !== episodeCount) {
      const rebuilt = rebuildFtsIndexInternal(database);
      if (rebuilt > 0) console.log(`[记忆] FTS5 索引已重建: ${rebuilt} 条`);
    }
  } catch {
    // 老库异常时跳过，检索侧会返回空并由调用方降级
  }
}

function ftsUpsert(database: Database.Database, id: number, content: string): void {
  if (!ftsAvailable) return;
  try {
    database.prepare(`DELETE FROM t2_fts WHERE rowid = CAST(? AS INTEGER)`).run(id);
    database
      .prepare(`INSERT INTO t2_fts(rowid, tokens) VALUES (CAST(? AS INTEGER), ?)`)
      .run(id, tokenizeForFts(content));
  } catch {
    // 索引写入失败不影响主数据（检索侧会缺该条）
  }
}

function ftsDelete(database: Database.Database, id: number): void {
  if (!ftsAvailable) return;
  try {
    database.prepare(`DELETE FROM t2_fts WHERE rowid = CAST(? AS INTEGER)`).run(id);
  } catch {
    // ignore
  }
}

/**
 * 中文 BM25 全文检索（返回匹配的 episode id，按 bm25 升序 = 越相关越靠前）。
 * 2 字词（咖啡/下雨/上海）与 ≥3 字词均可命中；查询词逐 token 加引号防注入 FTS 语法。
 */
export function searchEpisodesByFts(
  queryText: string,
  limit: number = 10,
  opts?: { excludeSources?: string[] }
): Array<{ id: number; bm25: number }> {
  const d = getVectorDb();
  if (!ftsAvailable) return [];

  const tokens = tokenizeForFts(queryText).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const matchExpr = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");

  const excludeSources = opts?.excludeSources ?? [];
  const excludeClause =
    excludeSources.length > 0
      ? ` AND e.source NOT IN (${excludeSources.map(() => "?").join(", ")})`
      : "";

  try {
    return d
      .prepare(
        `SELECT e.id AS id, bm25(t2_fts) AS bm25
         FROM t2_fts
         JOIN t2_episodes e ON e.id = t2_fts.rowid
         WHERE t2_fts MATCH ?
           AND e.persona_id = ?
           AND e.strength > 0.05
           ${excludeClause}
         ORDER BY bm25 ASC
         LIMIT ?`
      )
      .all(matchExpr, getCurrentPersona(), ...excludeSources, limit) as Array<{
      id: number;
      bm25: number;
    }>;
  } catch {
    return [];
  }
}

/** 全量重建 FTS5 索引（迁移/运维用；幂等）。返回重建条数。 */
export function rebuildFtsIndex(): number {
  const d = getVectorDb();
  if (!ftsAvailable) return 0;
  return rebuildFtsIndexInternal(d);
}

function rebuildFtsIndexInternal(database: Database.Database): number {
  const rows = database
    .prepare(`SELECT id, content FROM t2_episodes`)
    .all() as Array<{ id: number; content: string }>;
  const rebuild = database.transaction(() => {
    database.exec(`DELETE FROM t2_fts`);
    for (const row of rows) {
      database
        .prepare(`INSERT INTO t2_fts(rowid, tokens) VALUES (?, ?)`)
        .run(row.id, tokenizeForFts(row.content));
    }
    return rows.length;
  });
  return rebuild();
}

// ── sqlite-vec（vec0 cosine + metadata 过滤）──────────

const VEC_TABLE_COLUMNS = ["id", "embedding", "persona_id", "source", "embedding_model"];

function ensureVecTable(database: Database.Database): void {
  if (!vecAvailable) return;

  let existingColumns: string[] | null = null;
  try {
    if (tableExists(database, "t2_vec")) {
      existingColumns = (
        database.prepare(`PRAGMA table_info(t2_vec)`).all() as Array<{ name: string }>
      ).map((c) => c.name);
    }
  } catch {
    // 扩展加载异常时 PRAGMA 也可能失败 → 本次跳过向量索引
    return;
  }

  try {
    if (existingColumns && !VEC_TABLE_COLUMNS.every((c) => existingColumns!.includes(c))) {
      // 旧 schema 只有 (id, embedding)，M0 建表后从未写入（0 行）；派生索引可安全重建
      database.exec(`DROP TABLE t2_vec`);
      existingColumns = null;
      console.log(`[记忆] t2_vec 旧 schema 已重建（派生索引，零业务数据损失）`);
    }

    if (!existingColumns) {
      database.exec(`
        CREATE VIRTUAL TABLE t2_vec USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${EMBEDDING_DIM}] distance_metric=cosine,
          persona_id TEXT,
          source TEXT,
          embedding_model TEXT
        )
      `);
    }
  } catch (err) {
    vecAvailable = false;
    console.log(
      `[记忆] sqlite-vec 向量索引不可用，回退 JS 余弦: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // 语义向量列有数据但 vec 索引缺行（例如上次运行扩展不可用）→ 幂等重建
  try {
    const semanticCount = Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS c FROM t2_episodes
             WHERE semantic_embedding IS NOT NULL AND semantic_model IS NOT NULL`
          )
          .get() as { c: number }
      ).c
    );
    const vecCount = Number(
      (database.prepare(`SELECT COUNT(*) AS c FROM t2_vec`).get() as { c: number }).c
    );
    if (semanticCount > vecCount) {
      const rebuilt = rebuildVecIndexInternal(database);
      console.log(`[记忆] sqlite-vec 索引已重建: ${rebuilt} 条（语义向量 ${semanticCount} 条）`);
    }
  } catch {
    // ignore
  }
}

function toVecBuffer(vector: Float32Array): Buffer {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`向量维度 ${vector.length} != ${EMBEDDING_DIM}`);
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** upsert 语义向量到 vec0（vec0 不支持 INSERT OR REPLACE，需先 DELETE）。 */
function vecUpsert(
  database: Database.Database,
  id: number,
  vector: Float32Array,
  personaId: string,
  source: string,
  model: string
): void {
  if (!vecAvailable) return;
  try {
    database.prepare(`DELETE FROM t2_vec WHERE id = CAST(? AS INTEGER)`).run(id);
    database
      .prepare(
        `INSERT INTO t2_vec(id, embedding, persona_id, source, embedding_model)
         VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)`
      )
      .run(id, toVecBuffer(vector), personaId, source, model);
  } catch (err) {
    if (!warnedVecWriteFailure) {
      console.log(
        `[记忆] vec0 索引写入失败（检索将回退 JS 余弦）: ${err instanceof Error ? err.message : String(err)}`
      );
      warnedVecWriteFailure = true;
    }
  }
}

function vecDelete(database: Database.Database, id: number): void {
  if (!vecAvailable) return;
  try {
    database.prepare(`DELETE FROM t2_vec WHERE id = CAST(? AS INTEGER)`).run(id);
  } catch {
    // ignore
  }
}

/**
 * 语义向量 KNN：优先 sqlite-vec（cosine distance），不可用/无结果时回退 JS 余弦。
 * 只与同 model 的语义向量比较（跨模型余弦无意义）。
 */
export function searchSemanticEpisodes(
  queryEmbedding: Float32Array,
  k: number = 10,
  model: string = "",
  opts?: { excludeSources?: string[] }
): Array<{ id: number; similarity: number }> {
  const d = getVectorDb();
  if (!model) return [];
  const excludeSources = opts?.excludeSources ?? [];
  const excludeSet = new Set(excludeSources);

  // 1) sqlite-vec KNN（metadata 过滤 persona/model；source 在 JS 里过滤，k 放大补偿）
  if (vecAvailable) {
    try {
      const fetchK = Math.max(k * 3, 30);
      const rows = d
        .prepare(
          `SELECT id, source, distance
           FROM t2_vec
           WHERE embedding MATCH ? AND k = ? AND persona_id = ? AND embedding_model = ?
           ORDER BY distance`
        )
        .all(toVecBuffer(queryEmbedding), fetchK, getCurrentPersona(), model) as Array<{
        id: number;
        source: string;
        distance: number;
      }>;
      if (rows.length > 0) {
        return rows
          .filter((row) => !excludeSet.has(row.source))
          .map((row) => ({ id: row.id, similarity: Math.max(-1, Math.min(1, 1 - row.distance)) }))
          .slice(0, k);
      }
    } catch {
      // 扩展异常 → 回退 JS
    }
  }

  // 2) 回退：读 semantic_embedding JSON 全量余弦（数据量 10³–10⁴ 可接受）
  const excludeClause =
    excludeSources.length > 0
      ? ` AND source NOT IN (${excludeSources.map(() => "?").join(", ")})`
      : "";
  const rows = d
    .prepare(
      `SELECT id, semantic_embedding FROM t2_episodes
       WHERE persona_id = ?
         AND strength > 0.05
         AND semantic_model = ?
         AND semantic_embedding IS NOT NULL
         ${excludeClause}`
    )
    .all(getCurrentPersona(), model, ...excludeSources) as Array<{
    id: number;
    semantic_embedding: string;
  }>;

  const scored: Array<{ id: number; similarity: number }> = [];
  for (const row of rows) {
    try {
      const emb = JSON.parse(row.semantic_embedding) as number[];
      if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
      scored.push({ id: row.id, similarity: cosineSimilarity(queryEmbedding, emb) });
    } catch {
      // 损坏的 JSON 跳过
    }
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

/** 全量重建 vec0 索引（从 semantic_embedding 派生；迁移/运维用；幂等）。 */
export function rebuildVecIndex(): number {
  const d = getVectorDb();
  if (!vecAvailable) return 0;
  return rebuildVecIndexInternal(d);
}

function rebuildVecIndexInternal(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT id, persona_id, source, semantic_embedding, semantic_model
       FROM t2_episodes
       WHERE semantic_embedding IS NOT NULL AND semantic_model IS NOT NULL`
    )
    .all() as Array<{
    id: number;
    persona_id: string;
    source: string;
    semantic_embedding: string;
    semantic_model: string;
  }>;

  const rebuild = database.transaction(() => {
    database.exec(`DELETE FROM t2_vec`);
    let inserted = 0;
    for (const row of rows) {
      try {
        const emb = JSON.parse(row.semantic_embedding) as number[];
        if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) continue;
        const vector = Float32Array.from(emb);
        database
          .prepare(`DELETE FROM t2_vec WHERE id = CAST(? AS INTEGER)`)
          .run(row.id);
        database
          .prepare(
            `INSERT INTO t2_vec(id, embedding, persona_id, source, embedding_model)
             VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)`
          )
          .run(row.id, toVecBuffer(vector), row.persona_id, row.source, row.semantic_model);
        inserted++;
      } catch {
        // 单条损坏跳过
      }
    }
    return inserted;
  });

  return rebuild();
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

interface EpisodeRow {
  id: number;
  content: string;
  persona_id: string;
  source: string;
  strength: number;
  emotional_weight: number;
}

function getEpisodeRow(database: Database.Database, id: number): EpisodeRow | undefined {
  return database
    .prepare(
      `SELECT id, content, persona_id, source, strength, emotional_weight
       FROM t2_episodes WHERE id = ?`
    )
    .get(id) as EpisodeRow | undefined;
}

/** 向 T2 插入一条经历（无向量），返回 ID；同步维护 FTS 索引。 */
export function insertEpisode(
  content: string,
  source: string = "chat",
  emotionalWeight: number = 0
): number {
  const d = getVectorDb();
  const insert = d.transaction((): number => {
    const result = d.prepare(
      `INSERT INTO t2_episodes (persona_id, content, source, strength, emotional_weight, half_life_days)
       VALUES (?, ?, ?, 1.0, ?, 30.0)`
    ).run(getCurrentPersona(), content, source, emotionalWeight);
    const id = Number(result.lastInsertRowid);
    ftsUpsert(d, id, content);
    return id;
  });
  return insert();
}

/** 更新 T2 记忆强度（艾宾浩斯衰减或强化） */
export function updateStrength(id: number, newStrength: number): void {
  getVectorDb().prepare(
    `UPDATE t2_episodes SET strength = ?, last_recalled_at = datetime('now') WHERE id = ?`
  ).run(Math.max(0, Math.min(1, newStrength)), id);
}

/** 关键词搜索当前人设的 T2（legacy LIKE；混合检索请用 searchEpisodesByFts） */
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

/** 归档已衰减到接近零的记忆（同步删除 FTS / vec 派生索引）。 */
export function archiveDecayedEpisodes(): number {
  const d = getVectorDb();
  const archive = d.transaction((): number => {
    const ids = d
      .prepare(`SELECT id FROM t2_episodes WHERE strength < 0.05`)
      .all() as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    d.prepare(`DELETE FROM t2_episodes WHERE strength < 0.05`).run();
    for (const { id } of ids) {
      ftsDelete(d, id);
      vecDelete(d, id);
    }
    return ids.length;
  });
  return archive();
}

/** 按 id 删除一条 T2 记忆（同步删除 FTS / vec 派生索引）。 */
export function deleteEpisode(id: number): boolean {
  const d = getVectorDb();
  const remove = d.transaction((): boolean => {
    const result = d.prepare(`DELETE FROM t2_episodes WHERE id = ?`).run(id);
    ftsDelete(d, id);
    vecDelete(d, id);
    return result.changes > 0;
  });
  return remove();
}

// ── 向量嵌入操作（legacy JSON n-gram + 语义 JSON/vec0）──────────

/** 余弦相似度（向量需 L2 归一化） */
function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA < 1e-9 || normB < 1e-9) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 更新单条 episode 的 legacy n-gram 向量（JSON 列），并记录模型标记。
 * 语义向量请用 updateEpisodeSemanticEmbedding（两个空间互不混写）。
 */
export function updateEpisodeEmbedding(episodeId: number, embedding: Float32Array): void {
  const d = getVectorDb();
  const arr = JSON.stringify(Array.from(embedding));
  d.prepare(
    `UPDATE t2_episodes SET embedding = ?, embedding_model = ? WHERE id = ?`
  ).run(arr, NGRAM_EMBEDDING_MODEL, episodeId);
}

/** 写入一条 episode 时同步存储 legacy n-gram 嵌入 + FTS 索引。 */
export function insertEpisodeWithEmbedding(
  content: string,
  source: string,
  embedding: Float32Array,
  emotionalWeight: number = 0,
): number {
  const d = getVectorDb();
  const arr = JSON.stringify(Array.from(embedding));
  const insert = d.transaction((): number => {
    const result = d.prepare(
      `INSERT INTO t2_episodes
         (persona_id, content, source, strength, emotional_weight, half_life_days, embedding, embedding_model)
       VALUES (?, ?, ?, 1.0, ?, 30.0, ?, ?)`
    ).run(getCurrentPersona(), content, source, emotionalWeight, arr, NGRAM_EMBEDDING_MODEL);
    const id = Number(result.lastInsertRowid);
    ftsUpsert(d, id, content);
    return id;
  });
  return insert();
}

/**
 * 写入一条 episode，同时落 legacy n-gram 向量与语义向量（语义可用时的写入主路径）。
 * 两个向量空间各自记录 model，检索时不会混比。
 */
export function insertEpisodeWithSemanticEmbedding(
  content: string,
  source: string,
  legacyEmbedding: Float32Array,
  semanticEmbedding: Float32Array,
  semanticModel: string,
  emotionalWeight: number = 0,
): number {
  const d = getVectorDb();
  const legacyArr = JSON.stringify(Array.from(legacyEmbedding));
  const semanticArr = JSON.stringify(Array.from(semanticEmbedding));
  const personaId = getCurrentPersona();
  const insert = d.transaction((): number => {
    const result = d.prepare(
      `INSERT INTO t2_episodes
         (persona_id, content, source, strength, emotional_weight, half_life_days,
          embedding, embedding_model, semantic_embedding, semantic_model)
       VALUES (?, ?, ?, 1.0, ?, 30.0, ?, ?, ?, ?)`
    ).run(
      personaId,
      content,
      source,
      emotionalWeight,
      legacyArr,
      NGRAM_EMBEDDING_MODEL,
      semanticArr,
      semanticModel
    );
    const id = Number(result.lastInsertRowid);
    ftsUpsert(d, id, content);
    vecUpsert(d, id, semanticEmbedding, personaId, source, semanticModel);
    return id;
  });
  return insert();
}

/**
 * 写入/更新单条 episode 的语义向量（后台升级 / 回填用）。
 * 只与 semantic_model 相同的向量比较；同步维护 t2_vec。
 */
export function updateEpisodeSemanticEmbedding(
  episodeId: number,
  embedding: Float32Array,
  model: string
): boolean {
  const d = getVectorDb();
  const row = getEpisodeRow(d, episodeId);
  if (!row) return false;
  const arr = JSON.stringify(Array.from(embedding));
  const update = d.transaction((): boolean => {
    const result = d.prepare(
      `UPDATE t2_episodes SET semantic_embedding = ?, semantic_model = ? WHERE id = ?`
    ).run(arr, model, episodeId);
    vecUpsert(d, episodeId, embedding, row.persona_id, row.source, model);
    return result.changes > 0;
  });
  return update();
}

/**
 * 旧 JSON n-gram 向量检索（同步降级路径 / legacy API）。
 * 只比较 embedding_model = ngram-v1 的向量，避免与语义空间混比。
 */
export function searchSimilarEpisodes(
  queryEmbedding: Float32Array,
  k: number = 10,
  opts?: { excludeSources?: string[] }
): Array<{ id: number; similarity: number }> {
  const d = getVectorDb();
  const excludeSources = opts?.excludeSources ?? [];
  const excludeClause =
    excludeSources.length > 0
      ? ` AND source NOT IN (${excludeSources.map(() => "?").join(", ")})`
      : "";
  const rows = d.prepare(
    `SELECT id, embedding FROM t2_episodes
     WHERE persona_id = ?
       AND strength > 0.05
       AND embedding IS NOT NULL
       AND COALESCE(embedding_model, ?) = ?
       ${excludeClause}`
  ).all(getCurrentPersona(), NGRAM_EMBEDDING_MODEL, NGRAM_EMBEDDING_MODEL, ...excludeSources) as Array<{ id: number; embedding: string }>;

  if (rows.length === 0) return [];

  const scored: Array<{ id: number; similarity: number }> = [];
  for (const row of rows) {
    try {
      const emb = JSON.parse(row.embedding) as number[];
      if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
      scored.push({ id: row.id, similarity: cosineSimilarity(queryEmbedding, emb) });
    } catch {
      // 损坏的 JSON 跳过
    }
  }

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

/** 一次性回填：为已有 episodes 生成 legacy n-gram 嵌入（幂等；同步维护 FTS）。 */
export function backfillEpisodeVectors(embedFn: (text: string) => Float32Array): number {
  const d = getVectorDb();
  const missing = d.prepare(
    `SELECT id, content FROM t2_episodes
     WHERE persona_id = ? AND strength > 0.05 AND embedding IS NULL`
  ).all(getCurrentPersona()) as Array<{ id: number; content: string }>;

  if (missing.length === 0) return 0;

  const updateStmt = d.prepare(
    `UPDATE t2_episodes SET embedding = ?, embedding_model = ? WHERE id = ?`
  );
  const tx = d.transaction((rows: Array<{ id: number; content: string }>) => {
    for (const row of rows) {
      const vec = embedFn(row.content);
      updateStmt.run(JSON.stringify(Array.from(vec)), NGRAM_EMBEDDING_MODEL, row.id);
      ftsUpsert(d, row.id, row.content);
    }
    return rows.length;
  });

  return tx(missing);
}

// ── 语义 embedding 回填辅助（embedding.ts 使用）──────

/** 还缺语义向量的 episode（跨人设，按 id 排序，幂等回填用）。 */
export function getEpisodesNeedingSemanticEmbedding(
  limit: number = 100
): Array<{ id: number; content: string }> {
  const d = getVectorDb();
  return d.prepare(
    `SELECT id, content FROM t2_episodes
     WHERE semantic_embedding IS NULL AND strength > 0.05
     ORDER BY id
     LIMIT ?`
  ).all(limit) as Array<{ id: number; content: string }>;
}

/** 待回填语义向量的条数。 */
export function countPendingSemanticBackfill(): number {
  const d = getVectorDb();
  const row = d.prepare(
    `SELECT COUNT(*) AS c FROM t2_episodes
     WHERE semantic_embedding IS NULL AND strength > 0.05`
  ).get() as { c: number };
  return Number(row.c);
}

/** 索引统计（测试 / 运维 / /stats 用）。 */
export function getIndexStats(): {
  legacyEpisodes: number;
  semanticEpisodes: number;
  ftsRows: number;
  vecRows: number;
  vecAvailable: boolean;
  ftsAvailable: boolean;
} {
  const d = getVectorDb();
  const count = (sql: string): number => {
    try {
      return Number((d.prepare(sql).get() as { c: number }).c);
    } catch {
      return 0;
    }
  };
  return {
    legacyEpisodes: count(`SELECT COUNT(*) AS c FROM t2_episodes WHERE embedding IS NOT NULL`),
    semanticEpisodes: count(
      `SELECT COUNT(*) AS c FROM t2_episodes WHERE semantic_embedding IS NOT NULL`
    ),
    ftsRows: count(`SELECT COUNT(*) AS c FROM t2_fts`),
    vecRows: count(`SELECT COUNT(*) AS c FROM t2_vec`),
    vecAvailable,
    ftsAvailable,
  };
}

export function closeVectorDb(): void {
  if (db) {
    db.close();
    db = null;
    vecAvailable = false;
    ftsAvailable = false;
  }
}
