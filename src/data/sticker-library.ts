/**
 * 表情包库（v0.6）：从聊天里持续收集、去重、按情绪挑着发。
 *
 * 为什么：内置 11 张 Twemoji 太少，用户说了「太少了，而且可以从我的聊天记录里拿我的
 * 表情包，是个持续收集的过程」。所以：
 *  - **采集**：入站 `image` / `mface` 有可下载 URL 时，下载 → sha256 去重 → 落盘 → 入库；
 *  - **打标**：优先用视觉模型给的标签（可后补）；没标签时按来源合成一个兜底标签；
 *  - **挑选**：情绪匹配 + 用得少的优先 + 最近用过的排除；
 *  - **治理**：库容上限（超出按最久未用淘汰）、`purge` 一键清空、只存用户主动发来的。
 *
 * 全部数据在 `KAREN_DATA_DIR/stickers-collected/`，不进仓库、可一键删除。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { ensureMemoryV2Schema } from "./memory-v2.js";
import { getVectorDb } from "./vector.js";
import { dataFile, ensureDataDir } from "./paths.js";
import { MAX_IMAGE_PIXELS, inspectImageInfo } from "../ai/image-meta.js";
import { checkMediaUrl } from "../ai/media-url.js";

/** 库容上限：超出后淘汰最久没用过的 */
export const MAX_COLLECTED_STICKERS = 500;
/** 单个文件上限 2MB（QQ 表情包一般远小于此） */
export const MAX_STICKER_BYTES = 2 * 1024 * 1024;

export interface CollectedSticker {
  id: number;
  owner_id: string;
  hash: string;
  file: string;
  source: string;
  tags_json: string | null;
  emotion: string | null;
  /** AI 写的语义备注：这张表情在聊天里表达什么/适合什么场景（v0.9.24） */
  note: string | null;
  /** AI 写的场景标签 JSON（嘲讽/安慰/晚安…） */
  scene_tags: string | null;
  use_count: number;
  first_seen_at: number;
  last_used_at: number | null;
  mime: string | null;
  bytes: number | null;
}

export interface CollectResult {
  ok: boolean;
  reason: "saved" | "duplicate" | "too_large" | "empty" | "db_failed";
  id?: number;
}

/** 采集目录（跟着 KAREN_DATA_DIR 走，可被整体删除） */
export function stickerDir(): string {
  return path.join(path.dirname(dataFile("x")), "stickers-collected");
}

function ensureStickerTable(db: Database): void {
  ensureMemoryV2Schema(db);
}

/**
 * 从 URL 下载图片字节（QQ/NapCat 图片常是私有地址）。
 * 失败返回 null；调用方（bridge）应 fire-and-forget，不影响聊天。
 */
export async function downloadStickerBytes(url: string, timeoutMs = 8_000): Promise<Buffer | null> {
  const checked = checkMediaUrl(url);
  if (!checked.ok || !checked.url) return null;
  try {
    const res = await fetch(checked.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_STICKER_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_STICKER_BYTES) return null;
    const info = inspectImageInfo(buf);
    if (info && info.pixels > MAX_IMAGE_PIXELS) return null;
    return buf;
  } catch {
    return null;
  }
}

function sniffMime(bytes: Buffer): string {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (bytes.length > 12 && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function extFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "bin";
}

/**
 * 采集一张表情包。
 *
 * 输入来自入站消息（bridge 负责下载/或直接给 base64 解出的 Buffer）。
 * 同一 owner 内按 sha256 去重；重复时只更新 last_seen（不重复占磁盘）。
 */
export function collectSticker(input: {
  ownerId: string;
  bytes: Buffer;
  source?: string;
  tags?: string[];
  emotion?: string;
  note?: string;
  sceneTags?: string[];
  now?: number;
}): CollectResult {
  if (!input.bytes || input.bytes.length === 0) return { ok: false, reason: "empty" };
  if (input.bytes.length > MAX_STICKER_BYTES) return { ok: false, reason: "too_large" };
  const imageInfo = inspectImageInfo(input.bytes);
  if (imageInfo && imageInfo.pixels > MAX_IMAGE_PIXELS) return { ok: false, reason: "too_large" };

  const hash = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const mime = sniffMime(input.bytes);

  try {
    const db = getVectorDb();
    ensureStickerTable(db);
    const existing = db
      .prepare(`SELECT id FROM sticker_library WHERE owner_id = ? AND hash = ?`)
      .get(input.ownerId, hash) as { id: number } | undefined;
    if (existing) return { ok: true, reason: "duplicate", id: existing.id };

    ensureDataDir();
    const dir = stickerDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${hash.slice(0, 16)}.${extFor(mime)}`);
    fs.writeFileSync(file, input.bytes);

    const info = db
      .prepare(
        `INSERT INTO sticker_library
           (owner_id, hash, file, source, tags_json, emotion, note, scene_tags,
            use_count, first_seen_at, mime, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.ownerId,
        hash,
        file,
        input.source ?? "inbound",
        JSON.stringify(input.tags ?? []),
        input.emotion ?? null,
        input.note ?? null,
        input.sceneTags ? JSON.stringify(input.sceneTags) : null,
        input.now ?? Date.now(),
        mime,
        input.bytes.length,
      );

    const id = Number(info.lastInsertRowid);
    enforceCapacity(db, input.ownerId);
    return { ok: true, reason: "saved", id };
  } catch {
    return { ok: false, reason: "db_failed" };
  }
}

/** 超出库容时淘汰最久未使用的（保留常用度高的） */
function enforceCapacity(db: Database, ownerId: string): void {
  try {
    const count = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM sticker_library WHERE owner_id = ?`).get(ownerId) as {
        c: number;
      }).c,
    );
    if (count <= MAX_COLLECTED_STICKERS) return;
    const victims = db
      .prepare(
        `SELECT id, file FROM sticker_library WHERE owner_id = ?
         ORDER BY COALESCE(last_used_at, 0) ASC, use_count ASC
         LIMIT ?`,
      )
      .all(ownerId, count - MAX_COLLECTED_STICKERS) as Array<{ id: number; file: string }>;
    const del = db.prepare(`DELETE FROM sticker_library WHERE id = ?`);
    for (const v of victims) {
      try {
        fs.rmSync(v.file, { force: true });
      } catch {
        // 文件删不掉也继续删记录，避免库无限膨胀
      }
      del.run(v.id);
    }
  } catch {
    // 淘汰失败不影响采集
  }
}

export function listCollectedStickers(ownerId: string, limit = 50): CollectedSticker[] {
  try {
    const db = getVectorDb();
    ensureStickerTable(db);
    return db
      .prepare(
        `SELECT * FROM sticker_library WHERE owner_id = ?
         ORDER BY COALESCE(last_used_at, 0) DESC LIMIT ?`,
      )
      .all(ownerId, Math.max(1, limit)) as CollectedSticker[];
  } catch {
    return [];
  }
}

function parseTags(row: CollectedSticker): string[] {
  try {
    const parsed = JSON.parse(row.tags_json ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseSceneTags(row: CollectedSticker): string[] {
  try {
    const parsed = JSON.parse(row.scene_tags ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 单行化 + 限长：备注会跨会话注入/参与匹配，不能被换行/控制字符污染。 */
function sanitizeLabelText(raw: string | null | undefined, maxChars: number): string {
  const cleaned = String(raw ?? "")
    .replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : cleaned;
}

/**
 * 写入 AI 语义标签（v0.9.24）：note 说明「这张表情在聊天里怎么用」，
 * sceneTags 是 3~5 个场景/情绪标签。只更新本地 AI 层，不碰 QQ 收藏。
 * 返回是否更新成功。
 */
export function labelSticker(
  id: number,
  label: { note?: string; tags?: string[]; emotion?: string | null },
): boolean {
  const note = sanitizeLabelText(label.note, 80);
  const tags = (label.tags ?? [])
    .map((t) => sanitizeLabelText(t, 12))
    .filter(Boolean)
    .slice(0, 8);
  if (!note && tags.length === 0) return false;
  try {
    const db = getVectorDb();
    ensureStickerTable(db);
    const info = db
      .prepare(
        `UPDATE sticker_library
         SET note = COALESCE(?, note),
             scene_tags = COALESCE(?, scene_tags),
             emotion = COALESCE(?, emotion)
         WHERE id = ?`,
      )
      .run(
        note || null,
        tags.length ? JSON.stringify(tags) : null,
        label.emotion ?? null,
        id,
      );
    return info.changes > 0;
  } catch {
    return false;
  }
}

/**
 * 按当前情绪 + 对话上下文挑一张（用得少的优先，最近用过的排除）。
 * v0.9.24：加入 AI 场景标签匹配（contextText 来自最近一句用户消息/她的回复），
 * 比只看 happy/neutral/sad 三档情绪更能选到「对语境」的表情。
 * 没有任何匹配就返回 null，由调用方回退内置贴纸。
 */
export function pickCollectedSticker(input: {
  ownerId: string;
  emotion?: string;
  /** 当前对话上下文（最近一句用户话/回复），用于匹配 scene_tags */
  contextText?: string;
  excludeIds?: number[];
  /** 随机源（测试注入） */
  random?: () => number;
  now?: number;
}): CollectedSticker | null {
  const rows = listCollectedStickers(input.ownerId, 200);
  if (rows.length === 0) return null;
  const excluded = new Set(input.excludeIds ?? []);
  const candidates = rows.filter((r) => !excluded.has(r.id));
  if (candidates.length === 0) return null;

  const emotionMatch = (row: CollectedSticker): number => {
    if (!input.emotion) return 0;
    const tags = parseTags(row);
    if (row.emotion === input.emotion) return 2;
    if (tags.includes(input.emotion)) return 1;
    return 0;
  };
  const context = String(input.contextText ?? "").trim();
  const contextMatch = (row: CollectedSticker): number => {
    if (!context) return 0;
    const tags = [...parseTags(row), ...parseSceneTags(row)];
    let hits = 0;
    for (const tag of tags) {
      if (tag.length >= 2 && context.includes(tag)) hits++;
    }
    return Math.min(3, hits);
  };

  // 打分：场景命中 > 情绪匹配 > 用得少；同分随机
  const random = input.random ?? Math.random;
  const scored = candidates.map((row) => ({
    row,
    score: contextMatch(row) * 25 + emotionMatch(row) * 10 - row.use_count + random() * 0.5,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].row;
}

/** 记一次使用（影响后续挑选与淘汰）。 */
export function markStickerUsed(id: number, now = Date.now()): void {
  try {
    const db = getVectorDb();
    db.prepare(`UPDATE sticker_library SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`).run(
      now,
      id,
    );
  } catch {
    // 忽略
  }
}

/** 清空采集库（文件 + 记录），返回删除条数。 */
export function purgeCollectedStickers(ownerId?: string): number {
  try {
    const db = getVectorDb();
    ensureStickerTable(db);
    const rows = (ownerId
      ? db.prepare(`SELECT id, file FROM sticker_library WHERE owner_id = ?`).all(ownerId)
      : db.prepare(`SELECT id, file FROM sticker_library`).all()) as Array<{ id: number; file: string }>;
    const del = ownerId
      ? db.prepare(`DELETE FROM sticker_library WHERE owner_id = ?`)
      : db.prepare(`DELETE FROM sticker_library`);
    for (const row of rows) {
      try {
        fs.rmSync(row.file, { force: true });
      } catch {
        // 忽略
      }
    }
    if (ownerId) del.run(ownerId);
    else del.run();
    return rows.length;
  } catch {
    return 0;
  }
}
