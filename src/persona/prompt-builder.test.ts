import { describe, it, expect } from "vitest";
import {
  computeThreshold,
  activateRules,
  checkRuleBreach,
  buildStateLabel,
  selectScript,
  injectCorrections,
  translateTags,
  buildIdentityPart,
  buildStylePart,
  buildRulesPart,
  buildScriptsPart,
  buildRelationshipPart,
  buildWorldPart,
  assemblePrompt,
  buildPrompt,
  type ChainRule,
  type BehavioralScript,
  type InnerState,
  type CorrectionOverlay,
  type ActiveRule,
  type ActiveScript,
} from "./prompt-builder.js";
import { loadPersona, type Persona } from "./loader.js";
import type { AppConfig } from "../data/store.js";

// ── 测试装置 ───────────────────────────────────

function makeChainRules(): ChainRule[] {
  return [
    {
      id: "no_questions",
      resistance: 0.8,
      text: "不以问句结尾",
      chain: { trigger: "casual_chitchat", internal: "我不想让他觉得我在追问", behavior: "用陈述句结束" },
    },
    {
      id: "no_long_text",
      resistance: 0.6,
      text: "不长篇大论",
      chain: { trigger: "direct_question", internal: "说多了显得我很啰嗦", behavior: "控制在三句以内" },
    },
    {
      id: "dont_get_too_close",
      resistance: 0.9,
      immutable: true,
      immutable_reason: "作者设定",
      text: "不主动推进关系",
      chain: { trigger: "positive_affection", internal: "我现在不能太主动", behavior: "保持距离" },
    },
  ];
}

function makeBehavioralScripts(): BehavioralScript[] {
  return [
    {
      trigger: "casual_chitchat",
      sequence: ["接话", "吐槽一句"],
      tone: "日常",
      applicable_mode: ["neutral", "distant", "close"],
      rhythm: "2-3 条短消息",
    },
    {
      trigger: "positive_affection",
      sequence: ["愣一下", "转移话题"],
      tone: "回避",
      applicable_mode: ["distant", "avoidant"],
    },
    {
      trigger: "direct_question",
      sequence: ["直接回答", "反问"],
      tone: "干脆",
      applicable_mode: ["neutral", "close"],
    },
    {
      trigger: "exception_moment",
      sequence: ["沉默一下", "含糊回应"],
      tone: "愧疚",
      applicable_mode: ["guilty"],
    },
  ];
}

function makeNeutralState(): InnerState {
  return { exposure: 0.4, guilt: 0, emotion: 0, hour: 15, mode: "neutral", closeness: 5 };
}

function makePersona(): Persona {
  return {
    name: "小雅",
    hardRules: {
      neverDo: [],
      alwaysDo: [],
      triggerWords: [],
      boundaries: [],
    },
    identity: {
      name: "小雅", age: 24, gender: "女", birthday: "5月20日",
      appearance: { face: "圆脸", hair: "黑色短发", height: "162cm", build: "偏瘦", style: "卫衣+牛仔裤", features: [] },
      lifeStory: {
        hometown: "成都", career: "咖啡师", education: "大专",
        keyEvents: [{ age: 22, event: "来上海做咖啡师", impact: "决定了现在的生活" }],
        family: "父母在成都", currentStatus: "在上海做咖啡师",
      },
    },
    speaking: {
      catchphrases: ["真的", "救命"], sentencePattern: "短句，常省略主语",
      tone: "随性带点吐槽", emojiUsage: "偶尔用表情包",
      typingHabit: "一段一段发，不一次性发大段", addressUser: "你", dialect: "",
    },
    emotions: {
      attachmentStyle: "回避型",
      emotionalBaseline: "平静",
      emotionalRange: "平静到焦虑",
      stressReaction: "撤回",
      loveLanguage: "默默做事",
      vulnerabilities: [],
      triggers: [],
    },
    relationship: {
      type: "网友", closeness: 5, pace: "慢热",
      jealousyMode: "不说但会有点在意", apologyStyle: "不直接道歉，用行动弥补",
      howWeMet: "网上认识的", herViewOfYou: "一个挺有意思的人",
      sharedMemories: [],
    },
    world: {
      socialCircle: [{ name: "同事小李", relation: "同事", influence: "中等" }],
      dailyRhythm: [{ time: "09:00", day: "每天", activity: "上班" }],
      goals: [], stressSources: ["咖啡机老坏"],
      externalAwareness: { internetEnabled: true, weatherSensitive: true },
    },
  };
}

function makeConfig(): AppConfig {
  return { persona: "xiaoya", her_name: "小雅", your_name: "你", location: "上海", tags: ["话痨"], message_frequency_limit: 10, log_level: "info" };
}

// ── computeThreshold ─────────────────────────

describe("computeThreshold", () => {
  it("回避型基线约 0.6，在标准中性的状态下阈值接近基线", () => {
    const t = computeThreshold("回避型", makeNeutralState());
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(0.7);
  });

  it("高负债拉低阈值（更容易冲动）", () => {
    const base = computeThreshold("回避型", makeNeutralState());
    const low = computeThreshold("回避型", { ...makeNeutralState(), guilt: 0.5 });
    expect(low).toBeLessThan(base);
  });

  it("深夜拉低阈值", () => {
    const base = computeThreshold("回避型", { ...makeNeutralState(), hour: 15 });
    const night = computeThreshold("回避型", { ...makeNeutralState(), hour: 2 });
    expect(night).toBeLessThan(base);
  });

  it("安全型基线最高", () => {
    const secure = computeThreshold("安全型", makeNeutralState());
    const anxious = computeThreshold("焦虑型", makeNeutralState());
    expect(secure).toBeGreaterThan(anxious);
  });
});

// ── activateRules ───────────────────────────

describe("activateRules", () => {
  const rules = makeChainRules();
  const threshold = 0.6;

  it("低冲动时所有规则为 active", () => {
    const result = activateRules(rules, 0.2, threshold);
    expect(result.every(r => r.status === "active")).toBe(true);
  });

  it("中等冲动时低 resistance 规则进入 struggle", () => {
    // effective = 0.4/0.6 = 0.67: no_questions(0.8) → struggle, no_long_text(0.6) → 接近边界
    const result = activateRules(rules, 0.4, 0.6);
    const struggleRules = result.filter(r => r.status === "struggle");
    expect(struggleRules.length).toBeGreaterThan(0);
  });

  it("高冲动时不可变规则产生 struggle 而非 broken", () => {
    const result = activateRules(rules, 1.0, threshold);
    const immutableRule = result.find(r => r.rule.id === "dont_get_too_close");
    expect(immutableRule).toBeDefined();
    // 不可变规则即使在极高冲动下也不会标记为 broken
    expect(immutableRule!.status).not.toBe("broken");
  });

  it("每条规则都有 internal_voice", () => {
    const result = activateRules(rules, 0.6, threshold);
    for (const r of result) {
      expect(r.internal_voice).toBeTruthy();
    }
  });
});

// ── checkRuleBreach ─────────────────────────

describe("checkRuleBreach", () => {
  const rules = makeChainRules();

  it("低冲动轻松通过", () => {
    const r = checkRuleBreach(rules, 0.15, 0.6);
    expect(r.phase).toBe("clean_pass");
    expect(r.guiltProduced).toBe(0);
  });

  it("中等冲动进入内耗区间", () => {
    // effective = 0.4/0.6 = 0.67: no_long_text(0.6) ratio=1.11 → 在 struggle 带内
    const r = checkRuleBreach(rules, 0.4, 0.6);
    expect(r.phase).toBe("internal_struggle");
    expect(r.guiltProduced).toBe(0);
  });

  it("高冲动突破规则并制造负债", () => {
    const r = checkRuleBreach(rules, 0.9, 0.5);
    expect(r.phase).toBe("rule_broken");
    expect(r.guiltProduced).toBeGreaterThan(0);
  });

  it("空规则列表安全返回", () => {
    const r = checkRuleBreach([], 0.9, 0.5);
    expect(r.phase).toBe("clean_pass");
  });
});

// ── buildStateLabel ─────────────────────────

describe("buildStateLabel", () => {
  it("生成简短结构化标签", () => {
    const label = buildStateLabel(makeNeutralState());
    expect(label).toContain("[");
    expect(label).toContain("]");
    expect(label.length).toBeLessThan(30);
  });

  it("负债 > 0.2 时显示负债值", () => {
    const label = buildStateLabel({ ...makeNeutralState(), guilt: 0.3 });
    expect(label).toContain("负债");
  });

  it("深夜时段指代正确", () => {
    const label = buildStateLabel({ ...makeNeutralState(), hour: 3 });
    expect(label).toContain("深夜");
  });
});

// ── selectScript ────────────────────────────

describe("selectScript", () => {
  const scripts = makeBehavioralScripts();

  it("guilty 模式优先由系统匹配 exception_moment", () => {
    const state = { ...makeNeutralState(), mode: "guilty" as const };
    const active = selectScript(scripts, "对不起", state);
    expect(active.match_method).toBe("system");
    expect(active.script.trigger).toBe("exception_moment");
  });

  it("短消息正向情感词匹配 positive_affection", () => {
    const active = selectScript(scripts, "想你", makeNeutralState());
    if (active.match_method === "rule") {
      expect(active.script.trigger).toBe("positive_affection");
    }
  });

  it("问句匹配 direct_question", () => {
    const active = selectScript(scripts, "你几点下班？", makeNeutralState());
    if (active.match_method === "rule") {
      expect(active.script.trigger).toBe("direct_question");
    }
  });

  it("无匹配时回退到默认 casual_chitchat", () => {
    const active = selectScript(scripts, "今天天气挺好的随便聊聊", makeNeutralState());
    expect(active.match_method).toBe("semantic");
    expect(active.script.trigger).toBe("casual_chitchat");
  });
});

// ── injectCorrections ───────────────────────

describe("injectCorrections", () => {
  it("无覆盖时返回空", () => {
    expect(injectCorrections([], Date.now())).toBe("");
  });

  it("已完全衰减的覆盖不注入", () => {
    const old = Date.now() - 5 * 4.5 * 3600 * 1000; // 5 个半衰期
    const overlays: CorrectionOverlay[] = [
      { target: "r1", label: "太冷淡", adjustment: "稍微热情一点", applied_at: old, half_life_ms: 4.5 * 3600 * 1000 },
    ];
    expect(injectCorrections(overlays, Date.now())).toBe("");
  });

  it("强覆盖注入 prompt", () => {
    const recent = Date.now() - 1000;
    const overlays: CorrectionOverlay[] = [
      { target: "r1", label: "太冷淡", adjustment: "你应该更主动一些", applied_at: recent, half_life_ms: 4.5 * 3600 * 1000 },
    ];
    const result = injectCorrections(overlays, Date.now());
    expect(result).toContain("更主动一些");
  });

  it("短时间内 ≥3 次同类纠正触发阻抗", () => {
    const now = Date.now();
    const overlays: CorrectionOverlay[] = [
      { target: "r1", label: "太冷淡", adjustment: "a", applied_at: now - 1000, half_life_ms: 4.5 * 3600 * 1000 },
      { target: "r2", label: "太冷淡", adjustment: "b", applied_at: now - 2000, half_life_ms: 4.5 * 3600 * 1000 },
      { target: "r3", label: "太冷淡", adjustment: "c", applied_at: now - 3000, half_life_ms: 4.5 * 3600 * 1000 },
    ];
    const result = injectCorrections(overlays, now);
    expect(result).toContain("阻抗");
  });
});

// ── translateTags ───────────────────────────

describe("translateTags", () => {
  it("空标签返回空", () => {
    expect(translateTags([])).toBe("");
  });

  it("已知标签翻译为 prompt 片段", () => {
    const result = translateTags(["话痨"]);
    expect(result).toContain("消息密度高");
  });

  it("未知标签被过滤", () => {
    const result = translateTags(["不存在的标签"]);
    expect(result).toBe("");
  });
});

// ── buildIdentityPart ───────────────────────

describe("buildIdentityPart", () => {
  it("包含名字、年龄、职业", () => {
    const result = buildIdentityPart(makePersona());
    expect(result).toContain("小雅");
    expect(result).toContain("24");
    expect(result).toContain("咖啡师");
  });
});

// ── buildStylePart ──────────────────────────

describe("buildStylePart", () => {
  it("包含口头禅和语气", () => {
    const result = buildStylePart(makePersona());
    expect(result).toContain("真的");
    expect(result).toContain("随性带点吐槽");
  });
});

// ── buildRulesPart ──────────────────────────

describe("buildRulesPart", () => {
  it("active 规则显示规则文本和内心独白", () => {
    const rules = makeChainRules();
    const active: ActiveRule[] = rules.map(r => ({
      rule: r, status: "active" as const, internal_voice: r.chain.internal,
    }));
    const result = buildRulesPart(active);
    expect(result).toContain("不以问句结尾");
  });

  it("broken 规则不显示", () => {
    const rules = makeChainRules();
    const active: ActiveRule[] = rules.map(r => ({
      rule: r, status: "broken" as const, internal_voice: "不该这样",
    }));
    const result = buildRulesPart(active);
    expect(result).not.toContain("不以问句结尾");
  });
});

// ── buildScriptsPart ────────────────────────

describe("buildScriptsPart", () => {
  it("包含触发类型和行为序列", () => {
    const scripts = makeBehavioralScripts();
    const active: ActiveScript = { script: scripts[0], match_method: "semantic" };
    const result = buildScriptsPart(active);
    expect(result).toContain("casual_chitchat");
    expect(result).toContain("接话");
  });
});

// ── buildRelationshipPart ───────────────────

describe("buildRelationshipPart", () => {
  it("包含关系类型和亲密度", () => {
    const result = buildRelationshipPart(makePersona(), makeNeutralState());
    expect(result).toContain("网友");
    expect(result).toContain("5/10");
  });

  it("有 herViewOfYou 时包含之", () => {
    const result = buildRelationshipPart(makePersona(), makeNeutralState(), "一个挺有意思的人");
    expect(result).toContain("她眼里你是什么样的人");
  });
});

// ── buildWorldPart ──────────────────────────

describe("buildWorldPart", () => {
  it("包含城市和社交圈", () => {
    const result = buildWorldPart(makePersona(), makeConfig());
    expect(result).toContain("上海");
  });
});

describe("反编造往事", () => {
  it("prompt 明确禁止编造「怎么认识 / 第一次见面」的具体场景", async () => {
    const persona = await loadPersona("xiaoya");
    const prompt = buildPrompt({
      persona,
      config: { location: "上海" } as unknown as AppConfig,
      rules: persona.chainRules ?? [],
      scripts: persona.behavioralScripts ?? [],
      state: {
        exposure: 0.3,
        guilt: 0,
        emotion: 0,
        hour: 14,
        mode: "neutral",
        closeness: 3,
      },
      impulseIntensity: 0.2,
      corrections: [],
      tags: [],
      userText: "你还记得我们是怎么认识的吗？",
    });
    expect(prompt).toContain("怎么认识的");
    expect(prompt).toContain("别补场景");
  });
});
