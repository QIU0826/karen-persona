/**
 * 语音合成引擎测试（不依赖 macOS say 的 CI 安全版本）。
 *
 * - 全部默认用注入的 SpeechDeps mock：不跑 say、不联网；
 * - 真实 silk-wasm 编码用测试内构造的最小 WAV（24kHz/mono/16bit）验证；
 * - 真实 say → SILK 链路仅 darwin 跑（macOS CI 若缺 Tingting 语音则软跳过）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isSilk } from "silk-wasm";
import { configureLogger } from "../obs/logger.js";
import {
  DEFAULT_TTS_RATE,
  DEFAULT_TTS_VOICE,
  isSpeechAvailable,
  sanitizeSpeechText,
  synthesizeSpeech,
  type SpeechDeps,
} from "./tts.js";

// 失败路径会打 warn 日志：测试里静音，只保留 error 及以上
beforeEach(() => {
  configureLogger({ level: "error" });
});

// ── 测试工具 ─────────────────────────────────────

/** 构造真实最小 WAV（PCM s16le，1ch，默认 24kHz），用于真实 silk-wasm 编码测试。 */
function createWav(durationMs: number, sampleRate = 24_000): Buffer {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    // 440Hz 正弦，避免全零静音被编码器特殊处理
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    pcm.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** darwin + 可控依赖的默认 deps（不真的执行 say）。 */
function darwinDeps(overrides: Partial<SpeechDeps> = {}): SpeechDeps {
  return {
    platform: "darwin",
    runCommand: async () => {},
    readFile: async () => createWav(600),
    ...overrides,
  };
}

describe("sanitizeSpeechText", () => {
  it("去除 CQ 码、换行并压空白", () => {
    const result = sanitizeSpeechText("你好[CQ:face,id=1]呀\n\n今天  怎么样", 60);
    expect(result).not.toContain("[CQ:");
    expect(result.replace(/\s+/g, "")).toBe("你好呀今天怎么样");
  });

  it("去除 URL / 裸域名", () => {
    const result = sanitizeSpeechText("看这个 https://example.com/a?b=1 和 www.abc.com 很好笑", 60);
    expect(result).not.toContain("http");
    expect(result).not.toContain("example.com");
    expect(result).not.toContain("www.abc.com");
    expect(result).toContain("很好笑");
  });

  it("去除 emoji / 颜文字 / 常见网络表情", () => {
    const result = sanitizeSpeechText("今天好开心😀呀(╯°□°）╯ QAQ 哈哈哈", 60);
    expect(result).not.toContain("😀");
    expect(result).not.toContain("╯");
    expect(result).not.toContain("QAQ");
    expect(result.replace(/\s+/g, "")).toContain("今天好开心");
    expect(result).toContain("哈哈哈");
  });

  it("保留含正文的中文括号内容，只删纯符号块", () => {
    const result = sanitizeSpeechText("明天（周二）一起吃饭", 60);
    expect(result).toContain("周二");
  });

  it("超过上限时优先截到最后一个句末标点", () => {
    const result = sanitizeSpeechText("你好呀今天天气不错。第二句也在这里", 12);
    expect(Array.from(result).length).toBeLessThanOrEqual(12);
    expect(result.endsWith("。")).toBe(true);
    expect(result).toBe("你好呀今天天气不错。");
  });

  it("无句末标点时按字数硬截断", () => {
    const result = sanitizeSpeechText("一二三四五六七八九十", 5);
    expect(result).toBe("一二三四五");
  });

  it("空文本 / 纯标点返回空字符串", () => {
    expect(sanitizeSpeechText("", 60)).toBe("");
    expect(sanitizeSpeechText("……？！", 60)).toBe("");
    expect(sanitizeSpeechText("   \n\t ", 60)).toBe("");
  });
});

describe("isSpeechAvailable", () => {
  it("非 darwin 一律 false（不执行 which）", async () => {
    const which = vi.fn(async () => true);
    expect(await isSpeechAvailable({ platform: "linux", which })).toBe(false);
    expect(await isSpeechAvailable({ platform: "win32", which })).toBe(false);
    expect(which).not.toHaveBeenCalled();
  });

  it("darwin + which 失败 → false", async () => {
    expect(await isSpeechAvailable({ platform: "darwin", which: async () => false })).toBe(false);
  });

  it("darwin + which 成功 → true", async () => {
    expect(await isSpeechAvailable({ platform: "darwin", which: async () => true })).toBe(true);
  });

  it("which 抛异常 → false（不抛错）", async () => {
    const which = async (): Promise<boolean> => {
      throw new Error("boom");
    };
    expect(await isSpeechAvailable({ platform: "darwin", which })).toBe(false);
  });
});

describe("synthesizeSpeech（注入 deps，CI 安全）", () => {
  it("非 darwin 返回 null，且不执行命令", async () => {
    const runCommand = vi.fn(async () => {});
    const result = await synthesizeSpeech("你好呀", {}, { platform: "linux", runCommand });
    expect(result).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("空文本 / 纯标点返回 null，且不执行命令", async () => {
    const runCommand = vi.fn(async () => {});
    expect(await synthesizeSpeech("", {}, { ...darwinDeps(), runCommand })).toBeNull();
    expect(await synthesizeSpeech("……！？", {}, { ...darwinDeps(), runCommand })).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("成功链路：say 参数正确、返回 base64/duration/byteLength", async () => {
    const wav = createWav(600);
    const runCommand = vi.fn(async () => {});
    const readFile = vi.fn(async () => wav);
    const encodeFn = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      duration: 2260,
    }));

    const result = await synthesizeSpeech(
      "你好[CQ:face,id=1]呀\n今天怎么样",
      undefined,
      darwinDeps({ runCommand, readFile, encodeFn })
    );

    expect(result).not.toBeNull();
    expect(result!.silkBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(result!.durationMs).toBe(2260);
    expect(result!.byteLength).toBe(3);

    expect(runCommand).toHaveBeenCalledTimes(1);
    const [command, args, options] = runCommand.mock.calls[0] as unknown as [
      string,
      string[],
      { timeoutMs: number },
    ];
    expect(command).toBe("say");
    expect(args).toContain("-v");
    expect(args[args.indexOf("-v") + 1]).toBe(DEFAULT_TTS_VOICE);
    expect(args[args.indexOf("-r") + 1]).toBe(String(DEFAULT_TTS_RATE));
    expect(args).toContain("--file-format=WAVE");
    expect(args).toContain("--data-format=LEI16@24000");
    expect(args[args.length - 1]).toContain("你好");
    expect(args[args.length - 1]).not.toContain("[CQ:");
    expect(options.timeoutMs).toBe(8000);
  });

  it("自定义 voice/rate/maxChars/timeoutMs 生效且文本被截断", async () => {
    const runCommand = vi.fn(async () => {});
    const longText = "第一句话说的东西。第二句话说的东西。第三句话说的东西";
    const result = await synthesizeSpeech(
      longText,
      { voice: "Meijia", rate: 200, maxChars: 8, timeoutMs: 2500 },
      darwinDeps({ runCommand })
    );
    expect(result).not.toBeNull();

    const [, args, options] = runCommand.mock.calls[0] as unknown as [
      string,
      string[],
      { timeoutMs: number },
    ];
    expect(args[args.indexOf("-v") + 1]).toBe("Meijia");
    expect(args[args.indexOf("-r") + 1]).toBe("200");
    expect(options.timeoutMs).toBe(2500);
    expect(Array.from(args[args.length - 1]).length).toBeLessThanOrEqual(8);
  });

  it("临时目录在成功/失败后都会被清理", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "karen-tts-test-"));
    try {
      const result = await synthesizeSpeech("你好呀", {}, darwinDeps({ tmpDir: parent }));
      expect(result).not.toBeNull();
      expect(fs.readdirSync(parent)).toEqual([]);

      const failed = await synthesizeSpeech(
        "你好呀",
        {},
        darwinDeps({
          tmpDir: parent,
          runCommand: async () => {
            throw new Error("say failed");
          },
        })
      );
      expect(failed).toBeNull();
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("say 执行失败 → null", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({
        runCommand: async () => {
          throw new Error("say failed");
        },
      })
    );
    expect(result).toBeNull();
  });

  it("读取 WAV 失败 → null", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({
        readFile: async () => {
          throw new Error("read failed");
        },
      })
    );
    expect(result).toBeNull();
  });

  it("非法 WAV（非 RIFF/WAVE）→ null", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({ readFile: async () => Buffer.from("not a wav file") })
    );
    expect(result).toBeNull();
  });

  it("silk 编码抛错 → null", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({
        encodeFn: async () => {
          throw new Error("encode failed");
        },
      })
    );
    expect(result).toBeNull();
  });

  it("silk 超过 200KB 上限 → null", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({
        encodeFn: async () => ({ data: new Uint8Array(200 * 1024 + 1), duration: 1000 }),
      })
    );
    expect(result).toBeNull();
  });

  it("encode 未返回 duration 时按 WAV 长度兜底估算", async () => {
    const result = await synthesizeSpeech(
      "你好呀",
      {},
      darwinDeps({
        readFile: async () => createWav(1000),
        encodeFn: async () => ({ data: new Uint8Array([9, 9, 9]), duration: 0 }),
      })
    );
    expect(result).not.toBeNull();
    expect(result!.durationMs).toBeGreaterThan(800);
    expect(result!.durationMs).toBeLessThan(1200);
  });

  it("真实 silk-wasm 编码：输出的 base64 能通过 isSilk 检测", async () => {
    const result = await synthesizeSpeech(
      "你好呀，今天过得怎么样？",
      {},
      darwinDeps({ readFile: async () => createWav(800) }) // 不注入 encodeFn → 走真实 silk-wasm
    );
    expect(result).not.toBeNull();
    const silk = Buffer.from(result!.silkBase64, "base64");
    expect(isSilk(silk)).toBe(true);
    expect(result!.byteLength).toBe(silk.length);
    expect(result!.durationMs).toBeGreaterThan(0);
  });
});

// ── 真实 macOS 链路（仅 darwin 跑；CI 其它平台 skip）────────

describe("真实 say → SILK 链路（darwin only）", () => {
  it.skipIf(process.platform !== "darwin")("say 合成 + silk 编码真实跑通", async () => {
    const available = await isSpeechAvailable();
    if (!available) return; // 无 say 环境（理论上不会发生在 darwin）

    const result = await synthesizeSpeech("你好呀，今天过得怎么样？");
    // md 上没装 Tingting 语音的 CI 机器可能失败：软跳过而不是误报红
    if (!result) return;

    const silk = Buffer.from(result.silkBase64, "base64");
    expect(isSilk(silk)).toBe(true);
    expect(result.byteLength).toBe(silk.length);
    expect(result.durationMs).toBeGreaterThan(300);
    expect(result.byteLength).toBeGreaterThan(1000);
  });
});

// 保持 afterAll 引用，避免 lint 对未使用导入报错（vitest 全局钩子）
afterAll(() => {
  configureLogger({ level: "info" });
});
