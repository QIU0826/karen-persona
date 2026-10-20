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

describe("burst 条数上限（真人不会一次刷 5 条）", () => {
  it("单轮最多 4 条，多出来的内容合并进最后一条（不丢内容）", () => {
    const text = "一\n二二\n三三三\n四四四四\n五五五五五\n六六六六六六";
    const rendered = renderExpression(text, config, state);
    expect(rendered.mode).toBe("burst");
    const parts = rendered.burstParts ?? [];
    expect(parts.length).toBeLessThanOrEqual(4);
    // 被合并的内容不能丢
    expect(parts.join("")).toContain("六六六六六六");
  });

  it("短句走单条模式，不会被拆成多个气泡", () => {
    const rendered = renderExpression("嗯呐", config, state);
    expect(rendered.mode).toBe("single");
    expect(rendered.burstParts).toBeUndefined();
  });
});
