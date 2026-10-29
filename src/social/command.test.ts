import { describe, expect, it, vi } from "vitest";
import { buildPendingText, buildSocialStatus, handleSocialCommand, type SocialCommandDeps } from "./command.js";
import type { SocialActionRecord, SocialConfig, SocialMode } from "./types.js";

const config: SocialConfig = {
  mode: "approve",
  dryRun: true,
  minGapMinutes: 15,
  approvalTtlMinutes: 10,
  circuitCooldownHours: 24,
  cookieFile: "data/secrets/bilibili-cookie.json",
  caps: {
    commentsPerDay: 3, repliesPerDay: 2, dynamicsPerDay: 1, likesPerDay: 5,
    favoritesPerDay: 2, coinsPerDay: 2, followsPerDay: 1, sharesPerDay: 0, dmsPerDay: 0, totalPerDay: 15,
  },
};

function action(over: Partial<SocialActionRecord> = {}): SocialActionRecord {
  return {
    id: 7,
    platform: "bilibili",
    action: "comment",
    target: { platform: "bilibili", targetType: "video", targetId: "BV1", title: "咖啡店的一天" },
    content: "这家店的光线真好，想去坐坐",
    reason: "test",
    risk: "low",
    status: "draft",
    createdAt: 1_800_000_000_000,
    ...over,
  };
}

function deps(over: Partial<SocialCommandDeps> = {}): SocialCommandDeps {
  let mode: SocialMode = "approve";
  return {
    config,
    runtime: {},
    account: { loggedIn: true, uname: "小号", uid: 42, fingerprint: "abc123" },
    setMode: vi.fn((m: SocialMode) => {
      mode = m;
      return { ...config, mode };
    }),
    approve: vi.fn(async () => ({ ok: true, action: action({ status: "sent" }), result: { ok: true, platform: "bilibili" as const, action: "comment" as const, externalId: "rpid1" }, reason: "已发送" })),
    reject: vi.fn(() => ({ ok: true, reason: "已拒绝" })),
    undo: vi.fn(async () => ({ ok: true, action: action({ status: "undone" }), reason: "已撤销" })),
    postDynamic: vi.fn(async () => ({ ok: true, action: action({ action: "dynamic", status: "sent" }), result: { ok: true, platform: "bilibili" as const, action: "dynamic" as const, externalId: "dyn1" }, reason: "已发送" })),
    pending: vi.fn(() => [action()]),
    runTick: vi.fn(async () => ({
      ran: true, mode: "approve" as const, reason: "等待主人审批", dryRun: true, logs: ["policy=approval_required"],
      pending: action(),
    })),
    now: 1_800_000_000_000,
    ...over,
  };
}

describe("social command", () => {
  it("状态展示模式/账号/预算/待审批", () => {
    const text = buildSocialStatus(deps());
    expect(text).toContain("approve");
    expect(text).toContain("已登录 @小号");
    expect(text).toContain("待审批：1 条");
    expect(text).toContain("评论 3");
  });

  it("pending 列表含 id/动作/内容预览", () => {
    const text = buildPendingText([action()]);
    expect(text).toContain("#7");
    expect(text).toContain("评论");
    expect(text).toContain("咖啡店");
  });

  it("非 /social 返回 null；off/on/mode 走 setMode", async () => {
    const d = deps();
    expect(await handleSocialCommand("你好", d)).toBeNull();
    expect(await handleSocialCommand("/social off", d)).toContain("off");
    expect(d.setMode).toHaveBeenCalledWith("off");
    expect(await handleSocialCommand("/social on", d)).toContain("approve");
    expect(await handleSocialCommand("/social mode auto", d)).toContain("auto");
  });

  it("approve/reject/undo 校验 id 并调用 deps", async () => {
    const d = deps();
    expect(await handleSocialCommand("/social approve 7", d)).toContain("已发送");
    expect(d.approve).toHaveBeenCalledWith(7);
    expect(await handleSocialCommand("/social reject 7", d)).toContain("已拒绝");
    expect(await handleSocialCommand("/social undo 7", d)).toContain("已撤销");
    expect(await handleSocialCommand("/social approve x", d)).toContain("用法");
  });

  it("/social post 发手动动态", async () => {
    const d = deps();
    const text = await handleSocialCommand("/social post 今天店里很安静", d);
    expect(text).toContain("已发送");
    expect(text).toContain("dyn1");
    expect(d.postDynamic).toHaveBeenCalledWith("今天店里很安静");
  });

  it("run 返回 tick 结果", async () => {
    const d = deps();
    const text = await handleSocialCommand("/social run", d);
    expect(text).toContain("手动 tick");
    expect(text).toContain("等待主人审批");
  });
});
