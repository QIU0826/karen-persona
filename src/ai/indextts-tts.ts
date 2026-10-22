/**
 * IndexTTS2 客户端（v0.9.31）。
 *
 * 服务在 127.0.0.1:18088（services/indextts2/server.py），模型代码/权重在仓库外。
 * 与 CosyVoice 一样只负责「文本 + 参考音 → 24k WAV」；情绪由 8 维 emo_vector 控制。
 *
 * 8 维顺序（IndexTTS2 官方）：[高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静]
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("tts");

export const INDEXTTS_DEFAULT_URL = "http://127.0.0.1:18088";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

export type IndexTtsStyle = "natural" | "soft" | "lively" | "tired";

export interface IndexTtsSynthesisOptions {
  baseUrl?: string;
  refWav?: string;
  lang?: "ZH" | "EN" | "JA" | "ES" | "AR";
  emoVector?: number[];
  emoAlpha?: number;
  durationFactor?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface IndexTtsSynthesisResult {
  wav: Buffer;
  durationMs?: number;
  elapsedMs: number;
  mode: "emotion" | "neutral";
}

export function isIndexTtsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_TTS_BACKEND ?? "").trim().toLowerCase() === "indextts2";
}

export function indexTtsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ((env.INDEXTTS_TTS_URL ?? INDEXTTS_DEFAULT_URL).trim() || INDEXTTS_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

export function indexTtsRefWav(env: NodeJS.ProcessEnv = process.env): string {
  return (env.INDEXTTS_REF_WAV ?? "").trim();
}

/**
 * 把语气风格映射成 8 维情绪向量。natural 返回 null：不传向量，让模型沿用
 * 参考音本身的语调（避免每句都「演」）。
 */
export function buildIndexTtsEmotion(
  style: IndexTtsStyle,
  emotionVector = 0,
): { vector: number[]; alpha: number; durationFactor: number } | null {
  const strong = Math.abs(emotionVector) >= 0.45;
  if (style === "natural") return null;
  if (style === "lively") {
    return {
      vector: [strong ? 0.85 : 0.6, 0, 0, 0, 0, 0, 0, strong ? 0.05 : 0.12],
      alpha: strong ? 0.85 : 0.7,
      durationFactor: 0.92,
    };
  }
  if (style === "soft") {
    return {
      vector: [0, 0, strong ? 0.55 : 0.35, 0, 0, strong ? 0.3 : 0.2, 0, 0.3],
      alpha: strong ? 0.8 : 0.65,
      durationFactor: 1.08,
    };
  }
  return {
    // tired
    vector: [0, 0, 0.2, 0, 0, strong ? 0.55 : 0.4, 0, 0.4],
    alpha: strong ? 0.8 : 0.65,
    durationFactor: 1.15,
  };
}

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 44 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

/** 调 IndexTTS2 合成；任何失败都返回 null（上层回退 Kokoro/say）。 */
export async function synthesizeWithIndexTts(
  text: string,
  opts: IndexTtsSynthesisOptions = {},
): Promise<IndexTtsSynthesisResult | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const baseUrl = (opts.baseUrl ?? indexTtsBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = clamp(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const refWav = opts.refWav ?? indexTtsRefWav();
  const body: Record<string, unknown> = {
    text: trimmed,
    lang: opts.lang ?? "ZH",
    use_random: false,
  };
  if (refWav) body.ref_wav = refWav;
  if (opts.emoVector) {
    body.emo_vector = opts.emoVector.slice(0, 8).map((v) => clamp(Number(v) || 0, 0, 1));
    body.emo_alpha = clamp(opts.emoAlpha ?? 0.8, 0, 1);
  }
  if (opts.durationFactor !== undefined) {
    body.duration_factor = clamp(opts.durationFactor, 0.5, 2);
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${baseUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn("tts.indextts_failed", { status: response.status });
      return null;
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (!isWav(wav)) {
      log.warn("tts.indextts_failed", { reason: "invalid_wav", bytes: wav.length });
      return null;
    }
    const duration = Number(response.headers.get("x-indextts-duration-ms"));
    return {
      wav,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {}),
      mode: opts.emoVector ? "emotion" : "neutral",
    };
  } catch (err) {
    log.warn("tts.indextts_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
