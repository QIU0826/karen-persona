/**
 * herViewOfYou 动态更新 — 她对你的看法随关系演化。
 *
 * 设计原则：
 * - 不是 f(closeness) 的数学函数，而是关键事件驱动的心理快照
 * - 回避型允许"表达滞后"：她愿意说出来的可能比真实感受慢半拍
 * - 异步生成，不阻塞当前回复
 *
 * 触发条件（满足任一）：
 * 1. 亲密度较上次评估跳变 ≥ 0.5
 * 2. 自我叙事弧线阶段变化
 * 3. 距上次更新 > 30 天且亲密度变化 > 1.5（兜底）
 */

import OpenAI from "openai";
import { getChatModel } from "../ai/router.js";
import type { Persona } from "../persona/loader.js";

// ── 触发检测 ──────────────────────────────────

export interface ViewUpdateContext {
  currentCloseness: number;
  lastViewUpdateCloseness: number;
  lastViewUpdateAt: number | null; // timestamp ms，null 表示未初始化过
  narrativeStage: string;
  previousNarrativeStage: string | null;
}

export function shouldUpdateView(ctx: ViewUpdateContext): boolean {
  // 条件 1：亲密度跳变
  if (
    ctx.lastViewUpdateAt !== null &&
    Math.abs(ctx.currentCloseness - ctx.lastViewUpdateCloseness) >= 0.5
  ) {
    return true;
  }

  // 条件 2：叙事弧线阶段变化
  if (
    ctx.previousNarrativeStage !== null &&
    ctx.narrativeStage !== ctx.previousNarrativeStage
  ) {
    return true;
  }

  // 条件 3：30 天超时 + 亲密度显著变化
  if (ctx.lastViewUpdateAt !== null) {
    const daysSince = (Date.now() - ctx.lastViewUpdateAt) / (1000 * 60 * 60 * 24);
    if (daysSince > 30 && Math.abs(ctx.currentCloseness - ctx.lastViewUpdateCloseness) > 1.5) {
      return true;
    }
  }

  return false;
}

// ── LLM 生成 ──────────────────────────────────

export interface HerViewInput {
  persona: Persona;
  currentCloseness: number;
  previousView: string | null;
  /** 最近 30 天的关键记忆片段（从 T2 取，最多 5 条） */
  recentMemories: string[];
}

/**
 * 异步生成新的 herViewOfYou。
 * 不抛异常——失败时返回 null，调用方保持旧值。
 */
export async function generateHerView(input: HerViewInput): Promise<string | null> {
  const { persona, currentCloseness, previousView, recentMemories } = input;

  const closenessLabel =
    currentCloseness <= 3 ? "还不太熟" :
    currentCloseness <= 5 ? "渐渐熟了" :
    currentCloseness <= 7 ? "挺亲近的" : "很在意的人";

  const memoryContext = recentMemories.length > 0
    ? recentMemories.map(m => `- ${m}`).join("\n")
    : "（还没有特别值得一提的片段）";

  const previousViewContext = previousView
    ? `她之前对你的看法是："${previousView}"`
    : "她还没有形成对你的明确看法";

  const attachmentNote = persona.emotions.attachmentStyle === "回避型"
    ? "她是回避型人格，所以她对一个人的真实感受，往往比她愿意说出来的更深一层。她现在说的，是她「可以承认」的那个版本，不是全部。"
    : "";

  const prompt = [
    `你是${persona.name}，${persona.identity.age}岁，${persona.identity.lifeStory.career}。`,
    `说话风格：${persona.speaking.tone}，常用口头禅：${persona.speaking.catchphrases.join("、")}。`,
    "",
    `你和对方的关系：${closenessLabel}（亲密度 ${currentCloseness}/10）。`,
    previousViewContext,
    "",
    "最近你们之间发生的事：",
    memoryContext,
    "",
    attachmentNote,
    "",
    `请用${persona.name}的口吻，用 1-2 句话（不超过 80 个字）描述她此刻对你最真实但未必完全准确的主观感受。`,
    "她可能还没完全承认自己在乎你，也可能对你的评价存在偏见。不要写评价报告，不要用第三人称。像她在心里自言自语。",
    "",
    "只输出她内心的一句话或两句话，不要任何前缀或解释。",
  ].join("\n");

  try {
    const modelConfig = getChatModel();
    const client = new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl,
    });

    const response = await client.chat.completions.create({
      model: modelConfig.model,
      messages: [
        { role: "system", content: "你是一个角色内心独白生成器。只输出角色的内心想法，不要解释，不要引号。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 120,
    });

    const content = response.choices[0]?.message?.content;
    if (!content || content.trim().length === 0) return null;

    return content.trim().replace(/^["']|["']$/g, "").slice(0, 120);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    console.log(`[herView] LLM 生成失败: ${msg}`);
    return null;
  }
}
