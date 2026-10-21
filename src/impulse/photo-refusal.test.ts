import { describe, expect, it } from "vitest";
import { replyRefusesPhoto } from "./photo-refusal.js";

describe("她说不想发照片时，程序要尊重（v0.9.19）", () => {
  it("明确拒绝/推脱 → true", () => {
    expect(replyRefusesPhoto("不要 我在上班呢")).toBe(true);
    expect(replyRefusesPhoto("我不怎么爱拍照的")).toBe(true);
    expect(replyRefusesPhoto("改天吧")).toBe(true);
    expect(replyRefusesPhoto("现在不方便")).toBe(true);
    expect(replyRefusesPhoto("算了 不发了")).toBe(true);
    expect(replyRefusesPhoto("在忙 没空拍")).toBe(true);
  });

  it("答应要发 → false（即使带「不要」等字）", () => {
    expect(replyRefusesPhoto("不要担心，我拍给你")).toBe(false);
    expect(replyRefusesPhoto("等等我马上拍")).toBe(false);
    expect(replyRefusesPhoto("好 给你看下")).toBe(false);
    expect(replyRefusesPhoto("五花啊 我翻翻相册")).toBe(false);
  });

  it("普通回应不算拒绝", () => {
    expect(replyRefusesPhoto("好滴")).toBe(false);
    expect(replyRefusesPhoto("我看看")).toBe(false);
    expect(replyRefusesPhoto("刚吃完")).toBe(false);
    expect(replyRefusesPhoto("")).toBe(false);
    expect(replyRefusesPhoto(null)).toBe(false);
  });
});
