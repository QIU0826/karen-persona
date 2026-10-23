/**
 * 主动消息附带的低频媒体（P1-4，2026-10-23）。
 *
 * 之前主动消息只发文字 + QQ 表情；真人偶尔会主动甩一张照片/一条语音（“看这个猫”）。
 * 这里做纯函数决策：只在主动消息、亲密度够、非免打扰、冷却允许时，
 * 以很低概率把这一轮改成「语音」或「语音后补一张图」，避免变成骚扰。
 */
import { isQuietHour } from "./message-gate.js";

export type ProactiveMediaKind = "voice" | "photo" | "none";

export interface ProactiveMediaSettings {
  /** 整条主动消息改成语音的概率（默认 6%）。 */
  voiceProbability: number;
  /** 文字发完后补一张图的概率（默认 8%）。 */
  photoProbability: number;
  /** 最低亲密度（默认 5）。 */
  minCloseness: number;
  /** 语音冷却（默认 6 小时）。 */
  voiceCooldownMinutes: number;
  /** 照片冷却（默认 24 小时）。 */
  photoCooldownMinutes: number;
}

export const DEFAULT_PROACTIVE_MEDIA_SETTINGS: ProactiveMediaSettings = {
  voiceProbability: 0.06,
  photoProbability: 0.08,
  minCloseness: 5,
  voiceCooldownMinutes: 6 * 60,
  photoCooldownMinutes: 24 * 60,
};

export interface ProactiveMediaInput {
  voiceEnabled: boolean;
  photoEnabled: boolean;
  closeness: number;
  hour: number;
  quietHours?: { start: number; end: number };
  lastVoiceAt?: number;
  lastPhotoAt?: number;
  now?: number;
  random?: () => number;
}

export interface ProactiveMediaDecision {
  kind: ProactiveMediaKind;
  reason: string;
}

/** 主动媒体决策：稳定 reason 便于日志/测试；宁缺毋滥。 */
export function decideProactiveMedia(
  input: ProactiveMediaInput,
  settings: ProactiveMediaSettings = DEFAULT_PROACTIVE_MEDIA_SETTINGS,
): ProactiveMediaDecision {
  if (!input.voiceEnabled && !input.photoEnabled) {
    return { kind: "none", reason: "disabled" };
  }
  if (input.quietHours && isQuietHour(input.hour, input.quietHours)) {
    return { kind: "none", reason: "quiet_hours" };
  }
  // 深夜/凌晨不主动发媒体（即使免打扰配置没覆盖）。
  if (input.hour < 8 || input.hour >= 23) {
    return { kind: "none", reason: "late_hour" };
  }
  if (input.closeness < settings.minCloseness) {
    return { kind: "none", reason: "closeness" };
  }

  const now = input.now ?? Date.now();
  const voiceReady =
    input.voiceEnabled &&
    (input.lastVoiceAt === undefined ||
      now - input.lastVoiceAt >= settings.voiceCooldownMinutes * 60_000);
  const photoReady =
    input.photoEnabled &&
    (input.lastPhotoAt === undefined ||
      now - input.lastPhotoAt >= settings.photoCooldownMinutes * 60_000);

  const random = input.random ?? Math.random;
  const roll = random();
  if (voiceReady && roll < settings.voiceProbability) {
    return { kind: "voice", reason: "voice_roll" };
  }
  if (photoReady && roll < settings.voiceProbability + settings.photoProbability) {
    return { kind: "photo", reason: "photo_roll" };
  }
  return { kind: "none", reason: "no_roll" };
}
