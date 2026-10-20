/**
 * 语音发送决策层测试（纯函数，无文件/网络依赖）。
 *
 * 覆盖：配置解析、免打扰、选句规则（CQ/URL/emoji/颜文字/重复标点/长度）、
 * decideVoice 的每个 reason 分支与冷却边界。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VOICE_SETTINGS,
  decideVoice,
  isInQuietHours,
  pickVoiceLine,
  resolveVoiceSettings,
  type VoiceContext,
  type VoiceSettings,
} from "./voice.js";

/** 构造一个默认能发语音的上下文。 */
function context(overrides: Partial<VoiceContext> = {}): VoiceContext {
  return {
    text: "今天天气不错，要不要一起出去走走？",
    closeness: 6,
    hour: 14,
    isGroup: false,
    ...overrides,
  };
}

function settings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return { ...DEFAULT_VOICE_SETTINGS, enabled: true, ...overrides };
}

// ── 配置解析 ─────────────────────────────────────

describe("resolveVoiceSettings", () => {
  it("空配置返回默认值（默认不开启）", () => {
    const resolved = resolveVoiceSettings(undefined);
    expect(resolved).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(resolved.enabled).toBe(false);
  });

  it("读取全部扁平配置键", () => {
    const resolved = resolveVoiceSettings({
      voice_enabled: true,
      voice_probability: 0.35,
      voice_min_closeness: 3,
      voice_cooldown_minutes: 10,
      voice_max_chars: 40,
      voice_group_enabled: true,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.probability).toBeCloseTo(0.35, 6);
    expect(resolved.minCloseness).toBe(3);
    expect(resolved.cooldownMinutes).toBe(10);
    expect(resolved.maxChars).toBe(40);
    expect(resolved.allowedInGroup).toBe(true);
  });

  it("兼容字符串取值（.env / YAML 常见）", () => {
    const resolved = resolveVoiceSettings({
      voice_enabled: "true",
      voice_probability: "0.5",
      voice_group_enabled: "0",
      voice_cooldown_minutes: "15",
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.probability).toBeCloseTo(0.5, 6);
    expect(resolved.allowedInGroup).toBe(false);
    expect(resolved.cooldownMinutes).toBe(15);
  });

  it("非法值回退默认并 clamp 到合法范围", () => {
    const resolved = resolveVoiceSettings({
      voice_probability: 5,
      voice_min_closeness: -2,
      voice_cooldown_minutes: -1,
      voice_max_chars: 9999,
      voice_enabled: "maybe",
    });
    expect(resolved.probability).toBe(1);
    expect(resolved.minCloseness).toBe(0);
    expect(resolved.cooldownMinutes).toBe(0);
    expect(resolved.maxChars).toBe(200);
    expect(resolved.enabled).toBe(DEFAULT_VOICE_SETTINGS.enabled);
  });

  it("defaults 参数可覆盖默认值，且不被 undefined 覆盖", () => {
    const resolved = resolveVoiceSettings(undefined, { enabled: true, probability: 0.4 });
    expect(resolved.enabled).toBe(true);
    expect(resolved.probability).toBeCloseTo(0.4, 6);
    expect(resolved.minCloseness).toBe(DEFAULT_VOICE_SETTINGS.minCloseness);
  });
});

// ── 免打扰 ───────────────────────────────────────

describe("isInQuietHours", () => {
  it("无配置 → false", () => {
    expect(isInQuietHours(3, undefined)).toBe(false);
  });

  it("同起止视为关闭", () => {
    expect(isInQuietHours(23, { start: 23, end: 23 })).toBe(false);
  });

  it("普通时段 [13,15)", () => {
    expect(isInQuietHours(13, { start: 13, end: 15 })).toBe(true);
    expect(isInQuietHours(15, { start: 13, end: 15 })).toBe(false);
    expect(isInQuietHours(12, { start: 13, end: 15 })).toBe(false);
  });

  it("跨午夜时段 [23,7)", () => {
    expect(isInQuietHours(23.5, { start: 23, end: 7 })).toBe(true);
    expect(isInQuietHours(2, { start: 23, end: 7 })).toBe(true);
    expect(isInQuietHours(7, { start: 23, end: 7 })).toBe(false);
    expect(isInQuietHours(14, { start: 23, end: 7 })).toBe(false);
  });
});

// ── 选句 ─────────────────────────────────────────

describe("pickVoiceLine", () => {
  it("优先返回第一个 4-30 字的句子", () => {
    const line = pickVoiceLine("嗯。今天天气很不错，适合出去走走。明天可能会下雨。", 60);
    expect(line).toBe("今天天气很不错，适合出去走走");
  });

  it("按换行/句号/问号/感叹号切句", () => {
    expect(pickVoiceLine("嗨！今天过得怎么样？还行吧。", 60)).toBe("今天过得怎么样");
    expect(pickVoiceLine("第一行\n第二行内容在这里", 60)).toBe("第二行内容在这里");
  });

  it("跳过太短（<4 字）与太长（>30 字）的句子", () => {
    const short = pickVoiceLine("嗯。好呀。", 60);
    expect(short).toBeNull();
    const long = "这".repeat(31);
    expect(pickVoiceLine(`${long}。今天不错。`, 60)).toBe("今天不错");
  });

  it("跳过含 CQ 码 / 网址 / emoji / 颜文字的句子", () => {
    expect(pickVoiceLine("[CQ:face,id=1] 今天真开心呀", 60)).toBeNull();
    expect(pickVoiceLine("看这个 https://example.com 吧", 60)).toBeNull();
    expect(pickVoiceLine("今天真开心😀哈哈哈", 60)).toBeNull();
    expect(pickVoiceLine("今天真开心(╯°□°）╯", 60)).toBeNull();
    expect(pickVoiceLine("今天真开心 QAQ", 60)).toBeNull();
  });

  it("跳过连续重复标点与纯标点句", () => {
    expect(pickVoiceLine("真的吗？？？不会吧", 60)).toBeNull();
    expect(pickVoiceLine("……！！！", 60)).toBeNull();
  });

  it("maxChars 小于 4 时无候选", () => {
    expect(pickVoiceLine("今天天气不错", 3)).toBeNull();
  });

  it("maxChars 限制上界：短上限下长句跳过", () => {
    expect(pickVoiceLine("今天天气真的很不错呢", 5)).toBeNull();
    expect(pickVoiceLine("今天天气真的很不错。明天见呀", 6)).toBe("明天见呀");
  });

  it("剥掉列表符号/编号/包裹引号", () => {
    expect(pickVoiceLine("1. 「今天天气不错」", 60)).toBe("今天天气不错");
    expect(pickVoiceLine("- 今天心情很好呀", 60)).toBe("今天心情很好呀");
  });
});

// ── 决策 ─────────────────────────────────────────

describe("decideVoice", () => {
  it("disabled：总开关关闭", () => {
    const decision = decideVoice(context(), settings({ enabled: false }));
    expect(decision).toEqual({ speak: false, reason: "disabled" });
  });

  it("group_disabled：群聊且未开启群语音", () => {
    const decision = decideVoice(context({ isGroup: true }), settings({ allowedInGroup: false }));
    expect(decision.reason).toBe("group_disabled");
  });

  it("群聊允许时继续走后续判断", () => {
    const decision = decideVoice(
      context({ isGroup: true }),
      settings({ allowedInGroup: true }),
      { random: () => 0, speechAvailable: true }
    );
    expect(decision.speak).toBe(true);
    expect(decision.reason).toBe("ok");
  });

  it("crisis：危机轮绝不发语音", () => {
    const decision = decideVoice(context({ isCrisis: true }), settings());
    expect(decision).toEqual({ speak: false, reason: "crisis" });
  });

  it("tts_unavailable：TTS 不可用", () => {
    const decision = decideVoice(context(), settings(), { speechAvailable: false });
    expect(decision.reason).toBe("tts_unavailable");
  });

  it("quiet_hours：免打扰时段", () => {
    const decision = decideVoice(
      context({ hour: 23.5, quietHours: { start: 23, end: 7 } }),
      settings()
    );
    expect(decision.reason).toBe("quiet_hours");
  });

  it("low_closeness：亲密度不足", () => {
    const decision = decideVoice(context({ closeness: 2 }), settings({ minCloseness: 4 }));
    expect(decision.reason).toBe("low_closeness");
  });

  it("cooldown：冷却未过", () => {
    const now = 1_000_000_000;
    const decision = decideVoice(context({ now }), settings({ cooldownMinutes: 30 }), {
      lastSentAt: now - 10 * 60_000,
    });
    expect(decision.reason).toBe("cooldown");
  });

  it("cooldown 边界：刚好超过冷却可以发", () => {
    const now = 1_000_000_000;
    const decision = decideVoice(context({ now }), settings({ cooldownMinutes: 30 }), {
      lastSentAt: now - 30 * 60_000,
      random: () => 0,
    });
    expect(decision.reason).toBe("ok");
  });

  it("cooldownMinutes=0 时不冷却", () => {
    const now = 1_000_000_000;
    const decision = decideVoice(context({ now }), settings({ cooldownMinutes: 0 }), {
      lastSentAt: now - 1_000,
      random: () => 0,
    });
    expect(decision.reason).toBe("ok");
  });

  it("probability_miss：随机值未命中概率", () => {
    const decision = decideVoice(context(), settings({ probability: 0.2 }), {
      random: () => 0.9,
    });
    expect(decision).toEqual({ speak: false, reason: "probability_miss" });
  });

  it("probability=0 时永远不发", () => {
    const decision = decideVoice(context(), settings({ probability: 0 }), { random: () => 0 });
    expect(decision.reason).toBe("probability_miss");
  });

  it("no_line：没有适合念的句子", () => {
    const decision = decideVoice(context({ text: "嗯。" }), settings(), { random: () => 0 });
    expect(decision.reason).toBe("no_line");
  });

  it("ok：命中并返回第一句合适的话", () => {
    const decision = decideVoice(context(), settings({ probability: 1 }), {
      random: () => 0.5,
      speechAvailable: true,
    });
    expect(decision.speak).toBe(true);
    expect(decision.reason).toBe("ok");
    expect(decision.line).toContain("要不要一起出去走走");
  });

  it("不注入 random 时使用 Math.random（只断言返回结构）", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const decision = decideVoice(context(), settings({ probability: 1 }));
      expect(decision.reason).toBe("ok");
      expect(typeof decision.line).toBe("string");
    } finally {
      randomSpy.mockRestore();
    }
  });
});
