/**
 * Fun-CosyVoice 3.0 零样本克隆客户端（v0.9.16，实验性）。
 *
 * 用途：用户提供 3–10s **真人参考音** 后，把她的语音换成该音色（零样本克隆）。
 * 可信性评估见 docs/VOICE_CLONE.md：本机 CPU RTF ≈1.9–2.3x、内存 ≈8.3GB，
 * 且**合成参考音会导致复读**（真人参考音才可靠）——因此默认关闭，
 * `KAREN_TTS_BACKEND=cosyvoice` 才启用，失败自动回退 Kokoro → say。
 *
 * 环境变量：
 *   KAREN_TTS_BACKEND=cosyvoice    启用
 *   COSYVOICE_TTS_URL              默认 http://127.0.0.1:18087
 *   COSYVOICE_VOICE_ID             参考音 id（data/voice-ref/<id>.wav）；空=服务端取第一个
 *   COSYVOICE_SPEED                默认 1.15（克隆音色语速偏慢，略微加快）
 *   COSYVOICE_TTS_TIMEOUT_MS       默认 90000（CPU 合成 5s 音频约 14–20s）
 *
 * 设计约束：**绝不抛异常**，失败返回 null，由 tts.ts 回退。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("tts");

export const COSYVOICE_DEFAULT_URL = "http://127.0.0.1:18087";
const MAX_WAV_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_SPEED = 1.15;

export interface CosyVoiceSynthesisOptions {
  voiceId?: string;
  speed?: number;
  timeoutMs?: number;
  seed?: number;
  /** 自然语言控制（情绪/语气），如「请非常开心地说这句话。」；走 instruct2 路径 */
  instruct?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export interface CosyVoiceSynthesisResult {
  wav: Buffer;
  voiceId: string;
  durationMs?: number;
  elapsedMs: number;
  attempts?: number;
  verify?: string;
  /** v0.9.29：zero_shot / instruct（是否走了情绪指令） */
  mode?: "zero_shot" | "instruct";
}

export type CosyVoiceStyle = "natural" | "soft" | "lively" | "tired";

/**
 * v0.9.29：把她的语气风格翻译成 CosyVoice 的自然语言指令。
 *
 * 参考音只保音色；prosody/情绪靠 instruct2。情绪强度高时用强指令，
 * 弱时用轻指令，避免每句都像在演戏。
 */
export function buildCosyVoiceInstruct(input: {
  style?: CosyVoiceStyle;
  emotionVector?: number;
}): string | undefined {
  const style = input.style ?? "natural";
  const emo = Number(input.emotionVector ?? 0);
  const strong = Math.abs(emo) >= 0.45;
  const suffix = "<|endofprompt|>";
  if (style === "lively") {
    return strong
      ? `You are a helpful assistant. 请非常开心、带着笑意地说这句话。${suffix}`
      : `You are a helpful assistant. 请用轻快一点的语气说这句话。${suffix}`;
  }
  if (style === "soft") {
    return strong && emo < 0
      ? `You are a helpful assistant. 请用有点低落、委屈的语气说这句话。${suffix}`
      : `You are a helpful assistant. 请用温柔、轻声的语气说这句话。${suffix}`;
  }
  if (style === "tired") {
    return strong
      ? `You are a helpful assistant. 请用很困、很累、慢慢说的语气说这句话。${suffix}`
      : `You are a helpful assistant. 请用有点疲惫、放慢的语气说这句话。${suffix}`;
  }
  return `You are a helpful assistant. 请像日常聊天一样自然地说这句话。${suffix}`;
}

export function isCosyVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_TTS_BACKEND ?? "").trim().toLowerCase() === "cosyvoice";
}

export function cosyVoiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.COSYVOICE_TTS_URL ?? "").trim() || COSYVOICE_DEFAULT_URL;
  return raw.replace(/\/+$/, "");
}

export function cosyVoiceVoiceId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COSYVOICE_VOICE_ID ?? "").trim();
}

function clampedSpeed(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.COSYVOICE_SPEED ?? DEFAULT_SPEED);
  return Number.isFinite(raw) ? Math.max(0.8, Math.min(1.2, raw)) : DEFAULT_SPEED;
}

export interface CosyVoiceHealth {
  ok: boolean;
  loaded: boolean;
  voices: string[];
  sampleRate: number;
  loadError: string | null;
}

export async function checkCosyVoiceHealth(
  opts: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<CosyVoiceHealth | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${opts.baseUrl ?? cosyVoiceBaseUrl()}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return {
      ok: data.ok === true,
      loaded: data.loaded === true,
      voices: Array.isArray(data.voices) ? data.voices.map(String) : [],
      sampleRate: Number(data.sample_rate ?? 0),
      loadError: typeof data.load_error === "string" ? data.load_error : null,
    };
  } catch {
    return null;
  }
}

/** 文本 → 24kHz PCM WAV（克隆音色）。失败返回 null（不抛）。 */
export async function synthesizeWithCosyVoice(
  text: string,
  opts: CosyVoiceSynthesisOptions = {}
): Promise<CosyVoiceSynthesisResult | null> {
  const spoken = (text ?? "").trim();
  if (!spoken) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const voiceId = opts.voiceId ?? cosyVoiceVoiceId();
  const speed = Math.max(0.8, Math.min(1.2, opts.speed ?? clampedSpeed(process.env)));
  const timeoutMs = Math.max(
    10_000,
    Math.min(180_000, opts.timeoutMs ?? Number(process.env.COSYVOICE_TTS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS))
  );
  const startedAt = Date.now();
  try {
    const response = await fetchFn(`${opts.baseUrl ?? cosyVoiceBaseUrl()}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spoken,
        ...(voiceId ? { voice_id: voiceId } : {}),
        speed,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.instruct ? { instruct: opts.instruct } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log.warn("tts.cosyvoice_failed", {
        reason: "http_status",
        status: response.status,
        detail: detail.slice(0, 120),
      });
      return null;
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length < 44 || wav.length > MAX_WAV_BYTES || !isRiffWave(wav)) {
      log.warn("tts.cosyvoice_failed", { reason: "wav_invalid", bytes: wav.length });
      return null;
    }
    const duration = Number(response.headers.get("x-cosyvoice-duration-ms"));
    const attempts = Number(response.headers.get("x-cosyvoice-attempts"));
    const verify = response.headers.get("x-cosyvoice-verify") ?? undefined;
    const mode: "zero_shot" | "instruct" =
      response.headers.get("x-cosyvoice-instruct") === "1" ? "instruct" : "zero_shot";
    return {
      wav,
      voiceId: response.headers.get("x-cosyvoice-voice") ?? voiceId,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {}),
      ...(Number.isFinite(attempts) && attempts > 0 ? { attempts } : {}),
      ...(verify ? { verify } : {}),
      mode,
    };
  } catch (err) {
    log.warn("tts.cosyvoice_failed", {
      reason: "network",
      code: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

function isRiffWave(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}
