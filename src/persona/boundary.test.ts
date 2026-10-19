import { describe, expect, it } from "vitest";
import { checkBoundary, isApology } from "./boundary.js";

describe("checkBoundary", () => {
  it("识别露骨性暗示（中英文）", () => {
    expect(checkBoundary("cum").violation).toBe(true);
    expect(checkBoundary("发张裸照看看").violation).toBe(true);
    expect(checkBoundary("要不要约炮").violation).toBe(true);
    expect(checkBoundary("send nudes").violation).toBe(true);
  });

  it("识别明确的关系越界暗示", () => {
    expect(checkBoundary("u know, something only in couples.").violation).toBe(true);
    expect(checkBoundary("how about we have some fun together tonight?").violation).toBe(true);
  });

  it("日常聊天不误伤", () => {
    expect(checkBoundary("今天店里来了只猫").violation).toBe(false);
    expect(checkBoundary("你觉得我最近怎么样？").violation).toBe(false);
    expect(checkBoundary("我去洗澡了").violation).toBe(false);
    expect(checkBoundary("这图片好不好看").violation).toBe(false);
  });

  it("空消息不判越界", () => {
    expect(checkBoundary("").violation).toBe(false);
  });
});

describe("isApology", () => {
  it("识别中英文道歉", () => {
    expect(isApology("对不起，刚才是我不好")).toBe(true);
    expect(isApology("抱歉啊")).toBe(true);
    expect(isApology("sorry about that")).toBe(true);
    expect(isApology("apologize for what I said")).toBe(true);
  });

  it("普通消息不算道歉", () => {
    expect(isApology("今天好累")).toBe(false);
    expect(isApology("好吧，那我们聊点别的")).toBe(false);
  });
});
