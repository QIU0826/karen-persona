import { describe, expect, it } from "vitest";
import { hasSelfDisclosure } from "./qq-realrun.js";

describe("hasSelfDisclosure（真机 58 轮数据驱动）", () => {
  it("用户只是寒暄/吐槽 → 没自述（不该报「未抽取到事实」）", () => {
    const turns = [
      { user: "带伞干嘛？" },
      { user: "你在干嘛" },
      { user: "哈喽？怎么不鸟我呢" },
      { user: "可以撒" },
      { user: "喔" },
    ];
    expect(hasSelfDisclosure(turns)).toBe(false);
  });

  it("用户自述了事实（名字/工作/宠物）→ 应该报", () => {
    expect(hasSelfDisclosure([{ user: "我叫林哲" }])).toBe(true);
    expect(hasSelfDisclosure([{ user: "我在杭州做产品设计" }])).toBe(true);
    expect(hasSelfDisclosure([{ user: "我养了只橘猫叫团子" }])).toBe(true);
  });

  it("用户提到计划/家人也算（可以进事实层）", () => {
    expect(hasSelfDisclosure([{ user: "我下周要去杭州出差" }])).toBe(true);
    expect(hasSelfDisclosure([{ user: "我女朋友在南京" }])).toBe(true);
  });

  it("空对话 → false", () => {
    expect(hasSelfDisclosure([])).toBe(false);
  });
});
