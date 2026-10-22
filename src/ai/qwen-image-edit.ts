/**
 * Qwen-Image-Edit-2511 远程客户端（GPU2，127.0.0.1:18110；Mac 侧默认 19110）。
 *
 * 只负责「prompt + 参考图 → PNG」；生成后的上下文/异常检查在 image-guard.ts。
 * 失败返回 null，不抛异常；调用方决定重试/回退。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("image.qwen-edit");

export const DEFAULT_QWEN_IMAGE_EDIT_URL = "http://127.0.0.1:19110";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

export interface QwenImageEditOptions {
  baseUrl?: string;
  simple?: boolean;
  /** 覆盖默认参考图（服务器绝对路径）；自拍统一画风时传 cafe 自拍 */
  imagePaths?: string[];
  steps?: number;
  seed?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface QwenImageEditResult {
  png: Buffer;
  width?: number;
  height?: number;
  elapsedMs: number;
}

export function isQwenImageEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.KAREN_IMAGE_BACKEND ?? "").trim().toLowerCase() === "qwen-image-edit" ||
    Boolean((env.QWEN_IMAGE_EDIT_URL ?? "").trim())
  );
}

export function qwenImageEditBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    (env.QWEN_IMAGE_EDIT_URL ?? DEFAULT_QWEN_IMAGE_EDIT_URL).trim() ||
    DEFAULT_QWEN_IMAGE_EDIT_URL
  ).replace(/\/+$/, "");
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

/** 调远程 Qwen-Image-Edit 生成 PNG；任何失败返回 null。 */
export async function generateQwenImageEdit(
  prompt: string,
  opts: QwenImageEditOptions = {},
): Promise<QwenImageEditResult | null> {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  const baseUrl = (opts.baseUrl ?? qwenImageEditBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000),
    MAX_TIMEOUT_MS,
  );
  const fetchFn = opts.fetchFn ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${baseUrl}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        simple: opts.simple ?? true,
        ...(opts.imagePaths && opts.imagePaths.length > 0 ? { image_paths: opts.imagePaths } : {}),
        num_inference_steps: Math.max(8, Math.min(60, opts.steps ?? 20)),
        seed: opts.seed ?? 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn("image.qwen_edit_failed", { status: response.status });
      return null;
    }
    const png = Buffer.from(await response.arrayBuffer());
    if (!isPng(png)) {
      log.warn("image.qwen_edit_failed", { reason: "invalid_png", bytes: png.length });
      return null;
    }
    const width = Number(response.headers.get("x-image-width"));
    const height = Number(response.headers.get("x-image-height"));
    return {
      png,
      elapsedMs: Date.now() - startedAt,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    };
  } catch (err: unknown) {
    log.warn("image.qwen_edit_failed", {
      reason: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message.slice(0, 200) : undefined,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
