/**
 * 记忆 v2（v0.5）：锚点 / 日记忆 / 周汇总 / 调度记录。
 *
 * 为什么单独一模块：现有 `vector.ts` 管 T2 情节记忆（episodes + FTS + 向量），
 * 已经很长；v0.5 新增的四类数据（锚点、日记忆、周汇总、job 记录）语义不同、
 * 生命周期不同（锚点永不衰减、日记忆按天归档），分开放更清楚，也便于单独测试。
 *
 * 设计要点：
 * - 本模块只接受传入的 `Database` 实例，**不 import vector.ts**，避免循环依赖；
 *   `vector.ts` 的 migrate() 会调用 `ensureMemoryV2Schema()`。
 * - 所有建表/加列都幂等（IF NOT EXISTS / ADD COLUMN 失败忽略）。
 * - 多用户隔离：所有表都带 persona_id + owner_id。
 * - 显著度打分（scoreSalience）与锚点类型判定（inferAnchorKind）是纯函数，方便单测。
 */
import type DatabaseType from "better-sqlite3";
import type { Database } from "better-sqlite3";

// ── 类型 ──────────────────────────────────────

export type AnchorKind =
  | "first_meet"
  | "confession"
  | "conflict"
  | "makeup"
  | "promise"
  | "secret"
  | "shared_experience"
  | "loss";

export interface AnchorRow {
  id: number;
  persona_id: string;
  owner_id: string;
  kind: AnchorKind;
  summary: string;
  quote: string | null;
  strength: number;
  recall_count: number;
  last_recalled_at: number | null;
  source_msg_ids: string | null;
  created_at: number;
  valid_from: number | null;
  valid_to: number | null;
  rewritten_by: string | null;
}

export interface DailyDigestRow {
  id: number;
  persona_id: string;
  owner_id: string;
  day: string;
  summary: string;
  mood: string | null;
  events_json: string | null;
  open_threads_json: string | null;
  created_at: number;
}

// ── 建表（幂等） ───────────────────────────────

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // 老库/表不存在时忽略：调用方会先 ensureMemoryTables
  }
}

/**
 * 建立 v0.5 需要的表与列。幂等，可重复调用（每次启动都会跑）。
 */
export function ensureMemoryV2Schema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      quote TEXT,
      strength REAL DEFAULT 0.6,
      recall_count INTEGER DEFAULT 0,
      last_recalled_at INTEGER,
      source_msg_ids TEXT,
      created_at INTEGER NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      rewritten_by TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      day TEXT NOT NULL,
      summary TEXT NOT NULL,
      mood TEXT,
      events_json TEXT,
      open_threads_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(persona_id, owner_id, day)
    );
    CREATE TABLE IF NOT EXISTS weekly_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(persona_id, owner_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS sticker_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      file TEXT NOT NULL,
      source TEXT,
      tags_json TEXT,
      emotion TEXT,
      use_count INTEGER DEFAULT 0,
      first_seen_at INTEGER,
      last_used_at INTEGER,
      mime TEXT,
      bytes INTEGER,
      UNIQUE(owner_id, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_sticker_owner
      ON sticker_library(owner_id, last_used_at, use_count);
    CREATE TABLE IF NOT EXISTS initiative_plans (
      persona_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      day TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (persona_id, owner_id, day)
    );
    CREATE TABLE IF NOT EXISTS initiative_stats (
      owner_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      replied INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_id, sent_at)
    );
    CREATE TABLE IF NOT EXISTS getting_to_know (
      owner_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      asked_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, topic)
    );
    CREATE TABLE IF NOT EXISTS job_runs (
      job TEXT NOT NULL,
      period TEXT NOT NULL,
      ran_at INTEGER NOT NULL,
      PRIMARY KEY (job, period)
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_owner
      ON memory_anchors(persona_id, owner_id, valid_to, strength DESC);
    CREATE INDEX IF NOT EXISTS idx_digest_owner
      ON daily_digests(persona_id, owner_id, day DESC);
  `);

  // 扩展既有表（列不存在才加，失败忽略）
  addColumnIfMissing(db, "user_facts", "confidence", "REAL DEFAULT 0.6");
  addColumnIfMissing(db, "user_facts", "status", "TEXT DEFAULT 'pending'");
  addColumnIfMissing(db, "user_facts", "source_quote", "TEXT");
  addColumnIfMissing(db, "user_facts", "confirmed_at", "INTEGER");
  // 质疑留痕：同一条事实最近问过一次就别反复问（v0.5）
  addColumnIfMissing(db, "user_facts", "challenged_at", "INTEGER");
  addColumnIfMissing(db, "t2_episodes", "salience", "REAL DEFAULT 0.5");
  addColumnIfMissing(db, "t2_episodes", "heat", "REAL DEFAULT 0");
  addColumnIfMissing(db, "t2_episodes", "anchor_id", "INTEGER");
}

// ── 显著度与锚点类型（纯函数） ──────────────────

export interface SalienceInput {
  content: string;
  source?: string;
  /** 情绪向量 -1..1（绝对值越大越显著） */
  emotionVector?: number;
}

export interface SalienceResult {
  score: number;
  reasons: string[];
}

const PROMISE_WORDS = /(答应|说好|保证|一定会|下次|明天要|记得|约好|承诺)/;
const CONFLICT_WORDS = /(生气|吵架|翻脸|冷战|难过|凶我|不理我|吼|烦死)/;
const REPAIR_WORDS = /(对不起|抱歉|我错了|别生气|原谅)/;
const SELF_DISCLOSURE = /(我妈|我爸|我家|我小时候|我老板|我同事|我朋友|我以前|我大学)/;
const SHARED_WORDS = /(第一次|一起|那天我们|我们俩|上次你|上次我)/;
const SECRET_WORDS = /(别告诉|只跟你说|不想让别人知道|秘密)/;
const CONFESSION_WORDS = /(喜欢你|爱你|想你了|舍不得|在乎你)/;
// v0.8.15：收紧「失去」词表——原来的「走了/离开/没了」会误伤「我先走了/没电了」，
// 但真正的至亲离世必须记住（冒烟发现「奶奶去世」只有 0.60，低于 0.75 阈值 → 漏记）。
// 两部分：明确词 + 「亲人+走了/没了」这种口语说法（但不含「我先走了/没电了」）。
const LOSS_WORDS =
  /(去世|过世|离世|病逝|不在了|不在了以后|走了以后|离开人世|葬礼|下葬|分手|离婚|(?:奶奶|爷爷|姥姥|姥爷|外婆|外公|爸爸|妈妈|我爸|我妈|家人|亲人|朋友|同事|他|她)[^。！？\n]{0,8}(?:走了|没了))/;

/**
 * 显著度打分（0-1）：决定这段对话值不值得成为"锚点"。
 *
 * 真人记住的不是"每条消息"，而是**有情绪、有承诺、有冲突、有共同经历**的时刻。
 * 规则可解释、可单测；LLM 判定放在异步流程里做二次筛选。
 */
export function scoreSalience(input: SalienceInput): SalienceResult {
  const content = input.content ?? "";
  const reasons: string[] = [];
  let score = 0.35;

  const emotion = Math.abs(input.emotionVector ?? 0);
  if (emotion >= 0.4) {
    score += 0.2;
    reasons.push(`情绪强度 ${emotion.toFixed(2)}`);
  }
  if (PROMISE_WORDS.test(content)) {
    score += 0.25;
    reasons.push("承诺/约定");
  }
  if (CONFLICT_WORDS.test(content)) {
    score += 0.2;
    reasons.push("冲突/负面情绪");
  }
  if (REPAIR_WORDS.test(content)) {
    score += 0.15;
    reasons.push("道歉/修复");
  }
  if (SELF_DISCLOSURE.test(content)) {
    score += 0.15;
    reasons.push("自我披露");
  }
  if (SHARED_WORDS.test(content)) {
    score += 0.2;
    reasons.push("共同经历");
  }
  if (SECRET_WORDS.test(content)) {
    score += 0.3;
    reasons.push("秘密");
  }
  if (CONFESSION_WORDS.test(content)) {
    score += 0.3;
    reasons.push("表白/亲密表达");
  }
  if (LOSS_WORDS.test(content)) {
    // 至亲离世/分手这类事是"永远不会忘"的典型：单项就应达到阈值，
    // 否则会出现"记得住约好看海、记不住奶奶去世"的荒谬结果（真实冒烟抓到）。
    score += 0.4;
    reasons.push("失去/离开");
  }
  if (Array.from(content).length >= 60) {
    score += 0.1;
    reasons.push("长段落");
  }
  // 她的内心独白不作为「共同经历」锚点的主要来源，降权
  if (input.source === "internal_monologue") {
    score -= 0.15;
    reasons.push("独白降权");
  }

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(2)))), reasons };
}

/** 按内容猜锚点类型（规则版；LLM 可在异步流程里覆盖）。 */
export function inferAnchorKind(content: string): AnchorKind {
  if (LOSS_WORDS.test(content)) return "loss";
  if (CONFLICT_WORDS.test(content)) return "conflict";
  if (REPAIR_WORDS.test(content)) return "makeup";
  if (SECRET_WORDS.test(content)) return "secret";
  if (CONFESSION_WORDS.test(content)) return "confession";
  if (PROMISE_WORDS.test(content)) return "promise";
  if (SHARED_WORDS.test(content)) return "shared_experience";
  return "shared_experience";
}

/** 锚点一句话摘要（规则版兜底：截到 30 字，去掉多余空白）。 */
export function summarizeAnchor(content: string, maxChars = 30): string {
  const clean = (content ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, maxChars).join("")}…`;
}

// ── 锚点 CRUD ─────────────────────────────────

export interface AddAnchorInput {
  personaId: string;
  ownerId: string;
  kind: AnchorKind;
  summary: string;
  quote?: string;
  strength?: number;
  sourceMsgIds?: string;
  now?: number;
}

/** 按 summary 查已有锚点 id（复筛用来区分「新建」与「复述强化」）。 */
export function findAnchorBySummary(
  db: Database,
  personaId: string,
  ownerId: string,
  summary: string,
): number | null {
  const text = summarizeAnchor(summary, 60);
  if (!text) return null;
  try {
    const row = db
      .prepare(
        `SELECT id FROM memory_anchors
         WHERE persona_id = ? AND owner_id = ? AND summary = ? AND valid_to IS NULL`,
      )
      .get(personaId, ownerId, text) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  } catch {
    return null;
  }
}

/** 写一条锚点（同 owner 同一 summary 去重，避免同一件事反复入库）。 */
export function addAnchor(db: Database, input: AddAnchorInput): number | null {
  const now = input.now ?? Date.now();
  const summary = summarizeAnchor(input.summary, 60);
  if (!summary) return null;
  try {
    const existing = db
      .prepare(
        `SELECT id FROM memory_anchors
         WHERE persona_id = ? AND owner_id = ? AND summary = ? AND valid_to IS NULL`,
      )
      .get(input.personaId, input.ownerId, summary) as { id: number } | undefined;
    if (existing) {
      // 再次提到 → 强度上升（复述强化）
      db.prepare(
        `UPDATE memory_anchors SET strength = MIN(1.0, strength + 0.1) WHERE id = ?`,
      ).run(existing.id);
      return existing.id;
    }
    const info = db
      .prepare(
        `INSERT INTO memory_anchors
           (persona_id, owner_id, kind, summary, quote, strength, recall_count,
            source_msg_ids, created_at, valid_from)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.personaId,
        input.ownerId,
        input.kind,
        summary,
        input.quote ?? null,
        Math.max(0.1, Math.min(1, input.strength ?? 0.6)),
        input.sourceMsgIds ?? null,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

/** 取锚点（默认只取未失效的，按强度/新近排序）。 */
export function listAnchors(
  db: Database,
  personaId: string,
  ownerId: string,
  limit = 5,
): AnchorRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM memory_anchors
         WHERE persona_id = ? AND owner_id = ? AND valid_to IS NULL
         ORDER BY strength DESC, created_at DESC
         LIMIT ?`,
      )
      .all(personaId, ownerId, Math.max(1, limit)) as AnchorRow[];
  } catch {
    return [];
  }
}

/** 被回忆起时留痕（用于"她主动提起旧事"的频率控制与热度）。 */
export function touchAnchors(db: Database, ids: number[], now = Date.now()): void {
  if (ids.length === 0) return;
  try {
    const stmt = db.prepare(
      `UPDATE memory_anchors
       SET recall_count = recall_count + 1, last_recalled_at = ?
       WHERE id = ?`,
    );
    for (const id of ids) stmt.run(now, id);
  } catch {
    // 留痕失败不影响对话
  }
}

/**
 * 让锚点失效（双时间轴：不删，只标记 valid_to）。
 * 用于「用户否认这件事」或「再巩固后改写」。
 */
export function expireAnchor(db: Database, id: number, now = Date.now(), rewrittenBy?: string): void {
  try {
    db.prepare(
      `UPDATE memory_anchors SET valid_to = ?, rewritten_by = COALESCE(?, rewritten_by) WHERE id = ?`,
    ).run(now, rewrittenBy ?? null, id);
  } catch {
    // 忽略
  }
}

/** 锚点 → prompt 片段（一行一条，带类型标签）。 */
export function buildAnchorInjection(anchors: AnchorRow[]): string {
  if (anchors.length === 0) return "";
  const kindLabel: Record<AnchorKind, string> = {
    first_meet: "相识",
    confession: "表白",
    conflict: "冲突",
    makeup: "和好",
    promise: "约定",
    secret: "秘密",
    shared_experience: "共同经历",
    loss: "失去",
  };
  const lines = anchors.map((a) => `- [${kindLabel[a.kind] ?? "记忆"}] ${a.summary}`);
  return `\n## 你记得的关键时刻\n${lines.join("\n")}\n（这些是你们真实经历过的事，可以自然提起，但别每次都说。）\n`;
}

// ── 日记忆 ────────────────────────────────────

export interface UpsertDigestInput {
  personaId: string;
  ownerId: string;
  day: string;
  summary: string;
  mood?: string;
  events?: string[];
  openThreads?: string[];
  now?: number;
}

export function upsertDailyDigest(db: Database, input: UpsertDigestInput): void {
  try {
    db.prepare(
      `INSERT INTO daily_digests
         (persona_id, owner_id, day, summary, mood, events_json, open_threads_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(persona_id, owner_id, day) DO UPDATE SET
         summary = excluded.summary,
         mood = excluded.mood,
         events_json = excluded.events_json,
         open_threads_json = excluded.open_threads_json,
         created_at = excluded.created_at`,
    ).run(
      input.personaId,
      input.ownerId,
      input.day,
      input.summary,
      input.mood ?? null,
      JSON.stringify(input.events ?? []),
      JSON.stringify(input.openThreads ?? []),
      input.now ?? Date.now(),
    );
  } catch {
    // 写失败不影响对话
  }
}

export function listRecentDigests(
  db: Database,
  personaId: string,
  ownerId: string,
  limit = 3,
): DailyDigestRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM daily_digests
         WHERE persona_id = ? AND owner_id = ?
         ORDER BY day DESC LIMIT ?`,
      )
      .all(personaId, ownerId, Math.max(1, limit)) as DailyDigestRow[];
  } catch {
    return [];
  }
}

/** 日记忆 → prompt 片段（最近 N 天，按时间正序）。 */
export function buildDailyInjection(digests: DailyDigestRow[]): string {
  if (digests.length === 0) return "";
  const lines = [...digests]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => `- ${d.day}：${d.summary}${d.open_threads_json ? "" : ""}`);
  return `\n## 你们最近聊过的事\n${lines.join("\n")}\n`;
}

// ── 调度记录（幂等） ───────────────────────────

export function wasJobRun(db: Database, job: string, period: string): boolean {
  try {
    const row = db
      .prepare(`SELECT ran_at FROM job_runs WHERE job = ? AND period = ?`)
      .get(job, period) as { ran_at: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export function markJobRun(db: Database, job: string, period: string, now = Date.now()): void {
  try {
    db.prepare(
      `INSERT INTO job_runs (job, period, ran_at) VALUES (?, ?, ?)
       ON CONFLICT(job, period) DO UPDATE SET ran_at = excluded.ran_at`,
    ).run(job, period, now);
  } catch {
    // 忽略
  }
}

// ── 便捷：一次性初始化 ─────────────────────────

/** 测试用：在给定 db 上初始化 v0.5 表结构并返回它。 */
export function initMemoryV2(db: Database): Database {
  ensureMemoryV2Schema(db);
  return db;
}

/** 便于调用方构造类型（导出 Database 类型别名，避免各自 import better-sqlite3 类型）。 */
export type { DatabaseType };

// ── 认识初期：她主动了解你 ─────────────────────

/** 已经问过的主题（按 owner 记录，避免反复问同一个问题）。 */
export function listAskedTopics(db: Database, ownerId: string): Array<{ topic: string; asked_at: number }> {
  try {
    return db
      .prepare(`SELECT topic, asked_at FROM getting_to_know WHERE owner_id = ? ORDER BY asked_at DESC`)
      .all(ownerId) as Array<{ topic: string; asked_at: number }>;
  } catch {
    return [];
  }
}

export function markTopicAsked(db: Database, ownerId: string, topic: string, now = Date.now()): void {
  try {
    db.prepare(
      `INSERT INTO getting_to_know (owner_id, topic, asked_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, topic) DO UPDATE SET asked_at = excluded.asked_at`,
    ).run(ownerId, topic, now);
  } catch {
    // 忽略
  }
}

// ── 意图式主动性：计划与统计（v0.8）─────────────

export interface InitiativePlanRow {
  persona_id: string;
  owner_id: string;
  day: string;
  plan_json: string;
  created_at: number;
}

/** 读某天的主动计划（没有返回 null）。 */
export function getInitiativePlan(
  db: Database,
  personaId: string,
  ownerId: string,
  day: string,
): InitiativePlanRow | null {
  try {
    const row = db
      .prepare(
        `SELECT * FROM initiative_plans WHERE persona_id = ? AND owner_id = ? AND day = ?`,
      )
      .get(personaId, ownerId, day) as InitiativePlanRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** 写/覆盖某天的主动计划。 */
export function saveInitiativePlan(
  db: Database,
  input: { personaId: string; ownerId: string; day: string; planJson: string; now?: number },
): void {
  try {
    db.prepare(
      `INSERT INTO initiative_plans (persona_id, owner_id, day, plan_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(persona_id, owner_id, day) DO UPDATE SET
         plan_json = excluded.plan_json, created_at = excluded.created_at`,
    ).run(input.personaId, input.ownerId, input.day, input.planJson, input.now ?? Date.now());
  } catch {
    // 忽略
  }
}

/** 记一次主动发送（供频率校准）。 */
export function recordInitiativeSent(db: Database, ownerId: string, now = Date.now()): void {
  try {
    db.prepare(
      `INSERT INTO initiative_stats (owner_id, sent_at, replied) VALUES (?, ?, 0)`,
    ).run(ownerId, now);
  } catch {
    // 忽略
  }
}

/**
 * 他回了主动消息：把最近一次「还没被回」的主动标记为已回。
 * 简化语义：只要他在这条主动之后说过话，就算回了。
 */
export function markInitiativeReplied(db: Database, ownerId: string, now = Date.now()): void {
  try {
    db.prepare(
      `UPDATE initiative_stats SET replied = 1
       WHERE owner_id = ? AND replied = 0 AND sent_at < ?`,
    ).run(ownerId, now);
  } catch {
    // 忽略
  }
}

/**
 * 她一共发过多少条主动消息（v0.8.14）。
 * 用途：区分「他从没回过」和「她从来没主动过」——后者不该被判成"他不回"。
 */
export function initiativeSentCount(db: Database, ownerId: string): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM initiative_stats WHERE owner_id = ?")
      .get(ownerId) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/** 最近 N 次主动里他回了几次（频率校准用）。 */
export function recentInitiativeReplyCount(db: Database, ownerId: string, limit = 10): number {
  try {
    const rows = db
      .prepare(
        `SELECT replied FROM initiative_stats WHERE owner_id = ?
         ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(ownerId, Math.max(1, limit)) as Array<{ replied: number }>;
    return rows.filter((r) => r.replied === 1).length;
  } catch {
    return 0;
  }
}
