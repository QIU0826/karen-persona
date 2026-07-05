import { describe, it, expect } from "vitest";
import {
  ToneDecisionEngine,
  TONE_STYLES,
  type ContextFactors,
  type ToneDecision,
} from "./tone-engine.js";

// ── TONE_STYLES ───────────────────────────────

describe("TONE_STYLES", () => {
  it("包含全部 6 种风格", () => {
    const names = Object.keys(TONE_STYLES);
    expect(names).toContain("natural");
    expect(names).toContain("friendly");
    expect(names).toContain("coy");
    expect(names).toContain("casual");
    expect(names).toContain("serious");
    expect(names).toContain("shy");
  });

  it("每种风格都有 6 个 intensityModifiers", () => {
    for (const style of Object.values(TONE_STYLES)) {
      const categories = Object.keys(style.intensityModifiers);
      expect(categories).toHaveLength(6);
    }
  });

  it("每种风格的 frequency 在 0-1 之间", () => {
    for (const style of Object.values(TONE_STYLES)) {
      expect(style.frequency).toBeGreaterThan(0);
      expect(style.frequency).toBeLessThanOrEqual(1);
    }
  });
});

// ── ToneDecisionEngine ────────────────────────

describe("ToneDecisionEngine", () => {
  it("默认使用 natural 风格", () => {
    const engine = new ToneDecisionEngine();
    expect(engine.getStyleProfile().name).toBe("自然");
  });

  it("可以切换风格", () => {
    const engine = new ToneDecisionEngine("shy");
    expect(engine.getStyleProfile().name).toBe("害羞");
    engine.setStyle("serious");
    expect(engine.getStyleProfile().name).toBe("严肃");
  });

  it("无效风格回退到 natural", () => {
    const engine = new ToneDecisionEngine("nonexistent" as string);
    expect(engine.getStyleProfile().name).toBe("自然");
  });

  it("generateDecisions 返回数组", () => {
    const engine = new ToneDecisionEngine("natural");
    const factors: ContextFactors = {
      emotion: "neutral",
      scene: "casual",
      closeness: "acquaintance",
      recentMessages: [],
      currentTopic: "天气",
      impulseIntensity: 0.3,
      guilt: 0.1,
      busyLevel: 0,
    };
    const decisions = engine.generateDecisions(factors);
    expect(Array.isArray(decisions)).toBe(true);
  });

  it("每个 decision 包含必要字段", () => {
    const engine = new ToneDecisionEngine("friendly");
    const factors: ContextFactors = {
      emotion: "happy",
      scene: "greeting",
      closeness: "friend",
      recentMessages: ["嗨"],
      currentTopic: "打招呼",
      impulseIntensity: 0.5,
      guilt: 0,
      busyLevel: 0,
    };
    const decisions = engine.generateDecisions(factors);
    for (const d of decisions) {
      expect(d).toHaveProperty("category");
      expect(d).toHaveProperty("word");
      expect(d).toHaveProperty("position");
      expect(d).toHaveProperty("probability");
      expect(["start", "middle", "end"]).toContain(d.position);
    }
  });
});

// ── analyzeContext ────────────────────────────

describe("analyzeContext", () => {
  it("高愧疚将情绪调整为 anxious", () => {
    const engine = new ToneDecisionEngine();
    const factors: ContextFactors = {
      emotion: "happy",
      scene: "casual",
      closeness: "friend",
      recentMessages: [],
      currentTopic: "",
      impulseIntensity: 0.2,
      guilt: 0.7,
      busyLevel: 0,
    };
    const result = engine.analyzeContext(factors);
    expect(result.emotion).toBe("anxious");
  });

  it("高繁忙度将场景调整为 serious", () => {
    const engine = new ToneDecisionEngine();
    const factors: ContextFactors = {
      emotion: "neutral",
      scene: "casual",
      closeness: "friend",
      recentMessages: [],
      currentTopic: "",
      impulseIntensity: 0.2,
      guilt: 0,
      busyLevel: 2,
    };
    const result = engine.analyzeContext(factors);
    expect(result.scene).toBe("serious");
  });

  it("高冲动强度 + 开心 → excited", () => {
    const engine = new ToneDecisionEngine();
    const factors: ContextFactors = {
      emotion: "happy",
      scene: "sharing",
      closeness: "close",
      recentMessages: [],
      currentTopic: "",
      impulseIntensity: 0.8,
      guilt: 0,
      busyLevel: 0,
    };
    const result = engine.analyzeContext(factors);
    expect(result.emotion).toBe("excited");
  });
});
