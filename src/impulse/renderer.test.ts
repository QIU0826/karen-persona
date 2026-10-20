import { describe, expect, it } from "vitest";
import { renderExpression } from "./renderer.js";

const config = {
  emojiStyle: "动物系",
  stickerFrequency: 0,
  isChatty: true,
  stickerMode: "kaomoji" as const,
  tone: { style: "natural", frequency: 0 },
};
const state = {
  impulseIntensity: 0,
  hasInternalStruggle: false,
  emotionVector: 0,
  guilt: 0,
  busyLevel: 0,
};

describe("renderExpression burst 分条", () => {
  it("分条结果不以逗号/顿号结尾（去掉 AI 味碎片）", () => {
    const rendered = renderExpression("今天好累啊，\n不想动了，\n先躺会儿，再说", config, state);
    expect(rendered.mode).toBe("burst");
    for (const part of rendered.burstParts ?? []) {
      expect(part).not.toMatch(/[，,、;；]$/);
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it("单行多逗号也不会发出「，」分隔的碎片", () => {
    const rendered = renderExpression("嗯，今天有点忙，晚点再说，", config, state);
    for (const part of rendered.burstParts ?? []) {
      expect(part).not.toMatch(/[，,、]$/);
    }
  });
});
