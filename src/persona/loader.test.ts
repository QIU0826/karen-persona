import { describe, it, expect } from "vitest";
import { validatePersona, CURRENT_SCHEMA_VERSION, type ValidationResult } from "./loader.js";

// ── validatePersona ──────────────────────────

describe("validatePersona", () => {
  function validBase() {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      name: "测试人设",
      hardRules: { neverDo: [], alwaysDo: [], triggerWords: [], boundaries: [] },
      identity: {
        name: "测试", age: 25, gender: "女", birthday: "1月1日",
        appearance: { height: "165cm", build: "中等", face: "圆脸", hair: "长发", style: "休闲", features: [] },
        lifeStory: {
          hometown: "北京", education: "本科", career: "设计师",
          family: "父母", keyEvents: [{ age: 20, event: "毕业", impact: "重要" }], currentStatus: "工作中",
        },
      },
      speaking: {
        catchphrases: ["嗯"], sentencePattern: "短句", tone: "温柔",
        emojiUsage: "少", typingHabit: "分段", addressUser: "你", dialect: "",
      },
      emotions: {
        attachmentStyle: "安全型", emotionalBaseline: "平静",
        emotionalRange: "平静到开心", stressReaction: "沉默", loveLanguage: "陪伴",
        vulnerabilities: [], triggers: [],
      },
      relationship: {
        type: "网友", closeness: 5, pace: "慢热",
        jealousyMode: "不说", apologyStyle: "不道歉",
        howWeMet: "网上认识", sharedMemories: [],
      },
      world: {
        socialCircle: [{ name: "朋友A", relation: "朋友", influence: "中等" }],
        dailyRhythm: [{ time: "09:00", day: "每天", activity: "上班" }],
        goals: [], stressSources: ["忙"],
        externalAwareness: { internetEnabled: true, weatherSensitive: false },
      },
    };
  }

  it("完整人设通过校验", () => {
    const r = validatePersona(validBase(), "test");
    expect(r.errors).toHaveLength(0);
    expect(r.valid).toBe(true);
  });

  it("非对象输入直接失败", () => {
    const r = validatePersona(null, "null");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("不是有效的 JSON 对象");
  });

  it("缺少六层报错", () => {
    const r = validatePersona({ name: "空" }, "empty");
    expect(r.errors.filter(e => e.includes("缺少 Layer"))).toHaveLength(6);
    expect(r.valid).toBe(false);
  });

  it("缺失必需字段", () => {
    const bad = validBase();
    delete (bad.identity as Record<string, unknown>).name;
    delete (bad.identity as Record<string, unknown>).appearance;
    const r = validatePersona(bad, "test");
    expect(r.errors.some(e => e.includes("identity.name"))).toBe(true);
    expect(r.errors.some(e => e.includes("identity.appearance"))).toBe(true);
  });

  it("无效依恋类型报错", () => {
    const bad = validBase();
    (bad.emotions as Record<string, unknown>).attachmentStyle = "不知道";
    const r = validatePersona(bad, "test");
    expect(r.errors.some(e => e.includes("attachmentStyle"))).toBe(true);
  });

  it("closeness 超出范围报错", () => {
    const bad = validBase();
    (bad.relationship as Record<string, unknown>).closeness = 15;
    const r = validatePersona(bad, "test");
    expect(r.errors.some(e => e.includes("closeness"))).toBe(true);
  });

  it("缺少 schemaVersion 产生警告", () => {
    const bad = structuredClone(validBase());
    delete (bad as Record<string, unknown>).schemaVersion;
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("schemaVersion"))).toBe(true);
    expect(r.valid).toBe(true); // 警告不妨碍通过
  });

  it("schemaVersion 不匹配产生警告", () => {
    const bad = validBase();
    (bad as Record<string, unknown>).schemaVersion = 99;
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("schemaVersion"))).toBe(true);
  });

  it("缺少 howWeMet 产生警告", () => {
    const bad = validBase();
    delete (bad.relationship as Record<string, unknown>).howWeMet;
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("howWeMet"))).toBe(true);
  });

  it("缺少推荐的 behavioralScripts trigger 产生警告", () => {
    const bad = validBase();
    (bad as Record<string, unknown>).behavioralScripts = [
      { trigger: "custom_only", sequence: ["a"], tone: "日常", applicable_mode: ["neutral"] },
    ];
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("casual_chitchat"))).toBe(true);
  });

  it("chainRule resistance 超出范围报错", () => {
    const bad = validBase();
    (bad as Record<string, unknown>).chainRules = [
      { id: "r1", resistance: 2.5, text: "test", chain: { trigger: "t", internal: "i", behavior: "b" } },
    ];
    const r = validatePersona(bad, "test");
    expect(r.errors.some(e => e.includes("resistance"))).toBe(true);
  });

  it("behavioralScript 缺少 sequence 报错", () => {
    const bad = validBase();
    (bad as Record<string, unknown>).behavioralScripts = [
      { trigger: "test", tone: "日常", applicable_mode: ["neutral"] },
    ];
    const r = validatePersona(bad, "test");
    expect(r.errors.some(e => e.includes("sequence"))).toBe(true);
  });

  it("重复 trigger 产生警告", () => {
    const bad = validBase();
    (bad as Record<string, unknown>).behavioralScripts = [
      { trigger: "casual_chitchat", sequence: ["a"], tone: "日常", applicable_mode: ["neutral"] },
      { trigger: "casual_chitchat", sequence: ["b"], tone: "日常", applicable_mode: ["neutral"] },
    ];
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("重复 trigger"))).toBe(true);
  });

  it("dailyRhythm 为空产生警告", () => {
    const bad = validBase();
    (bad.world as Record<string, unknown>).dailyRhythm = [];
    const r = validatePersona(bad, "test");
    expect(r.warnings.some(w => w.includes("dailyRhythm"))).toBe(true);
  });
});
