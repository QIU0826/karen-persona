/**
 * 用户同意记录（合规：年龄确认 / AI 披露确认）。
 *
 * 为什么单独一张表：
 * - 年龄门需要知道「这个 owner 是否已确认 18+」，且要跨会话、跨重启保持；
 * - 与 user_facts 不同，这是合规状态，不允许被记忆抽取/清理逻辑改动；
 * - 按 owner 隔离（qq:<id>），与多用户架构一致。
 */
import { getVectorDb } from "./vector.js";
import { dbPath } from "./paths.js";

export interface UserConsent {
  ownerId: string;
  /** 确认已满 18 岁的时间（ms）；null = 尚未确认 */
  ageConfirmedAt: number | null;
  /** 首次 AI 披露确认时间（ms）；仅作审计记录 */
  disclosureAckedAt: number | null;
}

/**
 * 建表缓存按 DB 路径记录：评测/测试同进程切换 KAREN_DATA_DIR 时不会缺表。
 */
let readyForPath: string | null = null;

function ensureTable(): void {
  const currentPath = dbPath();
  if (readyForPath === currentPath) return;
  getVectorDb().exec(`
    CREATE TABLE IF NOT EXISTS user_consent (
      owner_id TEXT PRIMARY KEY,
      age_confirmed_at INTEGER,
      disclosure_acked_at INTEGER
    );
  `);
  readyForPath = currentPath;
}

/** 读取某 owner 的同意状态；没有记录返回 null。 */
export function getConsent(ownerId: string): UserConsent | null {
  if (!ownerId) return null;
  ensureTable();
  const row = getVectorDb()
    .prepare(
      `SELECT owner_id, age_confirmed_at, disclosure_acked_at
         FROM user_consent WHERE owner_id = ?`,
    )
    .get(ownerId) as
    | { owner_id: string; age_confirmed_at: number | null; disclosure_acked_at: number | null }
    | undefined;
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    ageConfirmedAt: typeof row.age_confirmed_at === "number" ? row.age_confirmed_at : null,
    disclosureAckedAt:
      typeof row.disclosure_acked_at === "number" ? row.disclosure_acked_at : null,
  };
}

/** 记录「已确认 18+」；重复调用保留最早一次的时间。 */
export function confirmAge(ownerId: string, nowMs: number = Date.now()): void {
  if (!ownerId) return;
  ensureTable();
  getVectorDb()
    .prepare(
      `INSERT INTO user_consent (owner_id, age_confirmed_at, disclosure_acked_at)
       VALUES (?, ?, NULL)
       ON CONFLICT(owner_id) DO UPDATE SET
         age_confirmed_at = COALESCE(user_consent.age_confirmed_at, excluded.age_confirmed_at)`,
    )
    .run(ownerId, nowMs);
}

/** 记录 AI 披露已发送（审计用；不影响年龄门）。 */
export function ackDisclosure(ownerId: string, nowMs: number = Date.now()): void {
  if (!ownerId) return;
  ensureTable();
  getVectorDb()
    .prepare(
      `INSERT INTO user_consent (owner_id, age_confirmed_at, disclosure_acked_at)
       VALUES (?, NULL, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         disclosure_acked_at = COALESCE(user_consent.disclosure_acked_at, excluded.disclosure_acked_at)`,
    )
    .run(ownerId, nowMs);
}

/** 是否已确认年龄。 */
export function hasAgeConfirmation(ownerId: string): boolean {
  const consent = getConsent(ownerId);
  return consent !== null && consent.ageConfirmedAt !== null;
}

/** 清空某 owner 的同意记录（用户要求删除数据 / 测试用）。 */
export function resetConsent(ownerId: string): void {
  if (!ownerId) return;
  ensureTable();
  getVectorDb().prepare(`DELETE FROM user_consent WHERE owner_id = ?`).run(ownerId);
}
