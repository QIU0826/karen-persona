/**
 * MOSS-Image-SFT 远程客户端（GPU7，127.0.0.1:18114；Mac 侧默认隧道 19114）。
 *
 * 与 Z-Image 客户端不同：MOSS 是 5.1B DiT + Qwen3.5-9B 文本编码器，默认 50 步、
 * guidance 3.0、负分支跳过第 22 层；单张耗时显著高于 8 步模型，因此默认超时更宽。
 * 服务端约定见 deploy/gpu-server/moss-image/server.py：
 * - POST /generate → PNG，响应头带 X-Image-Width/Height、X-Elapsed-Ms、X-Gpu-Peak-Gb；
 * - 尺寸必须为 16 的正整数倍；
 * - 失败返回 null（不抛异常），调用方按现有后端回退链（Z-Image / 图库）处理。
 *
 * 默认 shadow：只有显式设置 `KAREN_IMAGE_BACKEND=moss-image` 或 `MOSS_IMAGE_URL`
 * 才会启用；不改生产默认。
 */
import { createLogger } from "../obs/logger.js";

const log = createLogger("image.moss");

export const DEFAULT_MOSS_IMAGE_URL = "http://127.0.0.1:19114";
export const DEFAULT_MOSS_IMAGE_EDIT_URL = "http://127.0.0.1:19115";
/**
 * 人物专用服务（GPU6 18116）：MOSS-Image-SFT + Karen identity LoRA（merged）。
 * 场景图仍走 Z-Image，本服务只给自拍/人物用；默认 shadow。
 */
export const DEFAULT_MOSS_CHARACTER_URL = "http://127.0.0.1:19116";
/**
 * Hybrid 自拍 wrapper（GPU 服务端 18118，Mac 隧道 19118）：
 * MOSS v2 生成 base → Qwen-Image-Edit 修脸 → PNG。默认 shadow。
 */
export const DEFAULT_MOSS_HYBRID_URL = "http://127.0.0.1:19118";
/** MOSS 官方默认：50 步、guidance 3.0、负分支跳过第 22 层 */
export const MOSS_DEFAULT_STEPS = 50;
export const MOSS_DEFAULT_GUIDANCE = 3.0;
export const MOSS_DEFAULT_SKIP_LAYERS = [22] as const;
/** 官方要求：宽高必须是 16 的正整数倍 */
export const MOSS_SIZE_MULTIPLE = 16;
export const MOSS_MIN_SIDE = 256;
export const MOSS_MAX_SIDE = 1536;

/** 单张默认 5 分钟（50 步 + 模型刚加载时的抖动）；可用 MOSS_IMAGE_TIMEOUT_MS 覆盖 */
export const DEFAULT_MOSS_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

/** 解析超时：显式参数 > MOSS_IMAGE_TIMEOUT_MS > 默认；收敛到 [30s, 600s]。 */
export function mossTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  override?: number,
): number {
  const raw = override ?? Number(env.MOSS_IMAGE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MOSS_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), 30_000), MAX_TIMEOUT_MS);
}

export interface MossImageOptions {
  baseUrl?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  guidanceScale?: number;
  negativePrompt?: string;
  uncondSkipLayers?: number[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface MossImageEditOptions {
  baseUrl?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface MossImageResult {
  png: Buffer;
  width?: number;
  height?: number;
  elapsedMs: number;
  /** 服务端计时（响应头 X-Elapsed-Ms），用于区分网络/本地开销 */
  serverElapsedMs?: number;
  /** 服务端显存峰值（GB，响应头 X-Gpu-Peak-Gb） */
  gpuPeakGb?: number;
  steps?: number;
  seed?: number;
  /** hybrid wrapper：MOSS 生成段耗时（X-Moss-Ms） */
  mossMs?: number;
  /** hybrid wrapper：Qwen 修脸段耗时（X-Fix-Ms） */
  fixMs?: number;
}

/** hybrid wrapper 请求选项（POST `/selfie`） */
export interface MossHybridOptions {
  baseUrl?: string;
  width?: number;
  height?: number;
  seed?: number;
  /** Qwen 修脸步数（wrapper 内收敛 8–30，默认 15） */
  fixSteps?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function isMossImageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = (env.KAREN_IMAGE_BACKEND ?? "").trim().toLowerCase();
  return (
    backend === "moss-image" ||
    backend === "moss" ||
    backend === "moss-image-sft" ||
    Boolean((env.MOSS_IMAGE_URL ?? "").trim())
  );
}

export function mossImageBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ((env.MOSS_IMAGE_URL ?? DEFAULT_MOSS_IMAGE_URL).trim() || DEFAULT_MOSS_IMAGE_URL).replace(
    /\/+$/,
    "",
  );
}

/** 运行时自拍切 MOSS 编辑：必须显式 `KAREN_SELFIE_BACKEND=moss-edit`（默认 qwen）。 */
export function mossEditSelfieBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_SELFIE_BACKEND ?? "").trim().toLowerCase() === "moss-edit";
}

export function isMossImageEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return mossEditSelfieBackend(env) || Boolean((env.MOSS_IMAGE_EDIT_URL ?? "").trim());
}

export function mossImageEditBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    (env.MOSS_IMAGE_EDIT_URL ?? DEFAULT_MOSS_IMAGE_EDIT_URL).trim() || DEFAULT_MOSS_IMAGE_EDIT_URL
  ).replace(/\/+$/, "");
}

/** 人物 LoRA 自拍后端（`KAREN_SELFIE_BACKEND=moss-t2i`）是否启用；默认关。 */
export function isMossCharacterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = (env.KAREN_SELFIE_BACKEND ?? "").trim().toLowerCase();
  return (
    backend === "moss-t2i" ||
    backend === "moss-t2i-shadow" ||
    Boolean((env.MOSS_CHARACTER_URL ?? "").trim())
  );
}

/** 人物专用服务 base URL（env `MOSS_CHARACTER_URL`，默认隧道 19116）。 */
export function mossCharacterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    (env.MOSS_CHARACTER_URL ?? DEFAULT_MOSS_CHARACTER_URL).trim() || DEFAULT_MOSS_CHARACTER_URL
  ).replace(/\/+$/, "");
}

/** Hybrid 自拍 wrapper（`KAREN_SELFIE_BACKEND=moss-hybrid`）是否启用；默认关。 */
export function isMossHybridEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = (env.KAREN_SELFIE_BACKEND ?? "").trim().toLowerCase();
  return (
    backend === "moss-hybrid" ||
    backend === "moss-hybrid-shadow" ||
    backend === "hybrid" ||
    Boolean((env.MOSS_HYBRID_URL ?? "").trim())
  );
}

/** Hybrid wrapper base URL（env `MOSS_HYBRID_URL`，默认隧道 19118）。 */
export function mossHybridBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    ((env.MOSS_HYBRID_URL ?? DEFAULT_MOSS_HYBRID_URL).trim() || DEFAULT_MOSS_HYBRID_URL)
  ).replace(/\/+$/, "");
}

/** 把任意宽高收敛到 MOSS 合法区间：16 的倍数、[256, 1536]。 */
export function normalizeMossSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const normalize = (value: number): number => {
    const raw = Number.isFinite(value) ? value : 1024;
    const rounded = Math.round(raw / MOSS_SIZE_MULTIPLE) * MOSS_SIZE_MULTIPLE;
    return Math.max(MOSS_MIN_SIDE, Math.min(MOSS_MAX_SIDE, rounded));
  };
  return { width: normalize(width), height: normalize(height) };
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

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function parsePositiveNumber(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function clampTimeout(timeoutMs: number | undefined): number {
  return mossTimeoutMs(process.env, timeoutMs);
}

function headerResult(res: Response, png: Buffer, startedAt: number): MossImageResult {
  const width = parsePositiveInt(res.headers.get("x-image-width"));
  const height = parsePositiveInt(res.headers.get("x-image-height"));
  return {
    png,
    elapsedMs: Date.now() - startedAt,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(parsePositiveInt(res.headers.get("x-elapsed-ms")) !== undefined
      ? { serverElapsedMs: parsePositiveInt(res.headers.get("x-elapsed-ms")) }
      : {}),
    ...(parsePositiveNumber(res.headers.get("x-gpu-peak-gb")) !== undefined
      ? { gpuPeakGb: parsePositiveNumber(res.headers.get("x-gpu-peak-gb")) }
      : {}),
    ...(parsePositiveInt(res.headers.get("x-image-steps")) !== undefined
      ? { steps: parsePositiveInt(res.headers.get("x-image-steps")) }
      : {}),
    ...(parsePositiveInt(res.headers.get("x-image-seed")) !== undefined
      ? { seed: parsePositiveInt(res.headers.get("x-image-seed")) }
      : {}),
  };
}

/**
 * 调远程 MOSS 文生图服务（`/generate`）；任何失败返回 null（不抛异常）。
 * 默认 50 步 / guidance 3 / uncond_skip_layers=[22]，与官方默认一致。
 */
async function requestMossGenerate(
  baseUrl: string,
  prompt: string,
  opts: MossImageOptions,
  logEvent: string,
): Promise<MossImageResult | null> {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  const size = normalizeMossSize(opts.width ?? 832, opts.height ?? 1216);
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const fetchFn = opts.fetchFn ?? fetch;
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const steps = Math.max(1, Math.min(100, Math.round(opts.steps ?? MOSS_DEFAULT_STEPS)));
  const guidance = Math.max(0, Math.min(10, opts.guidanceScale ?? MOSS_DEFAULT_GUIDANCE));
  const startedAt = Date.now();
  try {
    const res = await fetchFn(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        width: size.width,
        height: size.height,
        steps,
        seed,
        guidance_scale: guidance,
        negative_prompt: opts.negativePrompt ?? "",
        uncond_skip_layers: opts.uncondSkipLayers ?? [...MOSS_DEFAULT_SKIP_LAYERS],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(logEvent, { status: res.status, stage: "generate" });
      return null;
    }
    const png = Buffer.from(await res.arrayBuffer());
    if (!isPng(png)) {
      log.warn(logEvent, { reason: "invalid_png", bytes: png.length });
      return null;
    }
    return headerResult(res, png, startedAt);
  } catch (err: unknown) {
    log.warn(logEvent, {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/** 调基础 MOSS 服务（GPU7 18114）：场景/通用文生图。 */
export async function generateMossImage(
  prompt: string,
  opts: MossImageOptions = {},
): Promise<MossImageResult | null> {
  return requestMossGenerate(
    (opts.baseUrl ?? mossImageBaseUrl()).replace(/\/+$/, ""),
    prompt,
    opts,
    "image.moss_failed",
  );
}

/**
 * 调「人物专用」MOSS 服务（GPU6 18116，merged Karen identity LoRA）。
 * prompt 需自带触发词 `karen_style` 与身份/画风描述（由 selfie-generator 组装）。
 */
export async function generateMossCharacterImage(
  prompt: string,
  opts: MossImageOptions = {},
): Promise<MossImageResult | null> {
  return requestMossGenerate(
    (opts.baseUrl ?? mossCharacterBaseUrl()).replace(/\/+$/, ""),
    prompt,
    opts,
    "image.moss_character_failed",
  );
}

/**
 * 调 hybrid wrapper（18118/19118）：MOSS v2 生成 base → Qwen-Image-Edit 修脸 → PNG。
 * 失败/超时返回 null；调用方按 selfie 后端链回退 Qwen → 图库。
 */
export async function generateMossHybridImage(
  prompt: string,
  opts: MossHybridOptions = {},
): Promise<MossImageResult | null> {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  const baseUrl = (opts.baseUrl ?? mossHybridBaseUrl()).replace(/\/+$/, "");
  const size = normalizeMossSize(opts.width ?? 832, opts.height ?? 1216);
  const timeoutMs = clampTimeout(opts.timeoutMs ?? 240_000);
  const fetchFn = opts.fetchFn ?? fetch;
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const startedAt = Date.now();
  try {
    const res = await fetchFn(`${baseUrl}/selfie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        width: size.width,
        height: size.height,
        seed,
        ...(opts.fixSteps !== undefined ? { fix_steps: opts.fixSteps } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("image.moss_hybrid_failed", { status: res.status, stage: "selfie" });
      return null;
    }
    const png = Buffer.from(await res.arrayBuffer());
    if (!isPng(png)) {
      log.warn("image.moss_hybrid_failed", { reason: "invalid_png", bytes: png.length });
      return null;
    }
    const result = headerResult(res, png, startedAt);
    const total = parsePositiveInt(res.headers.get("x-total-ms"));
    const moss = parsePositiveInt(res.headers.get("x-moss-ms"));
    const fix = parsePositiveInt(res.headers.get("x-fix-ms"));
    return {
      ...result,
      ...(total !== undefined ? { serverElapsedMs: total } : {}),
      ...(moss !== undefined ? { mossMs: moss } : {}),
      ...(fix !== undefined ? { fixMs: fix } : {}),
    };
  } catch (err: unknown) {
    log.warn("image.moss_hybrid_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * 调 MOSS 参考图编辑（服务端 /edit）。
 * 注意：当前部署的 MOSS-Image-SFT 只有文生图分支，/edit 返回 501；
 * 本函数先按协议实现，服务端升级到 Moss-Image-Edit 后无需改客户端即可用。
 */export async function editMossImage(
  prompt: string,
  imagePaths: string[],
  opts: MossImageEditOptions = {},
): Promise<MossImageResult | null> {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  const paths = (imagePaths ?? []).map((item) => item.trim()).filter(Boolean);
  if (paths.length === 0) return null;
  const baseUrl = (opts.baseUrl ?? mossImageEditBaseUrl()).replace(/\/+$/, "");
  const size = normalizeMossSize(opts.width ?? 832, opts.height ?? 1216);
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const fetchFn = opts.fetchFn ?? fetch;
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const steps = Math.max(1, Math.min(100, Math.round(opts.steps ?? MOSS_DEFAULT_STEPS)));
  const startedAt = Date.now();
  try {
    const res = await fetchFn(`${baseUrl}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        image_paths: paths,
        width: size.width,
        height: size.height,
        steps,
        seed,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("image.moss_edit_failed", { status: res.status, stage: "edit" });
      return null;
    }
    const png = Buffer.from(await res.arrayBuffer());
    if (!isPng(png)) {
      log.warn("image.moss_edit_failed", { reason: "invalid_png", bytes: png.length });
      return null;
    }
    return headerResult(res, png, startedAt);
  } catch (err: unknown) {
    log.warn("image.moss_edit_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
