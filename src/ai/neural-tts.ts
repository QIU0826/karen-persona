/**
 * 神经 TTS（Kokoro）客户端（v0.9.15）。
 *
 * 背景：她发语音用 macOS `say -v Tingting`，音色偏 AI。本模块把「文本 → WAV」
 * 换成**本机开源神经 TTS**（`services/kokoro`，Apache-2.0 的 Kokoro-82M + 中文少女音色），
 * 再由既有 `silk-wasm` 链路编码成 QQ 语音条。系统 TTS 保留为回退。
 *
 * 开关（默认关闭，保证不改变现有部署行为）：
 *   KAREN_TTS_BACKEND=kokoro    启用
 *   KOKORO_TTS_URL             默认 http://127.0.0.1:18086
 *   KOKORO_TTS_VOICE           默认 zf_xiaoxiao（可选 zf_xiaobei / zf_xiaoyi）
 *
 * 设计约束：**绝不抛异常**——服务没起/超时/返回非 WAV 一律返回 null，
 * 由调用方回退到 `say`（与既有多媒体链路的「失败静默回退」一致）。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("tts");

/** 本机 Kokoro 服务默认地址。 */
export const KOKORO_DEFAULT_URL = "http://127.0.0.1:18086";
/** 已验证可用（ASR CER ≤3.1%）的中文音色；zf_xiaoni 实测不可用。 */
export const KOKORO_VOICES = ["zf_xiaoxiao", "zf_xiaobei", "zf_xiaoyi"] as const;
export type KokoroVoice = (typeof KOKORO_VOICES)[number];
export const KOKORO_DEFAULT_VOICE: KokoroVoice = "zf_xiaoxiao";
/** 单次返回 WAV 体积上限（防异常服务撑爆内存）。 */
const MAX_WAV_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface KokoroSynthesisOptions {
  voice?: string;
  /** 0.7–1.3，默认 1.0 */
  speed?: number;
  timeoutMs?: number;
  /** 测试注入 */
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export interface KokoroSynthesisResult {
  wav: Buffer;
  voice: string;
  elapsedMs: number;
  durationMs?: number;
}

/** 是否启用神经 TTS（默认关：`KAREN_TTS_BACKEND=kokoro` 才开）。 */
export function isNeuralTtsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_TTS_BACKEND ?? "").trim().toLowerCase() === "kokoro";
}

export function neuralTtsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.KOKORO_TTS_URL ?? "").trim() || KOKORO_DEFAULT_URL;
  return raw.replace(/\/+$/, "");
}

export function neuralTtsVoice(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.KOKORO_TTS_VOICE ?? "").trim();
  return (KOKORO_VOICES as readonly string[]).includes(raw) ? raw : KOKORO_DEFAULT_VOICE;
}

export interface KokoroHealth {
  ok: boolean;
  loaded: boolean;
  voices: string[];
  sr: number;
  loadError: string | null;
}

/** 健康检查（用于 smoke / 启动自检；失败返回 null）。 */
export async function checkKokoroHealth(
  opts: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<KokoroHealth | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2_000);
  try {
    const response = await fetchFn(`${opts.baseUrl ?? neuralTtsBaseUrl()}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return {
      ok: data.ok === true,
      loaded: data.loaded === true,
      voices: Array.isArray(data.voices) ? data.voices.map(String) : [],
      sr: Number(data.sr ?? 0),
      loadError: typeof data.load_error === "string" ? data.load_error : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 文本 → 24kHz PCM WAV。失败返回 null（不抛）。
 * 只做 HTTP 调用与格式校验，不做文本清洗（调用方已清洗）。
 */
export async function synthesizeWithKokoro(
  text: string,
  opts: KokoroSynthesisOptions = {}
): Promise<KokoroSynthesisResult | null> {
  const spoken = (text ?? "").trim();
  if (!spoken) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const voice = opts.voice && (KOKORO_VOICES as readonly string[]).includes(opts.voice)
    ? opts.voice
    : neuralTtsVoice();
  const speed = Math.max(0.7, Math.min(1.3, opts.speed ?? 1));
  const timeoutMs = Math.max(1_000, Math.min(30_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchFn(`${opts.baseUrl ?? neuralTtsBaseUrl()}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, voice, speed }),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn("tts.kokoro_failed", { reason: "http_status", status: response.status });
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const wav = Buffer.from(arrayBuffer);
    if (wav.length < 44 || wav.length > MAX_WAV_BYTES || !isRiffWave(wav)) {
      log.warn("tts.kokoro_failed", { reason: "wav_invalid", bytes: wav.length });
      return null;
    }
    const durationHeader = Number(response.headers.get("x-kokoro-duration-ms"));
    return {
      wav,
      voice,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(durationHeader) && durationHeader > 0
        ? { durationMs: durationHeader }
        : {}),
    };
  } catch (err) {
    log.warn("tts.kokoro_failed", {
      reason: "network",
      code: err instanceof Error ? err.name : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRiffWave(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  return (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}
