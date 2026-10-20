/**
 * 首次引导落库单测：会话 / facts / consent / 标记文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-onboarding-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
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

const input = {
  personaId: "xiaoya",
  herName: "小雅",
  howWeMet: "在小红书刷到的",
  yourName: "林哲",
  location: "杭州",
  allowedUsers: [123456],
  ageConfirmed: true,
  disclosureAcked: true,
};

describe("completeOnboarding", () => {
  it("把第一段对话/事实/同意写进 cli:local 与主 QQ 两个 owner", async () => {
    const onboarding = await import("./onboarding.js");
    const history = await import("../data/history.js");
    const facts = await import("../data/user-facts.js");
    const consent = await import("../data/consent.js");

    const record = await onboarding.completeOnboarding(input);
    expect(record.version).toBe(1);
    expect(record.personaId).toBe("xiaoya");
    expect(record.owners.sort()).toEqual(["cli:local", "qq:123456"]);

    // 标记文件 600 权限（仅 POSIX 可断言）
    const marker = path.join(dir, "onboarding.json");
    expect(fs.existsSync(marker)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    }
    expect(onboarding.readOnboardingRecord()?.owners).toContain("cli:local");
    expect(onboarding.hasCompletedOnboarding("cli:local")).toBe(true);
    expect(onboarding.hasCompletedOnboarding("qq:123456")).toBe(true);
    expect(onboarding.hasCompletedOnboarding("qq:999999")).toBe(false);

    // CLI owner：会话含引导对话 + 事实 + consent
    const cliSession = history.loadSession("小雅", "");
    expect(cliSession.messages.length).toBeGreaterThanOrEqual(7);
    expect(cliSession.messages[0].content).toContain("从哪知道我的");
    expect(cliSession.messages.some((m) => m.content.includes("林哲"))).toBe(true);
    const cliFacts = facts.listUserFacts("cli:local");
    expect(cliFacts.map((f) => f.key).sort()).toEqual(["city", "how_we_met", "name"]);
    expect(consent.getConsent("cli:local")?.ageConfirmedAt).toBeTruthy();
    expect(consent.getConsent("cli:local")?.disclosureAckedAt).toBeTruthy();

    // 主 QQ owner 与 CLI 共用 legacy 会话（同一个人），引导对话不会写两遍
    expect(cliSession.messages.length).toBe(7);
    expect(facts.listUserFacts("qq:123456").map((f) => f.key).sort()).toEqual([
      "city",
      "how_we_met",
      "name",
    ]);
    expect(consent.hasAgeConfirmation("qq:123456")).toBe(true);
  });

  it("未确认 18+ 时抛错且不写标记", async () => {
    const onboarding = await import("./onboarding.js");
    await expect(
      onboarding.completeOnboarding({ ...input, ageConfirmed: false }),
    ).rejects.toThrow("18");
    expect(onboarding.readOnboardingRecord()).toBeNull();
    expect(fs.existsSync(path.join(dir, "onboarding.json"))).toBe(false);
  });

  it("白名单为空时只写 cli:local", async () => {
    const onboarding = await import("./onboarding.js");
    const record = await onboarding.completeOnboarding({ ...input, allowedUsers: [] });
    expect(record.owners).toEqual(["cli:local"]);
  });

  it("标记文件损坏时安全返回 null", async () => {
    const onboarding = await import("./onboarding.js");
    fs.writeFileSync(path.join(dir, "onboarding.json"), "{bad json", "utf-8");
    expect(onboarding.readOnboardingRecord()).toBeNull();
    expect(onboarding.hasCompletedOnboarding("cli:local")).toBe(false);
  });
});
