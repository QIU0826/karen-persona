/**
 * VoxCPM2 远程 TTS 客户端（GPU2，48kHz）。
 *
 * 服务：deploy/gpu-server/voxcpm2；Mac 侧隧道 19102 -> 服务器 18102。
 * 只负责「文本 + 风格 → 48k WAV」；失败返回 null，由 tts.ts 回退 Kokoro/say。
 *
 * 环境变量：
 *   KAREN_TTS_BACKEND=voxcpm2
 *   VOXCPM2_TTS_URL              默认 http://127.0.0.1:18102（Mac 生产用 19102）
 *   VOXCPM2_TIMEOUT_MS           默认 60000
 *   VOXCPM2_CFG_VALUE            默认 2.0
 *   VOXCPM2_STEPS                默认 10
 */
import { createLogger } from "../obs/logger.js";
import type { SpeechStyle } from "./tts-style.js";

const log = createLogger("tts");

export const VOXCPM2_DEFAULT_URL = "http://127.0.0.1:18102";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_WAV_BYTES = 8 * 1024 * 1024;

export interface VoxCpm2SynthesisOptions {
  baseUrl?: string;
  style?: string;
  cfgValue?: number;
  inferenceTimesteps?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface VoxCpm2SynthesisResult {
  wav: Buffer;
  durationMs?: number;
  sampleRate?: number;
  elapsedMs: number;
}

export function isVoxCpm2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = (env.KAREN_TTS_BACKEND ?? "").trim().toLowerCase();
  return backend === "voxcpm2" || backend === "voxcpm";
}

export function voxCpm2BaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    ((env.VOXCPM2_TTS_URL ?? "").trim() || VOXCPM2_DEFAULT_URL).replace(/\/+$/, "")
  );
}

/** 语气风格 → 给 VoxCPM2 的自然语言风格（服务会拼成 `(style)text`）。 */
export function buildVoxCpm2Style(
  style: SpeechStyle,
  emotionVector = 0,
): string | undefined {
  const strong = Math.abs(emotionVector) >= 0.45;
  switch (style) {
    case "lively":
      return strong ? "very happy, lively and smiling" : "slightly cheerful and light";
    case "soft":
      return strong && emotionVector < 0 ? "soft, slightly sad and quiet" : "gentle and soft";
    case "tired":
      return strong ? "very tired, slow and sleepy" : "a little tired and slow";
    default:
      return undefined;
  }
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 44 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export async function synthesizeWithVoxCpm2(
  text: string,
  opts: VoxCpm2SynthesisOptions = {},
): Promise<VoxCpm2SynthesisResult | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const baseUrl = (opts.baseUrl ?? voxCpm2BaseUrl()).replace(/\/+$/, "");
  const timeoutMs = clamp(
    opts.timeoutMs ?? Number(process.env.VOXCPM2_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    5_000,
    MAX_TIMEOUT_MS,
  );
  const cfgValue = clamp(
    opts.cfgValue ?? Number(process.env.VOXCPM2_CFG_VALUE ?? 2.0),
    1.0,
    3.0,
  );
  const steps = clamp(
    opts.inferenceTimesteps ?? Number(process.env.VOXCPM2_STEPS ?? 10),
    4,
    32,
  );
  const fetchFn = opts.fetchFn ?? fetch;
  const startedAt = Date.now();
  try {
    const response = await fetchFn(`${baseUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: trimmed,
        ...(opts.style ? { style: opts.style } : {}),
        cfg_value: cfgValue,
        inference_timesteps: steps,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.warn("tts.voxcpm2_failed", { status: response.status });
      return null;
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (!isWav(wav) || wav.length > MAX_WAV_BYTES) {
      log.warn("tts.voxcpm2_failed", { reason: "invalid_wav", bytes: wav.length });
      return null;
    }
    const seconds = Number(response.headers.get("x-audio-seconds"));
    const sampleRate = Number(response.headers.get("x-sample-rate"));
    return {
      wav,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(seconds) && seconds > 0 ? { durationMs: Math.round(seconds * 1000) } : {}),
      ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
    };
  } catch (err: unknown) {
    log.warn("tts.voxcpm2_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
