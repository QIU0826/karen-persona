import { describe, expect, it } from "vitest";
import { localDateKey, sanitizeQzoneDraft, shouldAttemptAutoPost } from "./qzone-auto.js";

describe("qzone-auto", () => {
  it("每天最多一次、只在 10–22 点尝试", () => {
    const noon = new Date(2026, 9, 23, 12, 0, 0);
    expect(shouldAttemptAutoPost({ now: noon, lastDate: null, random: () => 0, enabled: true })).toBe(true);
    expect(shouldAttemptAutoPost({ now: noon, lastDate: localDateKey(noon), random: () => 0, enabled: true })).toBe(false);
    expect(shouldAttemptAutoPost({ now: new Date(2026, 9, 23, 8), lastDate: null, random: () => 0, enabled: true })).toBe(false);
    expect(shouldAttemptAutoPost({ now: noon, lastDate: null, random: () => 0.99, enabled: true })).toBe(false);
    expect(shouldAttemptAutoPost({ now: noon, lastDate: null, random: () => 0, enabled: false })).toBe(false);
  });

  it("清理动态正文里的标记并限长", () => {
    expect(sanitizeQzoneDraft("  今天  [CQ:face,id=1] 有点累  ")).toBe("今天 有点累");
    expect(Array.from(sanitizeQzoneDraft("字".repeat(200))).length).toBe(120);
  });
});
