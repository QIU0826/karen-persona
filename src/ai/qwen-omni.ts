/**
 * Qwen2.5-Omni-7B 音频理解客户端（GPU3，Mac 隧道 19113）。
 *
 * 比 SenseVoice 多一层“语气/唱歌/阴阳怪气”的音频语义判断；
 * 但模型输出不是事实，不确定时必须按 uncertain 处理。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("asr");

export const QWEN_OMNI_DEFAULT_URL = "http://127.0.0.1:18113";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface QwenOmniResult {
  transcript: string;
  tone: string;
  emotion: string;
  singing: "yes" | "no" | "uncertain" | string;
  sarcasm: "yes" | "no" | "uncertain" | string;
  background: string;
  confidence?: number;
  durationSeconds?: number;
  elapsedMs?: number;
}

export function isQwenOmniEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.KAREN_ASR_BACKEND ?? "").trim().toLowerCase() === "qwen-omni" ||
    Boolean((env.QWEN_OMNI_URL ?? "").trim())
  );
}

export function qwenOmniUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ((env.QWEN_OMNI_URL ?? QWEN_OMNI_DEFAULT_URL).trim() || QWEN_OMNI_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

export function formatQwenOmniVoice(result: QwenOmniResult): string | null {
  const text = (result.transcript ?? "").trim();
  if (!text) return null;
  const parts = [`[语音：${text}`];
  if (result.tone) parts.push(`语气：${result.tone}`);
  if (result.emotion && result.emotion !== "uncertain") parts.push(`情绪：${result.emotion}`);
  if (result.singing === "yes") parts.push("唱歌：是");
  else if (result.singing === "uncertain") parts.push("唱歌：不确定");
  if (result.sarcasm === "yes") parts.push("阴阳怪气：可能");
  else if (result.sarcasm === "uncertain") parts.push("阴阳怪气：不确定");
  if (result.background) parts.push(`背景：${result.background}`);
  return `${parts.join("｜")}]`;
}

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export async function understandVoiceWithQwenOmni(
  wav: Buffer,
  opts: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<QwenOmniResult | null> {
  if (!isWav(wav) || wav.length === 0) return null;
  const baseUrl = (opts.baseUrl ?? qwenOmniUrl()).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${baseUrl}/understand`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("asr.qwen_omni_failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const transcript = String(data.transcript ?? "").trim();
    if (!transcript) return null;
    const confidence = Number(data.confidence);
    const duration = Number(data.duration_s);
    const elapsed = Number(data.elapsed_ms);
    return {
      transcript,
      tone: String(data.tone ?? ""),
      emotion: String(data.emotion ?? "uncertain"),
      singing: String(data.singing ?? "uncertain"),
      sarcasm: String(data.sarcasm ?? "uncertain"),
      background: String(data.background ?? ""),
      ...(Number.isFinite(confidence) ? { confidence } : {}),
      ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
      ...(Number.isFinite(elapsed) && elapsed > 0 ? { elapsedMs: elapsed } : {}),
    };
  } catch (err: unknown) {
    log.warn("asr.qwen_omni_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
