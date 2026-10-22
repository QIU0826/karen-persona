import { describe, expect, it, vi } from "vitest";
import {
  formatVoiceUnderstanding,
  isSenseVoiceEnabled,
  senseVoiceUrl,
  understandVoice,
} from "./sensevoice.js";

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(40)]);

describe("sensevoice", () => {
  it("开关/URL", () => {
    expect(isSenseVoiceEnabled({ KAREN_ASR_BACKEND: "sensevoice" })).toBe(true);
    expect(isSenseVoiceEnabled({ SENSEVOICE_URL: "http://x" })).toBe(true);
    expect(isSenseVoiceEnabled({ KAREN_ASR_BACKEND: "whisper" })).toBe(false);
    expect(senseVoiceUrl({ SENSEVOICE_URL: "http://127.0.0.1:19112/" })).toBe("http://127.0.0.1:19112");
  });

  it("格式化成中文语气/背景", () => {
    expect(
      formatVoiceUnderstanding({
        text: "今天好累啊",
        emotion: "sad",
        events: ["speech", "breath"],
        language: "zh",
      }),
    ).toBe("[语音：今天好累啊｜语气：低落｜背景：说话、呼吸]");
    expect(formatVoiceUnderstanding({ text: "", emotion: null, events: [], language: null })).toBeNull();
  });

  it("请求成功/失败", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ text: "笑死", emotion: "happy", events: ["laughter"], language: "zh" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const result = await understandVoice(WAV, { fetchFn, baseUrl: "http://x" });
    expect(result?.emotion).toBe("happy");
    expect(result?.events).toContain("laughter");
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(understandVoice(WAV, { fetchFn: fail })).resolves.toBeNull();
  });
});
