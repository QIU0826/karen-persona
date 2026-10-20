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

/**
 * 拼生图提示词（纯函数，便于单测与调参）。
 *
 * 原则：**像她用手机随手拍的**——真实、日常、不摆拍；避免"AI 感"的形容词堆砌。
 */
export function buildScenePrompt(input: ScenePromptInput): string {
  const parts: string[] = [];
  const chineseTags = new Set(input.tags ?? []);
  const scenes = [...chineseTags].map((t) => TAG_SCENES[t]).filter(Boolean);
  if (scenes.length > 0) parts.push(scenes[0]);
  else parts.push("casual everyday scene from her day, phone snapshot");

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

/**
 * 真正调用 ComfyUI 生成一张图。
 * 失败（服务没起/超时/返回异常）一律返回 ok:false，调用方回退本地图库。
 */
export async function generateImage(
  options: ComfyWorkflowOptions,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GenerateResult> {
  if (!isImageGenEnabled()) return { ok: false, reason: "disabled" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    return { ok: true, bytes, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: `error_${name}` };
  }
}
