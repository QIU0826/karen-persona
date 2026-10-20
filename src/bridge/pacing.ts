/**
 * 打字节奏模拟器（v0.6）。
 *
 * 问题：v0.4 的节奏是「字数 × 固定 80–120ms，深夜 ×1.35」——太机械，而且不区分
 * 人设与状态（忙碌/情绪/内容复杂度都不影响）。
 *
 * 真人打字的三个来源：
 *  1. **人设**：有人秒回、有人慢吞吞；有人一次发三四条、有人一次一条。
 *  2. **状态**：忙的时候先把消息放着（readDelay 长）；开心时打得快；困的时候慢。
 *  3. **内容**：长句要打更久；情绪强烈的话会更快发出（也更容易打错）。
 *
 * 本模块只做纯计算（随机数可注入），返回「等多久开始打字 / 每个字多久 / 条间间隔」，
 * 不负责真正 sleep，方便单测与调参。
 */

export interface PacingPersona {
  /** 打字速度（字/分钟），默认 210；180 慢、260 快 */
  typingWpm?: number;
  /** 条间间隔倍率（0.6–1.6），默认 1 */
  burstiness?: number;
  /** 犹豫程度（0–1）：越高越容易"打了一半停一下" */
  hesitation?: number;
  /** 深夜变慢系数，默认 1.35（与 v0.4.1 一致） */
  nightSlowdown?: number;
}

export interface PacingContext {
  /** 0-23，可带小数 */
  hour: number;
  /** 情绪 -1..1 */
  emotionVector?: number;
  /** 忙碌程度 0-1（1 = 很忙，会先放着不回） */
  busyness?: number;
  /** 人设参数 */
  persona?: PacingPersona;
  /** 是否深夜（默认由 hour 推导，测试可覆盖） */
  isNight?: boolean;
}

export interface PacingResult {
  /** 看到消息到开始打字（毫秒） */
  readDelayMs: number;
  /** 每个字的打字耗时（毫秒） */
  perCharMs: number;
  /** 单条气泡打字耗时上限（毫秒） */
  capMs: number;
  /** 条与条之间的间隔（毫秒） */
  gapMs: number;
  /** 这次有没有"打了一半停一下"的犹豫（额外毫秒，已含在 perChar 之外） */
  hesitationMs: number;
  /** 综合速度档位（便于日志/调试） */
  profile: "fast" | "normal" | "slow";
}

export const DEFAULT_TYPING_WPM = 210;
export const DEFAULT_NIGHT_SLOWDOWN = 1.35;
const MIN_PER_CHAR_MS = 90;
const MAX_PER_CHAR_MS = 420;
const MAX_CAP_MS = 3_800;

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

/** 深夜：23:00–06:00（与 v0.4.1 的人味处理一致） */
export function isNightHour(hour: number): boolean {
  return hour >= 23 || hour < 6;
}

/**
 * 计算这一轮的打字节奏。
 *
 * 例：`planPacing({ hour: 14, persona: { typingWpm: 240 } })` → 约 250ms/字。
 * 深夜 ×1.35；忙的时候 perChar 略快（在偷闲回复）但 readDelay 很长。
 */
export function planPacing(context: PacingContext, random: () => number = Math.random): PacingResult {
  const { hour } = context;
  const persona = context.persona ?? {};
  const wpm = clamp(persona.typingWpm ?? DEFAULT_TYPING_WPM, 120, 360);
  const night = context.isNight ?? isNightHour(hour);
  const emotion = clamp(context.emotionVector ?? 0, -1, 1);
  const busyness = clamp(context.busyness ?? 0, 0, 1);

  // 基础：每分钟 wpm 字 → 每字毫秒
  let perCharMs = 60_000 / wpm;

  // 情绪：开心时手速快；低落时略慢
  if (emotion > 0.3) perCharMs *= 0.9;
  else if (emotion < -0.3) perCharMs *= 1.08;

  // 深夜：困，慢
  if (night) perCharMs *= clamp(persona.nightSlowdown ?? DEFAULT_NIGHT_SLOWDOWN, 1, 2);

  // 忙碌：其实在偷闲回，打字反而快一点（但 readDelay 会很长）
  if (busyness > 0.6) perCharMs *= 0.92;

  // 个体差异抖动：同一个人每次也不会完全一样
  perCharMs *= 0.9 + random() * 0.25;
  perCharMs = clamp(perCharMs, MIN_PER_CHAR_MS, MAX_PER_CHAR_MS);

  // 看到消息到开始打字：基础 0.6–1.6s，忙的时候可能几秒甚至更久
  const baseRead = 600 + random() * 1_000;
  const busyRead = busyness > 0.5 ? (busyness - 0.5) * 2 * (2_000 + random() * 4_000) : 0;
  const readDelayMs = Math.round(baseRead + busyRead + (night ? 500 : 0));

  // 条间间隔：人设 burstiness 越高越"连珠炮"
  const gapBase = 120 + random() * 260;
  const gapMs = Math.round(gapBase / clamp(persona.burstiness ?? 1, 0.6, 1.6));

  // 犹豫：低概率"打了一半停一下"（长句子才会，短句不会）
  const hesitationChance = clamp(persona.hesitation ?? 0.15, 0, 1);
  const hesitationMs = random() < hesitationChance ? Math.round(800 + random() * 1_700) : 0;

  const capMs = night ? MAX_CAP_MS : 3_000;
  const profile: PacingResult["profile"] =
    perCharMs < 180 ? "fast" : perCharMs > 300 ? "slow" : "normal";

  return { readDelayMs, perCharMs, capMs, gapMs, hesitationMs, profile };
}

/** 按节奏算「打这条气泡要多久」（受单条上限约束）。 */
export function typingTimeFor(text: string, plan: PacingResult): number {
  const chars = Array.from(text ?? "").length;
  if (chars <= 0) return 0;
  const raw = chars * plan.perCharMs;
  return Math.round(Math.min(raw, plan.capMs));
}
