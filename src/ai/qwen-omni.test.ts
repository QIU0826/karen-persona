import { describe, expect, it, vi } from "vitest";
import {
  formatQwenOmniVoice,
  isQwenOmniEnabled,
  qwenOmniUrl,
  understandVoiceWithQwenOmni,
} from "./qwen-omni.js";

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(40)]);

describe("qwen-omni", () => {
  it("开关/URL", () => {
    expect(isQwenOmniEnabled({ KAREN_ASR_BACKEND: "qwen-omni" })).toBe(true);
    expect(isQwenOmniEnabled({ QWEN_OMNI_URL: "http://x" })).toBe(true);
    expect(isQwenOmniEnabled({ KAREN_ASR_BACKEND: "sensevoice" })).toBe(false);
    expect(qwenOmniUrl({ QWEN_OMNI_URL: "http://127.0.0.1:19113/" })).toBe("http://127.0.0.1:19113");
  });

  it("格式化唱歌/阴阳怪气/背景", () => {
    expect(
      formatQwenOmniVoice({
        transcript: "你再说一遍",
        tone: "压着火",
        emotion: "angry",
        singing: "no",
        sarcasm: "yes",
        background: "街道",
      }),
    ).toBe("[语音：你再说一遍｜语气：压着火｜情绪：angry｜阴阳怪气：可能｜背景：街道]");
    expect(
      formatQwenOmniVoice({
        transcript: "啦啦啦",
        tone: "轻快",
        emotion: "happy",
        singing: "yes",
        sarcasm: "uncertain",
        background: "音乐",
      }),
    ).toContain("唱歌：是");
  });

  it("请求成功/失败", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          transcript: "今天好累",
          tone: "低落",
          emotion: "sad",
          singing: "no",
          sarcasm: "uncertain",
          background: "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const result = await understandVoiceWithQwenOmni(WAV, { fetchFn, baseUrl: "http://x" });
    expect(result?.transcript).toBe("今天好累");
    expect(result?.sarcasm).toBe("uncertain");
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(understandVoiceWithQwenOmni(WAV, { fetchFn: fail })).resolves.toBeNull();
  });
});
