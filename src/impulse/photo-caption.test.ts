import { describe, expect, it } from "vitest";
import { shouldSendPhotoCaption } from "./photo-caption.js";

const never = () => 0.99;
const always = () => 0;

describe("发图配文是否单独发（v0.9.19）", () => {
  it("没有配文就不发", () => {
    expect(shouldSendPhotoCaption({ replyText: "", caption: "", random: never })).toBe(false);
    expect(shouldSendPhotoCaption({ replyText: "嗯", caption: null, random: never })).toBe(false);
  });

  it("15% 概率干发（只发图）", () => {
    // 随机值 0.1 < 0.15 → 干发
    expect(shouldSendPhotoCaption({ replyText: "嗯", caption: "喏", random: () => 0.1 })).toBe(false);
    expect(shouldSendPhotoCaption({ replyText: "嗯", caption: "喏", random: never })).toBe(true);
  });

  it("文字已经在说照片时，70% 概率不再补配文", () => {
    // 0.2 过了干发线(>0.15)，又 < 0.7 → 跳过配文
    expect(
      shouldSendPhotoCaption({ replyText: "等等我拍给你看", caption: "喏", random: () => 0.2 })
    ).toBe(false);
    // 0.8 > 0.7 → 保留配文
    expect(
      shouldSendPhotoCaption({ replyText: "等等我拍给你看", caption: "喏", random: () => 0.8 })
    ).toBe(true);
  });

  it("文字没提照片 → 保留配文（随机不落入干发区间时）", () => {
    expect(shouldSendPhotoCaption({ replyText: "好啊", caption: "喏", random: never })).toBe(true);
  });

  it("干发判断不依赖文字内容", () => {
    expect(shouldSendPhotoCaption({ replyText: "", caption: "喏", random: always })).toBe(false);
  });
});
