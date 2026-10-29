/**
 * 社会化 runner 单测：只 mock auth/digest/草稿，不联网、不真实写。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../pipeline/orchestrator.js";
import type { BilibiliAuthClient } from "./bilibili-auth.js";
import type { SocialConfig } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-runner-"));
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
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 29, 10, 0, 0).getTime();

function state(): ConversationState {
  return {
    owner: "qq:10001",
    storagePersona: "xiaoya",
    config: { quiet_hours_start: "23:00", quiet_hours_end: "07:00" },
    persona: {
      name: "小雅",
      identity: { lifeStory: { career: "咖啡店店员", currentStatus: "上海" } },
    },
  } as unknown as ConversationState;
}

function config(mode: SocialConfig["mode"]): SocialConfig {
  return {
    mode,
    dryRun: true,
    minGapMinutes: 15,
    approvalTtlMinutes: 10,
    circuitCooldownHours: 24,
    cookieFile: "data/secrets/bilibili-cookie.json",
    caps: {
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
    },
  };
}

function auth(overrides: Partial<BilibiliAuthClient> = {}): BilibiliAuthClient {
  return {
    dryRun: true,
    verifyLogin: vi.fn(async () => ({ ok: true, loggedIn: true, fingerprint: "abcdef123456" })),
    comment: vi.fn(async () => ({ ok: true, platform: "bilibili", action: "comment", externalId: "rpid-1", undoable: true })),
    postDynamic: vi.fn(async () => ({ ok: true, platform: "bilibili", action: "dynamic", externalId: "dyn-1", undoable: true })),
    ...overrides,
  } as unknown as BilibiliAuthClient;
}

const digest = {
  source: "popular" as const,
  fetchedAt: NOW,
  items: [{
    bvid: "BV1TEST",
    aid: 123,
    title: "咖啡店的一天：手冲咖啡记录",
    owner: "某个UP",
    desc: "记录一家咖啡店的日常",
    cover: "",
    url: "https://www.bilibili.com/video/BV1TEST",
    views: 100,
    danmaku: 1,
    likes: 10,
    replies: 2,
    durationSec: 60,
    pubdate: NOW - 3600_000,
    zone: "生活",
  }],
};

const generatedComment = async () => ({ content: "这家咖啡店的光线真好，想去坐坐", reason: "test" });
const generatedDynamic = async () => ({ content: "今天店里人不多，终于把窗边擦干净了", reason: "test" });

describe("runSocialTick", () => {
  it("off 直接不跑", async () => {
    const { runSocialTick } = await import("./runner.js");
    const r = await runSocialTick(state(), { config: config("off"), auth: auth(), digest, now: NOW });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("off");
  });

  it("observe 只落草稿，不执行", async () => {
    const { runSocialTick } = await import("./runner.js");
    const a = auth();
    const r = await runSocialTick(state(), {
      config: config("observe"), auth: a, digest, now: NOW,
      generateComment: generatedComment, generateDynamic: generatedDynamic,
    });
    expect(r.action?.status).toBe("draft");
    expect(a.comment).not.toHaveBeenCalled();
  });

  it("approve 进待审批，不执行", async () => {
    const { runSocialTick } = await import("./runner.js");
    const a = auth();
    const r = await runSocialTick(state(), {
      config: config("approve"), auth: a, digest, now: NOW,
      generateComment: generatedComment, generateDynamic: generatedDynamic,
    });
    expect(r.pending?.status).toBe("draft");
    expect(a.comment).not.toHaveBeenCalled();
  });

  it("auto 低风险评论执行并落 sent", async () => {
    const { runSocialTick } = await import("./runner.js");
    const a = auth();
    const r = await runSocialTick(state(), {
      config: config("auto"), auth: a, digest, now: NOW,
      generateComment: generatedComment, generateDynamic: generatedDynamic,
    });
    expect(r.sent?.status).toBe("sent");
    expect(r.sent?.externalId).toBe("rpid-1");
    expect(a.comment).toHaveBeenCalledOnce();
  });

  it("没有安全草稿时不动作", async () => {
    const { runSocialTick } = await import("./runner.js");
    const r = await runSocialTick(state(), {
      config: config("auto"), auth: auth(), digest, now: NOW,
      generateComment: async () => null,
      generateDynamic: async () => null,
    });
    expect(r.action).toBeUndefined();
    expect(r.reason).toContain("没有可发");
  });
});
