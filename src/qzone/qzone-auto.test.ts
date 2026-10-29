import { describe, expect, it } from "vitest";
import { localDateKey, parseQzoneDraftResponse, pickQzoneFriendlyTopic, pickQzoneTopicFromBilibili, sanitizeQzoneDraft, shouldAttemptAutoPost } from "./qzone-auto.js";

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

describe("Qzone 配图选择", () => {
  const candidates = [{ path: "/tmp/a.jpg", id: "a", tags: ["cafe"], label: "a" }];
  it("模型选择照片时带上 path", () => {
    expect(parseQzoneDraftResponse('{"content":"今天咖啡馆人好多","photo":0}', candidates)).toEqual({
      content: "今天咖啡馆人好多",
      photoPath: "/tmp/a.jpg",
    });
  });

  it("photo=null 或越界时不配图", () => {
    expect(parseQzoneDraftResponse('{"content":"今天有点累","photo":null}', candidates)).toEqual({ content: "今天有点累" });
    expect(parseQzoneDraftResponse('{"content":"今天有点累","photo":3}', candidates)).toEqual({ content: "今天有点累" });
  });

  it("非 JSON 回退为纯文字", () => {
    expect(parseQzoneDraftResponse("今天风很大", candidates)).toEqual({ content: "今天风很大" });
  });
});

describe("Qzone 从 B 站取题", () => {
  it("优先生活/娱乐题，跳过芯片/财经", () => {
    const topic = pickQzoneTopicFromBilibili([
      { title: "旗舰手机芯片大横评" },
      { title: "2026年超搞笑的猫狗日常合集" },
      { title: "A股大跌" },
    ]);
    expect(topic?.title).toContain("猫狗");
  });

  it("没有友好题时返回 undefined", () => {
    expect(pickQzoneTopicFromBilibili([{ title: "国际局势分析" }])).toBeUndefined();
  });
});

describe("Qzone 热点选择", () => {
  it("优先生活/娱乐话题，不硬蹭芯片财经", () => {
    expect(pickQzoneFriendlyTopic([{ title: "芯片人才百万年薪" }, { title: "今日霜降" }])?.title).toBe("今日霜降");
    expect(pickQzoneFriendlyTopic([{ title: "芯片人才百万年薪" }])).toBeUndefined();
  });
});
