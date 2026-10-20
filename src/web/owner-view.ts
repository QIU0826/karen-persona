/**
 * Web 控制台的多用户（owner）视图辅助（M2-C 最小版，只读）。
 *
 * 数据都来自现有按 owner 隔离的存储：
 * - 会话文件：`data/<人设名><storageKey>-session.json`（legacy 主用户 storageKey=""）；
 * - `user_facts.owner_id` / `user_consent.owner_id`；
 * - 不新增表、不写任何东西。
 *
 * owner 与 storageKey 的约定与 `src/data/owner.ts` 保持一致：
 * - 主用户（白名单第一个 QQ）与 `cli:local` → storageKey=""（历史数据）；
 * - 其他用户 → storageKey=`-qq-<id>`，T2 persona_id=`<personaId>@qq-<id>`。
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../data/paths.js";
import { ownerSlug } from "../data/owner.js";
import { getVectorDb } from "../data/vector.js";

export const OWNER_PATTERN = /^(qq|cli):[a-z0-9_.-]{1,64}$/i;

/** 校验请求里的 ?owner=；非法返回 null。 */
export function normalizeOwnerParam(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || !OWNER_PATTERN.test(value)) return null;
  return value;
}

export function isOwnerAllowed(
  owner: string,
  primaryOwner: string,
  allOwnersEnabled: boolean,
): boolean {
  return allOwnersEnabled || owner === primaryOwner;
}

/** 该 owner 是否为 legacy 存储（主用户/CLI 共用历史文件）。 */
export function isLegacyOwner(owner: string, primaryOwner: string): boolean {
  return owner === primaryOwner || owner === "cli:local";
}

/** owner → 会话/状态文件后缀（legacy 为 ""）。 */
export function storageKeyForOwner(owner: string, primaryOwner: string): string {
  return isLegacyOwner(owner, primaryOwner) ? "" : `-${ownerSlug(owner)}`;
}

/** owner → T2/T1 的 persona_id（legacy 为人设 id 本身）。 */
export function storagePersonaForOwner(
  personaId: string,
  owner: string,
  primaryOwner: string,
): string {
  return isLegacyOwner(owner, primaryOwner) ? personaId : `${personaId}@${ownerSlug(owner)}`;
}

/** storageKey（"-qq-123"）→ owner（"qq:123"）；空/异常回退 primaryOwner。 */
export function ownerFromStorageKey(storageKey: string | undefined, primaryOwner: string): string {
  if (!storageKey) return primaryOwner;
  const slug = storageKey.replace(/^-/, "");
  const separator = slug.indexOf("-");
  if (separator <= 0 || separator === slug.length - 1) return primaryOwner;
  return `${slug.slice(0, separator)}:${slug.slice(separator + 1)}`;
}

export interface OwnerInfo {
  owner: string;
  is_primary: boolean;
  legacy: boolean;
  /** 会话/状态文件后缀（"" = 历史文件） */
  storage_key: string;
  /** T2/T1 persona_id */
  persona_id: string;
  persona_name: string | null;
  messages: number;
  last_active_at: number | null;
  facts: number;
  age_confirmed: boolean;
}

interface SessionFileInfo {
  owner: string;
  personaName: string | null;
  messages: number;
  lastActiveAt: number | null;
}

/** 扫描 data/*-session.json，拿到每个 owner 的会话概况（只读，损坏文件跳过）。 */
export function scanSessionFiles(primaryOwner: string): SessionFileInfo[] {
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  const result: SessionFileInfo[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith("-session.json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as Record<string, unknown>;
      const storageKey = typeof raw.storageKey === "string" ? raw.storageKey : "";
      const owner = ownerFromStorageKey(storageKey, primaryOwner);
      const messages = Array.isArray(raw.messages) ? raw.messages.length : 0;
      const lastActiveAt =
        typeof raw.lastActiveAt === "number" && Number.isFinite(raw.lastActiveAt)
          ? raw.lastActiveAt
          : null;
      const personaName = typeof raw.personaId === "string" ? raw.personaId : null;
      result.push({ owner, personaName, messages, lastActiveAt });
    } catch {
      // 损坏文件不影响控制台
    }
  }
  return result;
}

function readGroupedCounts(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const rows = getVectorDb().prepare(sql).all() as Array<{ owner_id: string; c: number }>;
    for (const row of rows) {
      if (typeof row.owner_id === "string") counts.set(row.owner_id, Number(row.c) || 0);
    }
  } catch {
    // 表不存在/DB 未初始化：返回空
  }
  return counts;
}

function readConfirmedOwners(): Set<string> {
  const confirmed = new Set<string>();
  try {
    const rows = getVectorDb()
      .prepare("SELECT owner_id FROM user_consent WHERE age_confirmed_at IS NOT NULL")
      .all() as Array<{ owner_id: string }>;
    for (const row of rows) {
      if (typeof row.owner_id === "string") confirmed.add(row.owner_id);
    }
  } catch {
    // 忽略
  }
  return confirmed;
}

/**
 * 列出所有已知 owner（主用户始终在列表里）。
 * 合并来源：会话文件、user_facts、user_consent。
 */
export function listKnownOwners(
  personaId: string,
  primaryOwner: string,
): OwnerInfo[] {
  const sessions = scanSessionFiles(primaryOwner);
  const factsCounts = readGroupedCounts(
    "SELECT owner_id, COUNT(*) AS c FROM user_facts GROUP BY owner_id",
  );
  const confirmed = readConfirmedOwners();

  const map = new Map<string, OwnerInfo>();
  const ensure = (owner: string): OwnerInfo => {
    let info = map.get(owner);
    if (!info) {
      const legacy = isLegacyOwner(owner, primaryOwner);
      info = {
        owner,
        is_primary: owner === primaryOwner,
        legacy,
        storage_key: storageKeyForOwner(owner, primaryOwner),
        persona_id: storagePersonaForOwner(personaId, owner, primaryOwner),
        persona_name: null,
        messages: 0,
        last_active_at: null,
        facts: factsCounts.get(owner) ?? 0,
        age_confirmed: confirmed.has(owner),
      };
      map.set(owner, info);
    }
    return info;
  };

  ensure(primaryOwner);
  for (const session of sessions) {
    const info = ensure(session.owner);
    // 同一 owner 可能有 archive/多版本文件：取消息数与最近活跃的最大值
    info.messages = Math.max(info.messages, session.messages);
    if (
      session.lastActiveAt !== null &&
      (info.last_active_at === null || session.lastActiveAt > info.last_active_at)
    ) {
      info.last_active_at = session.lastActiveAt;
    }
    if (!info.persona_name && session.personaName) info.persona_name = session.personaName;
  }
  for (const owner of factsCounts.keys()) ensure(owner);
  for (const owner of confirmed) ensure(owner);

  return [...map.values()].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    const left = a.last_active_at ?? 0;
    const right = b.last_active_at ?? 0;
    if (left !== right) return right - left;
    return a.owner.localeCompare(b.owner);
  });
}
