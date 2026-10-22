/**
 * Z-Image-Turbo 远程客户端（GPU3，127.0.0.1:18111；Mac 侧默认 19111）。
 * 8 步文生图，只负责场景/照片/文字；角色一致性仍用 Qwen-Image-Edit。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("image.z-image");

export const DEFAULT_ZIMAGE_URL = "http://127.0.0.1:19111";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

export interface ZImageOptions {
  baseUrl?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface ZImageResult {
  png: Buffer;
  width?: number;
  height?: number;
  elapsedMs: number;
}

export function isZImageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.KAREN_IMAGE_BACKEND ?? "").trim().toLowerCase() === "z-image" ||
    Boolean((env.ZIMAGE_URL ?? "").trim())
  );
}

export function zImageBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ((env.ZIMAGE_URL ?? DEFAULT_ZIMAGE_URL).trim() || DEFAULT_ZIMAGE_URL).replace(/\/+$/, "");
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

export async function generateZImage(
  prompt: string,
  opts: ZImageOptions = {},
): Promise<ZImageResult | null> {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  const baseUrl = (opts.baseUrl ?? zImageBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
    MAX_TIMEOUT_MS,
  );
  const fetchFn = opts.fetchFn ?? fetch;
  const startedAt = Date.now();
  try {
    const res = await fetchFn(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        width: opts.width ?? 832,
        height: opts.height ?? 1216,
        steps: opts.steps ?? 9,
        seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("image.z_image_failed", { status: res.status });
      return null;
    }
    const png = Buffer.from(await res.arrayBuffer());
    if (!isPng(png)) {
      log.warn("image.z_image_failed", { reason: "invalid_png", bytes: png.length });
      return null;
    }
    const width = Number(res.headers.get("x-image-width"));
    const height = Number(res.headers.get("x-image-height"));
    return {
      png,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    };
  } catch (err: unknown) {
    log.warn("image.z_image_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
