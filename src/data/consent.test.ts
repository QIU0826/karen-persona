/**
 * 同意记录（年龄确认/披露）存储单测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-consent-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vector = await import("./vector.js");
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

describe("user_consent", () => {
  it("没有记录时返回 null / 未确认", async () => {
    const consent = await import("./consent.js");
    expect(consent.getConsent("qq:123")).toBeNull();
    expect(consent.hasAgeConfirmation("qq:123")).toBe(false);
    expect(consent.getConsent("")).toBeNull();
  });

  it("确认年龄后持久化；重复确认保留最早时间", async () => {
    const consent = await import("./consent.js");
    consent.confirmAge("qq:123", 1000);
    expect(consent.hasAgeConfirmation("qq:123")).toBe(true);
    expect(consent.getConsent("qq:123")?.ageConfirmedAt).toBe(1000);

    consent.confirmAge("qq:123", 9999);
    expect(consent.getConsent("qq:123")?.ageConfirmedAt).toBe(1000);

    // 换模块实例（模拟重启）仍能读到
    vi.resetModules();
    const reloaded = await import("./consent.js");
    expect(reloaded.hasAgeConfirmation("qq:123")).toBe(true);
  });

  it("披露记录不影响年龄确认状态", async () => {
    const consent = await import("./consent.js");
    consent.ackDisclosure("qq:456", 2000);
    const row = consent.getConsent("qq:456");
    expect(row?.disclosureAckedAt).toBe(2000);
    expect(row?.ageConfirmedAt).toBeNull();
    expect(consent.hasAgeConfirmation("qq:456")).toBe(false);
  });

  it("按 owner 隔离；resetConsent 清空", async () => {
    const consent = await import("./consent.js");
    consent.confirmAge("qq:1", 1);
    consent.confirmAge("qq:2", 2);
    expect(consent.hasAgeConfirmation("qq:1")).toBe(true);
    expect(consent.hasAgeConfirmation("qq:2")).toBe(true);

    consent.resetConsent("qq:1");
    expect(consent.hasAgeConfirmation("qq:1")).toBe(false);
    expect(consent.hasAgeConfirmation("qq:2")).toBe(true);
  });
});
