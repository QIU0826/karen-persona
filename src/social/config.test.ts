import { describe, expect, it } from "vitest";
import { loadSocialConfig, isAutoMode, isWriteEnabled } from "./config.js";
import { SOCIAL_HARD_CAPS, SOCIAL_DEFAULT_CAPS } from "./types.js";

describe("loadSocialConfig", () => {
  it("默认 approve + dry-run on + 默认预算", () => {
    const c = loadSocialConfig({});
    expect(c.mode).toBe("approve");
    expect(c.dryRun).toBe(true);
    expect(c.caps).toEqual({ ...SOCIAL_DEFAULT_CAPS });
    expect(c.minGapMinutes).toBe(15);
  });

  it("非法 mode 回退 approve；可显式 off/auto", () => {
    expect(loadSocialConfig({ KAREN_SOCIAL: "nonsense" }).mode).toBe("approve");
    expect(loadSocialConfig({ KAREN_SOCIAL: "off" }).mode).toBe("off");
    expect(loadSocialConfig({ KAREN_SOCIAL: "AUTO" }).mode).toBe("auto");
  });

  it("预算只能调低，不能超过硬上限", () => {
    const c = loadSocialConfig({
      KAREN_SOCIAL_COMMENTS_PER_DAY: "999",
      KAREN_SOCIAL_DYNAMICS_PER_DAY: "-3",
      KAREN_SOCIAL_TOTAL_PER_DAY: "100",
    });
    expect(c.caps.commentsPerDay).toBe(SOCIAL_HARD_CAPS.commentsPerDay);
    expect(c.caps.dynamicsPerDay).toBe(0);
    expect(c.caps.totalPerDay).toBe(SOCIAL_HARD_CAPS.totalPerDay);
  });

  it("dry-run 可关；间隔/审批 TTL 有边界", () => {
    const c = loadSocialConfig({
      KAREN_SOCIAL_DRY_RUN: "off",
      KAREN_SOCIAL_MIN_GAP_MIN: "1",
      KAREN_SOCIAL_APPROVAL_TTL_MIN: "999",
    });
    expect(c.dryRun).toBe(false);
    expect(c.minGapMinutes).toBe(5);
    expect(c.approvalTtlMinutes).toBe(60);
  });

  it("mode 语义", () => {
    expect(isWriteEnabled("off")).toBe(false);
    expect(isWriteEnabled("observe")).toBe(false);
    expect(isWriteEnabled("approve")).toBe(true);
    expect(isAutoMode("auto")).toBe(true);
    expect(isAutoMode("high")).toBe(true);
    expect(isAutoMode("approve")).toBe(false);
  });
});
