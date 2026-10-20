import { describe, expect, it } from "vitest";
import { assessPhotoRelevance, buildSceneCaption } from "./media-relevance.js";

const base = {
  userText: "今天好累啊",
  lastReply: "我刚到家，瘫着",
  sceneTags: [] as string[],
  photoTags: ["city", "street"],
  requested: false,
};

describe("assessPhotoRelevance", () => {
  it("他点名要照片 → 一定发", () => {
    const r = assessPhotoRelevance({ ...base, userText: "拍张照片看看", requested: true });
    expect(r).toEqual({ share: true, reason: "requested" });
  });

  it("场景命中 → 发（他说晚霞，照片也是晚霞）", () => {
    const r = assessPhotoRelevance({
      ...base,
      userText: "外面晚霞好好看",
      lastReply: "嗯",
      sceneTags: ["sunset"],
      photoTags: ["sunset", "warm"],
    });
    expect(r).toEqual({ share: true, reason: "scene_match" });
  });

  it("她刚分享生活细节 → 顺手发一张是自然的", () => {
    const r = assessPhotoRelevance({
      ...base,
      userText: "你在干嘛",
      lastReply: "刚下班，路上顺便买了点吃的",
      sceneTags: [],
      photoTags: ["street"],
    });
    expect(r).toEqual({ share: true, reason: "life_signal" });
  });

  it("纯问句且回复没有生活信号 → 不发（少而准）", () => {
    const r = assessPhotoRelevance({
      ...base,
      userText: "你觉得人为什么要上班？",
      lastReply: "大概是没得选吧",
      sceneTags: [],
      photoTags: ["mountain"],
    });
    expect(r).toEqual({ share: false, reason: "no_hook" });
  });

  it("抽象话题也不发（没有生活信号）", () => {
    const r = assessPhotoRelevance({
      ...base,
      userText: "聊聊你对AI的看法",
      lastReply: "这问题太大了吧",
      sceneTags: [],
      photoTags: ["city"],
    });
    expect(r.share).toBe(false);
  });

  it("场景不命中但回复有生活信号时仍然发（生活流优先于精确匹配）", () => {
    const r = assessPhotoRelevance({
      ...base,
      userText: "在忙什么",
      lastReply: "在煮东西，还没好",
      sceneTags: ["snow"],
      photoTags: ["food"],
    });
    expect(r.share).toBe(true);
    expect(r.reason).toBe("life_signal");
  });
});

describe("buildSceneCaption", () => {
  it("按场景给贴题配文", () => {
    expect(buildSceneCaption(["sunset"], () => 0)).toBe("天这样了");
    expect(buildSceneCaption(["rain"], () => 0)).toContain("雨");
    expect(buildSceneCaption(["cat"], () => 0)).toContain("它");
  });

  it("没有场景 / 未知场景 → null（调用方回退照片自带配文）", () => {
    expect(buildSceneCaption([], () => 0)).toBeNull();
    expect(buildSceneCaption(["unknown_tag"], () => 0)).toBeNull();
    expect(buildSceneCaption(undefined, () => 0)).toBeNull();
  });

  it("同一场景按随机取不同配文（不总是同一句）", () => {
    const a = buildSceneCaption(["cafe"], () => 0);
    const b = buildSceneCaption(["cafe"], () => 0.99);
    expect(a).not.toBe(b);
  });

  it("多个场景时取第一个认识的", () => {
    expect(buildSceneCaption(["unknown", "rain"], () => 0)).toContain("雨");
  });
});
