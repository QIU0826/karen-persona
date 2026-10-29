/**
 * 社会化自主 tick（P3）：一次只做一个动作。
 *
 * 流程：配置/模式 → 读流候选 → 生成草稿 → safety/policy → 落库 →
 *       observe 留稿 / approve 待审 / auto 低风险执行。
 *
 * 测试可注入 auth/digest/now，不联网、不真实写入。
 */
import type { ConversationState } from "../pipeline/orchestrator.js";
import {
  getBilibiliDigest,
  rankBilibiliForPersona,
  type BilibiliDigest,
  type BilibiliVideo,
} from "../world/bilibili.js";
import {
  createBilibiliAuthClient,
  type BilibiliAuthClient,
} from "./bilibili-auth.js";
import { effectiveSocialConfig, loadSocialRuntime, openCircuit, saveSocialRuntime, type SocialRuntimeState } from "./runtime.js";
import { loadBilibiliCredentials } from "./credentials.js";
import { generateCommentDraft, generateDynamicDraft, type GeneratedSocialDraft } from "./drafts.js";
import { evaluateSocialAction, type SocialQuietHours, type SocialUsageSnapshot } from "./policy.js";
import { isSocialContentSafe } from "./safety.js";
import {
  approveAction,
  countActionsToday,
  createDraft,
  getAction,
  lastActionAt,
  markFailed,
  markSent,
  setAccountFingerprint,
  wasTargetActiveToday,
} from "./store.js";
import type {
  SocialActionRecord,
  SocialActionType,
  SocialConfig,
  SocialDraft,
  SocialMode,
  SocialTarget,
} from "./types.js";

export interface SocialTickResult {
  ran: boolean;
  mode: SocialMode;
  /** 本次新建/命中的动作；skip 时可能为空 */
  action?: SocialActionRecord;
  /** 等待主人审批（approve 模式或 auto 高风险） */
  pending?: SocialActionRecord;
  /** 已执行成功 */
  sent?: SocialActionRecord;
  reason: string;
  dryRun: boolean;
  logs: string[];
}

export interface SocialTickDeps {
  config?: SocialConfig;
  runtime?: SocialRuntimeState;
  auth?: BilibiliAuthClient;
  digest?: BilibiliDigest | null;
  generateComment?: typeof generateCommentDraft;
  generateDynamic?: typeof generateDynamicDraft;
  now?: number;
  quietHours?: SocialQuietHours | null;
}

function parseHour(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const hour = Number(value.split(":")[0]);
  return Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : fallback;
}

export function quietHoursFromState(state: ConversationState): SocialQuietHours | null {
  const start = parseHour(state.config?.quiet_hours_start, 23);
  const end = parseHour(state.config?.quiet_hours_end, 7);
  return start === end ? null : { startHour: start, endHour: end };
}

function interestKeywords(state: ConversationState): string[] {
  const identity = state.persona.identity;
  const career = identity?.lifeStory?.career;
  const status = identity?.lifeStory?.currentStatus;
  return [...(career ? [career] : []), ...(status ? [status] : []), "猫", "咖啡", "生活", "音乐", "电影"]
    .filter((k): k is string => typeof k === "string" && k.trim().length >= 2)
    .slice(0, 8);
}

function pickCandidate(items: BilibiliVideo[], state: ConversationState, day: string): BilibiliVideo | null {
  const ranked = rankBilibiliForPersona(items, interestKeywords(state), items.length);
  for (const item of ranked) {
    if (wasTargetActiveToday("bilibili", "video", item.bvid, day)) continue;
    if (!isSocialContentSafe(item.title, { maxChars: 120 })) continue;
    return item;
  }
  return null;
}

function dayKey(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA");
}

function usageSnapshot(target: SocialTarget, nowMs: number): SocialUsageSnapshot {
  const day = dayKey(nowMs);
  const byAction: Partial<Record<SocialActionType, number>> = {};
  for (const action of ["comment", "reply", "dynamic", "like", "favorite", "coin", "follow", "share", "dm"] as SocialActionType[]) {
    byAction[action] = countActionsToday("bilibili", action, day);
  }
  return {
    byAction,
    byTarget: { [`${target.platform}|${target.targetType}|${target.targetId}`]: 0 },
    lastPublicActionAt: lastActionAt("bilibili"),
  };
}

function buildCommentTarget(video: BilibiliVideo): SocialTarget {
  return {
    platform: "bilibili",
    targetType: "video",
    targetId: video.bvid,
    title: video.title,
    url: video.url,
    authorUid: undefined,
    aid: video.aid,
  };
}

function asDraft(
  action: SocialActionType,
  target: SocialTarget,
  generated: GeneratedSocialDraft,
  reason: string,
): SocialDraft {
  return {
    platform: "bilibili",
    action,
    target,
    content: generated.content,
    reason: generated.reason || reason,
    risk: "low",
  };
}

async function execute(
  auth: BilibiliAuthClient,
  draft: SocialDraft,
): Promise<{ ok: boolean; externalId?: string; errorCode?: string; reason?: string }> {
  if (draft.action === "comment") return auth.comment(draft.target, draft.content);
  if (draft.action === "dynamic") return auth.postDynamic(draft.content);
  if (draft.action === "like") return auth.like(draft.target);
  if (draft.action === "favorite") return auth.favorite(draft.target, 0);
  return { ok: false, errorCode: "unsupported_action", reason: "runner 未实现该动作" };
}

/**
 * 执行一次社会化 tick。所有外部依赖可注入；异常只返回 reason，不抛。
 */
export async function runSocialTick(state: ConversationState, deps: SocialTickDeps = {}): Promise<SocialTickResult> {
  const nowMs = deps.now ?? Date.now();
  const runtime = deps.runtime ?? loadSocialRuntime();
  const config = deps.config ?? effectiveSocialConfig(process.env, runtime);
  const logs: string[] = [];
  const base = { mode: config.mode, dryRun: config.dryRun, logs } as const;
  if (config.mode === "off") return { ...base, ran: false, reason: "社交总开关 off" };
  if (runtime.circuitOpenUntil && runtime.circuitOpenUntil > nowMs) {
    return { ...base, ran: false, reason: "风控冷却中" };
  }

  // 没有 Cookie 时不做任何自主草稿/动作（即使 dry-run）；手动 /social run 也一样先配置凭据。
  if (!deps.auth) {
    const credentials = loadBilibiliCredentials({ cookieFile: config.cookieFile });
    if (!credentials.ok) {
      return { ...base, ran: false, reason: `B站凭据未配置：${credentials.error.code}` };
    }
  }
  const auth = deps.auth ?? createBilibiliAuthClient({
    dryRun: config.dryRun,
    cookieFile: config.cookieFile,
  });
  if (!config.dryRun) {
    const login = await auth.verifyLogin();
    if (!login.loggedIn) {
      return { ...base, ran: false, reason: `B站未登录：${login.errorCode ?? "unknown"}` };
    }
    if (typeof login.uid === "number") {
      try {
        setAccountFingerprint("bilibili", login.fingerprint, {
          label: login.uname ?? String(login.uid),
          status: "active",
        });
      } catch {
        // 账号摘要失败不影响动作
      }
    }
  }

  const digest = deps.digest !== undefined
    ? deps.digest
    : await getBilibiliDigest();
  const items = digest?.items ?? [];
  const day = dayKey(nowMs);
  const quietHours = deps.quietHours !== undefined ? deps.quietHours : quietHoursFromState(state);

  const commentBudgetLeft =
    countActionsToday("bilibili", "comment", day) < config.caps.commentsPerDay;
  const dynamicBudgetLeft =
    countActionsToday("bilibili", "dynamic", day) < config.caps.dynamicsPerDay;

  let draft: SocialDraft | null = null;
  const candidate = pickCandidate(items, state, day);
  if (commentBudgetLeft && candidate) {
    const generated = await (deps.generateComment ?? generateCommentDraft)(
      state.persona,
      { title: candidate.title, desc: candidate.desc, owner: candidate.owner, keywords: interestKeywords(state) },
      "刷热门时点进来的",
    );
    if (generated) draft = asDraft("comment", buildCommentTarget(candidate), generated, "看到视频后的反应");
    else logs.push("comment_draft_rejected");
  }
  if (!draft && dynamicBudgetLeft) {
    const generated = await (deps.generateDynamic ?? generateDynamicDraft)(state.persona);
    if (generated) {
      draft = asDraft("dynamic", { platform: "bilibili", targetType: "none", targetId: "" }, generated, "今天的生活小事");
    } else logs.push("dynamic_draft_rejected");
  }
  if (!draft) return { ...base, ran: true, reason: "没有可发的安全草稿" };

  // observe：安全草稿照常落库，但不进入预算/审批/执行。
  if (config.mode === "observe") {
    const created = createDraft(draft, {
      owner: state.owner,
      personaId: state.storagePersona,
      nowMs,
    });
    if (created.deduped) {
      return { ...base, ran: true, action: created.action, reason: "同目标已有记录，跳过" };
    }
    return { ...base, ran: true, action: created.action, reason: "observe 模式：只留草稿" };
  }

  const usage = usageSnapshot(draft.target, nowMs);
  const decision = evaluateSocialAction({
    mode: config.mode,
    caps: config.caps,
    draft,
    usage,
    minGapMinutes: config.minGapMinutes,
    quietHours,
    now: nowMs,
    approved: false,
  });
  logs.push(`policy=${decision.reason}: ${decision.detail}`);
  if (decision.reason === "duplicate_target" || decision.reason === "duplicate_comment") {
    return { ...base, ran: true, reason: decision.detail };
  }
  if (!decision.allow && !decision.needsApproval) {
    return { ...base, ran: true, reason: decision.detail };
  }

  // 落库（同目标 24h 去重；重复不再触发审批/执行）
  const created = createDraft(draft, {
    owner: state.owner,
    personaId: state.storagePersona,
    nowMs,
  });
  if (created.deduped) {
    return { ...base, ran: true, action: created.action, reason: "同目标已有记录，跳过" };
  }
  const action = created.action;
  logs.push(`action#${action.id} created`);

  if (decision.needsApproval || config.mode === "approve") {
    saveSocialRuntime({ ...runtime, lastTickAt: nowMs });
    return { ...base, ran: true, action, pending: action, reason: "等待主人审批" };
  }

  // auto/high：低风险且 policy 允许 → 审批（内部状态）→ 执行
  const approved = approveAction(action.id, {
    ttlMs: config.approvalTtlMinutes * 60_000,
    actor: "runner",
    note: "auto mode",
  });
  const result = await execute(auth, draft);
  if (result.ok) {
    const sent = markSent(approved.id, { ...result, platform: "bilibili", action: draft.action });
    saveSocialRuntime({ ...runtime, lastTickAt: nowMs, lastActionAt: nowMs, lastError: undefined });
    return { ...base, ran: true, action: sent, sent, reason: "已发送" };
  }
  const errorCode = result.errorCode ?? "unknown_error";
  try {
    markFailed(approved.id, { ...result, platform: "bilibili", action: draft.action, errorCode });
  } catch {
    // 已过期/状态并发时忽略；errorCode 仍返回
  }
  if (["risk_control", "not_logged_in", "csrf_failed"].includes(errorCode)) {
    openCircuit(config.circuitCooldownHours, errorCode, nowMs);
  }
  return { ...base, ran: true, action: getAction(approved.id) ?? approved, reason: `发送失败：${errorCode}` };
}
