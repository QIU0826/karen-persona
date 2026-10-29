/**
 * Social P2 policy 单测。
 *
 * 全部纯函数测试：时间/计数/审批状态显式注入，不联网、不读配置、不依赖进程时区
 * （静默时段用 `new Date(y,m,d,h)` 的本地时间或 `isWithinQuietHours` 的 hour 覆盖）。
 */
import { describe, expect, it } from "vitest";
import {
  SOCIAL_DEFAULT_CAPS,
  SOCIAL_HARD_CAPS,
  type SocialActionType,
  type SocialCaps,
  type SocialDraft,
  type SocialMode,
  type SocialRisk,
  type SocialTarget,
} from "./types.js";
import {
  SOCIAL_MAX_ACTIONS_PER_TARGET_PER_DAY,
  SOCIAL_MAX_COMMENTS_PER_VIDEO,
  classifyActionRisk,
  effectiveCaps,
  evaluateSocialAction,
  getSocialActionProfile,
  isGovernanceAction,
  isPublicSocialAction,
  isWithinQuietHours,
  maxSocialRisk,
  shouldRequireApproval,
  socialTargetKey,
  type EvaluateSocialActionInput,
  type SocialUsageSnapshot,
} from "./policy.js";

const CAPS: SocialCaps = { ...SOCIAL_DEFAULT_CAPS };
const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime(); // 本地时间 2026-01-05 12:00

function makeTarget(overrides: Partial<SocialTarget> = {}): SocialTarget {
  return {
    platform: "bilibili",
    targetType: "video",
    targetId: "BV1xx411c7mD",
    title: "周末去公园散步的 vlog",
    ...overrides,
  };
}

function makeDraft(
  action: SocialActionType,
  overrides: Partial<SocialDraft> = {},
): SocialDraft {
  return {
    platform: "bilibili",
    action,
    target: makeTarget(),
    content: action === "comment" ? "公园的树影拍得真好看" : "",
    reason: "测试",
    risk: "low",
    ...overrides,
  };
}

function makeUsage(overrides: Partial<SocialUsageSnapshot> = {}): SocialUsageSnapshot {
  return { byAction: {}, ...overrides };
}

function run(
  action: SocialActionType,
  opts: {
    mode?: SocialMode;
    draft?: Partial<SocialDraft>;
    caps?: SocialCaps;
    usage?: Partial<SocialUsageSnapshot>;
    quietHours?: { startHour: number; endHour: number } | null;
    minGapMinutes?: number;
    now?: number;
    approved?: boolean;
  } = {},
) {
  const input: EvaluateSocialActionInput = {
    mode: opts.mode ?? "auto",
    caps: opts.caps ?? CAPS,
    draft: { ...makeDraft(action), ...opts.draft },
    usage: makeUsage(opts.usage),
    quietHours: opts.quietHours ?? null,
    minGapMinutes: opts.minGapMinutes ?? 15,
    now: opts.now ?? NOW,
    approved: opts.approved,
  };
  return evaluateSocialAction(input);
}

// ── mode / 治理动作 ────────────────────────────────

describe("evaluateSocialAction：mode 与治理动作", () => {
  it("off：一律拒绝（reason=mode_off）", () => {
    const d = run("like", { mode: "off" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("mode_off");
    expect(d.needsApproval).toBe(false);
  });

  it("observe：只看不写（reason=observe_only）", () => {
    const d = run("comment", { mode: "observe" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("observe_only");
  });

  it("approve 模式下的撤回动作直接放行，不占预算、不受静默限制", () => {
    const d = run("delete_comment", {
      mode: "approve",
      quietHours: { startHour: 0, endHour: 23 },
      usage: { byAction: {}, totalToday: 99 },
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("governance_allowed");
    expect(d.needsApproval).toBe(false);
  });

  it("治理动作判定与公开动作判定", () => {
    expect(isGovernanceAction("delete_dynamic")).toBe(true);
    expect(isGovernanceAction("unfollow")).toBe(true);
    expect(isGovernanceAction("like")).toBe(false);
    expect(isPublicSocialAction("like")).toBe(true);
    expect(isPublicSocialAction("dm")).toBe(false);
    expect(isPublicSocialAction("delete_comment")).toBe(false);
  });
});

// ── 审批 ───────────────────────────────────────────

describe("shouldRequireApproval / 审批流程", () => {
  it("approve：写动作都要审批；off/observe/high 不需要", () => {
    expect(shouldRequireApproval("approve", "like", "low")).toBe(true);
    expect(shouldRequireApproval("approve", "comment", "medium")).toBe(true);
    expect(shouldRequireApproval("off", "like", "low")).toBe(false);
    expect(shouldRequireApproval("observe", "like", "low")).toBe(false);
    expect(shouldRequireApproval("high", "dynamic", "high")).toBe(false);
  });

  it("auto：低/中风险免审，高风险要审批；治理动作总是免审", () => {
    expect(shouldRequireApproval("auto", "like", "low")).toBe(false);
    expect(shouldRequireApproval("auto", "comment", "medium")).toBe(false);
    expect(shouldRequireApproval("auto", "dynamic", "high")).toBe(true);
    expect(shouldRequireApproval("auto", "share", "high")).toBe(true);
    expect(shouldRequireApproval("approve", "delete_comment", "low")).toBe(false);
  });

  it("approve 模式首次评估返回 approval_required + needsApproval", () => {
    const d = run("like", { mode: "approve" });
    expect(d.allow).toBe(false);
    expect(d.needsApproval).toBe(true);
    expect(d.reason).toBe("approval_required");
    expect(d.budget?.category).toBe("likes");
  });

  it("人工审批通过后（approved=true）同一请求放行", () => {
    const d = run("like", { mode: "approve", approved: true });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("allowed");
  });

  it("auto 模式高风险动作用于动态：要审批；approved 后放行", () => {
    const draft = { content: "今天在公园捡到一片很好看的叶子，夹在书里了", risk: "low" as SocialRisk };
    const pending = run("dynamic", { mode: "auto", draft });
    expect(pending.reason).toBe("approval_required");
    expect(pending.needsApproval).toBe(true);
    const ok = run("dynamic", { mode: "auto", draft, approved: true });
    expect(ok.allow).toBe(true);
  });

  it("high 模式下高风险动作也自动放行（内容安全仍单独一票否决）", () => {
    const d = run("share", {
      mode: "high",
      caps: { ...CAPS, sharesPerDay: 1 },
      draft: { target: makeTarget(), content: "" },
    });
    expect(d.allow).toBe(true);
  });

  it("审批前先过内容安全：不安全内容不会进入审批", () => {
    const d = run("comment", {
      mode: "approve",
      draft: { content: "这个视频讲的是地震救援，太惨了" },
    });
    expect(d.reason).toBe("unsafe_content");
    expect(d.needsApproval).toBe(false);
  });
});

// ── 预算 ───────────────────────────────────────────

describe("evaluateSocialAction：预算", () => {
  it("动作分类预算用尽 → budget_exceeded", () => {
    const d = run("comment", {
      usage: { byAction: { comment: CAPS.commentsPerDay } },
    });
    expect(d.reason).toBe("budget_exceeded");
    expect(d.budget).toMatchObject({ category: "comments", used: CAPS.commentsPerDay, limit: CAPS.commentsPerDay });
  });

  it("总预算用尽 → total_budget_exceeded", () => {
    const d = run("like", { usage: { totalToday: CAPS.totalPerDay } });
    expect(d.reason).toBe("total_budget_exceeded");
    expect(d.budget?.totalLimit).toBe(CAPS.totalPerDay);
  });

  it("预算按动作类型分别统计（点赞多不影响评论预算）", () => {
    const d = run("comment", { usage: { byAction: { like: CAPS.likesPerDay } } });
    expect(d.allow).toBe(true);
    expect(d.budget?.category).toBe("comments");
  });

  it("caps 超过代码级硬上限时，policy 内再夹一次", () => {
    const huge: SocialCaps = { ...SOCIAL_DEFAULT_CAPS, commentsPerDay: 999, totalPerDay: 999 };
    const d = run("comment", {
      caps: huge,
      usage: { byAction: { comment: SOCIAL_HARD_CAPS.commentsPerDay } },
    });
    expect(d.reason).toBe("budget_exceeded");
    expect(d.budget?.limit).toBe(SOCIAL_HARD_CAPS.commentsPerDay);
    expect(effectiveCaps(huge).commentsPerDay).toBe(SOCIAL_HARD_CAPS.commentsPerDay);
  });

  it("effectiveCaps：负数/NaN → 0，正常值原样", () => {
    const caps = effectiveCaps({
      ...SOCIAL_DEFAULT_CAPS,
      likesPerDay: -3,
      coinsPerDay: Number.NaN,
      commentsPerDay: 2,
    });
    expect(caps.likesPerDay).toBe(0);
    expect(caps.coinsPerDay).toBe(0);
    expect(caps.commentsPerDay).toBe(2);
  });
});

// ── 重复目标 / 评论 ────────────────────────────────

describe("evaluateSocialAction：重复目标", () => {
  it("同目标每天最多 2 次", () => {
    const targetKey = socialTargetKey(makeTarget());
    const d = run("like", { usage: { byTarget: { [targetKey]: SOCIAL_MAX_ACTIONS_PER_TARGET_PER_DAY } } });
    expect(d.reason).toBe("duplicate_target");
  });

  it("同一视频每天只能评论 1 次", () => {
    const targetKey = socialTargetKey(makeTarget());
    const d = run("comment", { usage: { commentsByTarget: { [targetKey]: SOCIAL_MAX_COMMENTS_PER_VIDEO } } });
    expect(d.reason).toBe("duplicate_comment");
  });

  it("对用户目标评论一次后仍可点赞（评论上限只限视频评论）", () => {
    const target = makeTarget({ targetType: "user", targetId: "12345", title: "" });
    const targetKey = socialTargetKey(target);
    const draft = makeDraft("comment", { target, content: "你拍的 vlog 很好看" });
    const d = run("like", { draft: { target }, usage: { commentsByTarget: { [targetKey]: 1 } } });
    expect(d.allow).toBe(true);
  });

  it("socialTargetKey：优先 targetId，缺省回退 aid", () => {
    expect(socialTargetKey(makeTarget())).toBe("bilibili:video:BV1xx411c7mD");
    expect(socialTargetKey({ platform: "bilibili", targetType: "video", targetId: "", aid: 42 })).toBe(
      "bilibili:video:42",
    );
  });
});

// ── 静默 / 间隔 / 风控 ─────────────────────────────

describe("evaluateSocialAction：静默、最小间隔与风控冷却", () => {
  it("静默时段内拒绝公开动作", () => {
    const d = run("like", {
      quietHours: { startHour: 23, endHour: 7 },
      now: new Date(2026, 0, 5, 23, 30, 0).getTime(),
    });
    expect(d.reason).toBe("quiet_hours");
  });

  it("跨午夜静默：凌晨 2 点仍在静默（hour 覆盖，不依赖时区）", () => {
    expect(isWithinQuietHours(NOW, { startHour: 23, endHour: 7 }, { hour: 2 })).toBe(true);
    expect(isWithinQuietHours(NOW, { startHour: 23, endHour: 7 }, { hour: 12 })).toBe(false);
    expect(isWithinQuietHours(NOW, { startHour: 9, endHour: 18 }, { hour: 17 })).toBe(true);
    expect(isWithinQuietHours(NOW, { startHour: 9, endHour: 18 }, { hour: 18 })).toBe(false);
  });

  it("start==end 视为关闭静默；null 不静默", () => {
    expect(isWithinQuietHours(NOW, { startHour: 8, endHour: 8 }, { hour: 8 })).toBe(false);
    expect(isWithinQuietHours(NOW, null)).toBe(false);
  });

  it("公开动作未满最小间隔 → min_gap", () => {
    const d = run("like", { usage: { lastPublicActionAt: NOW - 5 * 60_000 } });
    expect(d.reason).toBe("min_gap");
    expect(d.detail).toContain("15");
  });

  it("满最小间隔后放行", () => {
    const d = run("like", { usage: { lastPublicActionAt: NOW - 16 * 60_000 } });
    expect(d.allow).toBe(true);
  });

  it("私信不算公开动作，不受最小间隔限制", () => {
    const d = run("dm", {
      caps: { ...CAPS, dmsPerDay: 2 },
      draft: { content: "刚刚看到你发的视频，拍得真好" },
      usage: { lastPublicActionAt: NOW - 60_000 },
    });
    expect(d.allow).toBe(true);
  });

  it("风控冷却未结束 → circuit_open；结束后恢复", () => {
    const open = run("like", { usage: { circuitOpenUntil: NOW + 10 * 60_000 } });
    expect(open.reason).toBe("circuit_open");
    const closed = run("like", { usage: { circuitOpenUntil: NOW - 1 } });
    expect(closed.allow).toBe(true);
  });
});

// ── 内容校验 ───────────────────────────────────────

describe("evaluateSocialAction：正文安全与格式", () => {
  it("空评论 → content_invalid", () => {
    const d = run("comment", { draft: { content: "   " } });
    expect(d.reason).toBe("content_invalid");
    expect(d.detail).toContain("empty");
  });

  it("私信空正文 → content_invalid", () => {
    const d = run("dm", { draft: { content: "" } });
    expect(d.reason).toBe("content_invalid");
  });

  it("超长评论 → content_invalid(too_long)", () => {
    const d = run("comment", { draft: { content: "好".repeat(300) } });
    expect(d.reason).toBe("content_invalid");
    expect(d.detail).toContain("too_long");
  });

  it("评论带外链 → content_invalid(too_many_links)", () => {
    const d = run("comment", { draft: { content: "看这个 https://example.com/x 很搞笑" } });
    expect(d.reason).toBe("content_invalid");
    expect(d.detail).toContain("too_many_links");
  });

  it("敏感标题的目标直接不参与", () => {
    const d = run("like", {
      draft: { target: makeTarget({ title: "某地发生地震，救援现场" }) },
    });
    expect(d.reason).toBe("unsafe_target");
  });

  it("草稿声明高风险在 auto 下触发审批", () => {
    const d = run("like", { draft: { risk: "high" } });
    expect(d.risk).toBe("high");
    expect(d.reason).toBe("approval_required");
  });

  it("允许的决策带预算快照", () => {
    const d = run("like", { usage: { byAction: { like: 2 }, totalToday: 3 } });
    expect(d.allow).toBe(true);
    expect(d.budget).toMatchObject({ category: "likes", used: 2, limit: CAPS.likesPerDay, totalUsed: 3 });
  });
});

// ── 风险分级 ───────────────────────────────────────

describe("classifyActionRisk", () => {
  it("基础风险按动作类型", () => {
    expect(classifyActionRisk("like")).toBe("low");
    expect(classifyActionRisk("favorite")).toBe("low");
    expect(classifyActionRisk("comment")).toBe("medium");
    expect(classifyActionRisk("dm")).toBe("medium");
    expect(classifyActionRisk("dynamic")).toBe("high");
    expect(classifyActionRisk("share")).toBe("high");
    expect(classifyActionRisk("delete_comment")).toBe("low");
  });

  it("目标敏感 / 敏感正文 → high", () => {
    expect(classifyActionRisk({ action: "like", targetSensitive: true })).toBe("high");
    expect(classifyActionRisk({ action: "like", content: "这个视频在讲台海冲突" })).toBe("high");
  });

  it("带外链 → high；长文本 → 至少 medium", () => {
    expect(classifyActionRisk({ action: "like", content: "详见 https://example.com" })).toBe("high");
    expect(classifyActionRisk({ action: "like", content: "好".repeat(120) })).toBe("medium");
  });

  it("与草稿声明风险取 max", () => {
    expect(classifyActionRisk({ action: "like", declaredRisk: "high" })).toBe("high");
    expect(classifyActionRisk({ action: "dynamic", declaredRisk: "low" })).toBe("high");
    expect(maxSocialRisk("medium", "high")).toBe("high");
    expect(maxSocialRisk("high", "low")).toBe("high");
  });

  it("动作画像与内容上限一致", () => {
    expect(getSocialActionProfile("dynamic").baseRisk).toBe("high");
    expect(getSocialActionProfile("unlike").category).toBeNull();
    expect(getSocialActionProfile("comment").requiresContent).toBe(true);
    expect(getSocialActionProfile("like").requiresContent).toBe(false);
  });
});
