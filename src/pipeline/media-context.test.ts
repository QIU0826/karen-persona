import { describe, expect, it } from "vitest";
import {
  buildMediaContextNote,
  hasMediaMarker,
  hasRecentUserImage,
  isMediaOnly,
  stripMediaMarkers,
} from "./media-context.js";
import type { ConversationSession } from "../data/history.js";

function sessionWith(contents: string[]): ConversationSession {
  return {
    personaId: "小雅",
    startedAt: 1,
    lastActiveAt: 1,
    messages: contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content, timestamp: i })),
    t3: { currentTopic: "", emotionVector: 0, activeThreads: [] },
  };
}

describe("media-context", () => {
  it("图+文：同时要求接文字和归属规则", () => {
    const note = buildMediaContextNote({
      userInput: "[图片] 吃了呀",
      hasImages: true,
    });
    expect(note).toContain("不是你的作品");
    expect(note).toContain("先回应文字");
  });

  it("纯图：有归属规则，不要求接文字", () => {
    const note = buildMediaContextNote({ userInput: "[图片]", hasImages: true });
    expect(note).toContain("不是你的作品");
    expect(note).not.toContain("先回应文字");
  });

  it("纯文本 + 上一轮图片：先接当前文字", () => {
    const note = buildMediaContextNote({
      userInput: "吃了呀",
      hasImages: false,
      previousUserImage: true,
    });
    expect(note).toContain("上一轮");
    expect(note).toContain("先接这句文字");
  });

  it("无媒体无 hint 返回空；sticker hint 会追加", () => {
    expect(buildMediaContextNote({ userInput: "在干嘛", hasImages: false })).toBe("");
    const withHint = buildMediaContextNote({
      userInput: "这个表情什么意思",
      hasImages: false,
      stickerHint: "他刚发来的表情备注：安慰",
    });
    expect(withHint).toContain("他刚发来的表情备注");
  });

  it("标记清洗与最近图片检测", () => {
    expect(stripMediaMarkers("[图片] 吃了呀")).toBe("吃了呀");
    expect(stripMediaMarkers("[表情包：狗] 笑死")).toBe("笑死");
    expect(isMediaOnly("[图片]")).toBe(true);
    expect(isMediaOnly("[图片] 吃了呀")).toBe(false);
    expect(hasMediaMarker("[图片]")).toBe(true);
    expect(hasRecentUserImage(sessionWith(["[图片]", "吃了呀"]), "吃了呀")).toBe(true);
    expect(hasRecentUserImage(sessionWith(["吃了呀"]), "吃了呀")).toBe(false);
  });
});
