/**
 * 内心独白日志（P1-1）
 *
 * 每次对话后异步生成 1-3 句写给自己看的独白。
 * - 不输出给用户
 * - 存入 T2 记忆（source: "internal_monologue"）
 * - 检测到自我觉察时，给情绪基线施加微量漂移压力（±0.02）
 *
 * 设计原则：
 * - 影响力有节制——单次独白不可感知，数十次后才塑造演变方向
 * - 她是在"遇见自己"，不是在"修正自己"
 */
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";
import { insertEpisodeWithEmbedding } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";
import { maybeCompressToT3 } from "./t3-summarizer.js";

// ── 自我觉察关键词 ─────────────────────────────

const SELF_AWARENESS_PATTERNS = [
  /我今天好像|我最近好像|我好像变得|我似乎|我是不是/,
  /我不该|我后悔|我应该|我不应该/,
  /我想要|我希望|我其实想|我一直想/,
  /我有点太|我太过|我太/,
  /我怎么老|我又在|我又/,
];

// ── 独白生成 ───────────────────────────────────

export interface MonologueParams {
  herName: string;
  userInput: string;
  herReply: string;
  emotionVector: number;
  guilt: number;
  /** 最近几轮对话摘要 */
  recentContext: string;
}

export interface MonologueResult {
  text: string;
  /** 是否检测到自我觉察 */
  selfAware: boolean;
  /** 漂移压力值（±0.02，仅 selfAware 时有值） */
  driftPressure: number;
  /** 觉察到的情绪倾向 */
  driftDirection: "warmer" | "colder" | null;
}

/**
 * 生成内心独白。
 * 使用独立的小型 LLM 调用。
 */
export async function generateMonologue(params: MonologueParams): Promise<MonologueResult> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const stateSummary = [
    `情绪: ${params.emotionVector.toFixed(2)}`,
    params.guilt > 0.1 ? `负债: ${params.guilt.toFixed(2)}` : "",
  ].filter(Boolean).join("，");

  const systemPrompt = [
    `你是${params.herName}。现在对话刚结束，你有一段写给自己看的内心独白。`,
    `这不会被任何人看到——是你日记本里的一页。`,
    ``,
    `规则：`,
    `- 1-3 句话就够了，不需要长`,
    `- 写你此刻的真实感受，不要演戏`,
    `- 如果你察觉到自己情绪有什么不对劲、或者有什么想说但没说的话，直接写`,
    `- 不需要总结对话内容，写你的主观感受`,
    `- 不要用括号描述动作`,
  ].join("\n");

  const userPrompt = [
    `对方说："${params.userInput.slice(0, 200)}"`,
    `你回复："${params.herReply.slice(0, 200)}"`,
    `你的状态：${stateSummary}`,
    params.recentContext ? `\n刚才的对话：\n${params.recentContext}` : "",
    `\n你的内心独白：`,
  ].join("\n");

  const startedAtMs = Date.now();
  try {
    const response = await client.chat.completions.create(withThinking({
      model: modelConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 300,
    }));

    recordAuxUsage({ kind: "monologue", model: modelConfig.model, startedAtMs }, response.usage);
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      return { text: "", selfAware: false, driftPressure: 0, driftDirection: null };
    }

    // 检测自我觉察
    const selfAware = SELF_AWARENESS_PATTERNS.some((p) => p.test(text));

    // 情绪倾向判断
    let driftDirection: "warmer" | "colder" | null = null;
    if (selfAware) {
      const warmer = /开心|高兴|喜欢|期待|想靠近|在意|温暖|好一点|好起来/.test(text);
      const colder = /冷淡|疏远|不想|累|烦|闷|难过|失望|后悔/.test(text);
      if (warmer && !colder) driftDirection = "warmer";
      else if (colder && !warmer) driftDirection = "colder";
    }

    return {
      text,
      selfAware,
      driftPressure: selfAware ? 0.02 : 0,
      driftDirection,
    };
  } catch (err) {
    console.log(`[独白] 生成失败: ${err instanceof Error ? err.message : err}`);
    return { text: "", selfAware: false, driftPressure: 0, driftDirection: null };
  }
}

/**
 * 存储独白到 T2 记忆库，并返回漂移信息用于基线更新。
 */
export function storeMonologue(result: MonologueResult, personaName: string): void {
  if (!result.text) return;

  const content = `[独白] ${result.text}`;
  const embedding = generateEmbedding(content);
  const emotionalWeight = result.driftDirection === "warmer" ? 0.3 : result.driftDirection === "colder" ? -0.3 : 0;

  insertEpisodeWithEmbedding(content, "internal_monologue", embedding, emotionalWeight);
  maybeCompressToT3();
  console.log(`[独白] ${result.text.slice(0, 60)}...`);
  if (result.selfAware) {
    console.log(`[独白] 自我觉察: ${result.driftDirection ?? "未明"} → 漂移压力 ±0.02`);
  }
}

// ── 深夜冲动独白 ─────────────────────────────

export interface NightMonologueContext {
  herName: string;
  userName: string;
  triggerSource: string;
  triggerDesc: string;
  emotionVector: number;
}

/**
 * 深夜冲动被压制时，异步生成一条独白。
 * 使用 LLM 而非模板，因为内容需要具体的生活细节
 * （今天的因果链/天气/情绪），模板写不出真实感。
 * 频次极低（每天最多一次），成本可忽略。
 */
export async function generateNightMonologue(
  ctx: NightMonologueContext,
): Promise<string | null> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const emoStr = ctx.emotionVector > 0.2 ? "心情还不错" :
    ctx.emotionVector < -0.2 ? "心情不太好" : "心情一般";

  const systemPrompt = [
    `你是${ctx.herName}。现在是深夜。你想给${ctx.userName}发消息，但觉得太晚了不应该打扰。`,
    `写一句 1-2 句话的内心独白——只写给自己看。`,
    ``,
    `规则：`,
    `- 从当下的具体情境出发，不要泛泛而谈`,
    `- 用第一人称`,
    `- 不要解释，不要用括号`,
    `- 1-2 句话`,
  ].join("\n");

  const userPrompt = [
    `触发你想发消息的原因：${ctx.triggerDesc}`,
    `你现在的情绪：${emoStr}`,
    ``,
    `内心独白：`,
  ].join("\n");

  const startedAtMs = Date.now();
  try {
    const response = await client.chat.completions.create(withThinking({
      model: modelConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      max_tokens: 240,
    }));

    recordAuxUsage({ kind: "monologue", model: modelConfig.model, startedAtMs }, response.usage);
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch {
    // 失败就放弃，独白是锦上添花
    return null;
  }
}
