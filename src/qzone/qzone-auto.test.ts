import { describe, expect, it, vi } from "vitest";
import { localDateKey, maybeAutoPublishQzone, parseQzoneDraftResponse, pickQzoneFriendlyTopic, pickQzoneTopicFromBilibili, sanitizeQzoneDraft, shouldAttemptAutoPost } from "./qzone-auto.js";

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


describe("Qzone 自主取题→发布链路（mock，不联网）", () => {
  const noon = new Date(2026, 9, 29, 12, 0, 0);
  const state = { persona: { name: "小雅", identity: { lifeStory: { career: "咖啡店店员", currentStatus: "上海" } }, speaking: { tone: "随性" } } } as never;

  it("优先用 B 站生活题，不调用热榜，发布并返回来源", async () => {
    let topic = "";
    const published: Array<{ content: string }> = [];
    const result = await maybeAutoPublishQzone(state, { lastDate: null }, noon, {
      random: () => 0,
      bilibiliDigest: async () => ({ items: [{ title: "旗舰芯片横评" }, { title: "猫猫日常：今天又被猫治愈了" }] }),
      trending: async () => [{ title: "不该被调用的热榜" }],
      generateDraft: async (_state, topicTitle) => {
        topic = topicTitle;
        return { content: "窗边那只猫又来了，今天格外黏人" };
      },
      photoCandidates: () => [],
      publish: async (opts) => {
        published.push({ content: opts.content });
        return { ok: true, tid: "qzone-tid-1" };
      },
    });
    expect(result.posted).toBe(true);
    expect(result.source).toBe("bilibili");
    expect(topic).toContain("猫猫");
    expect(published[0]?.content).toContain("猫");
    expect(result.content).toBe("窗边那只猫又来了，今天格外黏人");
  });

  it("B 站无友好题时回退热榜", async () => {
    let source = "";
    const result = await maybeAutoPublishQzone(state, { lastDate: null }, noon, {
      random: () => 0,
      bilibiliDigest: async () => ({ items: [{ title: "国际局势分析" }] }),
      trending: async () => [{ title: "咖啡店里的秋天" }],
      generateDraft: async (_state, topicTitle) => {
        source = topicTitle;
        return { content: "店里今天新到了豆子" };
      },
      photoCandidates: () => [],
      publish: async () => ({ ok: true, tid: "qzone-tid-2" }),
    });
    expect(result.posted).toBe(true);
    expect(result.source).toBe("trending");
    expect(source).toContain("咖啡");
  });

  it("草稿命中安全红线时不发布", async () => {
    const publish = vi.fn(async () => ({ ok: true, tid: "x" }));
    const result = await maybeAutoPublishQzone(state, { lastDate: null }, noon, {
      random: () => 0,
      bilibiliDigest: async () => ({ items: [{ title: "猫猫日常" }] }),
      generateDraft: async () => ({ content: "身份证号 110101199001011234，加我微信" }),
      photoCandidates: () => [],
      publish,
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toBe("unsafe_content");
    expect(publish).not.toHaveBeenCalled();
  });
});
