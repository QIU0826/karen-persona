/**
 * 多用户隔离：owner（消息来源的用户）与存储作用域。
 *
 * 背景（商业化前置）：同一个「小雅」人设下，不同 QQ 好友不能共享会话、记忆、亲密度。
 * 做法：
 * - owner = "qq:<QQ号>" 或 "cli:local"；
 * - 主用户（白名单第一个 QQ）与 CLI 继续使用历史文件/历史 persona_id（向后兼容，旧数据不迁移即归属主用户）；
 * - 其他 owner 使用带后缀的会话/状态文件，T2/T1 存储 persona_id 用 `personaId@ownerSlug`，
 *   现有检索按当前 persona_id 过滤 → 天然隔离，无需改表结构。
 */
export const OWNER_CLI = "cli:local";

export function ownerForQq(userId: number | string): string {
  return `qq:${userId}`;
}

/** 文件/存储 id 的安全后缀（qq:123 → qq-123） */
export function ownerSlug(owner: string): string {
  return owner.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

export interface OwnerScope {
  owner: string;
  /** 会话/人格状态文件后缀；"" = 历史文件（主用户/CLI） */
  storageKey: string;
  /** T2/T1 记忆使用的 persona_id；"" 后缀 = 历史数据（主用户/CLI） */
  storagePersona: string;
  /** 是否使用历史存储（主用户/CLI） */
  legacy: boolean;
}

/**
 * 解析某个 owner 的存储作用域。
 * - 主用户（allowed_users[0]）与 CLI：legacy=true，直接用历史 persona_id / 历史文件名；
 * - 其他用户：隔离后缀。
 * - 白名单为空（允许所有人）：CLI 仍 legacy；QQ 用户全部隔离（避免彼此可见历史记忆）。
 */
export function resolveOwnerScope(
  personaId: string,
  owner: string,
  allowedUsers: number[] = [],
): OwnerScope {
  const primary = allowedUsers.length > 0 ? ownerForQq(allowedUsers[0]) : null;
  const legacy = owner === OWNER_CLI || (primary !== null && owner === primary);
  if (legacy) {
    return { owner, storageKey: "", storagePersona: personaId, legacy: true };
  }
  const slug = ownerSlug(owner);
  return {
    owner,
    storageKey: `-${slug}`,
    storagePersona: `${personaId}@${slug}`,
    legacy: false,
  };
}
