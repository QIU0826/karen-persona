/**
 * 承诺账本（P1-1，2026-10-23）。
 *
 * 真机问题：10-20 的日记忆里「他问认识经过并想听你语音，你说店里有人等会儿」，
 * 到 10-23 她还在说「答应你的语音还没发 等店里闲下来」，但既没有到期时间，
 * 也没有任何机制在兑现/过期时收口。模型只能每天从记忆里重新“想起”这件事。
 *
 * 这里把“答应的事”做成一张小表：
 * - 从最近对话确定性抽取（见 promise-extract.ts），不额外调 LLM；
 * - kind=voice/photo/other：她答应给对方的东西；event：对方的重要日程；
 * - 桥接在真的发出语音/照片时 mark done；heartbeat/每轮 prompt 只注入 open 项；
 * - 没有 due 的（改天/下次）也会在 7 天后淡出，不无限占上下文。
 */
import { getVectorDb } from "./vector.js";
import { createLogger } from "../obs/logger.js";
import { extractPromises, type PromiseCandidate, type PromiseExtractMessage, type PromiseKind } from "../pipeline/promise-extract.js";

const log = createLogger("promise");

export interface PromiseRow {
  id: number;
  persona_id: string;
  owner_id: string;
  kind: PromiseKind;
  content: string;
  due_at: number | null;
  status: "open" | "done" | "cancelled";
  created_at: number;
  updated_at: number;
}

const KEEP_OPEN_DAYS = 7;
const MAX_PROMPT_ITEMS = 3;
const MAX_PROMPT_CHARS = 320;

function ensureSchema(db: ReturnType<typeof getVectorDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS promise_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      due_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(persona_id, owner_id, kind, content)
    );
    CREATE INDEX IF NOT EXISTS idx_promise_open
      ON promise_ledger(persona_id, owner_id, status, created_at);
  `);
}

/**
 * 写入/更新承诺。同一条内容重复出现只更新 due/updated_at，不重复插入；
 * 已 done 的不因旧对话再次出现而重新打开（真的又答应一次会用不同措辞）。
 */
export function recordPromises(
  ownerId: string,
  personaId: string,
  candidates: PromiseCandidate[],
  now = Date.now(),
): number {
  if (candidates.length === 0) return 0;
  try {
    const db = getVectorDb();
    ensureSchema(db);
    const stmt = db.prepare(`
      INSERT INTO promise_ledger (persona_id, owner_id, kind, content, due_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(persona_id, owner_id, kind, content) DO UPDATE SET
        due_at = COALESCE(excluded.due_at, promise_ledger.due_at),
        updated_at = excluded.updated_at
    `);
    let written = 0;
    for (const candidate of candidates) {
      const info = stmt.run(
        personaId,
        ownerId,
        candidate.kind,
        candidate.content.slice(0, 80),
        candidate.dueAt ?? null,
        now,
        now,
      );
      if (info.changes > 0) written++;
    }
    return written;
  } catch (err) {
    log.warn("promise.record_failed", {
      error: err instanceof Error ? err.message.slice(0, 80) : "unknown",
    });
    return 0;
  }
}

/** 从最近消息里抽取并记账；桥接每轮调用一次（失败静默，不影响回复）。 */
export function recordPromisesFromMessages(
  ownerId: string,
  personaId: string,
  messages: PromiseExtractMessage[],
  now = Date.now(),
): number {
  try {
    return recordPromises(ownerId, personaId, extractPromises(messages, now), now);
  } catch {
    return 0;
  }
}

/** 列出 open 承诺（最多 5 条；7 天前的自动淡出）。 */
export function listOpenPromises(
  ownerId: string,
  personaId: string,
  now = Date.now(),
  limit = 5,
): PromiseRow[] {
  try {
    const db = getVectorDb();
    ensureSchema(db);
    return db
      .prepare(
        `SELECT id, persona_id, owner_id, kind, content, due_at, status, created_at, updated_at
         FROM promise_ledger
         WHERE persona_id = ? AND owner_id = ? AND status = 'open' AND created_at >= ?
         ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC
         LIMIT ?`,
      )
      .all(personaId, ownerId, now - KEEP_OPEN_DAYS * 24 * 60 * 60 * 1000, limit) as PromiseRow[];
  } catch {
    return [];
  }
}

/**
 * 标记已兑现：语音发出 → voice；照片发出 → photo。
 * 返回被标记的条数。
 */
export function markPromisesDone(
  ownerId: string,
  personaId: string,
  kinds: PromiseKind[],
  now = Date.now(),
): number {
  if (kinds.length === 0) return 0;
  try {
    const db = getVectorDb();
    ensureSchema(db);
    const placeholders = kinds.map(() => "?").join(", ");
    const info = db
      .prepare(
        `UPDATE promise_ledger SET status = 'done', updated_at = ?
         WHERE persona_id = ? AND owner_id = ? AND status = 'open' AND kind IN (${placeholders})`,
      )
      .run(now, personaId, ownerId, ...kinds);
    return info.changes;
  } catch {
    return 0;
  }
}

function formatDue(dueAt: number | null, now: number): string {
  if (dueAt === null) return "";
  const diff = dueAt - now;
  if (diff <= 0) return "（已到期）";
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `（约 ${minutes} 分钟后）`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `（约 ${hours} 小时后）`;
  return `（约 ${Math.round(hours / 24)} 天后）`;
}

/**
 * 注入 prompt 的短块：只写“还没兑现的”，不引用旧对话原文，
 * 避免模型把「等会儿/忙完」这类原话再复读一遍。
 */
export function getPromiseInjection(
  ownerId: string,
  personaId: string,
  now = Date.now(),
): string {
  const rows = listOpenPromises(ownerId, personaId, now);
  if (rows.length === 0) return "";
  const lines: string[] = [];
  for (const row of rows.slice(0, MAX_PROMPT_ITEMS)) {
    const ageMin = Math.max(1, Math.round((now - row.created_at) / 60_000));
    let line: string;
    if (row.kind === "voice") line = `- 你答应过给他发一条语音，${ageMin} 分钟了还没发`;
    else if (row.kind === "photo") line = `- 你答应过给他发照片，${ageMin} 分钟了还没发`;
    else if (row.kind === "event") line = `- 他的事：${row.content}`;
    else line = `- 你答应过：${row.content}`;
    line += formatDue(row.due_at, now);
    lines.push(line);
  }
  if (lines.length === 0) return "";
  const block =
    `\n## 还没兑现的承诺\n${lines.join("\n")}\n` +
    "（能兑现就现在做；做不到就说清什么时候，不要反复说「等会儿 / 忙完」。）\n";
  return block.length > MAX_PROMPT_CHARS ? `${block.slice(0, MAX_PROMPT_CHARS)}…\n` : block;
}

/** 测试/CLI：清空某人的账本。 */
export function clearPromisesForTest(ownerId: string, personaId: string): void {
  try {
    const db = getVectorDb();
    ensureSchema(db);
    db.prepare("DELETE FROM promise_ledger WHERE persona_id = ? AND owner_id = ?").run(
      personaId,
      ownerId,
    );
  } catch {
    // ignore
  }
}
