import { describe, expect, it } from "vitest";
import {
  crisisResourcesText,
  crisisSafetyNote,
  detectCrisis,
} from "./crisis.js";

describe("detectCrisis", () => {
  it("识别明确的自伤/自杀表达（high）", () => {
    expect(detectCrisis("我不想活了")).toBe("high");
    expect(detectCrisis("真的想死")).toBe("high");
    expect(detectCrisis("想结束自己的生命")).toBe("high");
    expect(detectCrisis("I want to kill myself")).toBe("high");
    expect(detectCrisis("i think suicide is the only way")).toBe("high");
  });

  it("识别临近危机的表达（medium）", () => {
    expect(detectCrisis("最近总是想自残")).toBe("medium");
    expect(detectCrisis("感觉撑不下去了")).toBe("medium");
    expect(detectCrisis("I can't go on anymore")).toBe("medium");
  });

  it("普通情绪表达不误报", () => {
    expect(detectCrisis("今天好累")).toBeNull();
    expect(detectCrisis("工作累死了")).toBeNull();
    expect(detectCrisis("笑死我了")).toBeNull();
    expect(detectCrisis("这游戏太难了我想弃坑")).toBeNull();
    expect(detectCrisis("")).toBeNull();
  });
});

describe("危机响应文案", () => {
  it("安全指引不含消息正文", () => {
    const note = crisisSafetyNote();
    expect(note).toContain("安全优先");
    expect(note).toContain("不要评判");
  });

  it("求助资源包含热线与紧急电话", () => {
    const text = crisisResourcesText();
    expect(text).toContain("12356");
    expect(text).toContain("010-82951332");
    expect(text).toContain("110 / 120");
  });
});
