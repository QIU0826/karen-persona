import { describe, expect, it } from "vitest";
import { collectedStickerProbability, getStickerCatalog, pickSticker, toStickerCqCode } from "./stickers.js";
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

  it("recentIds 排除最近用过的贴纸（跨轮去重）", () => {
    const base = { emotion: 0.5, hour: 14, conflictActive: false, random: () => 0 };
    const first = pickSticker(base);
    expect(first).not.toBeNull();
    const again = pickSticker({ ...base, recentIds: [first!.id] });
    expect(again).not.toBeNull();
    expect(again!.id).not.toBe(first!.id);
  });
});

describe("collectedStickerProbability（v0.8.19 真实桥接 E2E 驱动）", () => {
  const base = { requested: false, inboundSticker: false, normalProbability: 0.22, replyProbability: 0.55 };

  it("点名要表情包 → 必定从收集库发（概率 1）", () => {
    expect(collectedStickerProbability({ ...base, requested: true })).toBe(1);
    // 即使同时是"收到表情"，点名也优先
    expect(collectedStickerProbability({ ...base, requested: true, inboundSticker: true })).toBe(1);
  });

  it("收到对方表情 → 用更高的回应概率", () => {
    expect(collectedStickerProbability({ ...base, inboundSticker: true })).toBe(0.55);
  });

  it("平时顺手发 → 用普通概率", () => {
    expect(collectedStickerProbability(base)).toBe(0.22);
  });
});
