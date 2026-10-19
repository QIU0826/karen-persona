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
import { fetchUnsplashPhoto } from "../ai/image-gen.js";
import { describeEmotion } from "../persona/emotion.js";
import type { ConversationState } from "../pipeline/orchestrator.js";

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
  console.log(`[Unsplash] 首搜无结果，重试: "${broader}"`);
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
    const response = await Promise.race([
      client.chat.completions.create({
        model: modelConfig.model,
        messages: [
          {
            role: "system",
            content: "你是图片搜索词生成器。只输出英文搜索短语，不要引号，不要解释。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 30,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("QUERY_TIMEOUT")), QUERY_TIMEOUT_MS),
      ),
    ]);

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

const MINIMAL_CAPTIONS = ["今天拍的", "随手拍了一张", "喏", "刚好看到"];

/**
 * 尝试主动分享一张 Unsplash 图片。
 * 在 orchestrator 中 chat() 返回后调用。
 * 返回 { imageUrl, caption }，或 null（本轮不触发）。
 */
export async function trySharePhoto(
  state: ConversationState,
  lastReply: string,
): Promise<{ imageUrl: string; caption: string } | null> {
  const ps = state.persona.photoShare;
  if (!ps?.enabled) return null;

  // ── 决策层 ──────────────────────────────

  const personaId = state.persona.name;
  const cooldownMs = (ps.cooldownHours ?? 2) * 60 * 60 * 1000;
  const lastShare = cooldownMap.get(personaId);
  if (lastShare && Date.now() - lastShare < cooldownMs) return null;

  const minCloseness = ps.minCloseness ?? 4;
  if (state.persona.relationship.closeness < minCloseness) return null;

  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return null;

  if (!lastReply || lastReply.trim().length === 0) return null;

  const moodBonus = Math.abs(state.emotionState.vector) * 0.04;
  const closenessBonus = (state.persona.relationship.closeness - minCloseness) * 0.015;
  const probability = 0.08 + moodBonus + closenessBonus;
  if (Math.random() > probability) return null;

  // 提前锁定冷却（防止并发重复触发）
  cooldownMap.set(personaId, Date.now());

  // ── query 生成 ────────────────────────────

  const emotionDesc = describeEmotion(state.emotionState);
  const query = await generateQuery(
    lastReply,
    emotionDesc,
    ps.aesthetic,
    ps.vibeKeywords,
  );
  if (!query) return null;

  // ── 搜索 + 降级 ──────────────────────────

  const imageUrl = await searchWithFallback(query);
  if (!imageUrl) {
    console.log(`[Unsplash] 搜索无结果: "${query}"，放弃发图`);
    return null;
  }

  const caption = MINIMAL_CAPTIONS[Math.floor(Math.random() * MINIMAL_CAPTIONS.length)];
  console.log(`[Unsplash] 发图: "${query}" → ${imageUrl.slice(0, 60)}...`);
  return { imageUrl, caption };
}

/** 测试用：重置冷却 */
export function resetCooldown(personaId?: string): void {
  if (personaId) {
    cooldownMap.delete(personaId);
  } else {
    cooldownMap.clear();
  }
}
