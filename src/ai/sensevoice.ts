/**
 * SenseVoiceSmall 远程客户端（GPU3，ASR + 情绪 + 音频事件）。
 *
 * 与 faster-whisper 的区别：返回 text + emotion + events，让聊天模型知道
 * “语气/笑声/背景音乐”等非文字信息。它仍不是完整音频大模型，不能稳定识别阴阳怪气。
 *
 * 服务：deploy/gpu-server/sensevoice；Mac 隧道 19112 -> 服务器 18112。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("asr");

export const SENSEVOICE_DEFAULT_URL = "http://127.0.0.1:18112";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SenseVoiceResult {
  text: string;
  emotion: string | null;
  events: string[];
  language: string | null;
  durationSeconds?: number;
  elapsedMs?: number;
}

export function isSenseVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.KAREN_ASR_BACKEND ?? "").trim().toLowerCase() === "sensevoice" ||
    Boolean((env.SENSEVOICE_URL ?? "").trim())
  );
}

export function senseVoiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ((env.SENSEVOICE_URL ?? SENSEVOICE_DEFAULT_URL).trim() || SENSEVOICE_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

const EMOTION_ZH: Record<string, string> = {
  happy: "开心",
  sad: "低落",
  angry: "生气",
  neutral: "中性",
  fearful: "害怕",
  disgusted: "嫌弃",
  surprised: "惊讶",
};

const EVENT_ZH: Record<string, string> = {
  speech: "说话",
  bgm: "背景音乐",
  music: "音乐",
  applause: "掌声",
  laughter: "笑声",
  crying: "哭声",
  cough: "咳嗽",
  sneeze: "喷嚏",
  breath: "呼吸",
};

/** 把 SenseVoice 结果拼成聊天可用的语音标签；无 text 返回 null。 */
export function formatVoiceUnderstanding(result: SenseVoiceResult): string | null {
  const text = (result.text ?? "").trim();
  if (!text) return null;
  const parts = [`[语音：${text}`];
  if (result.emotion) parts.push(`语气：${EMOTION_ZH[result.emotion] ?? result.emotion}`);
  const events = (result.events ?? [])
    .map((e) => EVENT_ZH[e.toLowerCase()] ?? e)
    .filter((e, i, arr) => arr.indexOf(e) === i);
  if (events.length > 0) parts.push(`背景：${events.join("、")}`);
  return `${parts.join("｜")}]`;
}

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

/** 调 SenseVoice 理解 WAV；失败返回 null。 */
export async function understandVoice(
  wav: Buffer,
  opts: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<SenseVoiceResult | null> {
  if (!isWav(wav) || wav.length === 0) return null;
  const baseUrl = (opts.baseUrl ?? senseVoiceUrl()).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${baseUrl}/understand`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(
        opts.timeoutMs ?? Number(process.env.SENSEVOICE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
      ),
    });
    if (!res.ok) {
      log.warn("asr.sensevoice_failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      text?: unknown;
      emotion?: unknown;
      events?: unknown;
      language?: unknown;
      duration_s?: unknown;
      elapsed_ms?: unknown;
    };
    const text = typeof data.text === "string" ? data.text.replace(/\s+/g, " ").trim() : "";
    if (!text) return null;
    const duration = Number(data.duration_s);
    const elapsed = Number(data.elapsed_ms);
    return {
      text,
      emotion: typeof data.emotion === "string" ? data.emotion : null,
      events: Array.isArray(data.events) ? data.events.map(String) : [],
      language: typeof data.language === "string" ? data.language : null,
      ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
      ...(Number.isFinite(elapsed) && elapsed > 0 ? { elapsedMs: elapsed } : {}),
    };
  } catch (err: unknown) {
    log.warn("asr.sensevoice_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
