import { describe, it, expect } from "vitest";

// 自我觉察检测的正则模式（与 internal-monologue.ts 保持同步）
const SELF_AWARENESS_PATTERNS = [
  /我今天好像|我最近好像|我好像变得|我似乎|我是不是/,
  /我不该|我后悔|我应该|我不应该/,
  /我想要|我希望|我其实想|我一直想/,
  /我有点太|我太过|我太/,
  /我怎么老|我又在|我又/,
];

function detectSelfAwareness(text: string): boolean {
  return SELF_AWARENESS_PATTERNS.some((p) => p.test(text));
}

function detectDriftDirection(text: string): "warmer" | "colder" | null {
  const warmer = /开心|高兴|喜欢|期待|想靠近|在意|温暖|好一点|好起来/.test(text);
  const colder = /冷淡|疏远|不想|累|烦|闷|难过|失望|后悔/.test(text);
  if (warmer && !colder) return "warmer";
  if (colder && !warmer) return "colder";
  return null;
}

// ── 自我觉察检测 ────────────────────────────

describe("自我觉察检测", () => {
  it("'我今天好像有点冷淡' 触发觉察", () => {
    expect(detectSelfAwareness("我今天好像有点冷淡了")).toBe(true);
  });

  it("'我是不是太粘人了' 触发觉察", () => {
    expect(detectSelfAwareness("我是不是太粘人了")).toBe(true);
  });

  it("'我不该说那句话的' 触发觉察", () => {
    expect(detectSelfAwareness("我不该说那句话的")).toBe(true);
  });

  it("'我其实想多聊聊' 触发觉察", () => {
    expect(detectSelfAwareness("我其实想多聊聊的")).toBe(true);
  });

  it("'我有点太冷淡了' 触发觉察", () => {
    expect(detectSelfAwareness("我有点太冷淡了")).toBe(true);
  });

  it("'我又在逃避话题了' 触发觉察", () => {
    expect(detectSelfAwareness("我又在逃避话题了")).toBe(true);
  });

  it("普通日记内容不触发觉察", () => {
    expect(detectSelfAwareness("今天天气不错，心情还行")).toBe(false);
    expect(detectSelfAwareness("他说了句好玩的，我笑了")).toBe(false);
  });
});

// ── 情绪倾向检测 ────────────────────────────

describe("情绪倾向检测", () => {
  it("温暖关键词 → warmer", () => {
    expect(detectDriftDirection("今天和他聊天挺开心的")).toBe("warmer");
  });

  it("冷淡关键词 → colder", () => {
    expect(detectDriftDirection("感觉有点累，不想回消息")).toBe("colder");
  });

  it("冷暖混合 → null", () => {
    expect(detectDriftDirection("虽然有点累但还是很开心")).toBeNull();
  });

  it("无情绪关键词 → null", () => {
    expect(detectDriftDirection("咖啡机又坏了")).toBeNull();
  });
});
