/**
 * 本机 ComfyUI 生图（v0.7）。
 *
 * 为什么：现在照片全来自 15 张本地图库，长期一定重复；生成能让"她此刻拍到的"更具体。
 * 采用**进程外 ComfyUI**（GPL-3.0，只通过 HTTP 调用，不链接代码）：
 *  - 程序在 `vendor/comfyui/`（不进仓库）
 *  - 模型在 `KAREN_MODELS_DIR/comfyui/models/`（不进仓库、可一键清）
 *  - 生成物在 `KAREN_DATA_DIR/generated/日期/`（自动清理 30 天前）
 *
 * 设计约束：
 * - `KAREN_IMAGE_GEN=on` 才启用；没开/服务不可用/超时 → 返回 null，调用方回退图库；
 * - 单张超时 25s、体积上限 4MB；失败只记安全原因，不打印正文；
 * - 工作流极简（SDXL-Turbo 单步），参数可通过 env 覆盖，便于换模型。
 */

import { auditImage } from "../ai/image-guard.js";
import { generateQwenImageEdit } from "../ai/qwen-image-edit.js";
import { generateZImage } from "../ai/z-image.js";

export const GENERATED_DIR_NAME = "generated";
/** 生成图保留天数 */
export const GENERATED_RETENTION_DAYS = 30;
/** 单张生成上限（字节） */
export const MAX_GENERATED_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

export function isImageGenEnabled(): boolean {
  return (process.env.KAREN_IMAGE_GEN ?? "").toLowerCase() === "on";
}

export function comfyBaseUrl(): string {
  const raw = process.env.KAREN_COMFY_URL?.trim();
  return (raw && raw.length > 0 ? raw : "http://127.0.0.1:8188").replace(/\/+$/, "");
}

/**
 * 生图后端：`service`（默认，services/image 的 diffusers 服务）或 `comfyui`。
 *
 * 为什么默认 service：ComfyUI 要从 GitHub 克隆源码，本机实测只有 ~17KB/s，不可行；
 * 而 PyPI（2MB/s）与 diffusers 都很快，所以自己起一个极简 HTTP 服务更实际。
 */
export function imageBackend(): "service" | "comfyui" | "qwen-image-edit" | "z-image" {
  const backend = (process.env.KAREN_IMAGE_BACKEND ?? "service").toLowerCase();
  if (backend === "comfyui") return "comfyui";
  if (backend === "qwen-image-edit" || backend === "qwen") return "qwen-image-edit";
  if (backend === "z-image" || backend === "zimage") return "z-image";
  return "service";
}

/** diffusers 生图服务地址（services/image，默认 127.0.0.1:18084） */
export function imageServiceUrl(): string {
  const raw = process.env.KAREN_IMAGE_URL?.trim();
  return (raw && raw.length > 0 ? raw : "http://127.0.0.1:18084").replace(/\/+$/, "");
}

/**
 * 调 diffusers 服务生成一张图（同步返回 PNG 字节）。
 * 任何失败都返回 ok:false，调用方回退图库。
 */
async function generateViaService(
  options: ComfyWorkflowOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<GenerateResult> {
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${imageServiceUrl()}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: options.prompt,
        negative_prompt: options.negativePrompt ?? NEGATIVE_PROMPT,
        seed: options.seed ?? Math.floor(Math.random() * 1_000_000),
        width: options.width ?? 832,
        height: options.height ?? 1216,
        steps: options.steps ?? 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `service_${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > MAX_GENERATED_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, bytes, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: `service_error_${name}` };
  }
}

export interface ScenePromptInput {
  /** 场景标签（sunset/cafe/rain/cat…，来自 detectPhotoSceneTags） */
  tags?: string[];
  /** 她刚说的话（用来挑情绪与细节，不直接当提示词） */
  lastReply?: string;
  emotionVector?: number;
  /** 0-23 */
  hour: number;
  /** 角色一致性提示词（人设/外貌，来自 persona 或配置） */
  characterPrompt?: string;
}

/** 场景标签 → 具体画面（中文标签映射到英文提示词片段） */
const TAG_SCENES: Record<string, string> = {
  sunset: "warm sunset sky over city rooftops, phone photo",
  snow: "light snow falling on a quiet street, winter",
  cafe: "cozy coffee shop interior, latte on wooden table",
  coffee: "latte art in a ceramic cup on a cafe table",
  rain: "rainy window with blurred street lights outside",
  window: "view from a window, soft indoor light and plants",
  cat: "an orange tabby cat lounging on a sofa",
  animal: "a cat by the window, soft afternoon light",
  mountain: "distant mountains in soft morning haze",
  lake: "calm lake reflecting the sky",
  plants: "green houseplants by a sunny window",
  flowers: "small wildflowers in a glass jar",
  city: "city street at dusk, neon reflections on wet asphalt",
  street: "quiet street after rain, warm shop lights",
  food: "simple homemade dinner on a wooden table",
  dinner: "home-cooked dinner, warm kitchen light",
  morning: "soft morning light through curtains, a mug of tea",
};

/** 聊天上下文里的具体场景线索 → 画面片段（比抽象标签更贴合这一轮对话） */
const CONTEXT_SCENES: Array<[RegExp, string]> = [
  [/火锅|麻辣烫|hotpot/i, "steaming hotpot on a wooden table, warm restaurant light"],
  [/下雨|雨夜|淋雨|rain/i, "rainy street with blurred lights, wet pavement"],
  [/咖啡|拿铁|美式|coffee/i, "coffee cup on a cafe table, warm light"],
  [/看书|小说|书|read|book/i, "open book on a table, soft window light"],
  [/晚饭|晚餐|吃饭|dinner/i, "home-cooked dinner on a wooden table"],
  [/猫|猫咪|cat/i, "cat lounging nearby, soft afternoon light"],
  [/加班|工作|电脑|laptop|work/i, "laptop on a desk at night, warm desk lamp"],
  [/散步|走走|walk/i, "quiet street, soft evening light"],
  [/海边|大海|seaside|ocean/i, "seaside at dusk, gentle waves"],
  [/下雪|雪|snow/i, "light snow falling on a quiet street"],
  [/鲜花|花|flowers/i, "small flowers in a glass jar"],
];

/**
 * 拼生图提示词（纯函数，便于单测与调参）。
 *
 * 原则：**像她用手机随手拍的**——真实、日常、不摆拍；避免"AI 感"的形容词堆砌。
 * v0.9.32：把 lastReply 里的具体场景线索也带进 prompt，不再只靠抽象标签；
 * 生成后仍由 image-guard 按同一段上下文检查。
 */
export function buildScenePrompt(input: ScenePromptInput): string {
  const parts: string[] = [];
  const chineseTags = new Set(input.tags ?? []);
  const scenes = [...chineseTags].map((t) => TAG_SCENES[t]).filter(Boolean);
  if (scenes.length > 0) parts.push(scenes[0]);
  else parts.push("casual everyday scene from her day, phone snapshot");

  // 聊天上下文里的具体线索（火锅/雨夜/看书…），让画面跟这一轮对话走
  const contextScene = CONTEXT_SCENES.find(([re]) => re.test(input.lastReply ?? ""))?.[1];
  if (contextScene && !parts.includes(contextScene)) parts.push(contextScene);

  // 时段光线（她生活的真实感来源）
  const hour = input.hour;
  if (hour >= 5 && hour < 9) parts.push("soft morning light");
  else if (hour >= 9 && hour < 16) parts.push("bright daylight");
  else if (hour >= 16 && hour < 19) parts.push("golden hour light");
  else parts.push("dim evening indoor light");

  // 情绪 → 色调（低落不拍艳照；开心可以亮一点）
  const emotion = input.emotionVector ?? 0;
  if (emotion > 0.3) parts.push("warm cheerful tones");
  else if (emotion < -0.2) parts.push("muted calm tones");

  if (input.characterPrompt) parts.push(input.characterPrompt);

  // 手机随手拍质感 + 负面约束（避免 AI 味）
  parts.push("smartphone photo, slightly imperfect framing, natural colors, shallow depth of field");
  return parts.join(", ");
}

/** 负面提示词：避免明显的 AI 特征（多余的肢体、文字水印、卡通感） */
export const NEGATIVE_PROMPT =
  "text, watermark, logo, extra fingers, deformed hands, cartoon, anime, oversaturated, CGI, 3d render";

export interface ComfyWorkflowOptions {
  prompt: string;
  /** 聊天上下文/期望画面；生成后质检用；缺省时用 prompt */
  context?: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** SDXL-Turbo 用 1；Flux schnell 用 4 */
  steps?: number;
  checkpoint?: string;
}

/**
 * 构造 ComfyUI 的 API 工作流（极简：加载模型 → 编码 → 采样 → 解码 → 保存）。
 * 只依赖内置节点，不装自定义节点。
 */
export function buildComfyWorkflow(options: ComfyWorkflowOptions): Record<string, unknown> {
  const checkpoint = options.checkpoint ?? process.env.KAREN_SD_CHECKPOINT ?? "sd_xl_turbo_1.0_fp16.safetensors";
  const width = options.width ?? 832;
  const height = options.height ?? 1216;
  const steps = options.steps ?? 1;
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.negativePrompt ?? NEGATIVE_PROMPT, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: options.seed ?? Math.floor(Math.random() * 1_000_000),
        steps,
        cfg: 1,
        sampler_name: "euler_ancestral",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "karen" },
    },
  };
}

export interface GenerateResult {
  ok: boolean;
  bytes?: Buffer;
  reason?: string;
  elapsedMs?: number;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
  status?: { completed?: boolean; status_str?: string };
}

export interface GenerateDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 测试注入：图片质检 */
  auditFn?: typeof auditImage;
  /** 测试注入：Qwen-Image-Edit 生成 */
  qwenGenerateFn?: typeof generateQwenImageEdit;
  /** 测试注入：Z-Image 生成 */
  zImageGenerateFn?: typeof generateZImage;
}

/**
 * 统一图片质检闸门：
 * - qwen-image-edit 后端强制检查（requireNoHands）；
 * - 其他后端在 KAREN_IMAGE_GUARD=on 时检查；
 * - 检查不可用或不合格一律 ok:false，调用方回退图库。
 */
async function guardGenerated(
  result: GenerateResult,
  options: ComfyWorkflowOptions,
  deps: GenerateDeps,
  requireNoHands: boolean,
  expectCharacter: boolean,
): Promise<GenerateResult> {
  if (!result.ok || !result.bytes) return result;
  const forced = imageBackend() === "qwen-image-edit" || imageBackend() === "z-image";
  if (!forced && (process.env.KAREN_IMAGE_GUARD ?? "off").toLowerCase() !== "on") return result;
  const audit = await (deps.auditFn ?? auditImage)(result.bytes, {
    context: options.context ?? options.prompt,
    prompt: options.prompt,
    requireNoHands,
    expectCharacter,
  });
  if (!audit) return { ok: false, reason: "guard_unavailable", elapsedMs: result.elapsedMs };
  if (!audit.pass) return { ok: false, reason: "guard_rejected", elapsedMs: result.elapsedMs };
  return result;
}

async function generateViaZImage(
  options: ComfyWorkflowOptions,
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const startedAt = Date.now();
  const generated = await (deps.zImageGenerateFn ?? generateZImage)(options.prompt, {
    width: options.width ?? 832,
    height: options.height ?? 1216,
    steps: Math.max(4, Math.min(30, options.steps && options.steps > 1 ? options.steps : 9)),
    seed: options.seed ?? Math.floor(Math.random() * 1_000_000),
    timeoutMs: 120_000,
  });
  if (!generated) return { ok: false, reason: "z_image_failed" };
  if (generated.png.length > MAX_GENERATED_BYTES) {
    return { ok: false, reason: "too_large", elapsedMs: Date.now() - startedAt };
  }
  return guardGenerated(
    { ok: true, bytes: generated.png, elapsedMs: Date.now() - startedAt },
    options,
    deps,
    false,
    false,
  );
}

async function generateViaQwen(
  options: ComfyWorkflowOptions,
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const startedAt = Date.now();
  const generated = await (deps.qwenGenerateFn ?? generateQwenImageEdit)(options.prompt, {
    simple: true,
    steps: Math.max(8, Math.min(60, options.steps && options.steps > 1 ? options.steps : 20)),
    seed: options.seed ?? Math.floor(Math.random() * 1_000_000),
    timeoutMs: 300_000,
  });
  if (!generated) return { ok: false, reason: "qwen_failed" };
  if (generated.png.length > MAX_GENERATED_BYTES) {
    return { ok: false, reason: "too_large", elapsedMs: Date.now() - startedAt };
  }
  return guardGenerated(
    { ok: true, bytes: generated.png, elapsedMs: Date.now() - startedAt },
    options,
    deps,
    true,
    true,
  );
}

/**
 * 真正调用生图后端生成一张图。
 * 失败（服务没起/超时/返回异常/质检不通过）一律返回 ok:false，调用方回退本地图库。
 */
export async function generateImage(
  options: ComfyWorkflowOptions,
  deps: GenerateDeps = {},
): Promise<GenerateResult> {
  if (!isImageGenEnabled()) return { ok: false, reason: "disabled" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (imageBackend() === "qwen-image-edit") {
    return generateViaQwen(options, deps);
  }
  if (imageBackend() === "z-image") {
    return generateViaZImage(options, deps);
  }
  if (imageBackend() === "service") {
    return guardGenerated(await generateViaService(options, fetchImpl, timeoutMs), options, deps, false, false);
  }
  const startedAt = Date.now();
  const base = comfyBaseUrl();

  try {
    const clientId = `karen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const submit = await fetchImpl(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: buildComfyWorkflow(options), client_id: clientId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!submit.ok) return { ok: false, reason: `submit_${submit.status}` };
    const submitJson = (await submit.json()) as { prompt_id?: string };
    const promptId = submitJson.prompt_id;
    if (!promptId) return { ok: false, reason: "no_prompt_id" };

    // 轮询 history（ComfyUI 没有同步接口）
    const deadline = Date.now() + timeoutMs;
    let image: { filename: string; subfolder?: string; type?: string } | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const hist = await fetchImpl(`${base}/history/${promptId}`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!hist.ok) continue;
      const histJson = (await hist.json()) as Record<string, HistoryEntry>;
      const entry = histJson[promptId];
      image = entry?.outputs?.["7"]?.images?.[0];
      if (image) break;
    }
    if (!image) return { ok: false, reason: "timeout" };

    const view = await fetchImpl(
      `${base}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(
        image.subfolder ?? "",
      )}&type=${encodeURIComponent(image.type ?? "output")}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!view.ok) return { ok: false, reason: `view_${view.status}` };
    const bytes = Buffer.from(await view.arrayBuffer());
    if (bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > MAX_GENERATED_BYTES) return { ok: false, reason: "too_large" };
    return guardGenerated(
      { ok: true, bytes, elapsedMs: Date.now() - startedAt },
      options,
      deps,
      false,
      false,
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: `error_${name}` };
  }
}
