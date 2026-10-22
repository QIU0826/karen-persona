/**
 * 图片质检：用独立的视觉模型检查「是否符合聊天上下文 / 是否有解剖与画面异常」。
 *
 * 为什么不用生图模型自己检查：同一模型的偏好与盲区会一致，必须用独立视觉模型。
 * 默认使用项目已有的 DeepSeek Flash 多模态；失败返回 null（调用方应 fail-closed）。
 */
import OpenAI from "openai";
import { createLogger } from "../obs/logger.js";

const log = createLogger("image.guard");

const DEFAULT_VISION_MODEL = "deepseek-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const AUDIT_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 700;

export interface ImageAudit {
  pass: boolean;
  scene_match: boolean;
  character_match: boolean;
  anatomy_ok: boolean;
  hands_ok: boolean;
  artifacts: string[];
  issues: string[];
  reason: string;
}

export interface ImageAuditContext {
  /** 聊天上下文 / 用户期望的画面（自然语言） */
  context: string;
  /** 实际发给生图模型的 prompt（可选） */
  prompt?: string;
  /** 本次是否要求画面不出现手/手臂（simple 模式） */
  requireNoHands?: boolean;
}

interface RawAudit {
  scene_match?: unknown;
  character_match?: unknown;
  anatomy_ok?: unknown;
  hands_ok?: unknown;
  artifacts?: unknown;
  issues?: unknown;
  reason?: unknown;
}

const AUDIT_PROMPT = `你是图片质检员。请检查这张生成图是否适合作为角色 Karen 发给用户的聊天配图。

只看画面事实，不要脑补。重点：
1) scene_match：场景、天气、时间、地点、动作、关键道具是否符合「聊天上下文/期望画面」。不要求字面完全一致，但不能相反或缺少关键信息。
2) character_match：是否仍是同一个蓝发短发少女；脸型、发色、年龄、气质应一致。服装可以按上下文变化。
3) anatomy_ok：手部结构、手指数量、四肢、眼睛、脸、身体比例是否正常；有手时必须重点检查。
4) hands_ok：如果没有手/手臂入镜，填 true；如果有手，检查手指是否 5 根、无融合/缺指/多指/反关节。
5) artifacts：文字、水印、logo、重复肢体、融化、穿模、背景扭曲、奇怪物体、明显 AI 瑕疵。
6) 宁严勿松：只要有一项明显异常就应判 pass=false。

只输出一个 JSON 对象，不要 Markdown、不要解释：
{"scene_match":true,"character_match":true,"anatomy_ok":true,"hands_ok":true,"artifacts":[],"issues":[],"reason":"一句话"}`;

function getApiKey(): string | null {
  const key = process.env.DEEPSEEK_API_KEY;
  return key && key !== "sk-your-key-here" ? key : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** 从模型响应中解析 JSON；容忍 ```json 代码块和前后废话。 */
export function parseAuditResponse(content: string): ImageAudit | null {
  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as RawAudit;
    const audit: ImageAudit = {
      scene_match: asBool(raw.scene_match),
      character_match: asBool(raw.character_match),
      anatomy_ok: asBool(raw.anatomy_ok),
      hands_ok: asBool(raw.hands_ok),
      artifacts: asStrings(raw.artifacts),
      issues: asStrings(raw.issues),
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 300) : "",
      pass: false,
    };
    audit.pass =
      audit.scene_match &&
      audit.character_match &&
      audit.anatomy_ok &&
      audit.hands_ok &&
      audit.artifacts.length === 0;
    return audit;
  } catch {
    return null;
  }
}

/** 用 DeepSeek Flash 检查生成图；失败/解析失败返回 null，调用方不要放行。 */
export async function auditImage(
  png: Buffer,
  ctx: ImageAuditContext,
): Promise<ImageAudit | null> {
  const apiKey = getApiKey();
  if (!apiKey || png.length === 0) return null;
  const baseURL = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.DEEPSEEK_VISION_MODEL || DEFAULT_VISION_MODEL;
  const client = new OpenAI({ apiKey, baseURL, timeout: AUDIT_TIMEOUT_MS, maxRetries: 0 });
  const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
  const noHandsRule = ctx.requireNoHands
    ? "本次硬性要求：画面中不允许出现任何手或手臂；只要出现手/手臂，hands_ok=false 且 scene_match=false。"
    : "";
  const userText = [
    `聊天上下文/期望画面：${(ctx.context ?? "").slice(0, 1200)}`,
    ctx.prompt ? `生图 prompt：${ctx.prompt.slice(0, 1200)}` : "",
    noHandsRule,
    AUDIT_PROMPT,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            { type: "text", text: userText },
          ],
        },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.1,
      thinking: { type: "disabled" },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    const audit = parseAuditResponse(content);
    if (!audit) log.warn("image.guard_parse_failed");
    return audit;
  } catch (err: unknown) {
    log.warn("image.guard_failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
