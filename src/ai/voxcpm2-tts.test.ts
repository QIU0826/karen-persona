import { describe, expect, it, vi } from "vitest";
import {
  buildVoxCpm2Style,
  isVoxCpm2Enabled,
  synthesizeWithVoxCpm2,
  voxCpm2BaseUrl,
} from "./voxcpm2-tts.js";

const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(40),
]);

describe("voxcpm2-tts", () => {
  it("只有 backend=voxcpm2/voxcpm 才启用", () => {
    expect(isVoxCpm2Enabled({ KAREN_TTS_BACKEND: "voxcpm2" })).toBe(true);
    expect(isVoxCpm2Enabled({ KAREN_TTS_BACKEND: "VoxCPM" })).toBe(true);
    expect(isVoxCpm2Enabled({ KAREN_TTS_BACKEND: "indextts2" })).toBe(false);
    expect(voxCpm2BaseUrl({ VOXCPM2_TTS_URL: "http://127.0.0.1:19102/" })).toBe(
      "http://127.0.0.1:19102",
    );
  });

  it("风格映射成自然语言", () => {
    expect(buildVoxCpm2Style("natural")).toBeUndefined();
    expect(buildVoxCpm2Style("lively", 0.6)).toContain("happy");
    expect(buildVoxCpm2Style("soft")).toContain("gentle");
    expect(buildVoxCpm2Style("tired")).toContain("tired");
  });

  it("成功请求返回 WAV/时长", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(WAV, {
        status: 200,
        headers: { "x-audio-seconds": "3.500", "x-sample-rate": "48000" },
      }),
    ) as unknown as typeof fetch;
    const result = await synthesizeWithVoxCpm2("今天天气真好", {
      fetchFn,
      baseUrl: "http://127.0.0.1:19102",
      style: "gentle and soft",
    });
    expect(result?.wav.equals(WAV)).toBe(true);
    expect(result?.durationMs).toBe(3500);
    expect(result?.sampleRate).toBe(48000);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "今天天气真好",
      style: "gentle and soft",
    });
  });

  it("非 WAV/HTTP 失败返回 null", async () => {
    const bad = vi.fn(async () => new Response("no", { status: 200 })) as unknown as typeof fetch;
    await expect(synthesizeWithVoxCpm2("x", { fetchFn: bad })).resolves.toBeNull();
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(synthesizeWithVoxCpm2("x", { fetchFn: fail })).resolves.toBeNull();
  });
});
