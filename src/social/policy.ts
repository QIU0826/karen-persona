/**
 * 高权限社会化（P-social）——动作治理 policy：**纯函数**。
 *
 * 职责：在真正调用平台写接口之前，决定「这一次动作能不能做、要不要审批、为什么」。
 * 不联网、不读配置/文件、不依赖随机数；时间通过 `now` 注入（缺省 Date.now() 只为方便）。
 *
 * 治理顺序（命中即返回，越靠前越硬）：
 *   1. mode：off / observe 一律不允许写
 *   2. 治理动作（撤回/取消赞/取关等）放行——它们只减少影响，不占预算、不受静默/间隔限制
 *   3. 风控冷却（circuitOpenUntil）
 *   4. 静默时段（quietHours；跨午夜也支持；start==end 视为关闭）
 *   5. 目标本身是否敏感（标题/简介命中安全词表 → 不碰）
 *   6. 正文安全与结构限制（空/超长/链接/标签/@）
 *   7. 预算（按动作类型的日上限 + 总日上限；硬上限在 policy 内再夹一次）
 *   8. 重复目标（同一目标每天 ≤2 次；同一视频评论每天仅 1 次）
 *   9. 公开动作最小间隔
 *  10. 风险分级 + 是否需要人工审批（approve 模式全部要审批；auto 模式仅高风险要）
 *
 * 与 runner 的约定：
 * - `evaluateSocialAction` 返回 `needsApproval=true` 时，runner 建审批单；人工通过后
 *   带 `approved:true` 再调一次，通过后再执行；
 * - `reason` 是稳定枚举，UI/日志可直接映射中文文案（`SOCIAL_POLICY_REASON_LABEL`）。
 */

import {
  SOCIAL_HARD_CAPS,
  type SocialActionType,
  type SocialCaps,
  type SocialDraft,
  type SocialMode,
  type SocialRisk,
  type SocialTarget,
} from "./types.js";
import {
  SOCIAL_COMMENT_MAX_CHARS,
  SOCIAL_DM_MAX_CHARS,
  SOCIAL_DYNAMIC_MAX_CHARS,
  scanSocialContent,
  validateSocialContent,
} from "./safety.js";

// ── 动作画像 ───────────────────────────────────────

export type SocialBudgetCategory =
  | "comments"
  | "replies"
  | "dynamics"
  | "likes"
  | "favorites"
  | "coins"
  | "follows"
  | "shares"
  | "dms";

export type SocialActionGroup = "content" | "reaction" | "social" | "governance";

export interface SocialActionProfile {
  /** 预算分类；治理动作（撤回/取关）为 null，不占预算。 */
  category: SocialBudgetCategory | null;
  group: SocialActionGroup;
  /** 动作本身的基础风险；正文/目标还会再上调。 */
  baseRisk: SocialRisk;
  /** 是否是「平台上其他人可见」的公开动作（受最小间隔约束；私信不算）。 */
  public: boolean;
  /** 是否必须带正文（comment/reply/dynamic/dm）。 */
  requiresContent: boolean;
}

/** 动作 → 预算分类/风险/是否公开。是 policy 的唯一事实源（runner 不要另写一份）。 */
export const SOCIAL_ACTION_PROFILES: Readonly<Record<SocialActionType, SocialActionProfile>> =
  Object.freeze({
    comment: { category: "comments", group: "content", baseRisk: "medium", public: true, requiresContent: true },
    reply: { category: "replies", group: "content", baseRisk: "medium", public: true, requiresContent: true },
    dynamic: { category: "dynamics", group: "content", baseRisk: "high", public: true, requiresContent: true },
    like: { category: "likes", group: "reaction", baseRisk: "low", public: true, requiresContent: false },
    unlike: { category: null, group: "governance", baseRisk: "low", public: false, requiresContent: false },
    favorite: { category: "favorites", group: "reaction", baseRisk: "low", public: true, requiresContent: false },
    unfavorite: { category: null, group: "governance", baseRisk: "low", public: false, requiresContent: false },
    coin: { category: "coins", group: "reaction", baseRisk: "low", public: true, requiresContent: false },
    follow: { category: "follows", group: "social", baseRisk: "medium", public: true, requiresContent: false },
    unfollow: { category: null, group: "governance", baseRisk: "low", public: false, requiresContent: false },
    share: { category: "shares", group: "social", baseRisk: "high", public: true, requiresContent: false },
    dm: { category: "dms", group: "social", baseRisk: "medium", public: false, requiresContent: true },
    delete_comment: { category: null, group: "governance", baseRisk: "low", public: false, requiresContent: false },
    delete_dynamic: { category: null, group: "governance", baseRisk: "low", public: false, requiresContent: false },
  });

/** 同目标每日最多动作次数（含点赞/评论/收藏等，按 targetKey 计）。 */
export const SOCIAL_MAX_ACTIONS_PER_TARGET_PER_DAY = 2;
/** 同一视频每天最多评论次数。 */
export const SOCIAL_MAX_COMMENTS_PER_VIDEO = 1;

export function getSocialActionProfile(action: SocialActionType): SocialActionProfile {
  return SOCIAL_ACTION_PROFILES[action];
}

export function isGovernanceAction(action: SocialActionType): boolean {
  return getSocialActionProfile(action).group === "governance";
}

/** 是否公开动作（决定是否受最小间隔约束）。 */
export function isPublicSocialAction(action: SocialActionType): boolean {
  return getSocialActionProfile(action).public;
}

/** 该动作的正文长度上限；不需要正文的动作返回 null。 */
export function contentLimitForAction(action: SocialActionType): number | null {
  switch (action) {
    case "comment":
    case "reply":
      return SOCIAL_COMMENT_MAX_CHARS;
    case "dynamic":
      return SOCIAL_DYNAMIC_MAX_CHARS;
    case "dm":
      return SOCIAL_DM_MAX_CHARS;
    default:
      return null;
  }
}

/** 目标稳定 key：`platform:targetType:targetId`；缺 id 时回退 aid/authorUid。 */
export function socialTargetKey(target: SocialTarget): string {
  const id =
    (target.targetId && target.targetId.trim()) ||
    (target.aid !== undefined ? String(target.aid) : "") ||
    (target.authorUid && target.authorUid.trim()) ||
    "unknown";
  return `${target.platform}:${target.targetType}:${id}`;
}

// ── 预算 ───────────────────────────────────────────

export type SocialCapKey = keyof SocialCaps;

/** 把调用方 caps 再夹一次硬上限（config 已夹过一次，这里是 defense in depth）。 */
export function effectiveCaps(caps: SocialCaps): SocialCaps {
  const pick = (value: number, hard: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(hard, Math.floor(n)));
  };
  return {
    commentsPerDay: pick(caps.commentsPerDay, SOCIAL_HARD_CAPS.commentsPerDay),
    repliesPerDay: pick(caps.repliesPerDay, SOCIAL_HARD_CAPS.repliesPerDay),
    dynamicsPerDay: pick(caps.dynamicsPerDay, SOCIAL_HARD_CAPS.dynamicsPerDay),
    likesPerDay: pick(caps.likesPerDay, SOCIAL_HARD_CAPS.likesPerDay),
    favoritesPerDay: pick(caps.favoritesPerDay, SOCIAL_HARD_CAPS.favoritesPerDay),
    coinsPerDay: pick(caps.coinsPerDay, SOCIAL_HARD_CAPS.coinsPerDay),
    followsPerDay: pick(caps.followsPerDay, SOCIAL_HARD_CAPS.followsPerDay),
    sharesPerDay: pick(caps.sharesPerDay, SOCIAL_HARD_CAPS.sharesPerDay),
    dmsPerDay: pick(caps.dmsPerDay, SOCIAL_HARD_CAPS.dmsPerDay),
    totalPerDay: pick(caps.totalPerDay, SOCIAL_HARD_CAPS.totalPerDay),
  };
}

/** 预算分类 → SocialCaps 字段。 */
export function capKeyForCategory(category: SocialBudgetCategory): SocialCapKey {
  return `${category}PerDay` as SocialCapKey;
}

// ── 风险 ───────────────────────────────────────────

const RISK_RANK: Record<SocialRisk, number> = { low: 0, medium: 1, high: 2 };

export function maxSocialRisk(a: SocialRisk, b: SocialRisk): SocialRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export interface ActionRiskInput {
  action: SocialActionType;
  /** 评论/动态/私信正文；点赞等可省略。 */
  content?: string;
  /** 目标本身是否敏感（由调用方或本模块扫描目标标题得到）。 */
  targetSensitive?: boolean;
  /** 草稿里已有的 risk（模型/上游给的），取更高者。 */
  declaredRisk?: SocialRisk;
}

/**
 * 动作风险分级：
 * - 基础风险来自动作画像（dynamic/share=high，comment/reply/follow/dm=medium，reaction=low）；
 * - 目标敏感 → high；
 * - 正文命中安全词表/带外链 → high；
 * - 正文过长 → 至少 medium；
 * - 与草稿声明风险取 max。
 */
export function classifyActionRisk(action: SocialActionType): SocialRisk;
export function classifyActionRisk(input: ActionRiskInput): SocialRisk;
export function classifyActionRisk(input: SocialActionType | ActionRiskInput): SocialRisk {
  const data: ActionRiskInput = typeof input === "string" ? { action: input } : input;
  let risk = getSocialActionProfile(data.action).baseRisk;

  if (data.targetSensitive) risk = maxSocialRisk(risk, "high");

  const content = typeof data.content === "string" ? data.content : "";
  if (content.trim()) {
    const scan = scanSocialContent(content);
    if (scan.categories.length > 0) {
      risk = maxSocialRisk(risk, "high");
    } else if (/(https?:\/\/|www\.)/i.test(content)) {
      risk = maxSocialRisk(risk, "high");
    } else if (Array.from(content.trim()).length > 80) {
      risk = maxSocialRisk(risk, "medium");
    }
  }

  if (data.declaredRisk) risk = maxSocialRisk(risk, data.declaredRisk);
  return risk;
}

/**
 * 该动作在该 mode 下是否需要人工审批。
 *
 * - off / observe：false（根本不允许写；调用方应先看 `allow`）；
 * - governance（撤回/取消赞/取关）：false（只减少影响，越快越好）；
 * - approve：所有写动作都要审批（第一版灰度默认）；
 * - auto：仅高风险要审批；
 * - high：都自动（内容安全仍会一票否决）。
 */
export function shouldRequireApproval(
  mode: SocialMode,
  action: SocialActionType,
  risk: SocialRisk,
): boolean {
  if (mode === "off" || mode === "observe") return false;
  if (isGovernanceAction(action)) return false;
  if (mode === "approve") return true;
  if (mode === "auto") return risk === "high";
  return false; // high
}

// ── 静默时段 ───────────────────────────────────────

export interface SocialQuietHours {
  /** 0–23；与 endHour 相同表示未启用。 */
  startHour: number;
  endHour: number;
}

function normalizeHour(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((Math.floor(n) % 24) + 24) % 24;
}

/**
 * 是否处于静默时段（支持跨午夜，如 23→7）。
 * `opts.hour` 可显式覆盖小时（单测/调度器已有当地时间时用，避免依赖进程时区）。
 */
export function isWithinQuietHours(
  now: number,
  quietHours?: SocialQuietHours | null,
  opts: { hour?: number } = {},
): boolean {
  if (!quietHours) return false;
  const start = normalizeHour(quietHours.startHour);
  const end = normalizeHour(quietHours.endHour);
  if (start === end) return false; // 起止相同 = 关闭静默
  const hour = opts.hour !== undefined ? normalizeHour(opts.hour) : new Date(now).getHours();
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// ── 使用量快照 / 决策 ──────────────────────────────

export interface SocialUsageSnapshot {
  /** 今天各动作已执行次数（按动作类型）。 */
  byAction: Partial<Record<SocialActionType, number>>;
  /** 今天公开动作总数；缺省时由 byAction 里「有预算分类」的动作求和。 */
  totalToday?: number;
  /** 今天对每个 target 的动作次数（key = socialTargetKey）。 */
  byTarget?: Record<string, number>;
  /** 今天对每个 target 的评论次数（key 同上；建议由 runner 传「历史累计」更严）。 */
  commentsByTarget?: Record<string, number>;
  /** 最近一次公开动作时间（ms）。 */
  lastPublicActionAt?: number | null;
  /** 风控冷却截止时间（ms）；未到则暂停所有写动作。 */
  circuitOpenUntil?: number | null;
}

export interface EvaluateSocialActionInput {
  mode: SocialMode;
  caps: SocialCaps;
  draft: SocialDraft;
  usage?: Partial<SocialUsageSnapshot>;
  /** 两次公开动作最小间隔（分钟）；默认 15，来自 SocialConfig.minGapMinutes。 */
  minGapMinutes?: number;
  quietHours?: SocialQuietHours | null;
  /** 当前时间（ms），便于单测注入。 */
  now?: number;
  /** 人工审批是否已通过；approve 模式/auto 高风险动作需要。 */
  approved?: boolean;
}

export interface SocialBudgetSnapshot {
  category: SocialBudgetCategory;
  used: number;
  limit: number;
  totalUsed: number;
  totalLimit: number;
}

export type SocialPolicyReason =
  | "allowed"
  | "governance_allowed"
  | "mode_off"
  | "observe_only"
  | "circuit_open"
  | "quiet_hours"
  | "unsafe_target"
  | "unsafe_content"
  | "content_invalid"
  | "budget_exceeded"
  | "total_budget_exceeded"
  | "duplicate_target"
  | "duplicate_comment"
  | "min_gap"
  | "approval_required";

/** reason → 中文文案（UI/日志共用，避免各写一份）。 */
export const SOCIAL_POLICY_REASON_LABEL: Record<SocialPolicyReason, string> = {
  allowed: "允许执行",
  governance_allowed: "治理动作（撤回/取消）直接放行",
  mode_off: "社交总开关已关闭",
  observe_only: "当前为 observe 模式：只看不写",
  circuit_open: "风控冷却中，暂停写动作",
  quiet_hours: "静默时段内不发动作",
  unsafe_target: "目标内容敏感，不参与",
  unsafe_content: "草稿内容命中安全红线",
  content_invalid: "草稿格式不合规（空/超长/链接/标签）",
  budget_exceeded: "该动作今日预算已用完",
  total_budget_exceeded: "今日动作总预算已用完",
  duplicate_target: "对同一目标今天动作次数已达上限",
  duplicate_comment: "同一个视频今天已经评论过",
  min_gap: "距上次公开动作太近",
  approval_required: "需要人工审批",
};

export interface SocialPolicyDecision {
  allow: boolean;
  needsApproval: boolean;
  reason: SocialPolicyReason;
  risk: SocialRisk;
  action: SocialActionType;
  targetKey: string;
  detail: string;
  /** allow 或预算不足时给出预算快照；治理动作/模式拦截没有。 */
  budget?: SocialBudgetSnapshot;
}

/** 默认两次公开动作最小间隔（分钟）；来自 SocialConfig.minGapMinutes，缺省用它。 */
export const DEFAULT_SOCIAL_MIN_GAP_MINUTES = 15;

function countRecord(value: Partial<Record<SocialActionType, number>> | undefined): number {
  if (!value) return 0;
  let total = 0;
  for (const action of Object.keys(SOCIAL_ACTION_PROFILES) as SocialActionType[]) {
    if (!SOCIAL_ACTION_PROFILES[action].category) continue;
    const n = Number(value[action] ?? 0);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

function normalizeUsage(usage: Partial<SocialUsageSnapshot> | undefined): Required<
  Pick<SocialUsageSnapshot, "byAction" | "byTarget" | "commentsByTarget">
> & {
  totalToday: number;
  lastPublicActionAt: number | null;
  circuitOpenUntil: number | null;
} {
  const byAction = usage?.byAction ?? {};
  const byTarget = usage?.byTarget ?? {};
  const commentsByTarget = usage?.commentsByTarget ?? {};
  const totalToday =
    usage?.totalToday !== undefined && Number.isFinite(Number(usage.totalToday))
      ? Math.max(0, Math.floor(Number(usage.totalToday)))
      : countRecord(byAction);
  const last = Number(usage?.lastPublicActionAt);
  const circuit = Number(usage?.circuitOpenUntil);
  return {
    byAction,
    byTarget,
    commentsByTarget,
    totalToday,
    lastPublicActionAt: Number.isFinite(last) && last > 0 ? last : null,
    circuitOpenUntil: Number.isFinite(circuit) && circuit > 0 ? circuit : null,
  };
}

function decision(
  input: EvaluateSocialActionInput,
  risk: SocialRisk,
  targetKey: string,
  reason: SocialPolicyReason,
  detail: string,
  extra: { allow?: boolean; needsApproval?: boolean; budget?: SocialBudgetSnapshot } = {},
): SocialPolicyDecision {
  return {
    allow: extra.allow ?? false,
    needsApproval: extra.needsApproval ?? false,
    reason,
    risk,
    action: input.draft.action,
    targetKey,
    detail: detail || SOCIAL_POLICY_REASON_LABEL[reason],
    budget: extra.budget,
  };
}

/** 目标标题/简介是否敏感（只看外部标题/简介，不看 draft 正文）。 */
function targetLooksSensitive(target: SocialTarget): boolean {
  const text = `${target.title ?? ""}`.trim();
  if (!text) return false;
  return scanSocialContent(text).categories.length > 0;
}

function formatMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * 评估一个社交动作。纯函数；`now` 缺省 Date.now() 仅为方便（测试请注入）。
 */
export function evaluateSocialAction(input: EvaluateSocialActionInput): SocialPolicyDecision {
  const { mode, draft } = input;
  const now = input.now ?? Date.now();
  const profile = getSocialActionProfile(draft.action);
  const targetKey = socialTargetKey(draft.target);
  const targetSensitive = targetLooksSensitive(draft.target);
  const risk = classifyActionRisk({
    action: draft.action,
    content: draft.content,
    targetSensitive,
    declaredRisk: draft.risk,
  });

  // 1. mode 总闸
  if (mode === "off") {
    return decision(input, risk, targetKey, "mode_off", "");
  }
  if (mode === "observe") {
    return decision(input, risk, targetKey, "observe_only", "");
  }

  // 2. 治理动作：只减少影响，不占预算、不受静默/间隔限制
  if (profile.group === "governance") {
    return decision(input, risk, targetKey, "governance_allowed", "", { allow: true });
  }

  const caps = effectiveCaps(input.caps);
  const usage = normalizeUsage(input.usage);

  // 3. 风控冷却
  if (usage.circuitOpenUntil !== null && now < usage.circuitOpenUntil) {
    const minutes = formatMinutes(usage.circuitOpenUntil - now);
    return decision(
      input,
      risk,
      targetKey,
      "circuit_open",
      `风控冷却中，约还要等 ${minutes} 分钟`,
    );
  }

  // 4. 静默时段
  if (isWithinQuietHours(now, input.quietHours)) {
    return decision(
      input,
      risk,
      targetKey,
      "quiet_hours",
      `静默时段 ${normalizeHour(input.quietHours!.startHour)}:00–${normalizeHour(input.quietHours!.endHour)}:00 内不发动作`,
    );
  }

  // 5. 目标本身敏感
  if (targetSensitive) {
    return decision(input, risk, targetKey, "unsafe_target", "目标视频/用户标题命中安全词表");
  }

  // 6. 正文安全 + 结构限制（只有需要正文的动作才校验）
  if (profile.requiresContent) {
    const limit = contentLimitForAction(draft.action) ?? SOCIAL_COMMENT_MAX_CHARS;
    const validation = validateSocialContent(draft.content, { maxChars: limit });
    if (validation.categories.length > 0) {
      return decision(
        input,
        risk,
        targetKey,
        "unsafe_content",
        `内容命中安全类别：${validation.categories.join(", ")}`,
      );
    }
    if (validation.problems.length > 0) {
      return decision(
        input,
        risk,
        targetKey,
        "content_invalid",
        `内容不合规：${validation.problems.join(", ")}（长度上限 ${limit}）`,
      );
    }
  }

  // 7. 预算：按动作类型 + 总预算
  let budget: SocialBudgetSnapshot | undefined;
  if (profile.category) {
    const used = Math.max(0, Math.floor(Number(usage.byAction[draft.action] ?? 0)));
    const categoryLimit = caps[capKeyForCategory(profile.category)] as number;
    budget = {
      category: profile.category,
      used,
      limit: categoryLimit,
      totalUsed: usage.totalToday,
      totalLimit: caps.totalPerDay,
    };
    if (used >= categoryLimit) {
      return decision(
        input,
        risk,
        targetKey,
        "budget_exceeded",
        `${profile.category} 今日已用 ${used}/${categoryLimit}`,
        { budget },
      );
    }
    if (usage.totalToday >= caps.totalPerDay) {
      return decision(
        input,
        risk,
        targetKey,
        "total_budget_exceeded",
        `今日总动作已用 ${usage.totalToday}/${caps.totalPerDay}`,
        { budget },
      );
    }
  }

  // 8. 重复目标 / 重复评论
  const targetCount = Math.max(0, Math.floor(Number(usage.byTarget[targetKey] ?? 0)));
  if (targetCount >= SOCIAL_MAX_ACTIONS_PER_TARGET_PER_DAY) {
    return decision(
      input,
      risk,
      targetKey,
      "duplicate_target",
      `今天已对该目标动作 ${targetCount} 次（上限 ${SOCIAL_MAX_ACTIONS_PER_TARGET_PER_DAY}）`,
      { budget },
    );
  }
  if (draft.action === "comment" && draft.target.targetType === "video") {
    const commentCount = Math.max(0, Math.floor(Number(usage.commentsByTarget[targetKey] ?? 0)));
    if (commentCount >= SOCIAL_MAX_COMMENTS_PER_VIDEO) {
      return decision(
        input,
        risk,
        targetKey,
        "duplicate_comment",
        `今天已评论过该视频 ${commentCount} 次（上限 ${SOCIAL_MAX_COMMENTS_PER_VIDEO}）`,
        { budget },
      );
    }
  }

  // 9. 公开动作最小间隔
  const minGapMinutes = Number(input.minGapMinutes ?? DEFAULT_SOCIAL_MIN_GAP_MINUTES);
  if (
    profile.public &&
    Number.isFinite(minGapMinutes) &&
    minGapMinutes > 0 &&
    usage.lastPublicActionAt !== null
  ) {
    const gapMs = Math.floor(minGapMinutes) * 60_000;
    const elapsed = now - usage.lastPublicActionAt;
    if (elapsed < gapMs) {
      return decision(
        input,
        risk,
        targetKey,
        "min_gap",
        `距上次公开动作 ${formatMinutes(Math.max(0, elapsed))} 分钟，未满 ${Math.floor(minGapMinutes)} 分钟`,
        { budget },
      );
    }
  }

  // 10. 审批
  const needsApproval = shouldRequireApproval(mode, draft.action, risk);
  if (needsApproval && !input.approved) {
    return decision(
      input,
      risk,
      targetKey,
      "approval_required",
      `${mode} 模式下的 ${risk} 风险动作需要人工审批`,
      { needsApproval: true, budget },
    );
  }

  return decision(input, risk, targetKey, "allowed", "", { allow: true, budget });
}
