/**
 * Qzone 自动发说说：给“她偶尔发一条动态”用。
 * 默认关闭，必须 KAREN_QZONE_AUTO=on + KAREN_QZONE=on；每天最多一条。
 * 只从已经过滤过的热榜里取素材，不抓政治/灾难新闻。
 */
import fs from "node:fs";
import { createLogger } from "../obs/logger.js";
import { chat } from "../ai/chat.js";
import { getTrendingTopicsAsync } from "../world/trending-fetcher.js";
import { getBilibiliDigest } from "../world/bilibili.js";
import { validateSocialContent } from "../social/safety.js";
import type { ConversationState } from "../pipeline/orchestrator.js";
import { publishQzonePost } from "./qzone.js";
import { stripOutboundMediaMarkers } from "../persona/outbound-markers.js";
import { getPhotoCatalog, photoFilePath, type PhotoDef } from "../impulse/photo-library.js";

const log = createLogger("qzone");

const MIN_HOUR = 10;
const MAX_HOUR = 22;
const DEFAULT_ATTEMPT_CHANCE = 0.15;

/** 适合她（咖啡店店员）顺手聊的热点；技术/财经/国际新闻不硬蹭。 */
const QZONE_FRIENDLY_TOPIC_RE =
  /(咖啡|美食|餐厅|下厨|做饭|电影|电视剧|综艺|明星|歌手|演唱会|音乐|猫|狗|宠物|学生|校园|老师|天气|降温|霜降|下雪|节日|假期|旅游|景区|穿搭|时尚|游戏|动漫|搞笑|网友|情感|恋爱|结婚|分手|生活|上班|下班|打工|店员|咖啡馆|秋天|冬天|春天|夏天)/;

export function pickQzoneFriendlyTopic<T extends { title: string }>(topics: T[]): T | undefined {
  return topics.find((t) => QZONE_FRIENDLY_TOPIC_RE.test(t.title));
}

/** B 站只读候选 → 适合她发 QQ 空间的生活/娱乐题；不硬蹭芯片/财经/国际。 */
export function pickQzoneTopicFromBilibili<T extends { title: string }>(videos: T[]): T | undefined {
  return videos.find((v) => v.title.trim().length >= 4 && QZONE_FRIENDLY_TOPIC_RE.test(v.title));
}

function attemptChance(): number {
  const raw = Number(process.env.KAREN_QZONE_AUTO_CHANCE ?? DEFAULT_ATTEMPT_CHANCE);
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : DEFAULT_ATTEMPT_CHANCE;
}

export interface QzoneAutoState {
  lastDate: string | null;
  lastTid?: string;
  lastAt?: number;
  lastPhoto?: string;
}

export interface QzonePhotoCandidate {
  path: string;
  id: string;
  tags: string[];
  label: string;
}

export interface QzoneDraft {
  content: string;
  photoPath?: string;
}

export function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function shouldAttemptAutoPost(input: {
  now?: Date;
  lastDate: string | null;
  random?: () => number;
  enabled?: boolean;
}): boolean {
  if (!input.enabled) return false;
  const now = input.now ?? new Date();
  const hour = now.getHours();
  if (hour < MIN_HOUR || hour >= MAX_HOUR) return false;
  if (input.lastDate === localDateKey(now)) return false;
  return (input.random ?? Math.random)() < attemptChance();
}

/** 从本地照片/自拍缓存里抽几张，交给模型决定要不要配图。 */
export function listQzonePhotoCandidates(
  limit = 5,
  random: () => number = Math.random,
): QzonePhotoCandidate[] {
  const pool: Array<{ photo: PhotoDef; path: string }> = [];
  for (const photo of getPhotoCatalog()) {
    const path = photoFilePath(photo);
    if (path) pool.push({ photo, path });
  }
  // 简单洗牌后取前 N 张，避免总是同一张
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(1, limit)).map(({ photo, path }) => ({
    path,
    id: photo.id,
    tags: photo.tags.slice(0, 4),
    label: `${photo.id}：${photo.captions.today[0] ?? photo.captions.yesterday[0] ?? photo.id}（${photo.tags.slice(0, 3).join("/")}）`,
  }));
}

/** 解析模型返回的 {"content":"...","photo":0|null}；失败时把原文当动态、不配图。 */
export function parseQzoneDraftResponse(
  raw: string,
  candidates: QzonePhotoCandidate[],
): QzoneDraft | null {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { content?: unknown; photo?: unknown };
      const content = sanitizeQzoneDraft(String(obj.content ?? ""));
      if (Array.from(content).length >= 5) {
        const idx = obj.photo === null || obj.photo === undefined ? NaN : Number(obj.photo);
        const photoPath = Number.isInteger(idx) && idx >= 0 && idx < candidates.length
          ? candidates[idx]!.path
          : undefined;
        return { content, ...(photoPath ? { photoPath } : {}) };
      }
    } catch {
      // fall through
    }
  }
  const content = sanitizeQzoneDraft(text);
  return Array.from(content).length >= 5 ? { content } : null;
}

export function sanitizeQzoneDraft(raw: string): string {
  const text = stripOutboundMediaMarkers(String(raw ?? ""))
    .replace(/\[CQ:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, 120).join("");
}

/**
 * 基于热榜 + 可选本地照片生成一条动态；模型自己决定要不要配图。
 * 失败返回 null。
 */
export async function generateQzoneDraft(
  state: ConversationState,
  topicTitle: string,
  candidates: QzonePhotoCandidate[] = [],
): Promise<QzoneDraft | null> {
  const career = state.persona.identity?.lifeStory?.career ?? "咖啡店店员";
  const location = state.persona.identity?.lifeStory?.currentStatus ?? "上海";
  const tone = state.persona.speaking?.tone ?? "随性、口语";
  const system =
    `你是${state.persona.name}，${location}，职业是${career}，说话${tone}。` +
    "你在写一条 QQ 空间动态，不是聊天。第一人称、口语、20-50 个中文字，像真人随手发；" +
    "不要新闻播报、不要解释热点、不要 AI 腔、不要 emoji 堆砌、不要链接。" +
    "如果热点是学生/校园，你是店员视角，不要写成自己还在上学。" +
    "可以从给定照片里选一张自然配图；如果都不贴合，就不要配图。只输出 JSON。";
  const photoLines = candidates.map((c, i) => `${i}. ${c.label}`).join("\n") || "（今天没有可用照片）";
  const topicLine = topicTitle
    ? `今天你刷到「${topicTitle}」。如果这个热点跟你的生活（咖啡店/宠物/天气/娱乐/感情）有关，就写它；如果跟你无关，就不要硬蹭，写今天的生活小事。`
    : "今天没有特别适合你聊的热点，就写一条今天的生活小事。";
  const user = `${topicLine}\n可选照片：\n${photoLines}\n\n` +
    `输出：{"content":"20-50字动态","photo":0或null}。如果文案和照片不搭，photo 填 null。`;
  try {
    const raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      state.persona,
      { complexity: "simple" },
    );
    return parseQzoneDraftResponse(raw, candidates);
  } catch {
    return null;
  }
}

/**
 * 自动发一条；返回是否发布。调用方负责限频（每天最多一次）。
 * `state` 只用于取 persona 和热榜素材。
 */
export async function maybeAutoPublishQzone(
  state: ConversationState,
  qzoneState: QzoneAutoState,
  now = new Date(),
): Promise<{
  posted: boolean;
  state: QzoneAutoState;
  reason?: string;
  content?: string;
  tid?: string;
  source?: "bilibili" | "trending" | "none";
}> {
  if (!shouldAttemptAutoPost({ now, lastDate: qzoneState.lastDate, enabled: true })) {
    return { posted: false, state: qzoneState };
  }
  // 先读 B 站热门找生活/娱乐题（只读、失败静默），没有再回退热榜。
  let topicTitle = "";
  let topicSource: "bilibili" | "trending" | "none" = "none";
  try {
    const digest = await getBilibiliDigest();
    const biliTopic = digest ? pickQzoneTopicFromBilibili(digest.items) : undefined;
    if (biliTopic) {
      topicTitle = biliTopic.title;
      topicSource = "bilibili";
    }
  } catch {
    // B 站失败不影响 Qzone
  }
  if (!topicTitle) {
    const topics = await getTrendingTopicsAsync();
    const topic = pickQzoneFriendlyTopic(topics.filter((t) => t.title.trim().length >= 4));
    topicTitle = topic?.title ?? "";
    topicSource = topic ? "trending" : "none";
  }
  const candidates = listQzonePhotoCandidates(5);
  const draft = await generateQzoneDraft(state, topicTitle, candidates);
  if (!draft) return { posted: false, state: qzoneState, reason: "no_draft" };
  const safety = validateSocialContent(draft.content, {
    maxChars: 120,
    maxLinks: 0,
    maxHashtags: 0,
    maxMentions: 0,
  });
  if (!safety.ok) {
    log.warn("qzone.auto_safety_rejected", {
      problems: safety.problems.join(","),
      categories: safety.categories.join(","),
    });
    return { posted: false, state: qzoneState, reason: "unsafe_content" };
  }
  draft.content = safety.sanitized;

  let images: string[] | undefined;
  if (draft.photoPath) {
    try {
      images = [`base64://${fs.readFileSync(draft.photoPath).toString("base64")}`];
    } catch {
      images = undefined;
    }
  }
  const result = await publishQzonePost({ content: draft.content, ...(images ? { images } : {}) });
  if (!result.ok) {
    log.warn("qzone.auto_failed", { reason: result.reason ?? "unknown" });
    return { posted: false, state: qzoneState, reason: result.reason };
  }
  log.info("qzone.auto_posted", {
    chars: Array.from(draft.content).length,
    with_photo: Boolean(images),
    tid: result.tid ? "yes" : "no",
    topic_source: topicSource,
  });
  return {
    posted: true,
    state: {
      lastDate: localDateKey(now),
      lastAt: now.getTime(),
      ...(result.tid ? { lastTid: result.tid } : {}),
      ...(draft.photoPath ? { lastPhoto: draft.photoPath.split("/").pop() } : {}),
    },
    content: draft.content,
    ...(result.tid ? { tid: result.tid } : {}),
    source: topicSource,
  };
}
