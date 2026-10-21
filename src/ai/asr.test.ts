/**
 * 语音识别模块单测（v0.23）。
 *
 * 不依赖本地 whisper 服务：用 mock fetch 验证「发出去的是什么」；
 * SILK 解码用 silk-wasm 现场编码一段 PCM 再解回来，验证真实编解码链路。
 */
import { encode } from "silk-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASR_MAX_AUDIO_BYTES,
  asrServiceUrl,
  isAsrEnabled,
  isSilkBuffer,
  isWavBuffer,
  pcmToWav,
  silkToWav,
  transcribeVoice,
} from "./asr.js";

const ENV_KEYS = ["KAREN_ASR", "KAREN_ASR_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

/** 1 秒 24kHz 单声道 PCM16（简单正弦波，足够 s ILK 编解码） */
function makePcm(seconds = 1, sampleRate = 24_000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

describe("基础工具", () => {
  it("PCM → WAV 头合法（RIFF/WAVE/fmt/data 与长度正确）", () => {
    const pcm = makePcm(0.1);
    const wav = pcmToWav(pcm, 24_000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(isWavBuffer(wav)).toBe(true);
  });

  it("格式识别：WAV / SILK / 其他", async () => {
    const wav = pcmToWav(makePcm(0.1));
    expect(isWavBuffer(wav)).toBe(true);
    const silk = await encode(wav, 0);
    expect(isSilkBuffer(Buffer.from(silk.data))).toBe(true);
    expect(isSilkBuffer(Buffer.from("hello world"))).toBe(false);
    expect(isWavBuffer(Buffer.from("hello world"))).toBe(false);
  });

  it("SILK → WAV：真实编解码往返（silk-wasm）", async () => {
    const wav = pcmToWav(makePcm(0.5));
    const silk = await encode(wav, 0);
    const back = await silkToWav(Buffer.from(silk.data));
    expect(back).not.toBeNull();
    expect(isWavBuffer(back!)).toBe(true);
    expect(back!.length).toBeGreaterThan(44);
  });

  it("非法 SILK → null（不抛异常）", async () => {
    expect(await silkToWav(Buffer.from("not silk at all"))).toBeNull();
  });
});

describe("transcribeVoice：开关 / 长度 / 格式", () => {
  it("开关关着 → disabled", async () => {
    process.env.KAREN_ASR = "off";
    expect(isAsrEnabled()).toBe(false);
    const result = await transcribeVoice(pcmToWav(makePcm(0.1)));
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("空输入 → empty；超大 → too_large；垃圾 → unsupported_format", async () => {
    process.env.KAREN_ASR = "on";
    expect(await transcribeVoice(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "empty" });
    const huge = Buffer.alloc(ASR_MAX_AUDIO_BYTES + 1);
    expect(await transcribeVoice(huge)).toMatchObject({ ok: false, reason: "too_large" });
    expect(await transcribeVoice(Buffer.from("not audio"))).toMatchObject({
      ok: false,
      reason: "unsupported_format",
    });
  });

  it("服务地址默认 18085，可被 KAREN_ASR_URL 覆盖", () => {
    delete process.env.KAREN_ASR_URL;
    expect(asrServiceUrl()).toBe("http://127.0.0.1:18085");
    process.env.KAREN_ASR_URL = "http://127.0.0.1:19000/";
    expect(asrServiceUrl()).toBe("http://127.0.0.1:19000");
  });
});

describe("transcribeVoice：发出去的请求与返回处理", () => {
  it("WAV 直接 POST 给服务，返回文本被 trim", async () => {
    process.env.KAREN_ASR = "on";
    process.env.KAREN_ASR_URL = "http://asr.test";
    const fetchMock = vi.fn(async (url: string, init: { body: Uint8Array }) => {
      expect(url).toBe("http://asr.test/transcribe");
      expect(init.body[0]).toBe(0x52); // 'R'
      expect(init.body[1]).toBe(0x49); // 'I'
      return { ok: true, status: 200, json: async () => ({ text: "  明天下午三点开会  " }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribeVoice(pcmToWav(makePcm(0.1)));
    expect(result.ok).toBe(true);
    expect(result.text).toBe("明天下午三点开会");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SILK 输入会先解码成 WAV 再发（body 以 RIFF 开头）", async () => {
    process.env.KAREN_ASR = "on";
    process.env.KAREN_ASR_URL = "http://asr.test";
    const silk = await encode(pcmToWav(makePcm(0.3)), 0);
    let sawRiff = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: Uint8Array }) => {
        sawRiff = init.body[0] === 0x52 && init.body[8] === 0x57; // R...W
        return { ok: true, status: 200, json: async () => ({ text: "测试语音" }) } as unknown as Response;
      }),
    );
    const result = await transcribeVoice(Buffer.from(silk.data));
    expect(result.ok).toBe(true);
    expect(sawRiff).toBe(true);
  });

  it("服务 503 → service_503；空文本 → empty_text", async () => {
    process.env.KAREN_ASR = "on";
    process.env.KAREN_ASR_URL = "http://asr.test";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    expect(await transcribeVoice(pcmToWav(makePcm(0.1)))).toMatchObject({
      ok: false,
      reason: "service_503",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "   " }) }) as unknown as Response),
    );
    expect(await transcribeVoice(pcmToWav(makePcm(0.1)))).toMatchObject({
      ok: false,
      reason: "empty_text",
    });
  });

  it("网络异常 → service_error_*（不抛）", async () => {
    process.env.KAREN_ASR = "on";
    const err = new Error("boom");
    err.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(err)));
    expect(await transcribeVoice(pcmToWav(makePcm(0.1)))).toMatchObject({
      ok: false,
      reason: "service_error_TimeoutError",
    });
  });
});
