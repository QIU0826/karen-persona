/**
 * 高权限社会化 P2：SQLite 审计/审批/预算存储单测。
 *
 * 覆盖：建表幂等、draft→approve→sent→undone、非法迁移、审批 TTL/过期、
 * 同目标去重、预算计数（actions 与派生表一致）、目标统计、账号 fingerprint
 * 防 Cookie、审计链、重复调用幂等、listPending/listRecent 过滤。
 *
 * 每个用例用独立临时 KAREN_DATA_DIR + 动态 import，避免共享 memory.sqlite。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialActionType, SocialDraft, SocialTarget } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-store-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// 固定本地时间（预算按本地自然日；用 Date 构造保证 dayKey 与断言一致）
const T0 = new Date(2026, 9, 29, 10, 0, 0).getTime();
const DAY0 = "2026-10-29";

function baseTarget(targetId: string, overrides: Partial<SocialTarget> = {}): SocialTarget {
  return {
    platform: "bilibili",
    targetType: "video",
    targetId,
    title: "测试视频：海边黄昏的蓝发少女",
    url: `https://www.bilibili.com/video/${targetId}`,
    aid: 12345,
    ...overrides,
  };
}

function baseDraft(overrides: Partial<SocialDraft> = {}): SocialDraft {
  const target = overrides.target ?? baseTarget("BV1TEST0001");
  return {
    platform: "bilibili",
    action: "comment",
    target,
    content: "画得真好，蓝发和黄昏的光太配了",
    reason: "视频内容与她的兴趣相符（审计用，不公开）",
    risk: "low",
    ...overrides,
    target,
  };
}

function draftFor(action: SocialActionType, targetId: string, overrides: Partial<SocialDraft> = {}): SocialDraft {
  return baseDraft({
    action,
    target: baseTarget(targetId),
    content: action === "like" ? "" : `测试 ${action} 内容`,
    ...overrides,
  });
}

function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no_code";
  }
  return "no_throw";
}

type StoreModule = typeof import("./store.js");

function sendNow(
  store: StoreModule,
  draft: SocialDraft,
  nowMs: number,
  opts: { ttlMs?: number } = {},
): ReturnType<StoreModule["markSent"]> {
  const { action } = store.createDraft(draft, { nowMs });
  store.approveAction(action.id, { nowMs, ttlMs: opts.ttlMs ?? 60_000 });
  return store.markSent(
    action.id,
    {
      ok: true,
      platform: draft.platform,
      action: draft.action,
      externalId: `ext-${action.id}`,
      undoable: true,
    },
    { nowMs: nowMs + 1 },
  );
}

describe("social store schema", () => {
  it("ensureSocialSchema 幂等建表，且重开 DB 后仍可用", async () => {
    const store = await import("./store.js");
    const vector = await import("../data/vector.js");

    store.ensureSocialSchema();
    store.ensureSocialSchema();
    const names = (vector.getVectorDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<
      { name: string }
    >).map((row) => String(row.name));
    for (const table of [
      "social_actions",
      "social_budgets",
      "social_targets",
      "social_accounts",
      "social_audit",
      "social_meta",
    ]) {
      expect(names).toContain(table);
    }

    // 模拟进程重开：close 后新实例应重新建表（缓存按 DB 实例 + 路径）
    vector.closeVectorDb();
    store.resetSocialStoreCache();
    const { action } = store.createDraft(baseDraft(), { nowMs: T0 });
    expect(action.id).toBeGreaterThan(0);
    expect(store.getAction(action.id)?.status).toBe("draft");
  });

  it("createDraft 持久化完整字段 + meta；getAction 不存在返回 null", async () => {
    const store = await import("./store.js");
    const { action, deduped } = store.createDraft(
      baseDraft({
        target: baseTarget("BV1TEST0002", { title: "标题", authorUid: "uid-42", aid: 9988 }),
        content: "评论正文",
        reason: "审计原因",
        risk: "medium",
        meta: { model: "deepseek-flash", scene: "seaside", draftNo: 3 },
      }),
      { owner: "qq:10001", personaId: "karen", nowMs: T0 },
    );

    expect(deduped).toBe(false);
    expect(action.status).toBe("draft");
    expect(action.platform).toBe("bilibili");
    expect(action.action).toBe("comment");
    expect(action.target).toMatchObject({
      platform: "bilibili",
      targetType: "video",
      targetId: "BV1TEST0002",
      title: "标题",
      authorUid: "uid-42",
      aid: 9988,
    });
    expect(action.content).toBe("评论正文");
    expect(action.reason).toBe("审计原因");
    expect(action.risk).toBe("medium");
    expect(action.meta).toEqual({ model: "deepseek-flash", scene: "seaside", draftNo: 3 });
    expect(action.createdAt).toBe(T0);
    expect(store.getAction(action.id)).toEqual(action);
    expect(store.getAction(999_999)).toBeNull();
    expect(store.getAction(0)).toBeNull();
  });
});

describe("social store 状态机", () => {
  it("draft → approve → sent → undone 完整链路 + 审计链", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(baseDraft({ target: baseTarget("BV1LIFECYCLE") }), { nowMs: T0 });

    const approved = store.approveAction(action.id, { nowMs: T0 + 1_000, ttlMs: 60_000, actor: "owner" });
    expect(approved.status).toBe("approved");

    const sent = store.markSent(
      action.id,
      { ok: true, platform: "bilibili", action: "comment", externalId: "rpid-777", undoable: true },
      { nowMs: T0 + 5_000 },
    );
    expect(sent.status).toBe("sent");
    expect(sent.externalId).toBe("rpid-777");
    expect(sent.executedAt).toBe(T0 + 5_000);

    const undone = store.markUndone(action.id, { nowMs: T0 + 60_000, actor: "owner" });
    expect(undone.status).toBe("undone");
    expect(undone.undoneAt).toBe(T0 + 60_000);

    const audit = store.listAudit(action.id).map((entry) => `${entry.fromStatus ?? "null"}->${entry.toStatus}`);
    expect(audit).toContain("null->draft");
    expect(audit).toContain("draft->approved");
    expect(audit).toContain("approved->sent");
    expect(audit).toContain("sent->undone");
  });

  it("非法迁移被拒绝且状态不变", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(baseDraft({ target: baseTarget("BV1ILLEGAL") }), { nowMs: T0 });

    expect(catchCode(() => store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }))).toBe(
      "invalid_transition",
    );
    expect(store.getAction(action.id)?.status).toBe("draft");

    store.approveAction(action.id, { nowMs: T0 + 1 });
    expect(catchCode(() => store.approveAction(action.id))).toBe("no_throw"); // 重复审批幂等
    store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }, { nowMs: T0 + 2 });
    expect(catchCode(() => store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }))).toBe(
      "no_throw", // 重复 markSent 幂等
    );
    expect(catchCode(() => store.rejectAction(action.id))).toBe("invalid_transition");
    expect(catchCode(() => store.markUndone(action.id))).toBe("no_throw"); // sent → undone 合法
    expect(catchCode(() => store.markUndone(action.id))).toBe("no_throw"); // 重复撤销幂等
    expect(catchCode(() => store.approveAction(action.id))).toBe("invalid_transition");
  });

  it("reject 幂等；已拒绝不能再 approve", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(baseDraft({ target: baseTarget("BV1REJECT") }), { nowMs: T0 });

    const rejected = store.rejectAction(action.id, { nowMs: T0 + 10, actor: "owner", note: "内容不合适" });
    expect(rejected.status).toBe("rejected");
    expect(store.rejectAction(action.id).status).toBe("rejected"); // 幂等
    expect(catchCode(() => store.approveAction(action.id))).toBe("invalid_transition");
    const audit = store.listAudit(action.id).filter((entry) => entry.toStatus === "rejected");
    expect(audit).toHaveLength(1);
  });

  it("canTransition / isTerminalStatus 与迁移表一致", async () => {
    const store = await import("./store.js");
    expect(store.canTransition("draft", "approved")).toBe(true);
    expect(store.canTransition("approved", "sent")).toBe(true);
    expect(store.canTransition("sent", "undone")).toBe(true);
    expect(store.canTransition("sent", "approved")).toBe(false);
    expect(store.canTransition("undone", "sent")).toBe(false);
    expect(store.canTransition("failed", "sent")).toBe(false);
    expect(store.isTerminalStatus("sent")).toBe(false);
    expect(store.isTerminalStatus("undone")).toBe(true);
    expect(store.isTerminalStatus("expired")).toBe(true);
  });
});

describe("social store 审批 TTL / 过期", () => {
  it("超过审批 TTL 后 markSent 标 expired 并抛错", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(baseDraft({ target: baseTarget("BV1TTL") }), { nowMs: T0 });
    store.approveAction(action.id, { nowMs: T0, ttlMs: 1_000 });

    expect(catchCode(() => store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }, { nowMs: T0 + 2_000 }))).toBe(
      "expired",
    );
    expect(store.getAction(action.id)?.status).toBe("expired");
    // 已过期再执行仍是 expired
    expect(catchCode(() => store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }))).toBe(
      "expired",
    );
  });

  it("expireDueActions 批量过期且幂等", async () => {
    const store = await import("./store.js");
    const a = store.createDraft(baseDraft({ target: baseTarget("BV1DUE1") }), { nowMs: T0 }).action;
    const b = store.createDraft(baseDraft({ target: baseTarget("BV1DUE2") }), { nowMs: T0 }).action;
    store.approveAction(a.id, { nowMs: T0, ttlMs: 1_000 });
    store.approveAction(b.id, { nowMs: T0, ttlMs: 1_000 });

    expect(store.expireDueActions(T0 + 5_000)).toBe(2);
    expect(store.getAction(a.id)?.status).toBe("expired");
    expect(store.getAction(b.id)?.status).toBe("expired");
    expect(store.expireDueActions(T0 + 6_000)).toBe(0);
  });

  it("手动 expire / reject 只作用于待审批状态", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(baseDraft({ target: baseTarget("BV1EXPIRE") }), { nowMs: T0 });
    const expired = store.expireAction(action.id, { nowMs: T0 + 1, note: "owner skipped" });
    expect(expired.status).toBe("expired");
    expect(store.expireAction(action.id).status).toBe("expired"); // 幂等
    expect(catchCode(() => store.rejectAction(action.id))).toBe("invalid_transition");
  });
});

describe("social store 预算 / 目标统计", () => {
  it("countActionsToday / countTotalToday 按平台/动作/自然日统计，失败也计入", async () => {
    const store = await import("./store.js");
    sendNow(store, draftFor("comment", "BV1BUDGET1"), T0);
    sendNow(store, draftFor("comment", "BV1BUDGET2"), T0 + 1_000);
    sendNow(store, draftFor("like", "BV1BUDGET3"), T0 + 2_000);

    // 一个失败动作：approve 后 markFailed
    const failed = store.createDraft(draftFor("comment", "BV1BUDGET4"), { nowMs: T0 + 3_000 }).action;
    store.approveAction(failed.id, { nowMs: T0 + 3_000 });
    store.markFailed(failed.id, { ok: false, errorCode: "-412", reason: "风控" }, { nowMs: T0 + 4_000 });

    expect(store.countActionsToday("bilibili", "comment", DAY0)).toBe(3);
    expect(store.countActionsToday("bilibili", "like", DAY0)).toBe(1);
    expect(store.countTotalToday("bilibili", DAY0)).toBe(4);
    expect(store.countActionsToday("qzone", "comment", DAY0)).toBe(0);
    expect(store.countActionsToday("bilibili", "comment", "2026-10-28")).toBe(0);

    // 派生预算表与 actions 聚合一致
    expect(store.getBudgetUsage("bilibili", "comment", DAY0)).toBe(3);
    expect(store.getBudgetUsage("bilibili", "like", DAY0)).toBe(1);
    expect(store.getBudgetUsage("qzone", "comment", DAY0)).toBe(0);
  });

  it("lastActionAt / wasTargetActiveToday / countTargetActionsToday", async () => {
    const store = await import("./store.js");
    const sent = sendNow(store, draftFor("comment", "BV1TARGET1"), T0);
    sendNow(store, draftFor("like", "BV1TARGET1"), T0 + 1_000);
    // 待审批草稿不算 active
    store.createDraft(draftFor("comment", "BV1TARGET2"), { nowMs: T0 + 2_000 });

    expect(store.countTargetActionsToday("bilibili", "video", "BV1TARGET1", DAY0)).toBe(2);
    expect(store.countTargetActionsToday("bilibili", "video", "BV1TARGET2", DAY0)).toBe(0);
    expect(store.wasTargetActiveToday("bilibili", "video", "BV1TARGET1", DAY0)).toBe(true);
    expect(store.wasTargetActiveToday("bilibili", "video", "BV1TARGET2", DAY0)).toBe(false);
    expect(store.lastActionAt("bilibili", "comment")).toBe(sent.executedAt);
    expect(store.lastActionAt("bilibili", "like")).toBe(T0 + 1_001);
    expect(store.lastActionAt("qzone")).toBeNull();

    const stats = store.getTargetStats("bilibili", "video", "BV1TARGET1");
    expect(stats?.actionCount).toBe(2);
    expect(stats?.lastActionAt).toBe(T0 + 1_001);
    expect(stats?.title).toContain("测试视频");
  });
});

describe("social store 同目标去重", () => {
  it("同平台/同动作/同目标在窗口内返回已有记录（deduped），不同动作/目标不合并", async () => {
    const store = await import("./store.js");
    const first = store.createDraft(draftFor("comment", "BV1DEDUPE1"), { nowMs: T0 });
    const second = store.createDraft(draftFor("comment", "BV1DEDUPE1"), { nowMs: T0 + 1_000 });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.action.id).toBe(first.action.id);

    const otherAction = store.createDraft(draftFor("like", "BV1DEDUPE1"), { nowMs: T0 + 2_000 });
    expect(otherAction.deduped).toBe(false);
    const otherTarget = store.createDraft(draftFor("comment", "BV1DEDUPE2"), { nowMs: T0 + 3_000 });
    expect(otherTarget.deduped).toBe(false);
  });

  it("执行过的动作在去重窗口内同样去重；超出窗口后可再次创建", async () => {
    const store = await import("./store.js");
    const windowMs = 5_000;
    const { action } = store.createDraft(draftFor("comment", "BV1DEDUPE3"), {
      nowMs: T0,
      dedupeWindowMs: windowMs,
    });
    store.approveAction(action.id, { nowMs: T0 });
    store.markSent(action.id, { ok: true, platform: "bilibili", action: "comment" }, { nowMs: T0 });

    const within = store.createDraft(draftFor("comment", "BV1DEDUPE3"), {
      nowMs: T0 + 1_000,
      dedupeWindowMs: windowMs,
    });
    expect(within.deduped).toBe(true);
    expect(within.action.id).toBe(action.id);

    const outside = store.createDraft(draftFor("comment", "BV1DEDUPE3"), {
      nowMs: T0 + windowMs + 1,
      dedupeWindowMs: windowMs,
    });
    expect(outside.deduped).toBe(false);
    expect(outside.action.id).not.toBe(action.id);
  });
});

describe("social store 幂等 / 审计", () => {
  it("重复 markSent 不重复计预算、不重复写审计", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(draftFor("comment", "BV1IDEMPOTENT"), { nowMs: T0 });
    store.approveAction(action.id, { nowMs: T0 });
    const first = store.markSent(
      action.id,
      { ok: true, platform: "bilibili", action: "comment", externalId: "rpid-1" },
      { nowMs: T0 + 1 },
    );
    const second = store.markSent(
      action.id,
      { ok: true, platform: "bilibili", action: "comment", externalId: "rpid-2" },
      { nowMs: T0 + 2 },
    );

    expect(second.externalId).toBe("rpid-1"); // 保持首次外部 id
    expect(store.countActionsToday("bilibili", "comment", DAY0)).toBe(1);
    expect(store.getBudgetUsage("bilibili", "comment", DAY0)).toBe(1);
    const sentAudit = store.listAudit(action.id).filter((entry) => entry.toStatus === "sent");
    expect(sentAudit).toHaveLength(1);
    expect(first.executedAt).toBe(T0 + 1);
  });

  it("markFailed 记录错误码并计入预算/审计", async () => {
    const store = await import("./store.js");
    const { action } = store.createDraft(draftFor("reply", "BV1FAILED"), { nowMs: T0 });
    store.approveAction(action.id, { nowMs: T0 });
    const failed = store.markFailed(
      action.id,
      { ok: false, errorCode: "-412", reason: "请求被风控拦截" },
      { nowMs: T0 + 1_000 },
    );
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("-412");
    expect(failed.executedAt).toBe(T0 + 1_000);
    expect(store.countActionsToday("bilibili", "reply", DAY0)).toBe(1);
    const audit = store.listAudit(action.id).find((entry) => entry.toStatus === "failed");
    expect(audit?.note).toContain("风控");
  });
});

describe("social store 队列查询", () => {
  it("listPending 自动过期 TTL 并按平台/动作/owner 过滤", async () => {
    const store = await import("./store.js");
    const expiring = store.createDraft(draftFor("comment", "BV1PENDING1"), { nowMs: T0 }).action;
    store.approveAction(expiring.id, { nowMs: T0, ttlMs: 1_000 });
    const pending = store.createDraft(draftFor("like", "BV1PENDING2"), {
      nowMs: T0,
      owner: "qq:20002",
    }).action;
    const qzone = store.createDraft(
      baseDraft({
        platform: "qzone",
        action: "dynamic",
        target: baseTarget("", { platform: "qzone", targetType: "none", targetId: "" }),
        content: "今天海边的黄昏很好看",
      }),
      { nowMs: T0 },
    ).action;

    const all = store.listPending({ nowMs: T0 + 5_000 });
    expect(all.map((row) => row.id)).not.toContain(expiring.id);
    expect(all.map((row) => row.id)).toContain(pending.id);
    expect(all.map((row) => row.id)).toContain(qzone.id);

    expect(store.listPending({ platform: "qzone", nowMs: T0 + 5_000 })).toHaveLength(1);
    expect(store.listPending({ owner: "qq:20002", nowMs: T0 + 5_000 })).toHaveLength(1);
    expect(store.listPending({ limit: 1, nowMs: T0 + 5_000 })).toHaveLength(1);
  });

  it("listRecent 按创建时间倒序、支持状态/动作过滤与 limit", async () => {
    const store = await import("./store.js");
    const a = store.createDraft(draftFor("comment", "BV1RECENT1"), { nowMs: T0 }).action;
    const b = store.createDraft(draftFor("like", "BV1RECENT2"), { nowMs: T0 + 1_000 }).action;
    store.rejectAction(b.id, { nowMs: T0 + 2_000 });

    const recent = store.listRecent();
    expect(recent[0].id).toBe(b.id);
    expect(recent[1].id).toBe(a.id);
    expect(store.listRecent({ status: "rejected" })).toHaveLength(1);
    expect(store.listRecent({ action: "comment" })).toHaveLength(1);
    expect(store.listRecent({ limit: 1 })).toHaveLength(1);
    expect(store.listRecent({ platform: "qzone" })).toHaveLength(0);
  });
});

describe("social store 账号 fingerprint（不存 Cookie）", () => {
  it("只存 fingerprint；更新保留 created_at；拒绝 Cookie/Token 形态", async () => {
    const store = await import("./store.js");
    const fingerprint = "a".repeat(64); // 模拟 sha256
    const created = store.setAccountFingerprint("bilibili", fingerprint, {
      label: "小号A",
      nowMs: T0,
    });
    expect(created.fingerprint).toBe(fingerprint);
    expect(created.createdAt).toBe(T0);
    expect(store.getAccount("bilibili")?.fingerprint).toBe(fingerprint);
    expect(store.getAccount("qzone")).toBeNull();

    const updated = store.setAccountFingerprint("bilibili", "b".repeat(64), {
      label: "小号A-换绑",
      nowMs: T0 + 1_000,
    });
    expect(updated.createdAt).toBe(T0);
    expect(updated.updatedAt).toBe(T0 + 1_000);
    expect(updated.label).toBe("小号A-换绑");

    // Cookie 头 / 会话串不是 fingerprint，必须拒绝
    expect(catchCode(() => store.setAccountFingerprint("bilibili", "SESSDATA=abc; bili_jct=def; DedeUserID=1"))).toBe(
      "invalid_fingerprint",
    );
    expect(catchCode(() => store.setAccountFingerprint("bilibili", "bili_jct=abc123"))).toBe("invalid_fingerprint");
    expect(catchCode(() => store.setAccountFingerprint("bilibili", "short"))).toBe("invalid_fingerprint");

    store.clearAccount("bilibili");
    expect(store.getAccount("bilibili")).toBeNull();
  });

  it("meta 中出现 Cookie/Token 敏感键时拒绝写库", async () => {
    const store = await import("./store.js");
    expect(catchCode(() => store.createDraft(baseDraft({ meta: { SESSDATA: "abc" } }), { nowMs: T0 }))).toBe(
      "invalid_input",
    );
    expect(catchCode(() => store.createDraft(baseDraft({ meta: { authToken: "x" } }), { nowMs: T0 }))).toBe(
      "invalid_input",
    );
    // 合法 meta 可写入
    const ok = store.createDraft(baseDraft({ target: baseTarget("BV1METAOK"), meta: { model: "flash" } }), {
      nowMs: T0,
    });
    expect(ok.action.meta).toEqual({ model: "flash" });
  });
});
