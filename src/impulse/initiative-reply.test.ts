import { describe, expect, it } from "vitest";
import { buildInitiativeReplyHint, INITIATIVE_REPLY_MIN_CLOSENESS } from "./initiative-reply.js";

const plan = {
  day: "2026-10-21",
  createdAt: Date.now(),
  items: [
    { kind: "life_event" as const, topic: "下午被老板叫去谈话，有点闷", why: "刚发生", window: { startHour: 20, endHour: 23 }, urgency: 0.6, used: false },
    { kind: "open_thread" as const, topic: "裁员的传闻到底怎么样了", why: "上次没聊完", window: { startHour: 21, endHour: 23 }, urgency: 0.5, used: false },
  ],
};

describe("buildInitiativeReplyHint", () => {
  it("有由头 + 关系够近 + 他没在提问 → 注入一条（顺口带出来）", () => {
    const note = buildInitiativeReplyHint({ plan, userText: "今天下班好早", closeness: 4, messageCount: 10 });
    expect(note).toContain("你今天本来想跟他说的事");
    expect(note).toMatch(/(老板叫去谈话|裁员的传闻)/);
    expect(note).toContain("别硬转话题");
  });

  it("用户在问问题 → 不注入（先把问题答好）", () => {
    expect(buildInitiativeReplyHint({ plan, userText: "你觉得我该换工作吗？", closeness: 4, messageCount: 3 })).toBe("");
    expect(buildInitiativeReplyHint({ plan, userText: "你在干嘛呢", closeness: 4, messageCount: 3 })).toBe("");
  });

  it("关系还生 → 不注入", () => {
    expect(
      buildInitiativeReplyHint({ plan, userText: "今天好累", closeness: INITIATIVE_REPLY_MIN_CLOSENESS - 0.5, messageCount: 2 }),
    ).toBe("");
  });

  it("危机语境 → 不注入", () => {
    expect(buildInitiativeReplyHint({ plan, userText: "我很难受", closeness: 5, messageCount: 2, isCrisis: true })).toBe("");
  });

  it("今天没有由头 → 不注入", () => {
    expect(buildInitiativeReplyHint({ plan: null, userText: "今天好累", closeness: 4, messageCount: 1 })).toBe("");
    expect(
      buildInitiativeReplyHint({ plan: { ...plan, items: [] }, userText: "今天好累", closeness: 4, messageCount: 1 }),
    ).toBe("");
  });

  it("按消息条数轮换由头（不会每轮都说同一件）", () => {
    const a = buildInitiativeReplyHint({ plan, userText: "今天好累", closeness: 4, messageCount: 10 });
    const b = buildInitiativeReplyHint({ plan, userText: "今天好累", closeness: 4, messageCount: 11 });
    expect(a).not.toBe(b);
    expect([a, b].join("")).toMatch(/老板叫去谈话/);
    expect([a, b].join("")).toMatch(/裁员的传闻/);
  });
});
