import { describe, expect, it } from "vitest";
import { decideProactiveMedia, DEFAULT_PROACTIVE_MEDIA_SETTINGS, type ProactiveMediaInput } from "./proactive-media.js";

const NOW = new Date(2026, 9, 23, 15, 0).getTime();

function input(overrides: Partial<ProactiveMediaInput> = {}): ProactiveMediaInput {
  return {
    voiceEnabled: true,
    photoEnabled: true,
    closeness: 6,
    hour: 15,
    quietHours: { start: 2, end: 7 },
    now: NOW,
    ...overrides,
  };
}

describe("decideProactiveMedia", () => {
  it("总开关关 / 免打扰 / 深夜 / 亲密度不够 → 不发", () => {
    expect(decideProactiveMedia(input({ voiceEnabled: false, photoEnabled: false })).kind).toBe("none");
    expect(decideProactiveMedia(input({ hour: 3 }))).toMatchObject({ kind: "none", reason: "quiet_hours" });
    expect(decideProactiveMedia(input({ hour: 23 }))).toMatchObject({ kind: "none", reason: "late_hour" });
    expect(decideProactiveMedia(input({ closeness: 4.9 }))).toMatchObject({ kind: "none", reason: "closeness" });
  });

  it("低概率掷中语音/照片；默认概率很低", () => {
    expect(DEFAULT_PROACTIVE_MEDIA_SETTINGS.voiceProbability).toBeLessThanOrEqual(0.1);
    expect(
      decideProactiveMedia(input({ random: () => 0.01 }), DEFAULT_PROACTIVE_MEDIA_SETTINGS),
    ).toMatchObject({ kind: "voice" });
    expect(
      decideProactiveMedia(input({ random: () => 0.1 }), DEFAULT_PROACTIVE_MEDIA_SETTINGS),
    ).toMatchObject({ kind: "photo" });
    expect(
      decideProactiveMedia(input({ random: () => 0.5 }), DEFAULT_PROACTIVE_MEDIA_SETTINGS),
    ).toMatchObject({ kind: "none" });
  });

  it("语音/照片各自冷却；冷却中不选该类型", () => {
    const recentVoice = decideProactiveMedia(
      input({ random: () => 0.01, lastVoiceAt: NOW - 60_000 }),
      DEFAULT_PROACTIVE_MEDIA_SETTINGS,
    );
    // 语音冷却时仍可能落到照片（照片自己的冷却独立判断）。
    expect(recentVoice.kind).toBe("photo");
    const recentPhoto = decideProactiveMedia(
      input({ random: () => 0.1, lastPhotoAt: NOW - 60_000 }),
      DEFAULT_PROACTIVE_MEDIA_SETTINGS,
    );
    expect(recentPhoto.kind).toBe("none");
  });

  it("语音关掉时仍可发照片；照片关掉时仍可发语音", () => {
    expect(
      decideProactiveMedia(input({ voiceEnabled: false, random: () => 0.01 })).kind,
    ).toBe("photo");
    expect(
      decideProactiveMedia(input({ photoEnabled: false, random: () => 0.01 })).kind,
    ).toBe("voice");
  });
});
