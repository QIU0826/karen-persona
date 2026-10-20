/**
 * 语音消息引擎（TTS → SILK）——v0.3「语音消息」底层能力。
 *
 * 链路：文本（已清洗）→ macOS `say` 合成 24kHz/1ch/Int16 WAV → silk-wasm 编码
 * → base64（QQ/OneBot 语音消息 `record` 段需要 `base64://<silk>`）。
 *
 * 设计约束：
 * - 仅 macOS 有 `say`；非 darwin / say 不存在时 `isSpeechAvailable()` 返回 false，
 *   `synthesizeSpeech()` 返回 null（调用方静默降级为文字）；
 * - **绝不抛异常**：任何失败都返回 null，只记录安全的原因字符串（不打印正文）；
 * - 临时 WAV 用 `os.tmpdir()` + `mkdtemp`，`finally` 清理，失败也不残留；
 * - 文本长度上限默认 60 字、合成超时默认 8s、SILK 体积上限 200KB；
 * - CI（Linux/Windows）无 say：单测通过注入 `SpeechDeps` 完全 mock，
 *   真实链路测试仅 `it.skipIf(process.platform !== "darwin")` 时运行。
 *
 * 本模块不接入主流程；由 bridge 在文字回复后按决策层（`impulse/voice.ts`）
 * 决定是否发送，并通过 `recording` 段/`record` 消息发送 base64 SILK。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encode as encodeSilk } from "silk-wasm";
import { createLogger } from "../obs/logger.js";
import { buildSayText, planSpeechStyle, type SpeechStyle } from "./tts-style.js";

const log = createLogger("tts");

// ── 常量 ────────────────────────────────────────

/** 默认发音人（macOS 中文女声，系统自带）。 */
export const DEFAULT_TTS_VOICE = "Tingting";
/** 默认语速（字/分钟，实测 185 接近自然语速）。 */
export const DEFAULT_TTS_RATE = 185;
/** 单次语音文本上限（字）。 */
export const DEFAULT_TTS_MAX_CHARS = 60;
/** 单次合成超时。 */
const DEFAULT_TTS_TIMEOUT_MS = 8_000;
const MIN_TTS_TIMEOUT_MS = 1_000;
const MAX_TTS_TIMEOUT_MS = 30_000;
/** say 输出 WAV 的固定格式。 */
const TTS_SAMPLE_RATE = 24_000;
const TTS_BYTES_PER_SAMPLE = 2;
/** SILK 体积上限（QQ 语音消息实际限制远大于此；200KB 已足够 ~60s）。 */
const MAX_SILK_BYTES = 200 * 1024;

// ── 对外类型 ─────────────────────────────────────

/** 本次合成用了什么语气（便于日志/调试；不影响调用方逻辑）。 */
export interface SpeechStyleSummary {
  style: SpeechStyle;
  rate: number;
  pitch: number;
  addedPauseMs: number;
  usedFiller: boolean;
}

export interface SpeechResult {
  /** `base64://` 后面的内容；调用方拼成 `[CQ:record,file=base64://…]`。 */
  silkBase64: string;
  /** 语音时长（毫秒），可用于「录音中」占位时长 / 延迟估算。 */
  durationMs: number;
  /** SILK 二进制字节数（base64 解码后长度）。 */
  byteLength: number;
  /** v0.4.1：这次念出来是什么语气 */
  style?: SpeechStyleSummary;
}

export interface SpeechOptions {
  /** macOS say 发音人，默认 Tingting。 */
  voice?: string;
  /** 语速，默认 185（clamp 100-300）。 */
  rate?: number;
  /** 文本上限（字），默认 60（clamp 1-200）。 */
  maxChars?: number;
  /** 合成超时（毫秒），默认 8000（clamp 1000-30000）。 */
  timeoutMs?: number;
  /**
   * v0.4.1：语气润色入参（情绪/时间/亲密度）。
   * 不传 `hour` 时按「自然」处理；`styleEnabled: false` 可整体关闭（A/B 用）。
   */
  style?: {
    emotionVector?: number;
    hour?: number;
    closeness?: number;
    fillerProbability?: number;
  };
  /** 是否启用语气润色（默认 true） */
  styleEnabled?: boolean;
}

/**
 * 可注入依赖（测试/无 say 环境用；生产全部用默认实现）。
 * 注意：注入 `platform` 时不会真的检查 say 是否存在，由调用方保证。
 */
export interface SpeechDeps {
  /** 执行系统命令，默认 execFile 的 Promise 封装。 */
  runCommand?: (
    command: string,
    args: string[],
    options: { timeoutMs: number }
  ) => Promise<void>;
  /** 读取 WAV 文件，默认 fs.readFile。 */
  readFile?: (filePath: string) => Promise<Buffer>;
  /** SILK 编码，默认 silk-wasm `encode(wav, 0)`。 */
  encodeFn?: (wav: Buffer) => Promise<{ data: Uint8Array; duration: number }>;
  /** 平台覆盖（测试用），默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** say 可用性探测（synthesizeSpeech 内不做探测；保留给测试/调用方复用）。 */
  which?: (command: string) => Promise<boolean>;
  /** 临时目录父路径（测试用），默认 os.tmpdir()。 */
  tmpDir?: string;
}

// ── 默认依赖实现 ─────────────────────────────────

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function defaultWhich(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "which",
      [command],
      { timeout: 2_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(!err && stdout.trim().length > 0)
    );
  });
}

function defaultEncodeFn(wav: Buffer): Promise<{ data: Uint8Array; duration: number }> {
  // sampleRate=0：输入是 WAV，由 silk-wasm 自己读取采样率
  return encodeSilk(wav, 0);
}

// ── 工具函数 ─────────────────────────────────────

function charCount(text: string): number {
  return Array.from(text).length;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 安全错误码/类型（绝不返回可能包含正文的 error.message）。 */
function safeErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const record = err as { code?: unknown; name?: unknown; killed?: unknown };
  if (record.killed === true) return "timeout";
  if (typeof record.code === "string" && record.code.length > 0) return record.code.slice(0, 40);
  if (typeof record.name === "string" && record.name.length > 0) return record.name.slice(0, 40);
  return "unknown";
}

/** 检查 WAV 头（RIFF....WAVE）。 */
function isWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

/** 兜底估算时长（WAV 为 24kHz/mono/16bit；仅在 silk 未返回 duration 时使用）。 */
function estimateDurationMs(wav: Buffer): number {
  const pcmBytes = Math.max(0, wav.length - 44);
  return Math.round((pcmBytes / (TTS_SAMPLE_RATE * TTS_BYTES_PER_SAMPLE)) * 1000);
}

// ── 文本清洗 ─────────────────────────────────────

/** CQ 码（`[CQ:face,id=1]` 等）。 */
const CQ_CODE_PATTERN = /\[CQ:[^\]]*\]/gi;
/** URL / 裸域名。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
/** Emoji / 变体选择符 / ZWJ。 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}]/gu;
/** 常见 ASCII 颜文字 / 网络表情。 */
const ASCII_EMOTICON_PATTERN =
  /(?:\^[_^]?\^|T[._-]?T|QAQ|>[_<]+<|orz|0_0|o_O|O_o|=_=|\([^()\u4e00-\u9fff]{0,3}\))/gi;
/** 纯符号括号块（颜文字主体，如 `(╯°□°）╯` 的括号部分）。 */
const PURE_SYMBOL_BRACKETS = /[（(][^（）()\n]{0,20}[）)]/g;
/** 常见颜文字符号串（中文正文基本不会出现）。 */
const KAOMOJI_SYMBOL_RUN = /[╯╰▽△▲▼◆◇★☆♪♫￣╥﹏╳╬]{1,}/g;
/** 句末标点（用于超长截断时优先在句号处切）。 */
const SENTENCE_END_CHARS = "。！？!?；;…";

/**
 * 把回复文本清洗成「适合念出来」的一句话。
 *
 * 处理：去 CQ 码 / URL / emoji / 颜文字（含纯符号括号块与常见符号串）/
 * 换行与控制字符 → 压空白；超过 maxChars 时优先截到最后一个句末标点。
 * 返回空字符串表示没有可念内容。
 */
export function sanitizeSpeechText(text: string, maxChars: number): string {
  const limit = clampInt(maxChars, 1, 200, DEFAULT_TTS_MAX_CHARS);
  if (!text) return "";

  let cleaned = String(text);
  cleaned = cleaned.replace(CQ_CODE_PATTERN, " ");
  cleaned = cleaned.replace(URL_PATTERN, " ");
  cleaned = cleaned.replace(EMOJI_PATTERN, " ");
  // 只删除「括号内不含中日韩文字/字母/数字」的纯符号块（避免误删「（明天）」这类正文）
  cleaned = cleaned.replace(PURE_SYMBOL_BRACKETS, (block) =>
    /[\u4e00-\u9fffA-Za-z0-9]/.test(block) ? block : " "
  );
  cleaned = cleaned.replace(ASCII_EMOTICON_PATTERN, " ");
  cleaned = cleaned.replace(KAOMOJI_SYMBOL_RUN, " ");
  // 换行/制表/控制字符 → 空格，再压连续空白
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  // 去掉 markdown / 列表符号（念出来会很怪）
  cleaned = cleaned.replace(/^[-*•·#>\s]+/, "").replace(/[~`]/g, "").trim();
  // 只剩标点/符号时视为无内容
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(cleaned)) return "";

  const chars = Array.from(cleaned);
  if (chars.length <= limit) return cleaned;

  const sliced = chars.slice(0, limit);
  let cutIndex = -1;
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (SENTENCE_END_CHARS.includes(sliced[i])) {
      cutIndex = i;
      break;
    }
  }
  const truncated = cutIndex >= 0 ? sliced.slice(0, cutIndex + 1).join("") : sliced.join("");
  return truncated.replace(/[，,、\s]+$/g, "").trim();
}

// ── say 可用性 ───────────────────────────────────

/**
 * 当前环境能否合成语音（macOS + 可用的 say）。
 * 建议调用方在启动时探测一次并缓存结果；本函数不缓存，避免隐式全局状态。
 */
export async function isSpeechAvailable(
  opts: { platform?: NodeJS.Platform; which?: (command: string) => Promise<boolean> } = {}
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return false;
  const which = opts.which ?? defaultWhich;
  try {
    return await which("say");
  } catch {
    return false;
  }
}

// ── 合成主入口 ───────────────────────────────────

/**
 * 文本 → SILK base64。失败（无 say/超时/编码失败/体积超限/空文本）返回 null，
 * **绝不抛异常**；失败只记录安全的 reason（不含正文）。
 */
export async function synthesizeSpeech(
  text: string,
  opts: SpeechOptions = {},
  deps: SpeechDeps = {}
): Promise<SpeechResult | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    log.debug("tts.skipped", { reason: "platform_unsupported", platform });
    return null;
  }

  const maxChars = clampInt(opts.maxChars, 1, 200, DEFAULT_TTS_MAX_CHARS);
  const timeoutMs = clampInt(
    opts.timeoutMs,
    MIN_TTS_TIMEOUT_MS,
    MAX_TTS_TIMEOUT_MS,
    DEFAULT_TTS_TIMEOUT_MS
  );
  const voice = (opts.voice ?? DEFAULT_TTS_VOICE).trim() || DEFAULT_TTS_VOICE;
  const rate = clampInt(opts.rate, 100, 300, DEFAULT_TTS_RATE);

  const spoken = sanitizeSpeechText(text ?? "", maxChars);
  if (!spoken) {
    log.debug("tts.skipped", { reason: "empty_text" });
    return null;
  }

  // v0.4.1：语气润色（语速/音高/停顿/语气词），让念出来不像朗读
  const plan =
    opts.styleEnabled === false
      ? null
      : planSpeechStyle({
          text: spoken,
          baseRate: rate,
          emotionVector: opts.style?.emotionVector,
          hour: opts.style?.hour,
          closeness: opts.style?.closeness,
          fillerProbability: opts.style?.fillerProbability,
        });
  const sayText = plan ? buildSayText(plan) : spoken;
  const finalRate = plan ? plan.rate : rate;
  if (plan) {
    log.debug("tts.style", {
      style: plan.style,
      rate: plan.rate,
      pitch: plan.pitch,
      pause_ms: plan.addedPauseMs,
      filler: plan.usedFiller,
    });
  }

  let tempDir: string | null = null;
  try {
    tempDir = await fs.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), "karen-tts-"));
    const wavPath = path.join(tempDir, "speech.wav");
    const runCommand = deps.runCommand ?? defaultRunCommand;
    const args = [
      "-v",
      voice,
      "-r",
      String(finalRate),
      "-o",
      wavPath,
      "--file-format=WAVE",
      "--data-format=LEI16@24000",
      sayText,
    ];

    try {
      await runCommand("say", args, { timeoutMs });
    } catch (err) {
      log.warn("tts.failed", { reason: "say_failed", code: safeErrorCode(err) });
      return null;
    }

    const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath));
    let wav: Buffer;
    try {
      wav = await readFile(wavPath);
    } catch (err) {
      log.warn("tts.failed", { reason: "wav_read_failed", code: safeErrorCode(err) });
      return null;
    }
    if (!isWavBuffer(wav)) {
      log.warn("tts.failed", { reason: "wav_invalid", bytes: wav.length });
      return null;
    }

    const encodeFn = deps.encodeFn ?? defaultEncodeFn;
    let encoded: { data: Uint8Array; duration: number };
    try {
      encoded = await encodeFn(wav);
    } catch (err) {
      log.warn("tts.failed", { reason: "silk_encode_failed", code: safeErrorCode(err) });
      return null;
    }

    const data = encoded?.data;
    if (!data || data.byteLength === 0) {
      log.warn("tts.failed", { reason: "silk_empty" });
      return null;
    }
    if (data.byteLength > MAX_SILK_BYTES) {
      log.warn("tts.failed", { reason: "silk_too_large", bytes: data.byteLength });
      return null;
    }

    const encodedDuration = Number(encoded.duration);
    const durationMs = Math.max(
      0,
      Math.round(Number.isFinite(encodedDuration) && encodedDuration > 0
        ? encodedDuration
        : estimateDurationMs(wav))
    );
    if (durationMs <= 0) {
      log.warn("tts.failed", { reason: "duration_invalid" });
      return null;
    }

    const silkBase64 = Buffer.from(data).toString("base64");
    log.debug("tts.ok", {
      chars: charCount(spoken),
      duration_ms: durationMs,
      silk_bytes: data.byteLength,
      base64_len: silkBase64.length,
    });
    return {
      silkBase64,
      durationMs,
      byteLength: data.byteLength,
      ...(plan
        ? {
            style: {
              style: plan.style,
              rate: plan.rate,
              pitch: plan.pitch,
              addedPauseMs: plan.addedPauseMs,
              usedFiller: plan.usedFiller,
            },
          }
        : {}),
    };
  } catch (err) {
    log.warn("tts.failed", { reason: "unexpected", code: safeErrorCode(err) });
    return null;
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结果（temp 目录会被系统回收）
      }
    }
  }
}
