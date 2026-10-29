/**
 * 高权限社会化（P-social）：平台无关的动作/草稿/结果类型。
 *
 * 设计约束（与计划一致）：
 * - 所有写动作先进入社交引擎，不允许 bridge 直接调 B 站写接口；
 * - 动作必须可审计、可审批、可撤销（平台支持时）；
 * - 平台差异只体现在 adapter，不污染 policy/runner。
 */
export type SocialPlatform = "bilibili" | "qzone";

export type SocialActionType =
  | "comment"
  | "reply"
  | "dynamic"
  | "like"
  | "unlike"
  | "favorite"
  | "unfavorite"
  | "coin"
  | "follow"
  | "unfollow"
  | "share"
  | "dm"
  | "delete_comment"
  | "delete_dynamic";

export type SocialMode = "off" | "observe" | "approve" | "auto" | "high";

export type SocialRisk = "low" | "medium" | "high";

export type SocialActionStatus =
  | "draft"
  | "queued"
  | "approved"
  | "executing"
  | "sent"
  | "failed"
  | "rejected"
  | "expired"
  | "undone";

export interface SocialTarget {
  platform: SocialPlatform;
  targetType: "video" | "user" | "dynamic" | "comment" | "none";
  /** 平台内稳定 id：BV 号 / aid / uid / comment rpid / dynamic id */
  targetId: string;
  title?: string;
  url?: string;
  /** 目标作者 uid（可选；关注/回复时用） */
  authorUid?: string;
  /** 视频 aid（评论/点赞需要 oid） */
  aid?: number;
}

export interface SocialDraft {
  platform: SocialPlatform;
  action: SocialActionType;
  target: SocialTarget;
  /** 评论/动态/私信正文；like 等可为空 */
  content: string;
  /** 她为什么想做这件事（只进审计，不公开发） */
  reason: string;
  risk: SocialRisk;
  /** 可选：自动生成时的模型/摘要信息，便于复盘 */
  meta?: Record<string, unknown>;
}

export interface SocialActionResult {
  ok: boolean;
  platform: SocialPlatform;
  action: SocialActionType;
  /** 已发送时的外部 id（rpid/dynamic_id 等）；失败为空 */
  externalId?: string;
  errorCode?: string;
  reason?: string;
  /** 平台是否支持删除/撤销 */
  undoable?: boolean;
  /** 仅审计/日志用，不含 Cookie/敏感正文 */
  meta?: Record<string, unknown>;
}

export interface SocialActionRecord extends SocialDraft {
  id: number;
  status: SocialActionStatus;
  externalId?: string;
  errorCode?: string;
  createdAt: number;
  executedAt?: number;
  undoneAt?: number;
}

export interface SocialCaps {
  commentsPerDay: number;
  repliesPerDay: number;
  dynamicsPerDay: number;
  likesPerDay: number;
  favoritesPerDay: number;
  coinsPerDay: number;
  followsPerDay: number;
  sharesPerDay: number;
  dmsPerDay: number;
  totalPerDay: number;
}

/** 代码级硬上限：配置文件只能调低，不能调高。 */
export const SOCIAL_HARD_CAPS: Readonly<SocialCaps> = Object.freeze({
  commentsPerDay: 5,
  repliesPerDay: 5,
  dynamicsPerDay: 2,
  likesPerDay: 20,
  favoritesPerDay: 20,
  coinsPerDay: 10,
  followsPerDay: 2,
  sharesPerDay: 1,
  dmsPerDay: 5,
  totalPerDay: 25,
});

/** 默认值（第一版 approve 灰度）。 */
export const SOCIAL_DEFAULT_CAPS: Readonly<SocialCaps> = Object.freeze({
  commentsPerDay: 3,
  repliesPerDay: 2,
  dynamicsPerDay: 1,
  likesPerDay: 5,
  favoritesPerDay: 2,
  coinsPerDay: 2,
  followsPerDay: 1,
  sharesPerDay: 0,
  dmsPerDay: 0,
  totalPerDay: 15,
});

export interface SocialConfig {
  mode: SocialMode;
  dryRun: boolean;
  /** 连续失败/风控后自动暂停时长 */
  circuitCooldownHours: number;
  /** 两次公开动作最小间隔 */
  minGapMinutes: number;
  /** 审批 TTL */
  approvalTtlMinutes: number;
  /** B 站 Cookie 文件（0600）；env 可覆盖 */
  cookieFile: string;
  caps: SocialCaps;
}

export const SOCIAL_DEFAULT_MIN_GAP_MIN = 15;
export const SOCIAL_DEFAULT_APPROVAL_TTL_MIN = 10;
export const SOCIAL_DEFAULT_CIRCUIT_COOLDOWN_HOURS = 24;
