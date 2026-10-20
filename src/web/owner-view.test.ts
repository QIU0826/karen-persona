/**
 * 多用户只读视图辅助单测（owner ↔ storageKey/persona 映射 + 已知用户汇总）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-owner-view-"));
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

describe("owner ↔ storage 映射", () => {
  it("normalizeOwnerParam 接受 qq:/cli:，拒绝非法", async () => {
    const mod = await import("./owner-view.js");
    expect(mod.normalizeOwnerParam("qq:2889386774")).toBe("qq:2889386774");
    expect(mod.normalizeOwnerParam("cli:local")).toBe("cli:local");
    expect(mod.normalizeOwnerParam("")).toBeNull();
    expect(mod.normalizeOwnerParam("wechat:abc")).toBeNull();
    expect(mod.normalizeOwnerParam("qq:")).toBeNull();
    expect(mod.normalizeOwnerParam("qq:1".repeat(80))).toBeNull();
  });

  it("legacy 主用户/CLI 用空 storageKey 与裸 persona id", async () => {
    const mod = await import("./owner-view.js");
    expect(mod.storageKeyForOwner("qq:100000001", "qq:100000001")).toBe("");
    expect(mod.storageKeyForOwner("cli:local", "qq:100000001")).toBe("");
    expect(mod.storageKeyForOwner("qq:100000002", "qq:100000001")).toBe("-qq-100000002");
    expect(mod.storagePersonaForOwner("xiaoya", "qq:100000001", "qq:100000001")).toBe("xiaoya");
    expect(mod.storagePersonaForOwner("xiaoya", "qq:100000002", "qq:100000001")).toBe(
      "xiaoya@qq-100000002",
    );
  });

  it("ownerFromStorageKey 可逆；异常回退主用户", async () => {
    const mod = await import("./owner-view.js");
    expect(mod.ownerFromStorageKey("", "qq:1")).toBe("qq:1");
    expect(mod.ownerFromStorageKey("-qq-123456", "qq:1")).toBe("qq:123456");
    expect(mod.ownerFromStorageKey("-cli-local", "qq:1")).toBe("cli:local");
    expect(mod.ownerFromStorageKey("garbage", "qq:1")).toBe("qq:1");
  });
});

describe("listKnownOwners", () => {
  it("汇总会话/事实/同意，主用户排第一", async () => {
    const history = await import("../data/history.js");
    const facts = await import("../data/user-facts.js");
    const consent = await import("../data/consent.js");
    const mod = await import("./owner-view.js");

    // 主用户：legacy 会话
    const legacy = history.loadSession("小雅", "");
    history.addMessage(legacy, "user", "主用户的第一句");
    history.addMessage(legacy, "assistant", "在呢");

    // 第二用户：隔离会话 + 事实 + 年龄确认
    const second = history.loadSession("小雅", "-qq-100000002");
    history.addMessage(second, "user", "第二用户你好");
    facts.upsertUserFacts("qq:100000002", [
      { key: "name", value: "王五", category: "profile" },
      { key: "city", value: "成都", category: "profile" },
    ]);
    consent.confirmAge("qq:100000002");

    const owners = mod.listKnownOwners("xiaoya", "qq:100000001");
    const byOwner = new Map(owners.map((item) => [item.owner, item]));
    expect(owners[0].owner).toBe("qq:100000001");
    expect(owners[0].is_primary).toBe(true);
    expect(owners[0].legacy).toBe(true);
    expect(owners[0].messages).toBe(2);
    expect(owners[0].storage_key).toBe("");

    const secondInfo = byOwner.get("qq:100000002");
    expect(secondInfo).toBeTruthy();
    expect(secondInfo!.legacy).toBe(false);
    expect(secondInfo!.messages).toBe(1);
    expect(secondInfo!.facts).toBe(2);
    expect(secondInfo!.age_confirmed).toBe(true);
    expect(secondInfo!.storage_key).toBe("-qq-100000002");
    expect(secondInfo!.persona_id).toBe("xiaoya@qq-100000002");
    expect(secondInfo!.persona_name).toBe("小雅");

    // 只有同意/事实、没有会话的 owner 也会出现在列表里，但消息数 0
    consent.confirmAge("qq:100000099");
    const refreshed = mod.listKnownOwners("xiaoya", "qq:100000001");
    const ghost = refreshed.find((item) => item.owner === "qq:100000099");
    expect(ghost?.messages).toBe(0);
    expect(ghost?.age_confirmed).toBe(true);
  });
});
