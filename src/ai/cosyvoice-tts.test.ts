import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COSYVOICE_DEFAULT_URL,
  checkCosyVoiceHealth,
  cosyVoiceBaseUrl,
  cosyVoiceVoiceId,
  isCosyVoiceEnabled,
  synthesizeWithCosyVoice,
} from "./cosyvoice-tts.js";
import { synthesizeSpeech } from "./tts.js";

function makeWav(pcmBytes = 4): Buffer {
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

function wavResponse(headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(makeWav(8)), {
    status: 200,
    headers: { "Content-Type": "audio/wav", ...headers },
  });
}

const ENV_KEYS = [
  "KAREN_TTS_BACKEND",
  "COSYVOICE_TTS_URL",
  "COSYVOICE_VOICE_ID",
  "COSYVOICE_SPEED",
  "COSYVOICE_TTS_TIMEOUT_MS",
  "KOKORO_TTS_URL",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("CosyVoice 开关与配置", () => {
  it("只有 KAREN_TTS_BACKEND=cosyvoice 才启用", () => {
    expect(isCosyVoiceEnabled({})).toBe(false);
    expect(isCosyVoiceEnabled({ KAREN_TTS_BACKEND: "kokoro" })).toBe(false);
    expect(isCosyVoiceEnabled({ KAREN_TTS_BACKEND: "CosyVoice" })).toBe(true);
  });

  it("URL/音色默认值与去斜杠", () => {
    expect(cosyVoiceBaseUrl({})).toBe(COSYVOICE_DEFAULT_URL);
    expect(cosyVoiceBaseUrl({ COSYVOICE_TTS_URL: "http://x:1/" })).toBe("http://x:1");
    expect(cosyVoiceVoiceId({})).toBe("");
    expect(cosyVoiceVoiceId({ COSYVOICE_VOICE_ID: "xiaoya" })).toBe("xiaoya");
  });
});

describe("synthesizeWithCosyVoice", () => {
  it("成功：解析 WAV 与响应头（duration/attempts/verify）", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.text).toBe("今天想你了");
      expect(body.voice_id).toBe("xiaoya");
      expect(body.speed).toBe(1.15);
      return wavResponse({
        "x-cosyvoice-duration-ms": "5960",
        "x-cosyvoice-attempts": "1",
        "x-cosyvoice-verify": "asr_cer_0.00",
        "x-cosyvoice-voice": "xiaoya",
      });
    });
    const result = await synthesizeWithCosyVoice("今天想你了", {
      voiceId: "xiaoya",
      fetchFn: fetchFn as never,
    });
    expect(result).not.toBeNull();
    expect(result!.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result!.durationMs).toBe(5960);
    expect(result!.attempts).toBe(1);
    expect(result!.verify).toBe("asr_cer_0.00");
  });

  it("500 unstable_output → null（回退 Kokoro/say）", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unstable_output" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      synthesizeWithCosyVoice("你好", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
  });

  it("非 WAV / 网络异常 / 空文本 → null", async () => {
    const notWav = vi.fn(async () => new Response("nope"));
    await expect(
      synthesizeWithCosyVoice("你好", { fetchFn: notWav as never })
    ).resolves.toBeNull();

    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      synthesizeWithCosyVoice("你好", { fetchFn: boom as never })
    ).resolves.toBeNull();

    const fetchFn = vi.fn();
    await expect(
      synthesizeWithCosyVoice("  ", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("健康检查解析字段", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          loaded: true,
          voices: ["xiaoya"],
          sample_rate: 24000,
          load_error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const health = await checkCosyVoiceHealth({ fetchFn: fetchFn as never });
    expect(health).toEqual({
      ok: true,
      loaded: true,
      voices: ["xiaoya"],
      sampleRate: 24000,
      loadError: null,
    });
  });
});

describe("tts.ts 回退链：cosyvoice → kokoro → say", () => {
  const encodeFn = async () => ({ data: new Uint8Array([1, 2, 3]), duration: 2000 });

  it("克隆失败时回退 Kokoro（KOKORO_TTS_URL 已配置）", async () => {
    process.env.KAREN_TTS_BACKEND = "cosyvoice";
    process.env.KOKORO_TTS_URL = "http://127.0.0.1:18086";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(":18087/synthesize")) throw new Error("ECONNREFUSED");
        if (url.includes(":18086/synthesize")) return wavResponse({ "x-kokoro-duration-ms": "2000" });
        return new Response("not found", { status: 404 });
      });
    const result = await synthesizeSpeech("今天想你了", {}, { encodeFn, platform: "darwin" });
    expect(result).not.toBeNull();
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes(":18087/synthesize"))).toBe(true);
    expect(urls.some((url) => url.includes(":18086/synthesize"))).toBe(true);
  });

  it("克隆成功时不再请求 Kokoro", async () => {
    process.env.KAREN_TTS_BACKEND = "cosyvoice";
    process.env.KOKORO_TTS_URL = "http://127.0.0.1:18086";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      wavResponse({ "x-cosyvoice-duration-ms": "5000" })
    );
    const result = await synthesizeSpeech("今天想你了", {}, { encodeFn, platform: "darwin" });
    expect(result).not.toBeNull();
    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes(":18087/synthesize"))).toBe(true);
    expect(urls.some((url) => url.includes(":18086/synthesize"))).toBe(false);
  });
});
