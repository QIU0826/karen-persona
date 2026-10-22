import { describe, expect, it, vi } from "vitest";
import {
  buildIndexTtsEmotion,
  indexTtsBaseUrl,
  isIndexTtsEnabled,
  synthesizeWithIndexTts,
} from "./indextts-tts.js";

function makeWav(): Buffer {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(40, 4);
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
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

describe("IndexTTS2 客户端", () => {
  it("开关/URL", () => {
    expect(isIndexTtsEnabled({})).toBe(false);
    expect(isIndexTtsEnabled({ KAREN_TTS_BACKEND: "cosyvoice" })).toBe(false);
    expect(isIndexTtsEnabled({ KAREN_TTS_BACKEND: "IndexTTS2" })).toBe(true);
    expect(indexTtsBaseUrl({})).toMatch(/18088/);
    expect(indexTtsBaseUrl({ INDEXTTS_TTS_URL: "http://x:1/" })).toBe("http://x:1");
  });

  it("情绪映射：natural 不传、lively/soft/tired 的 8 维向量", () => {
    expect(buildIndexTtsEmotion("natural")).toBeNull();
    const lively = buildIndexTtsEmotion("lively", 0.6)!;
    expect(lively.vector).toHaveLength(8);
    expect(lively.vector[0]).toBeGreaterThan(0.5);
    expect(lively.durationFactor).toBeLessThan(1);
    const soft = buildIndexTtsEmotion("soft", -0.6)!;
    expect(soft.vector[2]).toBeGreaterThan(0);
    expect(soft.durationFactor).toBeGreaterThan(1);
    const tired = buildIndexTtsEmotion("tired")!;
    expect(tired.vector[5]).toBeGreaterThan(0);
  });

  it("请求体带 emo_vector/alpha/duration_factor，解析 WAV", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.text).toBe("今天真开心");
      expect(body.emo_vector).toHaveLength(8);
      expect(body.emo_alpha).toBe(0.85);
      expect(body.duration_factor).toBe(0.92);
      return new Response(new Uint8Array(makeWav()), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "x-indextts-duration-ms": "2000",
        },
      });
    });
    const result = await synthesizeWithIndexTts("今天真开心", {
      emoVector: [0.85, 0, 0, 0, 0, 0, 0, 0.05],
      emoAlpha: 0.85,
      durationFactor: 0.92,
      fetchFn: fetchFn as never,
    });
    expect(result).not.toBeNull();
    expect(result!.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result!.durationMs).toBe(2000);
    expect(result!.mode).toBe("emotion");
  });

  it("500 / 非 WAV / 网络异常 → null", async () => {
    const bad = vi.fn(async () =>
      new Response(JSON.stringify({ error: "x" }), { status: 500 }),
    );
    await expect(synthesizeWithIndexTts("你好", { fetchFn: bad as never })).resolves.toBeNull();
    const notWav = vi.fn(async () => new Response("nope"));
    await expect(
      synthesizeWithIndexTts("你好", { fetchFn: notWav as never }),
    ).resolves.toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(synthesizeWithIndexTts("你好", { fetchFn: boom as never })).resolves.toBeNull();
    const noCall = vi.fn();
    await expect(synthesizeWithIndexTts("  ", { fetchFn: noCall as never })).resolves.toBeNull();
    expect(noCall).not.toHaveBeenCalled();
  });
});
