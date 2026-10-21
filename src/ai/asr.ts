/**
 * 语音识别（ASR，v0.23）：把对方发来的 QQ 语音条转成文字。
 *
 * 背景：v0.3 起她只会"发语音"，用户发来的语音一直是 `[语音]` 占位——听不懂。
 * 现在接**本机 faster-whisper 服务**（`services/asr`，默认 127.0.0.1:18085）：
 *   QQ 语音条(SILK) → silk-wasm 解码为 PCM → 包成 WAV → POST /transcribe → 文本
 *
 * 设计约束（和生图一致）：
 *  - `KAREN_ASR=on` 才启用；服务不可用/超时/解码失败 → 返回失败，调用方继续用 `[语音]` 占位；
 *  - 音频体积上限（默认 8MB）、请求超时（默认 20s），不阻塞聊天太久；
 *  - 日志只记长度/耗时，不打印识别出的正文（隐私，遵循 obs/safe-text 约定）。
 */
import { decode } from "silk-wasm";
import { createLogger } from "../obs/logger.js";

const log = createLogger("asr");

/** ASR 单条音频上限（字节）。QQ 语音条一般 <1MB，8MB 足够。 */
export const ASR_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** 调用识别服务的默认超时 */
export const ASR_DEFAULT_TIMEOUT_MS = 20_000;
/** QQ 语音条采样率（SILK 常见 24000） */
export const DEFAULT_SILK_SAMPLE_RATE = 24_000;

export function isAsrEnabled(): boolean {
  return (process.env.KAREN_ASR ?? "").toLowerCase() === "on";
}

export function asrServiceUrl(): string {
  const raw = process.env.KAREN_ASR_URL?.trim();
  return (raw && raw.length > 0 ? raw : "http://127.0.0.1:18085").replace(/\/+$/, "");
}

export interface AsrResult {
  ok: boolean;
  text?: string;
  reason?: string;
  elapsedMs?: number;
}

/** 是否是 SILK（QQ 语音条格式）：`\x02#!SILK` 或 `#!SILK` 开头 */
export function isSilkBuffer(bytes: Buffer): boolean {
  if (bytes.length < 6) return false;
  const head = bytes.subarray(0, 8).toString("latin1");
  return head.includes("#!SILK");
}

/** 是否是 WAV：RIFF....WAVE */
export function isWavBuffer(bytes: Buffer): boolean {
  return (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

/** PCM s16le 单声道 → WAV（44 字节头 + 数据） */
export function pcmToWav(pcm: Buffer, sampleRate = DEFAULT_SILK_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * SILK → WAV；失败返回 null（不改动调用方行为）。
 * @param sampleRate SILK 原始采样率（QQ 常见 24000）
 */
export async function silkToWav(
  silk: Buffer,
  sampleRate = DEFAULT_SILK_SAMPLE_RATE,
): Promise<Buffer | null> {
  try {
    const decoded = await decode(silk, sampleRate);
    const pcm = Buffer.from(decoded.data);
    if (pcm.length === 0) return null;
    return pcmToWav(pcm, sampleRate);
  } catch {
    return null;
  }
}

/**
 * 语音字节 → 文字。
 *
 * 接受 SILK（QQ 语音条）或 WAV；其他格式直接失败（本机不做任意格式转码）。
 * 任何失败都返回 `{ok:false}`，不抛异常。
 */
export async function transcribeVoice(
  bytes: Buffer,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; sampleRate?: number } = {},
): Promise<AsrResult> {
  if (!isAsrEnabled()) return { ok: false, reason: "disabled" };
  if (!bytes || bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > ASR_MAX_AUDIO_BYTES) return { ok: false, reason: "too_large" };

  let audio: Buffer;
  if (isWavBuffer(bytes)) {
    audio = bytes;
  } else if (isSilkBuffer(bytes)) {
    const wav = await silkToWav(bytes, deps.sampleRate ?? DEFAULT_SILK_SAMPLE_RATE);
    if (!wav) return { ok: false, reason: "silk_decode_failed" };
    audio = wav;
  } else {
    return { ok: false, reason: "unsupported_format" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ASR_DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${asrServiceUrl()}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `service_${res.status}` };
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? "").replace(/\s+/g, " ").trim();
    const elapsedMs = Date.now() - startedAt;
    if (!text) return { ok: false, reason: "empty_text", elapsedMs };
    log.info("asr.ok", { chars: text.length, elapsed_ms: elapsedMs });
    return { ok: true, text, elapsedMs };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    log.warn("asr.failed", { reason: `service_error_${name}` });
    return { ok: false, reason: `service_error_${name}` };
  }
}
