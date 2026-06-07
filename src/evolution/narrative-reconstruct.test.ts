import { describe, it, expect } from "vitest";
import {
  createNarrativeArc,
  advanceNarrativeArc,
  shouldInjectNarrative,
  markNarrativeExpressed,
} from "./narrative-reconstruct.js";

// ── 测试装置 ───────────────────────────────────

function makeDrift(gap: number) {
  return {
    actualBaseline: 0.2,
    perceivedBaseline: 0.2 - gap,
    pressure: 0,
    lastAwareness: Date.now() - 14 * 24 * 3600 * 1000,
    history: [],
  };
}

// ── createNarrativeArc ────────────────────────

describe("createNarrativeArc", () => {
  it("初始化为 none 阶段", () => {
    const arc = createNarrativeArc();
    expect(arc.stage).toBe("none");
    expect(arc.expressed).toBe(false);
    expect(arc.direction).toBeNull();
  });
});

// ── advanceNarrativeArc ───────────────────────

describe("advanceNarrativeArc", () => {
  it("gap 不足不推进", () => {
    const arc = createNarrativeArc();
    const { arc: result } = advanceNarrativeArc({
      arc, drift: makeDrift(0.05), recentMemories: [], attachmentStyle: "安全型",
    });
    expect(result.stage).toBe("none");
  });

  it("gap > 0.1 且超过 7 天 → noticing", () => {
    const arc = createNarrativeArc();
    const { arc: result, logs } = advanceNarrativeArc({
      arc, drift: makeDrift(0.12), recentMemories: [], attachmentStyle: "回避型",
    });
    expect(result.stage).toBe("noticing");
    expect(result.currentNarrative).toBeTruthy();
    expect(logs.some(l => l.includes("觉察"))).toBe(true);
  });

  it("没有日记反应时用默认措辞", () => {
    const arc = createNarrativeArc();
    const { arc: result } = advanceNarrativeArc({
      arc, drift: makeDrift(0.12), recentMemories: [], attachmentStyle: "安全型",
    });
    expect(result.currentNarrative).toContain("说不上来");
  });

  it("有日记反应时自然融入叙事", () => {
    const arc = createNarrativeArc();
    const { arc: result } = advanceNarrativeArc({
      arc, drift: makeDrift(0.12), recentMemories: [], attachmentStyle: "安全型",
      diaryReaction: "翻了一下，发现自己这周老在写累",
    });
    expect(result.currentNarrative).toContain("翻了一下");
    expect(result.currentNarrative).toContain("写累");
  });

  it("日记反应为空字符串时回退到默认", () => {
    const arc = createNarrativeArc();
    const { arc: result } = advanceNarrativeArc({
      arc, drift: makeDrift(0.12), recentMemories: [], attachmentStyle: "安全型",
      diaryReaction: "",
    });
    // diaryReaction is empty string, not undefined, so it's falsy → should use default
    expect(result.currentNarrative).toContain("说不上来");
  });
});

// ── 弧线推进：noticing → denying ──────────────

describe("弧线 noticing → denying", () => {
  it("gap > 0.15 且超过 10 天", () => {
    const arc = {
      ...createNarrativeArc(),
      stage: "noticing" as const,
      lastAdvance: Date.now() - 11 * 24 * 3600 * 1000,
      direction: "negative" as const,
      currentNarrative: null,
      expressed: false,
    };
    // actual < perceived → direction = negative
    const drift = { ...makeDrift(0.18), actualBaseline: -0.1, perceivedBaseline: 0.08 };
    const { arc: result } = advanceNarrativeArc({
      arc, drift, recentMemories: [], attachmentStyle: "回避型",
    });
    expect(result.stage).toBe("denying");
    expect(result.currentNarrative).toContain("我不是");
  });
});

// ── denying → admitting ───────────────────────

describe("弧线 denying → admitting", () => {
  it("gap > 0.2 且超过 14 天", () => {
    const arc = {
      ...createNarrativeArc(),
      stage: "denying" as const,
      lastAdvance: Date.now() - 15 * 24 * 3600 * 1000,
      direction: "negative" as const,
      currentNarrative: null,
      expressed: false,
    };
    const drift = { ...makeDrift(0.22), actualBaseline: -0.1, perceivedBaseline: 0.12 };
    const { arc: result } = advanceNarrativeArc({
      arc, drift, recentMemories: [], attachmentStyle: "回避型",
      diaryReaction: "翻了日记，好像最近总在说一样的话",
    });
    expect(result.stage).toBe("admitting");
    expect(result.currentNarrative).toContain("翻了自己的日记");
    expect(result.currentNarrative).toContain("我自己能缓过来"); // 回避型 negative
  });

  it("无日记时承认叙事仍可用记忆", () => {
    const arc = {
      ...createNarrativeArc(),
      stage: "denying" as const,
      lastAdvance: Date.now() - 15 * 24 * 3600 * 1000,
      direction: "negative" as const,
      currentNarrative: null,
      expressed: false,
    };
    const drift = { ...makeDrift(0.22), actualBaseline: -0.1, perceivedBaseline: 0.12 };
    const { arc: result } = advanceNarrativeArc({
      arc, drift, recentMemories: [], attachmentStyle: "安全型",
    });
    expect(result.stage).toBe("admitting");
    // 没有 diaryReaction 时不应该包含"翻了自己的日记"
    expect(result.currentNarrative).not.toContain("翻了自己的日记");
  });
});

// ── shouldInjectNarrative ─────────────────────

describe("shouldInjectNarrative", () => {
  it("none 阶段不注入", () => {
    expect(shouldInjectNarrative(createNarrativeArc())).toBe(false);
  });

  it("noticing 且未表达 → 注入", () => {
    const arc = {
      stage: "noticing" as const,
      lastAdvance: Date.now(),
      direction: "negative" as const,
      currentNarrative: "最近好像有点闷",
      expressed: false,
    };
    expect(shouldInjectNarrative(arc)).toBe(true);
  });

  it("已表达 → 不注入", () => {
    const arc = {
      stage: "noticing" as const,
      lastAdvance: Date.now(),
      direction: "negative" as const,
      currentNarrative: "最近好像有点闷",
      expressed: true,
    };
    expect(shouldInjectNarrative(arc)).toBe(false);
  });
});

// ── markNarrativeExpressed ────────────────────

describe("markNarrativeExpressed", () => {
  it("标记为已表达且不可变", () => {
    const arc = {
      stage: "admitting" as const,
      lastAdvance: Date.now(),
      direction: "negative" as const,
      currentNarrative: "好吧",
      expressed: false,
    };
    const updated = markNarrativeExpressed(arc);
    expect(updated.expressed).toBe(true);
    expect(arc.expressed).toBe(false);
  });
});

// ── 用日记反应模拟真实场景 ────────────────────

describe("日记反应驱动的完整弧线", () => {
  it("从觉察到承认，日记伴随整个过程", () => {
    // noticing
    const arc0 = createNarrativeArc();
    const { arc: arc1 } = advanceNarrativeArc({
      arc: arc0, drift: makeDrift(0.12), recentMemories: [], attachmentStyle: "回避型",
      diaryReaction: "最近写的东西好像都有点闷",
    });
    expect(arc1.stage).toBe("noticing");
    expect(arc1.currentNarrative).toContain("写的东西");

    // denying: 10+ days pass
    const arc2 = {
      ...arc1,
      lastAdvance: Date.now() - 11 * 24 * 3600 * 1000,
    };
    const driftNeg = { ...makeDrift(0.18), actualBaseline: -0.1, perceivedBaseline: 0.08 };
    const { arc: arc3 } = advanceNarrativeArc({
      arc: arc2, drift: driftNeg, recentMemories: [], attachmentStyle: "回避型",
    });
    expect(arc3.stage).toBe("denying");

    // admitting: 15+ days pass
    const arc4 = {
      ...arc3,
      lastAdvance: Date.now() - 16 * 24 * 3600 * 1000,
    };
    const driftNeg2 = { ...makeDrift(0.22), actualBaseline: -0.1, perceivedBaseline: 0.12 };
    const { arc: arc5 } = advanceNarrativeArc({
      arc: arc4, drift: driftNeg2, recentMemories: [],
      attachmentStyle: "回避型",
      diaryReaction: "翻了自己的日记，好像真的在闷",
    });
    expect(arc5.stage).toBe("admitting");
    expect(arc5.currentNarrative).toContain("翻了自己的日记");
  });
});
