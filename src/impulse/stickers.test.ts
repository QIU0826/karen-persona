import { describe, expect, it } from "vitest";
import { getStickerCatalog, pickSticker, toStickerCqCode } from "./stickers.js";
import { isAllowedCqCode } from "../bridge/onebot.js";

describe("pickSticker", () => {
  it("冲突未化解时不发贴纸", () => {
    expect(pickSticker({ emotion: 0.5, hour: 14, conflictActive: true })).toBeNull();
  });

  it("积极情绪挑选 happy/love/cute 类", () => {
    const s = pickSticker({ emotion: 0.6, hour: 14, conflictActive: false, random: () => 0 });
    expect(s).not.toBeNull();
    expect(s!.tags.some((t) => ["happy", "love", "excited", "cute"].includes(t))).toBe(true);
  });

  it("低落情绪挑选安慰类", () => {
    const s = pickSticker({ emotion: -0.5, hour: 14, conflictActive: false, random: () => 0 });
    expect(s).not.toBeNull();
    expect(s!.tags.some((t) => ["comfort", "sad", "tired"].includes(t))).toBe(true);
  });

  it("深夜挑选困倦类", () => {
    const s = pickSticker({ emotion: 0, hour: 2, conflictActive: false, random: () => 0 });
    expect(s).not.toBeNull();
    expect(s!.tags.some((t) => ["sleepy", "tired"].includes(t))).toBe(true);
  });

  it("随机源 0.99 不会越界", () => {
    const s = pickSticker({ emotion: 0, hour: 14, conflictActive: false, random: () => 0.99 });
    expect(s).not.toBeNull();
  });
});

describe("toStickerCqCode", () => {
  it("读取本地贴纸并生成受控 base64 CQ image（可通过白名单）", () => {
    const sticker = getStickerCatalog().find((s) => s.id === "smile-cat")!;
    const cq = toStickerCqCode(sticker);
    expect(cq).toMatch(/^\[CQ:image,file=base64:\/\/[A-Za-z0-9+/=]+\]$/);
    expect(isAllowedCqCode(cq!)).toBe(true);
  });

  it("资源缺失时返回 null，不影响文字回复", () => {
    expect(toStickerCqCode({ id: "missing", file: "not-exists.png", tags: [] })).toBeNull();
  });
});
