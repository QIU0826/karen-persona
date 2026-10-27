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
 */
import { auditImage, type ImageAudit } from "../ai/image-guard.js";
import { editMossImage, type MossImageResult } from "../ai/moss-image.js";
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
}

export interface SelfieGenerationDeps {
  qwenGenerateFn?: typeof generateQwenImageEdit;
  /** MOSS-Edit 分支（KAREN_SELFIE_BACKEND=moss-edit）用的生成函数 */
  mossEditGenerateFn?: typeof editMossImage;
  auditFn?: (
    png: Buffer,
    ctx: { context: string; prompt?: string; requireNoHands?: boolean; expectCharacter?: boolean },
  ) => Promise<ImageAudit | null>;
  env?: NodeJS.ProcessEnv;
}

type AuditFn = NonNullable<SelfieGenerationDeps["auditFn"]>;

/** 自拍生成后端：默认 qwen（保持现状）；moss-edit 需显式开启。 */
export type SelfieBackend = "qwen" | "moss-edit";

export function selfieBackend(env: NodeJS.ProcessEnv = process.env): SelfieBackend {
  return (env.KAREN_SELFIE_BACKEND ?? "").trim().toLowerCase() === "moss-edit"
    ? "moss-edit"
    : "qwen";
}

/** 是否启用运行时自拍：默认开；`KAREN_SELFIE_GEN=off` 或没配对应后端地址时关。 */
export function isSelfieGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.KAREN_SELFIE_GEN ?? "on").trim().toLowerCase() === "off") return false;
  if (selfieBackend(env) === "moss-edit") {
    // 显式 opt-in 即视为启用；地址未配时用客户端默认 19115，失败会回退图库。
    return true;
  }
  return Boolean((env.QWEN_IMAGE_EDIT_URL ?? "").trim());
}

function stepsFromEnv(env: NodeJS.ProcessEnv, backend: SelfieBackend = "qwen"): number {
  const raw = Number(env.KAREN_SELFIE_STEPS);
  if (backend === "moss-edit") {
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

/**
 * 生成一张自拍。失败返回 ok:false + reason，由调用方回退本地自拍。
 * 质检失败会换 seed 重试一次（第一步 8 步实测 22s；两步合计约 45–60s）。
 */
export async function generateSelfie(
  input: SelfieRequestInput,
  deps: SelfieGenerationDeps = {},
): Promise<SelfieGenerationResult> {
  const env = deps.env ?? process.env;
  const { prompt, scene } = buildSelfiePromptForRequest(input);
  const startedAt = Date.now();
  if (!isSelfieGenerationEnabled(env)) {
    return { ok: false, prompt, scene, attempts: 0, elapsedMs: 0, reason: "disabled" };
  }

  const backend = selfieBackend(env);
  const qwenGenerate = deps.qwenGenerateFn ?? generateQwenImageEdit;
  const mossEditGenerate = deps.mossEditGenerateFn ?? editMossImage;
  const audit: AuditFn = deps.auditFn ?? auditImage;
  const steps = stepsFromEnv(env, backend);
  const context = [
    input.userText,
    input.lastReply,
    `场景：${scene}`,
    `当前约 ${input.hour} 点`,
  ]
    .filter(Boolean)
    .join(" / ");

  let lastReason: SelfieFailureReason = backend === "moss-edit" ? "moss_failed" : "qwen_failed";
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
      lastReason = backend === "moss-edit" ? "moss_failed" : "qwen_failed";
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
        attempt,
        issues: auditResult.issues.slice(0, 3),
        reason: auditResult.reason.slice(0, 80),
      });
      continue;
    }

    return {
      ok: true,
      bytes: generated.png,
      prompt,
      scene,
      attempts: attempt,
      elapsedMs: Date.now() - startedAt,
      audit: auditResult,
    };
  }

  return {
    ok: false,
    prompt,
    scene,
    attempts: 2,
    elapsedMs: Date.now() - startedAt,
    audit: lastAudit,
    reason: lastReason,
  };
}
