/**
 * 运行时自拍生成（P0-5，2026-10-23）。
 *
 * 之前的「自拍」是从 5 张本地库存里轮播；Qwen-Image-Edit + cafe 参考图只在
 * 离线脚本 `image:selfie` 里用过。这里把同一套能力接进运行时：
 * - 场景由用户这句话/她刚说的话 + 当前时段决定；
 * - 固定参考图 `SELFIE_STYLE_REF`（cafe 自拍）锁角色/画风；
 * - 生成后仍过 image-guard（expectCharacter=true，缺手/脸/穿模都拒绝）；
 * - 质检失败换 seed 重试一次，仍失败由桥接回退本地自拍（不空口承诺）。
 *
 * 实测（GPU2，simple，8 步）：一张 960×783 约 22.6s；默认用 10 步。
 * 调用方必须异步发（约 25–40s），不能阻塞当轮文字回复。
 *
 * MOSS-Edit 分支（P2，默认关闭）：`KAREN_SELFIE_BACKEND=moss-edit` 时改调
 * MOSS 服务的 `/edit`；当前部署的 MOSS-Image-SFT 只有文生图分支、`/edit` 返回 501，
 * 因此这条路会失败并回退本地自拍，等 Moss-Image-Edit 部署后再切。
 *
 * MOSS-t2i 分支（P3，默认关闭，shadow）：`KAREN_SELFIE_BACKEND=moss-t2i` 时调用
 * GPU6 的「人物专用」MOSS 服务 18116（MOSS-Image-SFT + Karen identity LoRA merged），
 * prompt 固定触发词 `karen_style` + 中蓝发色/铅笔水彩画风；失败或 guard 不过会先回退
 * Qwen-Image-Edit，再失败才由调用方回退本地自拍。实测 identity 仍弱于 Qwen（见
 * docs/MOSS_IMAGE.md「人物 LoRA」），**不切生产默认**。
 *
 * MOSS-hybrid 分支（P3，默认关闭，shadow）：`KAREN_SELFIE_BACKEND=moss-hybrid` 时调
 * GPU 服务端 wrapper 18118（MOSS v2 生成 base → Qwen-Image-Edit 修脸），失败/guard 不过
 * 回退 Qwen-Image-Edit，再回退本地自拍。实测总延迟约 110s（MOSS ~40s + Qwen ~71s），
 * identity 与 MOSS v2 单跑基本一致（修脸增量 ~+0.003），**不切生产默认**。
 */
import { auditImage, type ImageAudit } from "../ai/image-guard.js";
import {
  editMossImage,
  generateMossCharacterImage,
  generateMossHybridImage,
  type MossImageResult,
} from "../ai/moss-image.js";
import {
  generateQwenImageEdit,
  type QwenImageEditResult,
} from "../ai/qwen-image-edit.js";
import { createLogger } from "../obs/logger.js";
import { buildSelfiePrompt, SELFIE_STYLE_REF } from "./selfie-style.js";

const log = createLogger("selfie");

export interface SelfieRequestInput {
  /** 用户这一句（如「发张自拍看看」） */
  userText: string;
  /** 她刚发出的文字（用于挑场景/情绪） */
  lastReply?: string;
  hour: number;
  emotionVector?: number;
  weather?: { condition?: string; temperature?: number } | null;
}

export type SelfieFailureReason =
  | "disabled"
  | "qwen_failed"
  | "moss_failed"
  | "moss_t2i_failed"
  | "moss_hybrid_failed"
  | "too_large"
  | "guard_unavailable"
  | "guard_rejected";

export interface SelfieGenerationResult {
  ok: boolean;
  bytes?: Buffer;
  prompt: string;
  scene: string;
  attempts: number;
  elapsedMs: number;
  audit?: ImageAudit | null;
  reason?: SelfieFailureReason;
  /** 实际出图的后端（fallback 后可区分） */
  backend?: SelfieBackend;
  /** moss-t2i 失败后由 Qwen 兜底成功时为 true */
  fallbackUsed?: boolean;
}

export interface SelfieGenerationDeps {
  qwenGenerateFn?: typeof generateQwenImageEdit;
  /** MOSS-Edit 分支（KAREN_SELFIE_BACKEND=moss-edit）用的生成函数 */
  mossEditGenerateFn?: typeof editMossImage;
  /** MOSS-t2i 分支（KAREN_SELFIE_BACKEND=moss-t2i）用的人物 LoRA 生成函数 */
  mossCharacterGenerateFn?: typeof generateMossCharacterImage;
  /** MOSS-hybrid 分支（KAREN_SELFIE_BACKEND=moss-hybrid）用的 wrapper 生成函数 */
  mossHybridGenerateFn?: typeof generateMossHybridImage;
  auditFn?: (
    png: Buffer,
    ctx: { context: string; prompt?: string; requireNoHands?: boolean; expectCharacter?: boolean },
  ) => Promise<ImageAudit | null>;
  env?: NodeJS.ProcessEnv;
}

type AuditFn = NonNullable<SelfieGenerationDeps["auditFn"]>;

/** 自拍生成后端：默认 qwen（保持现状）；moss-edit / moss-t2i / moss-hybrid 需显式开启。 */
export type SelfieBackend = "qwen" | "moss-edit" | "moss-t2i" | "moss-hybrid";

export function selfieBackend(env: NodeJS.ProcessEnv = process.env): SelfieBackend {
  const raw = (env.KAREN_SELFIE_BACKEND ?? "").trim().toLowerCase();
  if (raw === "moss-edit") return "moss-edit";
  if (raw === "moss-t2i" || raw === "moss-t2i-shadow" || raw === "moss-character") {
    return "moss-t2i";
  }
  if (raw === "moss-hybrid" || raw === "moss-hybrid-shadow" || raw === "hybrid") {
    return "moss-hybrid";
  }
  return "qwen";
}

/** 是否启用运行时自拍：默认开；`KAREN_SELFIE_GEN=off` 或没配对应后端地址时关。 */
export function isSelfieGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.KAREN_SELFIE_GEN ?? "on").trim().toLowerCase() === "off") return false;
  const backend = selfieBackend(env);
  if (backend === "moss-edit" || backend === "moss-t2i" || backend === "moss-hybrid") {
    // 显式 opt-in 即视为启用；地址未配时用客户端默认 19115/19116/19118，失败会回退。
    return true;
  }
  return Boolean((env.QWEN_IMAGE_EDIT_URL ?? "").trim());
}

function hasQwenBackend(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.QWEN_IMAGE_EDIT_URL ?? "").trim());
}

function stepsFromEnv(env: NodeJS.ProcessEnv, backend: SelfieBackend = "qwen"): number {
  const raw = Number(env.KAREN_SELFIE_STEPS);
  if (backend === "moss-hybrid") {
    // hybrid wrapper：这是 Qwen 修脸步数（默认 15，收敛 [8, 30]）；MOSS 段固定 50 步
    if (!Number.isFinite(raw)) return 15;
    return Math.max(8, Math.min(30, Math.round(raw)));
  }
  if (backend === "moss-edit" || backend === "moss-t2i") {
    // MOSS 官方默认 50 步；未显式配置时用 50，显式配置时收敛到 [10, 100]
    if (!Number.isFinite(raw)) return 50;
    return Math.max(10, Math.min(100, Math.round(raw)));
  }
  if (!Number.isFinite(raw)) return 10;
  return Math.max(6, Math.min(20, Math.round(raw)));
}

/** 从用户/她的文字 + 当前时段挑一个自拍场景（不引入新地点/人物）。 */
export function inferSelfieScene(input: SelfieRequestInput): string {
  const text = `${input.userText ?? ""}\n${input.lastReply ?? ""}`;
  if (/雨/.test(text)) return "下雨的窗边，玻璃上有水珠";
  if (/海边|沙滩|海浪/.test(text)) return "傍晚的海边，风把头发吹起来";
  if (/公园|花|春天|外面走走/.test(text)) return "春天的公园长椅，自然光";
  if (/夜|街|霓虹|路灯/.test(text)) return "夜晚街头，远处霓虹灯虚化，人物脸部有柔和主光，环境光不要染色头发";
  if (/家|沙发|窝在|卧室|床上/.test(text)) return "家里的沙发上，暖色台灯";
  if (/店|咖啡|吧台|上班/.test(text)) return "咖啡馆吧台，木质台面和暖光";
  const hour = input.hour;
  if (hour >= 8 && hour < 17) return "咖啡馆窗边，午后暖光";
  if (hour >= 17 && hour < 21) return "傍晚的店里，暖色灯光";
  return "家里的窗边，柔和台灯";
}

/** 构造发给 Qwen-Image-Edit 的完整 prompt（场景 + 情绪 + 固定画风）。 */
export function buildSelfiePromptForRequest(input: SelfieRequestInput): {
  prompt: string;
  scene: string;
} {
  const scene = inferSelfieScene(input);
  const emotion = input.emotionVector ?? 0;
  const mood =
    emotion > 0.3 ? "表情轻松，嘴角带笑" : emotion < -0.2 ? "表情安静，有点疲惫" : "表情自然，看着镜头";
  const weather = input.weather?.condition ? `，${input.weather.condition}` : "";
  const scenePrompt = `${scene}${weather}，${mood}，对着镜头自拍，胸部以上近景，不出现手和手臂`;
  return { prompt: buildSelfiePrompt(scenePrompt), scene };
}

const CAPTIONS = ["拍好了，刚拍的", "喏，刚拍的", "这张还行吧", "给你拍了一张", "刚拍的，光线还不错"];

// ── MOSS 人物 LoRA 自拍 prompt（与 identity LoRA 训练 caption 对齐）────────────
//
// 训练数据（docs/CHARACTER_LORA_TRAINING.md §3.2）每张 caption 都以固定的
// `karen_style` + 身份短语 + 铅笔水彩画风短语开头；这里逐字复用这些锚点，
// 场景只换「场景/服装/光线」三段，避免触发词过期导致身份漂移。

/** identity LoRA 固定触发词（训练 caption 第 1 个 token） */
export const MOSS_CHARACTER_TRIGGER = "karen_style";

const MOSS_CHARACTER_IDENTITY =
  `${MOSS_CHARACTER_TRIGGER}, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), ` +
  "gray-blue eyes, pale skin";
const MOSS_CHARACTER_STYLE =
  "soft pencil and watercolor illustration style, low-saturation cool gray-blue palette, " +
  "fine pencil and ink linework with light watercolor wash, subtle paper texture, " +
  "clean background with a clear scene atmosphere, single person, no text, no watermark, no border";
const MOSS_CHARACTER_SELFIE = "close-up selfie, head and shoulders, facing the camera, no hands";

interface MossSceneClause {
  scene: string;
  outfit: string;
  light: string;
}

/** inferSelfieScene 的中文场景 → 训练集里出现过的英文场景/服装/光线短语 */
const MOSS_SCENE_CLAUSES: Array<[RegExp, MossSceneClause]> = [
  [
    /雨/,
    {
      scene: "by the window on a rainy day, raindrops on the glass",
      outfit: "wearing an oatmeal knit cardigan",
      light: "cool diffused light on a rainy day",
    },
  ],
  [
    /海边|沙滩|海浪/,
    {
      scene: "the seaside at dusk, an orange sky over calm water",
      outfit: "wearing a light linen dress",
      light: "warm orange sunset side light",
    },
  ],
  [
    /公园|花|春天/,
    {
      scene: "a park bench in early spring, budding trees and fresh green grass",
      outfit: "wearing a beige trench coat",
      light: "dappled light through leaves",
    },
  ],
  [
    /夜|街|霓虹|路灯/,
    {
      scene: "a city street at night, neon signs and wet pavement reflecting the lights",
      outfit: "wearing a long black coat",
      light: "mixed cool neon light and warm sign light",
    },
  ],
  [
    /家|沙发|窝在|卧室|床上/,
    {
      scene: "a cozy living-room sofa at home",
      outfit: "wearing a dark gray knit long-sleeve top",
      light: "soft warm indoor lamp light",
    },
  ],
  [
    /店|咖啡|吧台|上班|窗边/,
    {
      scene: "sitting by a window seat in a cafe, a coffee cup on the table",
      outfit: "wearing a light denim jacket",
      light: "warm afternoon light",
    },
  ],
];

/**
 * 构造发给「人物专用 MOSS 服务」（merged identity LoRA）的自拍 prompt。
 * 与训练 caption 保持同一触发词/身份/画风锚点；场景只从句表里选。
 */
export function buildMossCharacterSelfiePrompt(input: SelfieRequestInput): {
  prompt: string;
  scene: string;
} {
  const scene = inferSelfieScene(input);
  const clause =
    MOSS_SCENE_CLAUSES.find(([pattern]) => pattern.test(scene))?.[1] ?? {
      scene: "a quiet indoor corner",
      outfit: "wearing a light knit cardigan",
      light: "soft natural light",
    };
  const emotion = input.emotionVector ?? 0;
  const mood =
    emotion > 0.3
      ? "a slight smile, relaxed expression"
      : emotion < -0.2
        ? "a calm expression, a little tired"
        : "a natural expression, looking at the camera";
  const weather = input.weather?.condition ? `, ${input.weather.condition}` : "";
  const prompt = [
    MOSS_CHARACTER_IDENTITY,
    clause.scene + weather,
    clause.outfit,
    clause.light,
    mood,
    MOSS_CHARACTER_SELFIE,
    MOSS_CHARACTER_STYLE,
  ].join(", ");
  return { prompt, scene };
}

/** Qwen-Image-Edit 自拍的负面提示词（仅用于 MOSS-t2i 的 negative branch） */
const MOSS_CHARACTER_NEGATIVE =
  "text, watermark, logo, multiple people, extra fingers, deformed hands, bad anatomy, blurry";

/** 挑一句配文，尽量不与最近用过的重复。 */
export function pickSelfieCaption(random: () => number = Math.random, recent: string[] = []): string {
  const fresh = CAPTIONS.filter((caption) => !recent.includes(caption));
  const pool = fresh.length > 0 ? fresh : CAPTIONS;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? CAPTIONS[0];
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

interface BackendAttemptOutcome {
  ok: boolean;
  bytes?: Buffer;
  attempts: number;
  reason?: SelfieFailureReason;
  audit?: ImageAudit | null;
}

/**
 * 单个后端的 2 次尝试（生成 + guard；失败换 seed 重试一次）。
 * 失败一律返回 ok:false（不抛异常），由调用方决定是否换下一个后端。
 */
async function runBackendAttempts(
  backend: SelfieBackend,
  prompt: string,
  context: string,
  steps: number,
  deps: SelfieGenerationDeps,
): Promise<BackendAttemptOutcome> {
  const qwenGenerate = deps.qwenGenerateFn ?? generateQwenImageEdit;
  const mossEditGenerate = deps.mossEditGenerateFn ?? editMossImage;
  const mossCharacterGenerate = deps.mossCharacterGenerateFn ?? generateMossCharacterImage;
  const mossHybridGenerate = deps.mossHybridGenerateFn ?? generateMossHybridImage;
  const audit: AuditFn = deps.auditFn ?? auditImage;
  const failureReason: SelfieFailureReason =
    backend === "moss-edit"
      ? "moss_failed"
      : backend === "moss-t2i"
        ? "moss_t2i_failed"
        : backend === "moss-hybrid"
          ? "moss_hybrid_failed"
          : "qwen_failed";
  let lastReason: SelfieFailureReason = failureReason;
  let lastAudit: ImageAudit | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let generated: QwenImageEditResult | MossImageResult | null = null;
    try {
      if (backend === "moss-edit") {
        generated = await mossEditGenerate(prompt, [SELFIE_STYLE_REF], {
          steps,
          seed: Math.floor(Math.random() * 1_000_000),
          timeoutMs: 300_000,
        });
      } else if (backend === "moss-t2i") {
        generated = await mossCharacterGenerate(prompt, {
          width: 832,
          height: 1216,
          steps,
          seed: Math.floor(Math.random() * 1_000_000),
          negativePrompt: MOSS_CHARACTER_NEGATIVE,
          timeoutMs: 300_000,
        });
      } else if (backend === "moss-hybrid") {
        generated = await mossHybridGenerate(prompt, {
          width: 832,
          height: 1216,
          fixSteps: steps,
          seed: Math.floor(Math.random() * 1_000_000),
          timeoutMs: 360_000,
        });
      } else {
        generated = await qwenGenerate(prompt, {
          simple: true,
          imagePaths: [SELFIE_STYLE_REF],
          steps,
          seed: Math.floor(Math.random() * 1_000_000),
          timeoutMs: 150_000,
        });
      }
    } catch (err) {
      log.warn("selfie.generate_error", {
        backend,
        attempt,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    if (!generated || !isPng(generated.png)) {
      lastReason = failureReason;
      continue;
    }
    if (generated.png.length > 8 * 1024 * 1024) {
      lastReason = "too_large";
      continue;
    }

    const auditResult = await audit(generated.png, {
      context,
      prompt,
      requireNoHands: true,
      expectCharacter: true,
    }).catch(() => null);
    lastAudit = auditResult;
    if (!auditResult) {
      lastReason = "guard_unavailable";
      continue;
    }
    if (!auditResult.pass) {
      lastReason = "guard_rejected";
      log.warn("selfie.guard_rejected", {
        backend,
        attempt,
        issues: auditResult.issues.slice(0, 3),
        reason: auditResult.reason.slice(0, 80),
      });
      continue;
    }

    return { ok: true, bytes: generated.png, attempts: attempt, audit: auditResult };
  }

  return { ok: false, attempts: 2, reason: lastReason, audit: lastAudit };
}

/**
 * 生成一张自拍。失败返回 ok:false + reason，由调用方回退本地自拍。
 * 质检失败会换 seed 重试一次（第一步 8 步实测 22s；两步合计约 45–60s）。
 *
 * 后端链：
 * - 默认 qwen：Qwen-Image-Edit（现状）；
 * - `KAREN_SELFIE_BACKEND=moss-edit`：MOSS `/edit`（当前 501，占位）；
 * - `KAREN_SELFIE_BACKEND=moss-t2i`：先人物 LoRA MOSS，失败/guard 不过时若配置了
 *   `QWEN_IMAGE_EDIT_URL` 再用 Qwen-Image-Edit 兜底（`fallbackUsed=true`）；
 * - `KAREN_SELFIE_BACKEND=moss-hybrid`：先 hybrid wrapper（MOSS 生成 + Qwen 修脸），
 *   失败同样回退 Qwen（`fallbackUsed=true`）。
 */
export async function generateSelfie(
  input: SelfieRequestInput,
  deps: SelfieGenerationDeps = {},
): Promise<SelfieGenerationResult> {
  const env = deps.env ?? process.env;
  const startedAt = Date.now();
  const qwenPrompt = buildSelfiePromptForRequest(input);
  const mossPrompt = buildMossCharacterSelfiePrompt(input);
  const prompts: Record<SelfieBackend, string> = {
    qwen: qwenPrompt.prompt,
    "moss-edit": qwenPrompt.prompt,
    "moss-t2i": mossPrompt.prompt,
    "moss-hybrid": mossPrompt.prompt,
  };
  const scene = qwenPrompt.scene;

  if (!isSelfieGenerationEnabled(env)) {
    return { ok: false, prompt: prompts[selfieBackend(env)], scene, attempts: 0, elapsedMs: 0, reason: "disabled" };
  }

  const primary = selfieBackend(env);
  const chain: SelfieBackend[] =
    (primary === "moss-t2i" || primary === "moss-hybrid") && hasQwenBackend(env)
      ? [primary, "qwen"]
      : [primary];
  const context = [
    input.userText,
    input.lastReply,
    `场景：${scene}`,
    `当前约 ${input.hour} 点`,
    "她是 24 岁蓝发短发少女，要求同一个人、铅笔水彩风格",
  ]
    .filter(Boolean)
    .join(" / ");

  let totalAttempts = 0;
  let lastAudit: ImageAudit | null = null;
  let lastReason: SelfieFailureReason =
    primary === "moss-edit"
      ? "moss_failed"
      : primary === "moss-t2i"
        ? "moss_t2i_failed"
        : primary === "moss-hybrid"
          ? "moss_hybrid_failed"
          : "qwen_failed";

  for (const backend of chain) {
    const outcome = await runBackendAttempts(backend, prompts[backend], context, stepsFromEnv(env, backend), deps);
    totalAttempts += outcome.attempts;
    lastAudit = outcome.audit ?? lastAudit;
    if (outcome.ok && outcome.bytes) {
      return {
        ok: true,
        bytes: outcome.bytes,
        prompt: prompts[backend],
        scene,
        attempts: totalAttempts,
        elapsedMs: Date.now() - startedAt,
        audit: outcome.audit ?? null,
        backend,
        fallbackUsed: backend !== primary,
      };
    }
    lastReason = outcome.reason ?? lastReason;
  }

  return {
    ok: false,
    prompt: prompts[primary],
    scene,
    attempts: totalAttempts,
    elapsedMs: Date.now() - startedAt,
    audit: lastAudit,
    reason: lastReason,
  };
}
