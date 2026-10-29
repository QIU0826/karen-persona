import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BilibiliAuthClient } from "./bilibili-auth.js";
import type { SocialConfig, SocialDraft } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-executor-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch { /* ignore */ }
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

const config: SocialConfig = {
  mode: "approve", dryRun: true, minGapMinutes: 15, approvalTtlMinutes: 10,
  circuitCooldownHours: 24, cookieFile: "data/secrets/bilibili-cookie.json",
  caps: { commentsPerDay: 3, repliesPerDay: 2, dynamicsPerDay: 1, likesPerDay: 5, favoritesPerDay: 2, coinsPerDay: 2, followsPerDay: 1, sharesPerDay: 0, dmsPerDay: 0, totalPerDay: 15 },
};

const draft: SocialDraft = {
  platform: "bilibili",
  action: "comment",
  target: { platform: "bilibili", targetType: "video", targetId: "BV1EXEC", title: "测试视频", aid: 123 },
  content: "咖啡店的光线真好",
  reason: "test",
  risk: "low",
};

function auth(over: Partial<BilibiliAuthClient> = {}): BilibiliAuthClient {
  return {
    dryRun: true,
    verifyLogin: vi.fn(async () => ({ ok: true, loggedIn: true, fingerprint: "abcdef123456" })),
    comment: vi.fn(async () => ({ ok: true, platform: "bilibili" as const, action: "comment" as const, externalId: "rpid-9", undoable: true })),
    deleteComment: vi.fn(async () => ({ ok: true, platform: "bilibili" as const, action: "delete_comment" as const })),
    ...over,
  } as unknown as BilibiliAuthClient;
}

describe("social executor", () => {
  it("审批后执行并落 sent；再撤销", async () => {
    const store = await import("./store.js");
    const { approveAndExecuteAction, undoSocialAction } = await import("./executor.js");
    const created = store.createDraft(draft, { owner: "qq:1" });
    const a = auth();
    const out = await approveAndExecuteAction(created.action.id, config, { auth: a });
    expect(out.ok).toBe(true);
    expect(out.action?.status).toBe("sent");
    expect(a.comment).toHaveBeenCalledOnce();

    const undone = await undoSocialAction(created.action.id, config, { auth: a });
    expect(undone.ok).toBe(true);
    expect(undone.action?.status).toBe("undone");
    expect(a.deleteComment).toHaveBeenCalledOnce();
  });

  it("手动发动态走安全校验/审计", async () => {
    const { postDynamicManual } = await import("./executor.js");
    const a = auth({ postDynamic: vi.fn(async () => ({ ok: true, platform: "bilibili" as const, action: "dynamic" as const, externalId: "dyn-1", undoable: true })) });
    const out = await postDynamicManual("今天店里很安静", config, { auth: a, owner: "qq:1" });
    expect(out.ok).toBe(true);
    expect(out.action?.status).toBe("sent");
    expect(out.action?.action).toBe("dynamic");
    expect(a.postDynamic).toHaveBeenCalledWith("今天店里很安静");
  });

  it("风控失败写 failed 并开 circuit", async () => {
    const store = await import("./store.js");
    const { approveAndExecuteAction } = await import("./executor.js");
    const created = store.createDraft(draft, { owner: "qq:1" });
    const a = auth({
      comment: vi.fn(async () => ({ ok: false, platform: "bilibili" as const, action: "comment" as const, errorCode: "risk_control", reason: "412" })),
    });
    const out = await approveAndExecuteAction(created.action.id, config, { auth: a });
    expect(out.ok).toBe(false);
    expect(out.action?.status).toBe("failed");
    const runtime = await import("./runtime.js");
    expect(runtime.isCircuitOpen(runtime.loadSocialRuntime())).toBe(true);
  });
});
