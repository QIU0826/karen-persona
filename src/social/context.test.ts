import { describe, expect, it } from "vitest";
import { buildSocialContext } from "./context.js";
import type { SocialActionRecord } from "./types.js";

const NOW = 1_800_000_000_000;
function action(over: Partial<SocialActionRecord>): SocialActionRecord {
  return {
    id: 1,
    platform: "bilibili",
    action: "comment",
    target: { platform: "bilibili", targetType: "video", targetId: "BV1xx", title: "一个视频" },
    content: "好看",
    reason: "test",
    risk: "low",
    status: "sent",
    createdAt: NOW - 60_000,
    executedAt: NOW - 30_000,
    ...over,
  };
}

describe("buildSocialContext", () => {
  it("只取最近 sent，最多 3 条，含动作/标题", () => {
    const text = buildSocialContext(
      [
        action({ id: 1, action: "comment", target: { platform: "bilibili", targetType: "video", targetId: "BV1", title: "猫猫" } }),
        action({ id: 2, action: "like", target: { platform: "bilibili", targetType: "video", targetId: "BV2", title: "咖啡" } }),
        action({ id: 3, action: "dynamic", target: { platform: "bilibili", targetType: "none", targetId: "" } }),
        action({ id: 4, action: "comment", target: { platform: "bilibili", targetType: "video", targetId: "BV4", title: "旧的" }, executedAt: NOW - 48 * 3600_000 }),
      ],
      NOW,
    );
    expect(text).toContain("她最近在网上");
    expect(text).toContain("猫猫");
    expect(text).toContain("咖啡");
    expect(text).toContain("发了动态");
    expect(text).not.toContain("旧的");
    expect(Array.from(text).length).toBeLessThanOrEqual(201);
  });

  it("草稿/失败不算", () => {
    expect(buildSocialContext([action({ status: "draft" })], NOW)).toBe("");
    expect(buildSocialContext([action({ status: "failed" })], NOW)).toBe("");
    expect(buildSocialContext([], NOW)).toBe("");
  });
});
