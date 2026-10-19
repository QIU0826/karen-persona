/**
 * 持久化延迟回复队列（M1 BUG-2 修复）。
 *
 * 背景：消息门判定「晚点回」时，旧实现只用内存 setTimeout 排期。
 * 进程重启（加载配置/PM2 重启/崩溃）后 timer 丢失，用户消息虽在记忆里，
 * 但「明早再回」的承诺永远不会兑现。
 *
 * 设计：
 * - 与主记忆同库（data/memory.sqlite），SQLite 单文件、WAL，无需新依赖；
 * - 状态机：pending → done / cancelled，失败时 attempts+1 并指数退避重排；
 * - bridge 启动/重连时调用 listPendingReplies() 恢复；
 * - 单用户多条待补发时，仅保留最新一条（与内存 timer 语义一致）。
 */
import { getVectorDb } from "./vector.js";

export interface PendingReply {
  id: number;
  platform: string;
  userId: string;
  userName: string;
  personaId: string;
  text: string;
  dueAt: number;
  createdAt: number;
  attempts: number;
  status: "pending" | "done" | "cancelled";
  lastError: string;
}

export interface EnqueuePendingReplyInput {
  platform: string;
  userId: string;
  userName?: string;
  personaId: string;
  text: string;
  dueAt: number;
}

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getVectorDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      persona_id TEXT NOT NULL DEFAULT 'unknown',
      text TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pending_status_due ON pending_replies(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_pending_platform_user ON pending_replies(platform, user_id);
  `);
  tableReady = true;
}

function rowToPending(row: Record<string, unknown>): PendingReply {
  return {
    id: Number(row.id),
    platform: String(row.platform),
    userId: String(row.user_id),
    userName: String(row.user_name ?? ""),
    personaId: String(row.persona_id ?? "unknown"),
    text: String(row.text),
    dueAt: Number(row.due_at),
    createdAt: Number(row.created_at),
    attempts: Number(row.attempts ?? 0),
    status: (row.status as PendingReply["status"]) ?? "pending",
    lastError: String(row.last_error ?? ""),
  };
}

/** 入队一条待补发回复，返回 id。 */
export function enqueuePendingReply(input: EnqueuePendingReplyInput): number {
  ensureTable();
  const db = getVectorDb();
  const result = db
    .prepare(
      `INSERT INTO pending_replies (platform, user_id, user_name, persona_id, text, due_at, created_at, attempts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
    )
    .run(
      input.platform,
      input.userId,
      input.userName ?? "",
      input.personaId,
      input.text,
      Math.round(input.dueAt),
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/** 列出所有 pending（按到期时间升序）；可按平台过滤。 */
export function listPendingReplies(platform?: string): PendingReply[] {
  ensureTable();
  const db = getVectorDb();
  const rows = platform
    ? db
        .prepare(
          `SELECT * FROM pending_replies WHERE status = 'pending' AND platform = ? ORDER BY due_at ASC`,
        )
        .all(platform)
    : db
        .prepare(`SELECT * FROM pending_replies WHERE status = 'pending' ORDER BY due_at ASC`)
        .all();
  return (rows as Record<string, unknown>[]).map(rowToPending);
}

/** 取消某用户所有 pending（用户发来新消息时调用，与内存 timer 行为一致）。 */
export function cancelPendingReplies(platform: string, userId: string, reason = ""): number {
  ensureTable();
  const db = getVectorDb();
  const result = db
    .prepare(
      `UPDATE pending_replies SET status = 'cancelled', last_error = ?
       WHERE status = 'pending' AND platform = ? AND user_id = ?`,
    )
    .run(reason.slice(0, 200), platform, userId);
  return result.changes;
}

/** 标记完成。 */
export function markPendingDone(id: number): void {
  ensureTable();
  getVectorDb()
    .prepare(`UPDATE pending_replies SET status = 'done' WHERE id = ? AND status = 'pending'`)
    .run(id);
}

/**
 * 记录一次失败尝试，并计算退避后的下次到期时间。
 * 退避：60s × attempts，上限 10 分钟。
 */
export function markPendingAttempt(id: number, errorMessage = ""): { attempts: number; dueAt: number } {
  ensureTable();
  const db = getVectorDb();
  const row = db.prepare(`SELECT attempts FROM pending_replies WHERE id = ?`).get(id) as
    | { attempts: number }
    | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const retryDelay = Math.min(10 * 60 * 1000, 60 * 1000 * attempts);
  const dueAt = Date.now() + retryDelay;
  db.prepare(
    `UPDATE pending_replies SET attempts = ?, due_at = ?, last_error = ? WHERE id = ? AND status = 'pending'`,
  ).run(attempts, dueAt, errorMessage.slice(0, 300), id);
  return { attempts, dueAt };
}

/** 清理 7 天前的已完成/已取消记录（避免表无限增长）。 */
export function purgeFinishedReplies(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  ensureTable();
  const cutoff = Date.now() - olderThanMs;
  const result = getVectorDb()
    .prepare(
      `DELETE FROM pending_replies WHERE status IN ('done', 'cancelled') AND created_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

/** 统计 pending 数量（健康检查/日志用）。 */
export function countPendingReplies(): number {
  ensureTable();
  const row = getVectorDb()
    .prepare(`SELECT COUNT(*) AS cnt FROM pending_replies WHERE status = 'pending'`)
    .get() as { cnt: number };
  return Number(row?.cnt ?? 0);
}
