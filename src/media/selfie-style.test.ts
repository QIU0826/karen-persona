import { describe, expect, it } from "vitest";
import { SELFIE_STYLE_PROMPT, SELFIE_STYLE_REF, buildSelfiePrompt } from "./selfie-style.js";

describe("selfie-style", () => {
  it("画风参考图固定为宣传页人物", () => {
    expect(SELFIE_STYLE_REF).toContain("karen-ref-promo/character-2.jpg");
  });

  it("场景 prompt 会拼上统一画风和禁手", () => {
    const prompt = buildSelfiePrompt("春天公园长椅自拍，浅色开衫");
    expect(prompt).toContain("春天公园长椅自拍");
    expect(prompt).toContain("中蓝色");
    expect(prompt).toContain("不出现手和手臂");
    expect(prompt).toContain(SELFIE_STYLE_PROMPT);
  });

  it("去掉场景末尾标点，避免出现两个分号", () => {
    expect(buildSelfiePrompt("海边自拍。")).not.toContain("。；");
  });
});
