import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KOKORO_DEFAULT_URL,
  KOKORO_VOICES,
  checkKokoroHealth,
  isNeuralTtsEnabled,
  neuralTtsBaseUrl,
  neuralTtsVoice,
  synthesizeWithKokoro,
} from "./neural-tts.js";
import { synthesizeSpeech } from "./tts.js";

/** 最小合法 WAV（44 字节头 + 4 字节 PCM）。 */
function makeWav(pcmBytes = 4): Buffer {
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

function fakeResponse(wav: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: { "Content-Type": "audio/wav", ...headers },
  });
}

const ENV_KEYS = ["KAREN_TTS_BACKEND", "KOKORO_TTS_URL", "KOKORO_TTS_VOICE"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("神经 TTS 开关与配置", () => {
  it("默认关闭，只有 KAREN_TTS_BACKEND=kokoro 才启用", () => {
    expect(isNeuralTtsEnabled({})).toBe(false);
    expect(isNeuralTtsEnabled({ KAREN_TTS_BACKEND: "say" })).toBe(false);
    expect(isNeuralTtsEnabled({ KAREN_TTS_BACKEND: "Kokoro" })).toBe(true);
    expect(isNeuralTtsEnabled({ KAREN_TTS_BACKEND: " kokoro " })).toBe(true);
  });

  it("URL 默认 18086，去掉尾部斜杠", () => {
    expect(neuralTtsBaseUrl({})).toBe(KOKORO_DEFAULT_URL);
    expect(neuralTtsBaseUrl({ KOKORO_TTS_URL: "http://x:1/" })).toBe("http://x:1");
  });

  it("音色只接受白名单，非法值回退默认", () => {
    expect(neuralTtsVoice({})).toBe("zf_xiaoxiao");
    expect(neuralTtsVoice({ KOKORO_TTS_VOICE: "zf_xiaobei" })).toBe("zf_xiaobei");
    expect(neuralTtsVoice({ KOKORO_TTS_VOICE: "evil" })).toBe("zf_xiaoxiao");
    expect(KOKORO_VOICES).toContain("zf_xiaoyi");
  });
});

describe("synthesizeWithKokoro", () => {
  it("成功：返回 WAV、音色、时长头", async () => {
    const wav = makeWav(8);
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.text).toBe("今天店里人不多");
      expect(body.voice).toBe("zf_xiaoxiao");
      expect(body.speed).toBe(1);
      return fakeResponse(wav, { "x-kokoro-duration-ms": "4125" });
    });
    const result = await synthesizeWithKokoro("今天店里人不多", { fetchFn: fetchFn as never });
    expect(result).not.toBeNull();
    expect(result!.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result!.durationMs).toBe(4125);
    expect(result!.voice).toBe("zf_xiaoxiao");
  });

  it("HTTP 非 200 → null（交给调用方回退 say）", async () => {
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(
      synthesizeWithKokoro("你好", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
  });

  it("返回非 WAV → null", async () => {
    const fetchFn = vi.fn(async () => new Response("not-a-wav"));
    await expect(
      synthesizeWithKokoro("你好", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
  });

  it("网络异常 → null（不抛）", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      synthesizeWithKokoro("你好", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
  });

  it("空白文本不发请求", async () => {
    const fetchFn = vi.fn();
    await expect(
      synthesizeWithKokoro("   ", { fetchFn: fetchFn as never })
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("健康检查解析字段", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, loaded: true, voices: ["zf_xiaoxiao"], sr: 24000, load_error: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const health = await checkKokoroHealth({ fetchFn: fetchFn as never });
    expect(health).toEqual({ ok: true, loaded: true, voices: ["zf_xiaoxiao"], sr: 24000, loadError: null });
  });
});

describe("tts.ts 集成：kokoro 优先、say 回退", () => {
  const encodeFn = async () => ({ data: new Uint8Array([1, 2, 3, 4]), duration: 1234 });

  it("启用后走 kokoro，不调用 say", async () => {
    process.env.KAREN_TTS_BACKEND = "kokoro";
    const say = vi.fn(async () => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fakeResponse(makeWav(8), { "x-kokoro-duration-ms": "2000" }));
    const result = await synthesizeSpeech("今天想你了", {}, { runCommand: say, encodeFn, platform: "darwin" });
    expect(result).not.toBeNull();
    expect(result!.silkBase64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(result!.durationMs).toBe(1234);
    expect(say).not.toHaveBeenCalled();
    expect((fetchSpy.mock.calls[0]?.[0] as string).endsWith("/synthesize")).toBe(true);
  });

  it("kokoro 失败时静默回退 say", async () => {
    process.env.KAREN_TTS_BACKEND = "kokoro";
    const say = vi.fn(async () => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const readFile = vi.fn(async () => makeWav(8));
    const result = await synthesizeSpeech("今天想你了", {}, { runCommand: say, readFile, encodeFn, platform: "darwin" });
    expect(result).not.toBeNull();
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("未启用时不发 kokoro 请求", async () => {
    delete process.env.KAREN_TTS_BACKEND;
    const say = vi.fn(async () => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const readFile = vi.fn(async () => makeWav(8));
    const result = await synthesizeSpeech("你好", {}, { runCommand: say, readFile, encodeFn, platform: "darwin" });
    expect(result).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
  });
});
