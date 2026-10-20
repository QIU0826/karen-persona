/**
 * Unsplash 主动发图触发器（P2-c）。
 *
 * 设计原则：
 * - 决策层只判断"何时发"（情绪/亲密度/时段/冷却）
 * - "发什么"由 LLM 根据她刚说的话 + 情绪 + 视觉人格当场生成
 * - 不预设兴趣池，不硬编码主题
 */
import OpenAI from "openai";
import { getChatModel } from "../ai/router.js";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { previewText } from "../obs/safe-text.js";
import { fetchUnsplashPhoto } from "../ai/image-gen.js";
import { describeEmotion } from "../persona/emotion.js";
import { hasPhotosForTags, pickPhotoShare, photoFilePath } from "./photo-library.js";
import { assessPhotoRelevance, buildSceneCaption } from "./media-relevance.js";
import { createLogger } from "../obs/logger.js";
import { buildScenePrompt, generateImage, isImageGenEnabled } from "../media/comfyui.js";
import { saveGeneratedImage } from "../media/generated-store.js";
import type { ConversationState } from "../pipeline/orchestrator.js";

const log = createLogger("photo");

// ── 共享冷却 ──────────────────────────────────

const cooldownMap = new Map<string, number>();
const QUERY_TIMEOUT_MS = 1500;

// ── 降级策略 ──────────────────────────────────

/**
 * 从 Unsplash 搜图，无结果时用更宽泛的词重试一次。
 * 仍无结果则返回 null——不强行配无关图。
 */
async function searchWithFallback(query: string): Promise<string | null> {
  const result = await fetchUnsplashPhoto(query);
  if (result) return result;

  // 去掉后 2-3 个词，用更宽泛的关键词重试
  const words = query.split(" ");
  if (words.length <= 3) return null;
  const broader = words.slice(0, -2).join(" ");
  console.log(`[Unsplash] 首搜无结果，重试: "${previewText(broader)}"`);
  return fetchUnsplashPhoto(broader);
}

// ── LLM query 生成 ────────────────────────────

async function generateQuery(
  lastReply: string,
  emotionDesc: string,
  aesthetic: string,
  vibeKeywords: string[],
): Promise<string | null> {
  const prompt = [
    "基于以下信息，生成一个英文 Unsplash 搜索 query（5-8个词，具体、有画面感）：",
    "",
    `她刚说的话：${lastReply.slice(0, 120)}`,
    `当前情绪：${emotionDesc}`,
    `视觉风格偏好：${aesthetic}`,
    `氛围关键词：${vibeKeywords.join("、")}`,
    "",
    "只输出 query，不要任何解释。",
  ].join("\n");

  try {
    const modelConfig = getChatModel();
    const client = new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl,
    });
    const startedAtMs = Date.now();
    const response = await Promise.race([
      client.chat.completions.create(withThinking({
        model: modelConfig.model,
        messages: [
          {
            role: "system",
            content: "你是图片搜索词生成器。只输出英文搜索短语，不要引号，不要解释。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 80,
      })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("QUERY_TIMEOUT")), QUERY_TIMEOUT_MS),
      ),
    ]);

    recordAuxUsage({ kind: "photo_query", model: modelConfig.model, startedAtMs }, response.usage);

    const content = response.choices[0]?.message?.content;
    if (!content || content.trim().length === 0) return null;

    return content
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\n/g, " ")
      .slice(0, 80);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "QUERY_TIMEOUT") {
      console.log("[Unsplash] query LLM 超时，放弃发图");
    } else {
      console.log(`[Unsplash] query LLM 失败: ${msg}`);
    }
    return null;
  }
}

// ── 主入口 ────────────────────────────────────

const MINIMAL_CAPTIONS = ["随手拍了一张", "喏", "刚好看到", "这张挺好看的"];

export interface PhotoShareResult {
  /** Unsplash 图片 URL（有 Key 且搜索成功时） */
  imageUrl?: string;
  /** 本地兜底图片绝对路径（无 Key/搜索失败时） */
  imageFile?: string;
  caption: string;
  source: "unsplash" | "local" | "generated";
}

/** 是否配置了 Unsplash Key（未配置时直接走本地图库，省一次 LLM query） */
function hasUnsplashKey(): boolean {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  return typeof key === "string" && key.trim().length > 0 && key !== "your-unsplash-key";
}

/** 挑选本地兜底图并发图；资源缺失返回 null。 */
/** 每个用户最近发过的本地图（避免同一张图连着复用） */
const recentLocalPhotoIds = new Map<string, string[]>();
/** 每个用户最近用过的配文（避免同一句话反复出现） */
const recentPhotoCaptions = new Map<string, string[]>();

/** 生图占照片的比例（其余仍用图库：真实、便宜、不占算力） */
export const GENERATED_PHOTO_RATIO = 0.2;

/**
 * 尝试用本机 ComfyUI 生成一张"她随手拍的"照片。
 * 未开启 / 失败 / 超时 → 返回 null，由调用方回退本地图库（绝不阻塞聊天）。
 */
async function tryGeneratedPhoto(
  state: ConversationState,
  options: PhotoShareOptions,
  random: () => number = Math.random,
): Promise<PhotoShareResult | null> {
  if (!isImageGenEnabled()) return null;
  // 点名要图时不赌概率，直接尝试（他要看"现在的"）
  if (!options.requested && random() > GENERATED_PHOTO_RATIO) return null;

  const hour = new Date().getHours();
  const prompt = buildScenePrompt({
    ...(options.preferredTags && options.preferredTags.length > 0
      ? { tags: options.preferredTags }
      : {}),
    emotionVector: state.emotionState.vector,
    hour,
    ...(state.persona.photoShare?.aesthetic
      ? { characterPrompt: state.persona.photoShare.aesthetic }
      : {}),
  });

  const result = await generateImage({ prompt });
  if (!result.ok || !result.bytes) {
    log.warn("photo.gen_failed", { reason: result.reason ?? "unknown" });
    return null;
  }
  const file = saveGeneratedImage(result.bytes);
  if (!file) return null;

  const captionPool =
    (options.preferredTags ?? []).includes("sunset")
      ? ["刚拍的，天这样了", "你看今天的天空"]
      : ["刚拍的", "随手拍了一张", "这个角度还行吧"];
  const caption = captionPool[Math.floor(random() * captionPool.length)];
  log.info("photo.generated", { bytes: result.bytes.length, elapsed_ms: result.elapsedMs ?? 0 });
  return { imageFile: file, caption, source: "generated" };
}

function shareLocalPhoto(
  state: ConversationState,
  preferredTags?: string[],
): PhotoShareResult | null {
  const personaKey = state.storagePersona ?? state.persona.name;
  const recentIds = recentLocalPhotoIds.get(personaKey) ?? [];
  const recentCaptions = recentPhotoCaptions.get(personaKey) ?? [];
  // 时间关系不是硬过滤：早上可以发「昨天的晚霞」，亲密度够了才会分享「以前的照片」
  const choice = pickPhotoShare({
    emotion: state.emotionState.vector,
    hour: new Date().getHours(),
    closeness: state.persona.relationship.closeness,
    ...(preferredTags && preferredTags.length > 0 ? { tags: preferredTags } : {}),
    excludeIds: recentIds,
    excludeCaptions: recentCaptions,
  });
  if (!choice) return null;
  const imageFile = photoFilePath(choice.photo);
  if (!imageFile) {
    log.warn("photo.local_missing", { photo_id: choice.photo.id });
    return null;
  }
  // v0.9：场景命中时用贴题配文（他说晚霞 → 「天这样了」），否则用照片自带配文
  const sceneCaption = buildSceneCaption(preferredTags);
  const caption = sceneCaption ?? choice.caption;
  recentLocalPhotoIds.set(personaKey, [...recentIds, choice.photo.id].slice(-3));
  recentPhotoCaptions.set(personaKey, [...recentCaptions, caption].slice(-5));
  log.info("photo.local", {
    photo_id: choice.photo.id,
    era: choice.era,
    caption_chars: caption.length,
    scene_matched: Boolean(preferredTags && preferredTags.length > 0),
    caption_source: sceneCaption ? "scene" : "photo",
  });
  return { imageFile, caption, source: "local" };
}

/**
 * 尝试主动分享一张图片。
 * - 有 Unsplash Key：LLM 生成 query → 搜索；失败/无结果回退本地图库
 * - 无 Key：直接本地授权图库兜底
 * 返回 { imageUrl | imageFile, caption, source }，或 null（本轮不触发）。
 */
export interface PhotoShareOptions {
  /**
   * 用户明确要照片（「拍张看看」「发张你那边」）。
   * 为 true 时跳过概率判定，但仍受「开关/亲密度/冷却」约束——
   * 不熟的时候她仍会婉拒，符合真人边界。
   */
  requested?: boolean;
  /** 用户提到的场景（晚霞/雪/咖啡/猫…），用于本地图库内容匹配 */
  preferredTags?: string[];
  /** 她刚说的那句话（用于判断"是否在分享生活"，决定该不该顺手发图） */
  lastReply?: string;
  /** 用户这轮原话（判断是否纯问句/抽象话题） */
  userText?: string;
  /** 对方在讲糟心事：这一轮不顺手发生活照（发呆/共情优先） */
  skipWhenTroubleTalk?: boolean;
}

export async function trySharePhoto(
  state: ConversationState,
  lastReply: string,
  options: PhotoShareOptions = {},
): Promise<PhotoShareResult | null> {
  const ps = state.persona.photoShare;
  if (!ps?.enabled) return null;
  if (options.skipWhenTroubleTalk) return null;

  // ── 决策层（config 可覆盖，仅测试/调优用）─────
  const personaId = state.persona.name;
  const cooldownMinutes = state.config.photo_share_cooldown_minutes ?? (ps.cooldownHours ?? 2) * 60;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const lastShare = cooldownMap.get(personaId);
  if (lastShare && Date.now() - lastShare < cooldownMs) return null;

  const minCloseness = state.config.photo_share_min_closeness ?? ps.minCloseness ?? 4;
  if (state.persona.relationship.closeness < minCloseness) return null;

  // 不单独限制时段：夜间消息本身已被免打扰（quiet hours）门控，
  // 她在这个点回消息时顺手发张图（晚霞/店里/路上）是自然的。
  if (!lastReply || lastReply.trim().length === 0) return null;

  const moodBonus = Math.abs(state.emotionState.vector) * 0.04;
  const closenessBonus = (state.persona.relationship.closeness - minCloseness) * 0.015;
  const probability =
    state.config.photo_share_probability ?? Math.min(0.5, 0.08 + moodBonus + closenessBonus);
  if (!options.requested && Math.random() > probability) return null;

  // v0.9 相关性门控：只在「点名 / 场景命中 / 她刚分享生活」时发图，
  // 其余情况宁可不发（回归评审：随机插入的照片被认为"跟对话无关"）
  const sceneTags = options.preferredTags ?? [];
  // 图库里真有这类图时，才把场景算作"命中"（否则场景词只是他说的话，发不出对应的图）
  const sceneMatched = sceneTags.length > 0 && hasPhotosForTags(sceneTags);
  const relevance = assessPhotoRelevance({
    userText: options.userText ?? "",
    lastReply: options.lastReply ?? lastReply,
    sceneTags: sceneMatched ? sceneTags : [],
    photoTags: sceneMatched ? sceneTags : [],
    requested: options.requested === true,
  });
  if (!relevance.share && !options.requested) {
    log.info("photo.skipped_no_hook", { reason: relevance.reason });
    return null;
  }

  // 提前锁定冷却（防止并发重复触发）
  cooldownMap.set(personaId, Date.now());

  // v0.7：约 20% 的照片用本机 ComfyUI 生成（失败静默回退图库）
  const generated = await tryGeneratedPhoto(state, options);
  if (generated) return generated;

  // ── 无 Key：本地图库兜底 ─────────────────────
  if (!hasUnsplashKey()) {
    return shareLocalPhoto(state, options.preferredTags);
  }

  // ── query 生成 + 搜索 ────────────────────────
  const emotionDesc = describeEmotion(state.emotionState);
  const query = await generateQuery(lastReply, emotionDesc, ps.aesthetic, ps.vibeKeywords);
  if (!query) {
    log.warn("photo.query_failed");
    return shareLocalPhoto(state);
  }

  const imageUrl = await searchWithFallback(query);
  if (!imageUrl) {
    log.warn("photo.unsplash_empty", { query });
    return shareLocalPhoto(state);
  }

  const caption = MINIMAL_CAPTIONS[Math.floor(Math.random() * MINIMAL_CAPTIONS.length)];
  log.info("photo.unsplash", { query, url_host: new URL(imageUrl).host });
  return { imageUrl, caption, source: "unsplash" };
}

/** 测试用：重置冷却 */
export function resetCooldown(personaId?: string): void {
  if (personaId) {
    cooldownMap.delete(personaId);
  } else {
    cooldownMap.clear();
  }
}
