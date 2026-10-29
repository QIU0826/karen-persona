/**
 * 审批通过后的执行/撤销：把 store 里的动作映射到 B 站写客户端。
 * 不产生新草稿、不做审批判定；由 runner/命令层调用。
 */
import { createBilibiliAuthClient, type BilibiliAuthClient } from "./bilibili-auth.js";
import { openCircuit } from "./runtime.js";
import { validateSocialContent as validateSocialContentBase, SOCIAL_DYNAMIC_MAX_CHARS } from "./safety.js";
import {
  createDraft,
  approveAction,
  getAction,
  markFailed,
  markSent,
  markUndone,
} from "./store.js";
import type { SocialActionResult, SocialActionRecord, SocialConfig } from "./types.js";

export interface ExecuteSocialOptions {
  auth?: BilibiliAuthClient;
  nowMs?: number;
  /** 手动动作的 owner（审计用） */
  owner?: string;
}

export interface ExecuteSocialOutcome {
  ok: boolean;
  action: SocialActionRecord | null;
  result?: SocialActionResult;
  reason: string;
}

async function dispatch(auth: BilibiliAuthClient, action: SocialActionRecord): Promise<SocialActionResult> {
  switch (action.action) {
    case "comment":
      return auth.comment(action.target, action.content);
    case "reply": {
      const meta = action.meta ?? {};
      const root = typeof meta.root === "string" || typeof meta.root === "number" ? meta.root : undefined;
      if (root === undefined) return { ok: false, platform: "bilibili", action: "reply", errorCode: "invalid_target", reason: "缺少 root 评论 id" };
      return auth.reply(action.target, action.content, root, typeof meta.parent === "string" || typeof meta.parent === "number" ? meta.parent : root);
    }
    case "dynamic":
      return auth.postDynamic(action.content);
    case "like":
      return auth.like(action.target);
    case "unlike":
      return auth.unlike(action.target);
    case "favorite":
    case "unfavorite": {
      const folder = Number(action.meta?.folderId ?? 0);
      if (!Number.isInteger(folder) || folder < 0) return { ok: false, platform: "bilibili", action: action.action, errorCode: "invalid_target", reason: "缺少收藏夹 id" };
      return action.action === "favorite"
        ? auth.favorite(action.target, folder)
        : auth.unfavorite(action.target, folder);
    }
    case "coin":
      return auth.coin(action.target, 1);
    case "follow":
    case "unfollow":
      return action.action === "follow" ? auth.follow(action.target) : auth.unfollow(action.target);
    case "share":
      return auth.share(action.target);
    default:
      return { ok: false, platform: "bilibili", action: action.action, errorCode: "unsupported_action", reason: "未实现的社交动作" };
  }
}

/** 审批并执行一个动作；失败写 failed（失败也计入预算），风控码开冷却。 */
export async function approveAndExecuteAction(
  id: number,
  config: SocialConfig,
  options: ExecuteSocialOptions = {},
): Promise<ExecuteSocialOutcome> {
  const existing = getAction(id);
  if (!existing) return { ok: false, action: null, reason: "动作不存在" };
  if (existing.status === "sent") return { ok: true, action: existing, reason: "已发送" };
  const auth = options.auth ?? createBilibiliAuthClient({ dryRun: config.dryRun, cookieFile: config.cookieFile });
  let approved: SocialActionRecord;
  try {
    approved = approveAction(id, { actor: "owner", ttlMs: config.approvalTtlMinutes * 60_000 });
  } catch (err) {
    return { ok: false, action: existing, reason: err instanceof Error ? err.message : "审批失败" };
  }
  const result = await dispatch(auth, approved);
  const nowMs = options.nowMs ?? Date.now();
  if (result.ok) {
    try {
      const sent = markSent(approved.id, { ...result, platform: "bilibili", action: approved.action }, { nowMs, actor: "owner" });
      return { ok: true, action: sent, result, reason: "已发送" };
    } catch (err) {
      return { ok: false, action: approved, result, reason: err instanceof Error ? err.message : "落库失败" };
    }
  }
  const errorCode = result.errorCode ?? "unknown_error";
  try {
    markFailed(approved.id, { ...result, platform: "bilibili", action: approved.action, errorCode }, { nowMs, actor: "owner" });
  } catch {
    // 过期/并发时忽略；返回原始错误
  }
  if (["risk_control", "not_logged_in", "csrf_failed"].includes(errorCode)) {
    openCircuit(config.circuitCooldownHours, errorCode, nowMs);
  }
  return { ok: false, action: getAction(approved.id), result, reason: `发送失败：${errorCode}` };
}

/** 撤销已发送的评论/动态（平台不支持时返回失败，不改状态）。 */
export async function undoSocialAction(
  id: number,
  config: SocialConfig,
  options: ExecuteSocialOptions = {},
): Promise<ExecuteSocialOutcome> {
  const action = getAction(id);
  if (!action) return { ok: false, action: null, reason: "动作不存在" };
  if (action.status !== "sent") return { ok: false, action, reason: `当前状态 ${action.status} 不可撤销` };
  if (!action.externalId) return { ok: false, action, reason: "缺少外部 id，无法撤销" };
  const auth = options.auth ?? createBilibiliAuthClient({ dryRun: config.dryRun, cookieFile: config.cookieFile });
  let result: SocialActionResult;
  if (action.action === "comment") {
    result = await auth.deleteComment(action.target, action.externalId);
  } else if (action.action === "dynamic") {
    result = await auth.deleteDynamic(action.externalId);
  } else {
    return { ok: false, action, reason: "该动作平台不支持撤销" };
  }
  if (!result.ok) return { ok: false, action, result, reason: `撤销失败：${result.errorCode ?? "unknown"}` };
  const undone = markUndone(action.id, { actor: "owner", note: "undo" });
  return { ok: true, action: undone, result, reason: "已撤销" };
}

function validateSocialContentForDynamic(content: string) {
  return validateSocialContentBase(content, {
    maxChars: SOCIAL_DYNAMIC_MAX_CHARS,
    maxLinks: 0,
    maxHashtags: 0,
    maxMentions: 0,
  });
}

/** 手动发一条动态（主人显式命令）：仍走安全校验与审计；不占自动审批队列。 */
export async function postDynamicManual(
  content: string,
  config: SocialConfig,
  options: ExecuteSocialOptions = {},
): Promise<ExecuteSocialOutcome> {
  if (config.mode === "off") return { ok: false, action: null, reason: "社交总开关 off" };
  const validation = validateSocialContentForDynamic(content);
  if (!validation.ok) return { ok: false, action: null, reason: `内容不合规：${[...validation.problems, ...validation.categories].join(", ")}` };
  const created = createDraft(
    {
      platform: "bilibili",
      action: "dynamic",
      target: { platform: "bilibili", targetType: "none", targetId: "" },
      content: validation.sanitized,
      reason: "owner manual /social post",
      risk: "medium",
    },
    { owner: options.owner ?? "owner", skipDedupe: true },
  );
  return approveAndExecuteAction(created.action.id, config, options);
}
