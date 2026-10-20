/**
 * 发送节奏（v0.4.0）：让"她打字"的时长更像真人。
 *
 * 设计参考同类项目 ai-companion-kit 的 Humanizer：按键速度估算打字时长，
 * 并且**深夜打字更慢**（人困了、在被窝里戳屏幕）。
 *
 * 只影响气泡之间的等待时间，不影响内容、门控与记忆。
 * 纯函数（随机数可注入），方便单测与调参。
 */

/** 固定开销：读屏、点发送、网络一个来回 */
export const TYPING_BASE_MS = 300;

/** 白天封顶 3s（再长会显得卡住） */
export const TYPING_CAP_DAY_MS = 3000;

/** 深夜封顶放宽到 4.2s（困的时候确实打得慢） */
export const TYPING_CAP_NIGHT_MS = 4200;

/** 深夜变慢系数 */
export const TYPING_NIGHT_FACTOR = 1.35;

/** 20:00 以后、6:00 以前算夜间（与她的生活作息一致） */
export function isNightHour(hour: number): boolean {
  return hour >= 23 || hour < 6;
}

/**
 * 估算「把这条气泡打出来」需要多久（毫秒）。
 *
 * 中文手打约 80–120ms/字（随机抖动），叠加固定开销后夹在 0.3–3s（夜间 4.2s）。
 */
export function computeTypingDelay(
  chars: number,
  hour: number,
  rnd: () => number = Math.random,
): number {
  const safeChars = Math.max(0, Math.round(chars));
  const perChar = 80 + rnd() * 40;
  const base = TYPING_BASE_MS + safeChars * perChar + rnd() * 250;
  const night = isNightHour(hour);
  const factor = night ? TYPING_NIGHT_FACTOR : 1;
  const cap = night ? TYPING_CAP_NIGHT_MS : TYPING_CAP_DAY_MS;
  return Math.min(base * factor, cap);
}
