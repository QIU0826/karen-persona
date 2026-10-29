/**
 * 高权限社会化 P2：SQLite 审计 / 审批 / 预算存储。
 *
 * 单一职责：把「她要在 B 站/QQ 空间做什么」落成可审计、可审批、可撤销的记录，
 * 并提供预算计数与同目标去重查询。**不负责**策略判断（policy.ts）、内容安全
 * （safety.ts）、执行（runner.ts）和 Cookie 管理（credentials.ts）。
 *
 * 安全不变量（与 docs/SOCIAL_AUTONOMY.md 一致）：
 * - 只存账号 **fingerprint**（不可逆摘要），绝不落 Cookie/密码/二维码：`social_accounts`
 *   只有 fingerprint 列；`setAccountFingerprint` 拒绝任何像 Cookie/Token 的值；
 * - 正文可以存（审计需要），但本模块不打印任何 content/reason/meta；
 * - `meta` 里出现 cookie/token/authorization 等敏感键直接拒绝；
 * - 状态机只允许合法迁移；重复调用同状态迁移是幂等的（不产生重复预算/审计）；
 * - 审批 TTL：`approveAction` 写入 `expires_at`，执行前过期会被标记 `expired` 并拒绝；
 * - 预算从 actions 表聚合（`countActionsToday`），`social_budgets` 是随执行累加的派生表，
 *   便于 runner/policy 快速读取；两者以 actions 为准。
 *
 * 表结构（全部 `IF NOT EXISTS`，幂等）：
 * - social_actions      动作主表（状态机 + 审批 TTL + 执行结果 + 目标快照）
 * - social_budgets      按 (day, platform, action_type) 聚合的派生预算计数
 * - social_targets      目标寄存器（去重/每日同目标次数审计）
 * - social_accounts     账号 fingerprint（绝不存 Cookie）
 * - social_audit       状态迁移审计（from/to/note/actor）
 * - social_meta         模块 schema 版本（独立于 memory.sqlite 的 user_version）
 *
 * 与主记忆同库（`data/memory.sqlite`，WAL），不新增依赖；测试/评测切换
 * `KAREN_DATA_DIR` 时按 DB 路径重建 schema 缓存。
 */
import { getVectorDb } from "../data/vector.js";
import { dbPath } from "../data/paths.js";
import type {
  SocialActionRecord,
  SocialActionResult,
  SocialActionStatus,
  SocialActionType,
  SocialDraft,
  SocialPlatform,
  SocialRisk,
  SocialTarget,
} from "./types.js";

type SqlDatabase = ReturnType<typeof getVectorDb>;

// ── 常量 ─────────────────────────────────────────────

export const SOCIAL_SCHEMA_VERSION = 1;

/** 审批默认 TTL（10 分钟，与 SOCIAL_DEFAULT_APPROVAL_TTL_MIN 一致，避免循环依赖 types 常量） */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

/** 同目标去重默认窗口：24 小时（policy 可传更短/更长；0 = 只去重未执行动作） */
export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60_000;

const EXECUTED_STATUSES: readonly SocialActionStatus[] = ["executing", "sent", "failed", "undone"];
const PENDING_STATUSES: readonly SocialActionStatus[] = ["draft", "queued", "approved"];

/**
 * 合法状态迁移表（唯一事实源；`canTransition` 直接读它）。
 * 说明：
 * - draft/queued → approved 是人工审批；
 * - approved → executing/sent/failed 允许跳过 executing（policy 直接执行）；
 * - 只有 sent 可 undone；已 rejected/expired/failed/undone 是终态。
 */
export const SOCIAL_TRANSITIONS: Readonly<
  Record<SocialActionStatus, readonly SocialActionStatus[]>
> = Object.freeze({
  draft: Object.freeze(["queued", "approved", "rejected", "expired"] as const),
  queued: Object.freeze(["approved", "rejected", "expired"] as const),
  approved: Object.freeze(["executing", "sent", "failed", "rejected", "expired"] as const),
  executing: Object.freeze(["sent", "failed"] as const),
  sent: Object.freeze(["undone"] as const),
  failed: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
  expired: Object.freeze([] as const),
  undone: Object.freeze([] as const),
});

const PLATFORMS: readonly SocialPlatform[] = ["bilibili", "qzone"];
const ACTIONS: readonly SocialActionType[] = [
  "comment",
  "reply",
  "dynamic",
  "like",
  "unlike",
  "favorite",
  "unfavorite",
  "coin",
  "follow",
  "unfollow",
  "share",
  "dm",
  "delete_comment",
  "delete_dynamic",
];
const TARGET_TYPES = ["video", "user", "dynamic", "comment", "none"] as const;
const RISKS: readonly SocialRisk[] = ["low", "medium", "high"];
const STATUSES: readonly SocialActionStatus[] = [
  "draft",
  "queued",
  "approved",
  "executing",
  "sent",
  "failed",
  "rejected",
  "expired",
  "undone",
];

/** meta 敏感键（不落 Cookie/Token；命中直接拒绝写入） */
const SENSITIVE_META_KEY = /cookie|sessdata|bili_jct|dedeuserid|token|authorization|password|secret/i;
/** fingerprint 允许字符（sha256/短哈希/平台 uid 摘要），拒绝 Cookie 形态 */
const FINGERPRINT_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const COOKIE_LIKE = /sessdata|cookie|bili_jct|dedeuserid|authorization|token=|;|\\s/i;

// ── 错误类型 ─────────────────────────────────────────

export type SocialStoreErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_transition"
  | "invalid_fingerprint"
  | "expired";

export class SocialStoreError extends Error {
  readonly code: SocialStoreErrorCode;

  constructor(code: SocialStoreErrorCode, message: string) {
    super(message);
    this.name = "SocialStoreError";
    this.code = code;
  }
}

// ── 公共类型（仅本模块导出，不改 social/types.ts）────────────

export interface CreateDraftOptions {
  owner?: string;
  personaId?: string;
  nowMs?: number;
  /** 同目标去重窗口；0 = 只去重未执行动作；默认 24h */
  dedupeWindowMs?: number;
  skipDedupe?: boolean;
}

export interface CreateDraftResult {
  action: SocialActionRecord;
  /** true = 命中同目标去重，返回的是已有记录，没有新建 */
  deduped: boolean;
}

export interface TransitionOptions {
  nowMs?: number;
  actor?: string;
  note?: string;
}

export interface ApproveOptions extends TransitionOptions {
  /** 审批 TTL，默认 10 分钟 */
  ttlMs?: number;
}

export interface ListPendingFilter {
  platform?: SocialPlatform;
  action?: SocialActionType;
  owner?: string;
  limit?: number;
  /** 传入时先处理过期审批（默认 Date.now()） */
  nowMs?: number;
}

export interface ListRecentFilter {
  platform?: SocialPlatform;
  action?: SocialActionType;
  status?: SocialActionStatus;
  owner?: string;
  limit?: number;
}

export interface SocialAccountRecord {
  platform: SocialPlatform;
  fingerprint: string;
  label: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface SocialAuditEntry {
  id: number;
  actionId: number;
  fromStatus: SocialActionStatus | null;
  toStatus: SocialActionStatus;
  note: string;
  actor: string;
  createdAt: number;
}

export interface SocialTargetStats {
  platform: SocialPlatform;
  targetType: SocialTarget["targetType"];
  targetId: string;
  title: string;
  url: string;
  authorUid: string;
  firstSeenAt: number;
  lastActionAt: number | null;
  actionCount: number;
}

// ── 校验 ─────────────────────────────────────────────

function asPlatform(value: unknown): SocialPlatform {
  if (typeof value === "string" && (PLATFORMS as readonly string[]).includes(value)) {
    return value as SocialPlatform;
  }
  throw new SocialStoreError("invalid_input", `unknown social platform: ${String(value)}`);
}

function asAction(value: unknown): SocialActionType {
  if (typeof value === "string" && (ACTIONS as readonly string[]).includes(value)) {
    return value as SocialActionType;
  }
  throw new SocialStoreError("invalid_input", `unknown social action: ${String(value)}`);
}

function asTargetType(value: unknown): SocialTarget["targetType"] {
  if (typeof value === "string" && (TARGET_TYPES as readonly string[]).includes(value)) {
    return value as SocialTarget["targetType"];
  }
  throw new SocialStoreError("invalid_input", `unknown target type: ${String(value)}`);
}

function asStatus(value: unknown): SocialActionStatus {
  if (typeof value === "string" && (STATUSES as readonly string[]).includes(value)) {
    return value as SocialActionStatus;
  }
  throw new SocialStoreError("invalid_input", `unknown social status: ${String(value)}`);
}

function asRisk(value: unknown): SocialRisk {
  if (typeof value === "string" && (RISKS as readonly string[]).includes(value)) {
    return value as SocialRisk;
  }
  throw new SocialStoreError("invalid_input", `unknown social risk: ${String(value)}`);
}

function nonEmptyString(value: unknown, field: string, maxLen = 200): string {
  if (typeof value !== "string") {
    throw new SocialStoreError("invalid_input", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new SocialStoreError("invalid_input", `${field} must not be empty`);
  if (trimmed.length > maxLen) {
    throw new SocialStoreError("invalid_input", `${field} exceeds ${maxLen} chars`);
  }
  return trimmed;
}

function sanitizeMeta(meta: Record<string, unknown> | undefined): string {
  if (meta === undefined) return "{}";
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new SocialStoreError("invalid_input", "meta must be a plain object");
  }
  for (const key of Object.keys(meta)) {
    if (SENSITIVE_META_KEY.test(key)) {
      throw new SocialStoreError("invalid_input", `meta must not contain sensitive key: ${key}`);
    }
  }
  try {
    return JSON.stringify(meta);
  } catch {
    throw new SocialStoreError("invalid_input", "meta is not JSON serializable");
  }
}

function parseMeta(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Schema ───────────────────────────────────────────

/**
 * 幂等建表。可传显式 DB（测试/迁移用）；默认用主记忆库。
 * 不修改 PRAGMA user_version（那是 vector.ts 的记忆 schema 版本）。
 */
export function ensureSocialSchema(database: SqlDatabase = getVectorDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS social_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      target_title TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      target_author_uid TEXT NOT NULL DEFAULT '',
      target_aid INTEGER,
      content TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'medium',
      meta_json TEXT NOT NULL DEFAULT '{}',
      external_id TEXT,
      error_code TEXT,
      owner TEXT NOT NULL DEFAULT 'main',
      persona_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      approved_at INTEGER,
      expires_at INTEGER,
      executed_at INTEGER,
      undone_at INTEGER,
      undoable INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_social_actions_status_created
      ON social_actions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_social_actions_platform_action_exec
      ON social_actions(platform, action_type, executed_at);
    CREATE INDEX IF NOT EXISTS idx_social_actions_target
      ON social_actions(platform, target_type, target_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_social_actions_owner
      ON social_actions(owner, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_actions_active_dedupe
      ON social_actions(platform, action_type, target_type, target_id)
      WHERE target_type <> 'none' AND status IN ('draft', 'queued', 'approved', 'executing');

    CREATE TABLE IF NOT EXISTS social_budgets (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      action_type TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (day, platform, action_type)
    );

    CREATE TABLE IF NOT EXISTS social_targets (
      platform TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      author_uid TEXT NOT NULL DEFAULT '',
      first_seen_at INTEGER NOT NULL,
      last_action_at INTEGER,
      action_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS social_accounts (
      platform TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_social_audit_action
      ON social_audit(action_id, id);

    CREATE TABLE IF NOT EXISTS social_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO social_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(SOCIAL_SCHEMA_VERSION));
}

/** 建表缓存按 DB 路径 + 实例记录：测试/评测切换 KAREN_DATA_DIR 或重开库时自动重建。 */
let readyForPath: string | null = null;
let readyDb: SqlDatabase | null = null;

function db(): SqlDatabase {
  const database = getVectorDb();
  const currentPath = dbPath();
  if (readyForPath !== currentPath || readyDb !== database) {
    ensureSocialSchema(database);
    readyForPath = currentPath;
    readyDb = database;
  }
  return database;
}

/** 测试辅助：清空本模块的建表缓存（DB 本身由 vector.closeVectorDb 关闭）。 */
export function resetSocialStoreCache(): void {
  readyForPath = null;
  readyDb = null;
}

// ── 时间工具 ─────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时区的 day key（YYYY-MM-DD）；预算按自然日统计。 */
export function dayKey(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** day key → [start, end) 毫秒区间（end 为下一个本地零点）。 */
export function dayRangeMs(day: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    throw new SocialStoreError("invalid_input", `invalid day: ${day}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const start = new Date(year, month - 1, date).getTime();
  const end = new Date(year, month - 1, date + 1).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new SocialStoreError("invalid_input", `invalid day: ${day}`);
  }
  return { start, end };
}

function normalizeNow(value: number | undefined): number {
  if (value === undefined) return Date.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new SocialStoreError("invalid_input", "nowMs must be a finite non-negative number");
  }
  return Math.floor(value);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(200, Math.floor(value));
}

// ── 行映射 ───────────────────────────────────────────

type ActionRow = Record<string, unknown>;

function rowTarget(row: ActionRow): SocialTarget {
  const targetAid = row.target_aid;
  return {
    platform: asPlatform(row.platform),
    targetType: asTargetType(row.target_type),
    targetId: String(row.target_id ?? ""),
    ...(typeof row.target_title === "string" && row.target_title ? { title: row.target_title } : {}),
    ...(typeof row.target_url === "string" && row.target_url ? { url: row.target_url } : {}),
    ...(typeof row.target_author_uid === "string" && row.target_author_uid
      ? { authorUid: row.target_author_uid }
      : {}),
    ...(typeof targetAid === "number" && Number.isFinite(targetAid) ? { aid: targetAid } : {}),
  };
}

function rowToRecord(row: ActionRow): SocialActionRecord {
  const meta = parseMeta(row.meta_json);
  const externalId = typeof row.external_id === "string" && row.external_id ? row.external_id : undefined;
  const errorCode = typeof row.error_code === "string" && row.error_code ? row.error_code : undefined;
  const executedAt = typeof row.executed_at === "number" ? row.executed_at : undefined;
  const undoneAt = typeof row.undone_at === "number" ? row.undone_at : undefined;
  return {
    id: Number(row.id),
    platform: asPlatform(row.platform),
    action: asAction(row.action_type),
    target: rowTarget(row),
    content: String(row.content ?? ""),
    reason: String(row.reason ?? ""),
    risk: asRisk(row.risk),
    ...(meta ? { meta } : {}),
    status: asStatus(row.status),
    ...(externalId ? { externalId } : {}),
    ...(errorCode ? { errorCode } : {}),
    createdAt: Number(row.created_at),
    ...(executedAt !== undefined ? { executedAt } : {}),
    ...(undoneAt !== undefined ? { undoneAt } : {}),
  };
}

function loadRow(id: number): ActionRow {
  if (!Number.isInteger(id) || id <= 0) {
    throw new SocialStoreError("not_found", `social action not found: ${String(id)}`);
  }
  const row = db().prepare("SELECT * FROM social_actions WHERE id = ?").get(id) as ActionRow | undefined;
  if (!row) throw new SocialStoreError("not_found", `social action not found: ${id}`);
  return row;
}

// ── 状态机 ───────────────────────────────────────────

export function canTransition(from: SocialActionStatus, to: SocialActionStatus): boolean {
  return (SOCIAL_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalStatus(status: SocialActionStatus): boolean {
  return (SOCIAL_TRANSITIONS[status] ?? []).length === 0;
}

function assertTransition(from: SocialActionStatus, to: SocialActionStatus): void {
  if (!canTransition(from, to)) {
    throw new SocialStoreError("invalid_transition", `illegal social status transition: ${from} -> ${to}`);
  }
}

function writeAudit(
  database: SqlDatabase,
  actionId: number,
  fromStatus: SocialActionStatus | null,
  toStatus: SocialActionStatus,
  note: string,
  actor: string,
  nowMs: number,
): void {
  database
    .prepare(
      `INSERT INTO social_audit (action_id, from_status, to_status, note, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(actionId, fromStatus, toStatus, note, actor, nowMs);
}

function touchTarget(database: SqlDatabase, target: SocialTarget, nowMs: number): void {
  if (target.targetType === "none") return;
  database
    .prepare(
      `INSERT INTO social_targets
         (platform, target_type, target_id, title, url, author_uid, first_seen_at, last_action_at, action_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT(platform, target_type, target_id) DO UPDATE SET
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE social_targets.title END,
         url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE social_targets.url END,
         author_uid = CASE WHEN excluded.author_uid <> '' THEN excluded.author_uid ELSE social_targets.author_uid END`,
    )
    .run(
      target.platform,
      target.targetType,
      target.targetId,
      target.title ?? "",
      target.url ?? "",
      target.authorUid ?? "",
      nowMs,
    );
}

function bumpTargetAction(database: SqlDatabase, target: SocialTarget, nowMs: number, success: boolean): void {
  if (target.targetType === "none") return;
  database
    .prepare(
      `UPDATE social_targets
          SET last_action_at = ?, action_count = action_count + ?
        WHERE platform = ? AND target_type = ? AND target_id = ?`,
    )
    .run(nowMs, success ? 1 : 0, target.platform, target.targetType, target.targetId);
}

function bumpBudget(
  database: SqlDatabase,
  platform: SocialPlatform,
  action: SocialActionType,
  executedAt: number,
): void {
  const day = dayKey(executedAt);
  database
    .prepare(
      `INSERT INTO social_budgets (day, platform, action_type, count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day, platform, action_type) DO UPDATE SET
         count = social_budgets.count + 1,
         updated_at = excluded.updated_at`,
    )
    .run(day, platform, action, executedAt);
}

// ── 动作 CRUD / 状态迁移 ─────────────────────────────

interface DedupeQuery {
  platform: SocialPlatform;
  action: SocialActionType;
  targetType: SocialTarget["targetType"];
  targetId: string;
  sinceMs: number;
}

function findDedupeCandidate(query: DedupeQuery): ActionRow | null {
  const row = db()
    .prepare(
      `SELECT * FROM social_actions
        WHERE platform = ? AND action_type = ? AND target_type = ? AND target_id = ?
          AND (
            status IN ('draft', 'queued', 'approved', 'executing')
            OR (status IN ('sent', 'failed', 'undone') AND executed_at IS NOT NULL AND executed_at >= ?)
          )
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(
      query.platform,
      query.action,
      query.targetType,
      query.targetId,
      query.sinceMs,
    ) as ActionRow | undefined;
  return row ?? null;
}

/** 创建草稿；同目标同动作在去重窗口内返回已有记录（deduped=true），不新建。 */
export function createDraft(draft: SocialDraft, options: CreateDraftOptions = {}): CreateDraftResult {
  const nowMs = normalizeNow(options.nowMs);
  const platform = asPlatform(draft?.platform);
  const action = asAction(draft?.action);
  const target = draft?.target;
  if (!target || typeof target !== "object") {
    throw new SocialStoreError("invalid_input", "draft.target is required");
  }
  const targetType = asTargetType(target.targetType);
  const targetId = targetType === "none" ? "" : nonEmptyString(target.targetId, "target.targetId", 256);
  if (target.aid !== undefined && (!Number.isFinite(target.aid) || target.aid < 0)) {
    throw new SocialStoreError("invalid_input", "target.aid must be a non-negative number");
  }
  const content = typeof draft.content === "string" ? draft.content : "";
  const reason = typeof draft.reason === "string" ? draft.reason : "";
  if (content.length > 20_000) throw new SocialStoreError("invalid_input", "content exceeds 20000 chars");
  if (reason.length > 5_000) throw new SocialStoreError("invalid_input", "reason exceeds 5000 chars");
  const risk = asRisk(draft.risk);
  const metaJson = sanitizeMeta(draft.meta);
  const owner = (options.owner ?? "main").trim() || "main";
  const personaId = (options.personaId ?? "").trim();

  const normalizedTarget: SocialTarget = {
    platform,
    targetType,
    targetId,
    ...(target.title ? { title: String(target.title).slice(0, 512) } : {}),
    ...(target.url ? { url: String(target.url).slice(0, 2048) } : {}),
    ...(target.authorUid ? { authorUid: String(target.authorUid).slice(0, 128) } : {}),
    ...(target.aid !== undefined ? { aid: target.aid } : {}),
  };

  const database = db();
  const dedupeWindowMs =
    options.dedupeWindowMs !== undefined && Number.isFinite(options.dedupeWindowMs)
      ? Math.max(0, Math.floor(options.dedupeWindowMs))
      : DEFAULT_DEDUPE_WINDOW_MS;
  if (!options.skipDedupe && targetType !== "none") {
    const existing = findDedupeCandidate({
      platform,
      action,
      targetType,
      targetId,
      sinceMs: nowMs - dedupeWindowMs,
    });
    if (existing) {
      return { action: rowToRecord(existing), deduped: true };
    }
  }

  const insert = database.transaction((): number => {
    const result = database
      .prepare(
        `INSERT INTO social_actions
           (platform, action_type, status, target_type, target_id, target_title, target_url,
            target_author_uid, target_aid, content, reason, risk, meta_json, owner, persona_id,
            created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        platform,
        action,
        targetType,
        targetId,
        normalizedTarget.title ?? "",
        normalizedTarget.url ?? "",
        normalizedTarget.authorUid ?? "",
        normalizedTarget.aid ?? null,
        content,
        reason,
        risk,
        metaJson,
        owner,
        personaId,
        nowMs,
        nowMs,
      );
    const id = Number(result.lastInsertRowid);
    touchTarget(database, normalizedTarget, nowMs);
    writeAudit(database, id, null, "draft", "created", "system", nowMs);
    return id;
  });

  let id: number;
  try {
    id = insert();
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "";
    if (!code.startsWith("SQLITE_CONSTRAINT")) throw err;
    // 并发下同目标同动作已经被另一个调用插入：返回已有记录（幂等）
    const existing = findDedupeCandidate({
      platform,
      action,
      targetType,
      targetId,
      sinceMs: nowMs - dedupeWindowMs,
    });
    if (!existing) throw err;
    return { action: rowToRecord(existing), deduped: true };
  }
  const row = loadRow(id);
  return { action: rowToRecord(row), deduped: false };
}

/** 读取单个动作；不存在返回 null（非法 id 也返回 null，便于调用方判断）。 */
export function getAction(id: number): SocialActionRecord | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db().prepare("SELECT * FROM social_actions WHERE id = ?").get(id) as ActionRow | undefined;
  return row ? rowToRecord(row) : null;
}

function transitionTo(
  id: number,
  to: SocialActionStatus,
  options: TransitionOptions,
  mutate?: (database: SqlDatabase, row: ActionRow, nowMs: number) => void,
): SocialActionRecord {
  const database = db();
  const row = loadRow(id);
  const from = asStatus(row.status);
  const nowMs = normalizeNow(options.nowMs);
  const actor = (options.actor ?? "system").trim() || "system";
  const note = options.note ?? "";

  if (from === to) {
    // 幂等：同状态重复调用不重复执行副作用
    return rowToRecord(row);
  }
  assertTransition(from, to);

  const apply = database.transaction((): void => {
    const next = database
      .prepare("UPDATE social_actions SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(to, nowMs, id, from);
    if (next.changes === 0) {
      // 并发下已被其它调用迁移：读取最新状态，合法则视为已完成
      const current = loadRow(id);
      if (asStatus(current.status) === to) return;
      throw new SocialStoreError(
        "invalid_transition",
        `social action ${id} changed concurrently (expected ${from} -> ${to})`,
      );
    }
    mutate?.(database, row, nowMs);
    writeAudit(database, id, from, to, note, actor, nowMs);
  });
  apply();
  return rowToRecord(loadRow(id));
}

/** 审批通过：draft/queued → approved，写入 expires_at（默认 10 分钟 TTL）。 */
export function approveAction(id: number, options: ApproveOptions = {}): SocialActionRecord {
  const database = db();
  const row = loadRow(id);
  const status = asStatus(row.status);
  const nowMs = normalizeNow(options.nowMs);

  if (status === "approved") return rowToRecord(row);
  if (status === "expired") {
    throw new SocialStoreError("expired", `social action ${id} already expired`);
  }
  if (status === "draft" || status === "queued") {
    const expiresAt = typeof row.expires_at === "number" ? row.expires_at : null;
    if (expiresAt !== null && nowMs > expiresAt) {
      transitionTo(id, "expired", { ...options, nowMs, note: "expired before approve" });
      throw new SocialStoreError("expired", `social action ${id} expired before approval`);
    }
    const ttlMs =
      options.ttlMs !== undefined && Number.isFinite(options.ttlMs)
        ? Math.max(1_000, Math.floor(options.ttlMs))
        : DEFAULT_APPROVAL_TTL_MS;
    const row2 = loadRow(id);
    const from = asStatus(row2.status);
    assertTransition(from, "approved");
    const apply = database.transaction((): void => {
      const next = database
        .prepare(
          `UPDATE social_actions
              SET status = 'approved', approved_at = ?, expires_at = ?, updated_at = ?
            WHERE id = ? AND status = ?`,
        )
        .run(nowMs, nowMs + ttlMs, nowMs, id, from);
      if (next.changes === 0) {
        const current = loadRow(id);
        if (asStatus(current.status) === "approved") return;
        throw new SocialStoreError("invalid_transition", `social action ${id} changed concurrently during approve`);
      }
      writeAudit(database, id, from, "approved", options.note ?? `ttl=${ttlMs}ms`, options.actor ?? "system", nowMs);
    });
    apply();
    return rowToRecord(loadRow(id));
  }
  throw new SocialStoreError("invalid_transition", `cannot approve social action ${id} from ${status}`);
}

/** 人工拒绝：draft/queued/approved → rejected。 */
export function rejectAction(id: number, options: TransitionOptions = {}): SocialActionRecord {
  const row = loadRow(id);
  const status = asStatus(row.status);
  if (status === "rejected") return rowToRecord(row);
  if (!(status === "draft" || status === "queued" || status === "approved")) {
    throw new SocialStoreError("invalid_transition", `cannot reject social action ${id} from ${status}`);
  }
  return transitionTo(id, "rejected", options, (database, _row, nowMs) => {
    database
      .prepare("UPDATE social_actions SET error_code = ?, updated_at = ? WHERE id = ?")
      .run(options.note ?? "rejected_by_owner", nowMs, id);
  });
}

/** 手动过期：draft/queued/approved → expired。 */
export function expireAction(id: number, options: TransitionOptions = {}): SocialActionRecord {
  const row = loadRow(id);
  const status = asStatus(row.status);
  if (status === "expired") return rowToRecord(row);
  if (!(status === "draft" || status === "queued" || status === "approved")) {
    throw new SocialStoreError("invalid_transition", `cannot expire social action ${id} from ${status}`);
  }
  return transitionTo(id, "expired", {
    ...options,
    note: options.note ?? "expired_manually",
  });
}

/** 把所有已过 TTL 的待审批动作标为 expired；返回处理条数（幂等）。 */
export function expireDueActions(nowMs: number = Date.now()): number {
  const now = normalizeNow(nowMs);
  const database = db();
  const rows = database
    .prepare(
      `SELECT id FROM social_actions
        WHERE status IN ('draft', 'queued', 'approved')
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY id ASC`,
    )
    .all(now) as Array<{ id: number }>;
  let count = 0;
  const apply = database.transaction((): void => {
    for (const row of rows) {
      try {
        expireAction(row.id, { nowMs: now, actor: "system", note: "expired_by_ttl" });
        count += 1;
      } catch {
        // 并发迁移/已过期：忽略，保持幂等
      }
    }
  });
  apply();
  return count;
}

/** 标记执行成功：approved/executing → sent，记录外部 id 与撤销能力。 */
export function markSent(
  id: number,
  result: Partial<SocialActionResult> = {},
  options: TransitionOptions = {},
): SocialActionRecord {
  const row = loadRow(id);
  const status = asStatus(row.status);
  const nowMs = normalizeNow(options.nowMs);

  if (status === "sent") return rowToRecord(row);
  if (status === "expired") throw new SocialStoreError("expired", `social action ${id} expired before send`);
  if (!(status === "approved" || status === "executing")) {
    throw new SocialStoreError("invalid_transition", `cannot mark social action ${id} sent from ${status}`);
  }
  const expiresAt = typeof row.expires_at === "number" ? row.expires_at : null;
  if (expiresAt !== null && nowMs > expiresAt) {
    transitionTo(id, "expired", {
      nowMs,
      actor: "system",
      note: "expired_before_send",
    });
    throw new SocialStoreError("expired", `social action ${id} expired before send`);
  }

  const externalId = typeof result.externalId === "string" ? result.externalId : undefined;
  const undoable = result.undoable !== false;
  return transitionTo(id, "sent", options, (database2, row2, now) => {
    database2
      .prepare(
        `UPDATE social_actions
            SET external_id = ?, undoable = ?, executed_at = ?, error_code = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(externalId ?? null, undoable ? 1 : 0, now, now, id);
    bumpBudget(database2, asPlatform(row2.platform), asAction(row2.action_type), now);
    bumpTargetAction(database2, rowTarget(row2), now, true);
  });
}

/** 标记执行失败：approved/executing → failed；失败也计入当日预算（防连续重试打爆）。 */
export function markFailed(
  id: number,
  result: Partial<SocialActionResult> = {},
  options: TransitionOptions = {},
): SocialActionRecord {
  const row = loadRow(id);
  const status = asStatus(row.status);
  const nowMs = normalizeNow(options.nowMs);
  if (status === "failed") return rowToRecord(row);
  if (status === "expired") throw new SocialStoreError("expired", `social action ${id} expired before execution`);
  if (!(status === "approved" || status === "executing")) {
    throw new SocialStoreError("invalid_transition", `cannot mark social action ${id} failed from ${status}`);
  }
  const expiresAt = typeof row.expires_at === "number" ? row.expires_at : null;
  if (expiresAt !== null && nowMs > expiresAt) {
    // 过期不算失败；先标过期再报错
    transitionTo(id, "expired", {
      nowMs,
      actor: "system",
      note: "expired_before_execute",
    });
    throw new SocialStoreError("expired", `social action ${id} expired before execution`);
  }
  const errorCode = result.errorCode ?? "unknown_error";
  const note = options.note ?? result.reason ?? errorCode;
  return transitionTo(id, "failed", { ...options, note }, (database2, row2, now) => {
    database2
      .prepare(
        `UPDATE social_actions
            SET error_code = ?, executed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(errorCode, now, now, id);
    bumpBudget(database2, asPlatform(row2.platform), asAction(row2.action_type), now);
    bumpTargetAction(database2, rowTarget(row2), now, false);
  });
}

/** 撤销：sent → undone（幂等）。平台不支持撤销时由调用方检查 undoable。 */
export function markUndone(id: number, options: TransitionOptions = {}): SocialActionRecord {
  const row = loadRow(id);
  const status = asStatus(row.status);
  if (status === "undone") return rowToRecord(row);
  if (status !== "sent") {
    throw new SocialStoreError("invalid_transition", `cannot undo social action ${id} from ${status}`);
  }
  return transitionTo(id, "undone", {
    ...options,
    note: options.note ?? "undone_by_owner",
  }, (database2, _row2, now) => {
    database2.prepare("UPDATE social_actions SET undone_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  });
}

// ── 查询：审批队列 / 审计 / 最近动作 ─────────────────

/** 待审批/待执行列表（draft/queued/approved）；先处理过期的审批 TTL。 */
export function listPending(filter: ListPendingFilter = {}): SocialActionRecord[] {
  const nowMs = filter.nowMs ?? Date.now();
  expireDueActions(nowMs);
  const clauses = ["status IN ('draft', 'queued', 'approved')"];
  const params: unknown[] = [];
  if (filter.platform) {
    clauses.push("platform = ?");
    params.push(asPlatform(filter.platform));
  }
  if (filter.action) {
    clauses.push("action_type = ?");
    params.push(asAction(filter.action));
  }
  if (filter.owner) {
    clauses.push("owner = ?");
    params.push(filter.owner);
  }
  params.push(clampLimit(filter.limit, 50));
  const rows = db()
    .prepare(`SELECT * FROM social_actions WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params) as ActionRow[];
  return rows.map(rowToRecord);
}

/** 最近的审计记录（可按 action 过滤）。 */
export function listAudit(actionId?: number, limit = 50): SocialAuditEntry[] {
  const rows = (
    actionId === undefined
      ? db()
          .prepare("SELECT * FROM social_audit ORDER BY id DESC LIMIT ?")
          .all(clampLimit(limit, 50))
      : db()
          .prepare("SELECT * FROM social_audit WHERE action_id = ? ORDER BY id DESC LIMIT ?")
          .all(actionId, clampLimit(limit, 50))
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    actionId: Number(row.action_id),
    fromStatus: row.from_status === null ? null : asStatus(row.from_status),
    toStatus: asStatus(row.to_status),
    note: String(row.note ?? ""),
    actor: String(row.actor ?? "system"),
    createdAt: Number(row.created_at),
  }));
}

/** 最近动作（审计面板/`/social history` 用）。 */
export function listRecent(filter: ListRecentFilter = {}): SocialActionRecord[] {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (filter.platform) {
    clauses.push("platform = ?");
    params.push(asPlatform(filter.platform));
  }
  if (filter.action) {
    clauses.push("action_type = ?");
    params.push(asAction(filter.action));
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(asStatus(filter.status));
  }
  if (filter.owner) {
    clauses.push("owner = ?");
    params.push(filter.owner);
  }
  params.push(clampLimit(filter.limit, 20));
  const rows = db()
    .prepare(`SELECT * FROM social_actions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params) as ActionRow[];
  return rows.map(rowToRecord);
}

// ── 预算 / 目标查询 ──────────────────────────────────

function executedRange(day: string): { start: number; end: number } {
  return dayRangeMs(day);
}

/** 某日某平台某动作的已执行次数（sent/failed/undone/executing；失败也计入）。 */
export function countActionsToday(platform: SocialPlatform, action: SocialActionType, day: string): number {
  const { start, end } = executedRange(day);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM social_actions
        WHERE platform = ? AND action_type = ?
          AND status IN ('executing', 'sent', 'failed', 'undone')
          AND executed_at IS NOT NULL AND executed_at >= ? AND executed_at < ?`,
    )
    .get(asPlatform(platform), asAction(action), start, end) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 某日某平台的总执行次数。 */
export function countTotalToday(platform: SocialPlatform, day: string): number {
  const { start, end } = executedRange(day);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM social_actions
        WHERE platform = ?
          AND status IN ('executing', 'sent', 'failed', 'undone')
          AND executed_at IS NOT NULL AND executed_at >= ? AND executed_at < ?`,
    )
    .get(asPlatform(platform), start, end) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 某日某目标被执行过多少次（用于「每目标每日最多 N 次」）。 */
export function countTargetActionsToday(
  platform: SocialPlatform,
  targetType: SocialTarget["targetType"],
  targetId: string,
  day: string,
): number {
  const { start, end } = executedRange(day);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM social_actions
        WHERE platform = ? AND target_type = ? AND target_id = ?
          AND status IN ('executing', 'sent', 'failed', 'undone')
          AND executed_at IS NOT NULL AND executed_at >= ? AND executed_at < ?`,
    )
    .get(asPlatform(platform), asTargetType(targetType), targetId, start, end) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 今天是否已经对该目标执行过动作。 */
export function wasTargetActiveToday(
  platform: SocialPlatform,
  targetType: SocialTarget["targetType"],
  targetId: string,
  day: string = dayKey(),
): boolean {
  return countTargetActionsToday(platform, targetType, targetId, day) > 0;
}

/** 最近一次执行时间（ms）；可按平台/动作过滤。没有返回 null。 */
export function lastActionAt(
  platform: SocialPlatform,
  action?: SocialActionType,
  options: { beforeMs?: number } = {},
): number | null {
  const params: unknown[] = [asPlatform(platform)];
  let sql =
    `SELECT MAX(executed_at) AS at FROM social_actions
      WHERE platform = ? AND status IN ('executing', 'sent', 'failed', 'undone')
        AND executed_at IS NOT NULL`;
  if (action) {
    sql += " AND action_type = ?";
    params.push(asAction(action));
  }
  if (options.beforeMs !== undefined) {
    sql += " AND executed_at <= ?";
    params.push(normalizeNow(options.beforeMs));
  }
  const row = db().prepare(sql).get(...params) as { at: number | null } | undefined;
  return typeof row?.at === "number" ? row.at : null;
}

/** 派生预算表读数（应与 countActionsToday 一致；用于快速读/对账）。 */
export function getBudgetUsage(platform: SocialPlatform, action: SocialActionType, day: string): number {
  const row = db()
    .prepare("SELECT count FROM social_budgets WHERE day = ? AND platform = ? AND action_type = ?")
    .get(day, asPlatform(platform), asAction(action)) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** 目标寄存器信息（审计/去重面板用）。 */
export function getTargetStats(
  platform: SocialPlatform,
  targetType: SocialTarget["targetType"],
  targetId: string,
): SocialTargetStats | null {
  const row = db()
    .prepare("SELECT * FROM social_targets WHERE platform = ? AND target_type = ? AND target_id = ?")
    .get(asPlatform(platform), asTargetType(targetType), targetId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    platform: asPlatform(row.platform),
    targetType: asTargetType(row.target_type),
    targetId: String(row.target_id ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
    authorUid: String(row.author_uid ?? ""),
    firstSeenAt: Number(row.first_seen_at),
    lastActionAt: typeof row.last_action_at === "number" ? row.last_action_at : null,
    actionCount: Number(row.action_count ?? 0),
  };
}

// ── 账号 fingerprint（绝不存 Cookie）──────────────────

function assertSafeFingerprint(fingerprint: unknown): string {
  if (typeof fingerprint !== "string") {
    throw new SocialStoreError("invalid_fingerprint", "fingerprint must be a string");
  }
  const trimmed = fingerprint.trim();
  if (!FINGERPRINT_RE.test(trimmed)) {
    throw new SocialStoreError(
      "invalid_fingerprint",
      "fingerprint must be 8-128 chars of [A-Za-z0-9._:-] (hash/uid digest, not raw account data)",
    );
  }
  if (COOKIE_LIKE.test(trimmed)) {
    throw new SocialStoreError("invalid_fingerprint", "fingerprint looks like cookie/token material");
  }
  return trimmed;
}

/** 写入/更新账号 fingerprint（只存不可逆摘要；Cookie 请放 credentials.ts）。 */
export function setAccountFingerprint(
  platform: SocialPlatform,
  fingerprint: string,
  options: { label?: string; status?: string; nowMs?: number } = {},
): SocialAccountRecord {
  const nowMs = normalizeNow(options.nowMs);
  const safeFingerprint = assertSafeFingerprint(fingerprint);
  const label = (options.label ?? "").trim();
  const status = (options.status ?? "active").trim() || "active";
  const database = db();
  database
    .prepare(
      `INSERT INTO social_accounts (platform, fingerprint, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         label = excluded.label,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(asPlatform(platform), safeFingerprint, label, status, nowMs, nowMs);
  const row = database.prepare("SELECT * FROM social_accounts WHERE platform = ?").get(asPlatform(platform)) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new SocialStoreError("not_found", `social account not found: ${platform}`);
  return {
    platform: asPlatform(row.platform),
    fingerprint: String(row.fingerprint ?? ""),
    label: String(row.label ?? ""),
    status: String(row.status ?? "active"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 读取账号 fingerprint；未登记返回 null（**不会**返回 Cookie）。 */
export function getAccount(platform: SocialPlatform): SocialAccountRecord | null {
  const row = db().prepare("SELECT * FROM social_accounts WHERE platform = ?").get(asPlatform(platform)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    platform: asPlatform(row.platform),
    fingerprint: String(row.fingerprint ?? ""),
    label: String(row.label ?? ""),
    status: String(row.status ?? "active"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 清空账号登记（换号/退出登录/用户要求删除数据）。 */
export function clearAccount(platform: SocialPlatform): void {
  db().prepare("DELETE FROM social_accounts WHERE platform = ?").run(asPlatform(platform));
}

// ── 导出别名（便于 policy/runner 调用语义更短）─────────

export const approve = approveAction;
export const reject = rejectAction;
export const expire = expireAction;

// 保持内部常量被引用（避免 noUnusedLocals；同时给测试/调试用）
export const SOCIAL_PENDING_STATUSES = PENDING_STATUSES;
export const SOCIAL_EXECUTED_STATUSES = EXECUTED_STATUSES;
