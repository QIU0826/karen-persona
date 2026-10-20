/**
 * 语音消息发送决策层（v0.3）——纯函数，不碰网络/文件/全局状态。
 *
 * 职责：回答两个问题
 * 1. 这一轮要不要发语音？（enabled / 群聊 / 危机 / TTS 可用 / 免打扰 / 亲密度 /
 *    冷却 / 概率 / 是否有一句适合念的话）
 * 2. 发哪一句？（从文字回复里挑一句话，4-30 字、不含 CQ 码/颜文字/网址/重复标点）
 *
 * 冷却状态**不放在本模块**：由调用方（bridge）维护 `lastSentAt` 并作为 deps 传入，
 * 保证纯函数可测试、无隐式全局状态。
 *
 * 真实 TTS/SILK 能力见 `src/ai/tts.ts`；本模块只做决策，便于单测与后续复用（CLI/Web）。
 */

export interface VoiceSettings {
  /** 总开关（默认 false，显式开启才发语音）。 */
  enabled: boolean;
  /** 概率 0-1（默认 0.2）。 */
  probability: number;
  /** 最低亲密度（0-10，默认 4）。 */
  minCloseness: number;
  /** 冷却分钟数（默认 30；0 = 不冷却）。 */
  cooldownMinutes: number;
  /** 文本上限（字，默认 60；单句仍限制 4-30 字）。 */
  maxChars: number;
  /** 群聊是否允许发语音（默认 false）。 */
  allowedInGroup?: boolean;
}

export interface VoiceContext {
  /** 本轮文字回复（用于挑一句念出来）。 */
  text: string;
  /** 当前亲密度 0-10。 */
  closeness: number;
  /** 当前小时 0-23（可带小数，如 22.5）。 */
  hour: number;
  isGroup: boolean;
  /** 免打扰时段（start==end 视为关闭）。 */
  quietHours?: { start: number; end: number };
  /** 危机信号轮：绝不发语音（安全兜底只走文字）。 */
  isCrisis?: boolean;
  /** 当前时间戳（默认 Date.now()；测试注入固定值）。 */
  now?: number;
}

export interface VoiceDecision {
  speak: boolean;
  /** 决定发送时要念的句子（speak=false 时无）。 */
  line?: string;
  /** 决策原因（稳定字符串，便于日志/测试）。 */
  reason: string;
}

/** 语音决策的注入依赖（测试用；生产用默认实现）。 */
export interface VoiceDecisionDeps {
  /** 随机源 0-1（默认 Math.random）。 */
  random?: () => number;
  /** 上次发语音的时间戳（由 bridge 维护；不传 = 无冷却记录）。 */
  lastSentAt?: number;
  /** TTS 是否可用（bridge 启动时探测后传入；false 直接不发）。 */
  speechAvailable?: boolean;
}

/** 默认语音设置（不启用；显式配置 voice_enabled: true 才生效）。 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  probability: 0.2,
  minCloseness: 4,
  cooldownMinutes: 30,
  maxChars: 60,
  allowedInGroup: false,
};

/** 单句长度下限/上限（字）——太短没信息量，太长听不完。 */
const MIN_VOICE_LINE_CHARS = 4;
const MAX_VOICE_LINE_CHARS = 30;

// ── 配置解析 ─────────────────────────────────────

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "是"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "否"].includes(normalized)) return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 从 config.yaml 的扁平键解析语音设置（缺失/非法值回退默认，不抛错）：
 * voice_enabled / voice_probability / voice_min_closeness /
 * voice_cooldown_minutes / voice_max_chars / voice_group_enabled
 *
 * `defaults` 可覆盖默认值（例如按人设给不同默认），null/undefined 不覆盖。
 */
export function resolveVoiceSettings(
  raw: Record<string, unknown> | undefined,
  defaults: Partial<VoiceSettings> = {}
): VoiceSettings {
  const base: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  if (defaults.enabled !== undefined) base.enabled = defaults.enabled;
  if (defaults.probability !== undefined) base.probability = defaults.probability;
  if (defaults.minCloseness !== undefined) base.minCloseness = defaults.minCloseness;
  if (defaults.cooldownMinutes !== undefined) base.cooldownMinutes = defaults.cooldownMinutes;
  if (defaults.maxChars !== undefined) base.maxChars = defaults.maxChars;
  if (defaults.allowedInGroup !== undefined) base.allowedInGroup = defaults.allowedInGroup;

  const source = raw ?? {};
  return {
    enabled: parseBoolean(source.voice_enabled, base.enabled),
    probability: clampNumber(parseNumber(source.voice_probability, base.probability), 0, 1),
    minCloseness: clampNumber(
      parseNumber(source.voice_min_closeness, base.minCloseness),
      0,
      10
    ),
    cooldownMinutes: clampNumber(
      parseNumber(source.voice_cooldown_minutes, base.cooldownMinutes),
      0,
      24 * 60
    ),
    maxChars: Math.round(
      clampNumber(parseNumber(source.voice_max_chars, base.maxChars), 4, 200)
    ),
    allowedInGroup: parseBoolean(source.voice_group_enabled, base.allowedInGroup ?? false),
  };
}

// ── 免打扰判断 ───────────────────────────────────

function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return ((hour % 24) + 24) % 24;
}

/** 是否处于免打扰时段（start==end 视为关闭；支持跨午夜，如 23:00-07:00）。 */
export function isInQuietHours(
  hour: number,
  quietHours?: { start: number; end: number }
): boolean {
  if (!quietHours) return false;
  const start = normalizeHour(quietHours.start);
  const end = normalizeHour(quietHours.end);
  if (start === end) return false;
  const current = normalizeHour(hour);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

// ── 选句 ─────────────────────────────────────────

/** 句子切分：换行 / 句号 / 问号 / 感叹号 / 分号 / 省略号。 */
const SENTENCE_SPLIT_PATTERN = /[\n\r。！？!?；;…]+/;
/** 行首列表符号 / 编号（「1. 」「- 」「• 」等念出来很怪）。 */
const LEADING_MARKER_PATTERN = /^(?:[-*•·#>]+\s*|\d+[.、)）]\s*)/;
/** 包裹引号。 */
const WRAPPING_QUOTE_PATTERN = /^[「『"'“”‘’]+|[」』"'“”‘’]+$/g;
/** CQ 码。 */
const PICK_CQ_PATTERN = /\[CQ:/i;
/** URL / 裸域名。 */
const PICK_URL_PATTERN = /(?:https?:\/\/|www\.)/i;
/** Emoji。 */
const PICK_EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}]/u;
/** 常见 ASCII 颜文字。 */
const PICK_EMOTICON_PATTERN = /(?:\^[_^]?\^|T[._-]?T|QAQ|>[_<]+<|orz|0_0|o_O|O_o|=_=|:[)(DPp])/i;
/** 纯符号括号块（颜文字主体，如 `(╯°□°）`）。 */
const PICK_PURE_SYMBOL_BRACKET_PATTERN = /[（(][^（）()\n]{0,20}[）)]/;
/** 常见颜文字符号串（中文正文基本不会出现）。 */
const PICK_KAOMOJI_SYMBOL_PATTERN = /[╯╰▽△▲▼◆◇★☆♪♫￣╥﹏╳╬]/;
/** 连续重复标点（「！！！」「。。。」「？？？」等）。 */
const REPEATED_PUNCTUATION_PATTERN = /([!?！？。，,.;；~～])\1{1,}/;
/** 中文/字母/数字（判断是否只有标点）。 */
const HAS_SPEAKABLE_CONTENT_PATTERN = /[\u4e00-\u9fffA-Za-z0-9]/;

function countChars(text: string): number {
  return Array.from(text).length;
}

/**
 * 从文字回复里挑一句适合念出来的话；没有返回 null。
 *
 * 规则：按换行/句号/问号/感叹号切句 → 依次检查 → **返回第一句符合条件的**：
 * - 4-30 字（且不超过 maxChars）；
 * - 不含 CQ 码 / 网址 / emoji / 颜文字 / 连续重复标点；
 * - 至少含中文/字母/数字（纯标点跳过）。
 */
export function pickVoiceLine(text: string, maxChars: number = DEFAULT_VOICE_SETTINGS.maxChars): string | null {
  if (!text) return null;
  const upper = Math.min(MAX_VOICE_LINE_CHARS, Math.floor(maxChars));
  if (upper < MIN_VOICE_LINE_CHARS) return null;

  const candidates = text
    .split(SENTENCE_SPLIT_PATTERN)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const raw of candidates) {
    let line = raw.replace(LEADING_MARKER_PATTERN, "").replace(WRAPPING_QUOTE_PATTERN, "").trim();
    if (!line) continue;

    const length = countChars(line);
    if (length < MIN_VOICE_LINE_CHARS || length > upper) continue;
    if (PICK_CQ_PATTERN.test(line)) continue;
    if (PICK_URL_PATTERN.test(line)) continue;
    if (PICK_EMOJI_PATTERN.test(line)) continue;
    if (PICK_EMOTICON_PATTERN.test(line)) continue;
    if (PICK_KAOMOJI_SYMBOL_PATTERN.test(line)) continue;
    const bracketBlock = line.match(PICK_PURE_SYMBOL_BRACKET_PATTERN);
    if (bracketBlock && !HAS_SPEAKABLE_CONTENT_PATTERN.test(bracketBlock[0])) continue;
    if (REPEATED_PUNCTUATION_PATTERN.test(line)) continue;
    if (!HAS_SPEAKABLE_CONTENT_PATTERN.test(line)) continue;

    return line;
  }
  return null;
}

// ── 决策 ─────────────────────────────────────────

/**
 * 决定本轮是否发语音、发哪一句。
 *
 * 判定顺序（先排除硬条件，再概率）：
 * disabled → group_disabled → crisis → tts_unavailable → quiet_hours →
 * low_closeness → cooldown → probability_miss → no_line → ok
 */
export function decideVoice(
  ctx: VoiceContext,
  settings: VoiceSettings,
  deps: VoiceDecisionDeps = {}
): VoiceDecision {
  if (!settings.enabled) return { speak: false, reason: "disabled" };
  if (ctx.isGroup && !settings.allowedInGroup) return { speak: false, reason: "group_disabled" };
  if (ctx.isCrisis) return { speak: false, reason: "crisis" };
  if (deps.speechAvailable === false) return { speak: false, reason: "tts_unavailable" };
  if (isInQuietHours(ctx.hour, ctx.quietHours)) return { speak: false, reason: "quiet_hours" };
  if (ctx.closeness < settings.minCloseness) return { speak: false, reason: "low_closeness" };

  const cooldownMinutes = clampNumber(parseNumber(settings.cooldownMinutes, 0), 0, 24 * 60);
  if (deps.lastSentAt !== undefined && cooldownMinutes > 0) {
    const now = ctx.now ?? Date.now();
    const elapsedMs = now - deps.lastSentAt;
    if (elapsedMs >= 0 && elapsedMs < cooldownMinutes * 60_000) {
      return { speak: false, reason: "cooldown" };
    }
  }

  const probability = clampNumber(parseNumber(settings.probability, 0), 0, 1);
  const random = deps.random ?? Math.random;
  if (probability <= 0 || random() >= probability) {
    return { speak: false, reason: "probability_miss" };
  }

  const line = pickVoiceLine(ctx.text, settings.maxChars);
  if (!line) return { speak: false, reason: "no_line" };
  return { speak: true, line, reason: "ok" };
}

/**
 * 语音节流（v0.8.11）：21 轮回归里出现过「同一轮/相邻轮连发两条语音，内容还重复」——
 * 真人不会在几秒内录两遍语音。点名要语音时允许更快，但也要求一个最小间隔。
 */
export function shouldThrottleVoice(
  lastSentAt: number | undefined,
  now: number,
  requested: boolean,
): boolean {
  if (lastSentAt === undefined) return false;
  const minGapMs = requested ? 20_000 : 0;
  return now - lastSentAt < minGapMs;
}
