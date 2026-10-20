import { describe, expect, it } from "vitest";
import {
  ASK_COOLDOWN_TURNS,
  GET_TO_KNOW_MAX_CLOSENESS,
  buildGetToKnowNote,
  pickGetToKnowAsk,
  type PickAskInput,
} from "./get-to-know.js";

function input(patch: Partial<PickAskInput> = {}): PickAskInput {
  return {
    knownFactKeys: [],
    askedTopics: [],
    closeness: 2,
    turnIndex: 10,
    lastAskedTurn: null,
    ...patch,
  };
}

describe("pickGetToKnowAsk", () => {
  it("还不熟又什么都不知道时，会挑一个主题问", () => {
    const result = pickGetToKnowAsk(input());
    expect(result).not.toBeNull();
    expect(["job", "city", "pet", "name", "plan"]).toContain(result!.topic);
    expect(result!.hint.length).toBeGreaterThan(0);
  });

  it("优先问工作/城市（更自然、信息量大）", () => {
    expect(pickGetToKnowAsk(input())!.topic).toBe("job");
  });

  it("已经知道的事不再问", () => {
    const result = pickGetToKnowAsk(input({ knownFactKeys: ["job", "city"] }));
    expect(result!.topic).not.toBe("job");
    expect(result!.topic).not.toBe("city");
  });

  it("问过的主题不再问（持久化在 getting_to_know）", () => {
    const result = pickGetToKnowAsk(input({ askedTopics: ["job", "city", "pet", "name"] }));
    expect(result!.topic).toBe("plan");
  });

  it("全问过了就不再问", () => {
    expect(
      pickGetToKnowAsk(input({ askedTopics: ["job", "city", "pet", "name", "plan"] })),
    ).toBeNull();
  });

  it("亲密度够了就不再像查户口", () => {
    expect(pickGetToKnowAsk(input({ closeness: GET_TO_KNOW_MAX_CLOSENESS }))).toBeNull();
  });

  it("两次提问之间至少隔几轮", () => {
    expect(
      pickGetToKnowAsk(input({ turnIndex: 11, lastAskedTurn: 10 })),
    ).toBeNull();
    expect(
      pickGetToKnowAsk(input({ turnIndex: 10 + ASK_COOLDOWN_TURNS, lastAskedTurn: 10 })),
    ).not.toBeNull();
  });

  it("事实 key 大小写不敏感", () => {
    const result = pickGetToKnowAsk(input({ knownFactKeys: ["JOB", "City"] }));
    expect(result!.topic).not.toBe("job");
    expect(result!.topic).not.toBe("city");
  });
});

describe("buildGetToKnowNote", () => {
  it("提示是「可以」而不是硬指令，并只问一件", () => {
    const note = buildGetToKnowNote({ topic: "job", hint: "他平时做什么工作" });
    expect(note).toContain("可以顺口问一句");
    expect(note).toContain("他平时做什么工作");
    expect(note).toContain("一次只问一件");
  });
});
