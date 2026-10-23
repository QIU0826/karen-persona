/**
 * Qzone 自动发说说：给“她偶尔发一条动态”用。
 * 默认关闭，必须 KAREN_QZONE_AUTO=on + KAREN_QZONE=on；每天最多一条。
 * 只从已经过滤过的热榜里取素材，不抓政治/灾难新闻。
 */
import { createLogger } from "../obs/logger.js";
import { chat } from "../ai/chat.js";
import { getTrendingTopicsAsync } from "../world/trending-fetcher.js";
import type { ConversationState } from "../pipeline/orchestrator.js";
import { publishQzonePost } from "./qzone.js";
import { stripOutboundMediaMarkers } from "../persona/outbound-markers.js";

const log = createLogger("qzone");

const MIN_HOUR = 10;
const MAX_HOUR = 22;
const ATTEMPT_CHANCE = 0.15;

export interface QzoneAutoState {
  lastDate: string | null;
  lastTid?: string;
  lastAt?: number;
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
  return (input.random ?? Math.random)() < ATTEMPT_CHANCE;
}

export function sanitizeQzoneDraft(raw: string): string {
  const text = stripOutboundMediaMarkers(String(raw ?? ""))
    .replace(/\[CQ:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, 120).join("");
}

/** 基于热榜生成一条像真人随手发的动态；失败返回 null。 */
export async function generateQzoneDraft(
  state: ConversationState,
  topicTitle: string,
): Promise<string | null> {
  const system =
    "你在写一条 QQ 空间动态，不是聊天。第一人称、口语、20-50 个中文字，像真人随手发；" +
    "不要新闻播报、不要解释热点、不要 AI 腔、不要 emoji 堆砌、不要链接。只输出正文。";
  const user = `今天你刷到「${topicTitle}」。如果你有感觉就写一条，不想评价就写今天的生活小事。`;
  try {
    const raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      state.persona,
      { complexity: "simple" },
    );
    const draft = sanitizeQzoneDraft(raw);
    if (Array.from(draft).length < 5) return null;
    return draft;
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
): Promise<{ posted: boolean; state: QzoneAutoState; reason?: string }> {
  if (!shouldAttemptAutoPost({ now, lastDate: qzoneState.lastDate, enabled: true })) {
    return { posted: false, state: qzoneState };
  }
  const topics = await getTrendingTopicsAsync();
  const topic = topics.find((t) => t.title.trim().length >= 4) ?? topics[0];
  if (!topic) return { posted: false, state: qzoneState, reason: "no_topic" };

  const content = await generateQzoneDraft(state, topic.title);
  if (!content) return { posted: false, state: qzoneState, reason: "no_draft" };

  const result = await publishQzonePost({ content });
  if (!result.ok) {
    log.warn("qzone.auto_failed", { reason: result.reason ?? "unknown" });
    return { posted: false, state: qzoneState, reason: result.reason };
  }
  log.info("qzone.auto_posted", { chars: Array.from(content).length, tid: result.tid ? "yes" : "no" });
  return {
    posted: true,
    state: { lastDate: localDateKey(now), lastAt: now.getTime(), ...(result.tid ? { lastTid: result.tid } : {}) },
  };
}
