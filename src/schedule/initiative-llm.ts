/**
 * 每日主动计划生成器（v0.8）。
 *
 * 与 jobs.ts 的分工一致：调度逻辑保持纯函数，LLM 调用与记账在这里。
 * 每天生成 2–3 个「今天想找他聊什么」的由头，存进 initiative_plans 表；
 * 心跳时由 processProactive 读取并挑选（时间窗/上限/校准都在纯函数里）。
 */
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";
import type { DailyInitiativePlan } from "../impulse/initiative-plan.js";

export interface DailyPlanPrompt {
  system: string;
  user: string;
}

/** 调一次模型生成计划 JSON。失败返回 null（调度层下次心跳重试）。 */
export async function generateDailyPlanWithLLM(prompt: DailyPlanPrompt): Promise<string | null> {
  try {
    const modelConfig = getChatModel();
    const client = new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl,
      timeout: 15_000,
      maxRetries: 0,
    });
    const startedAtMs = Date.now();
    const response = await client.chat.completions.create(
      withThinking({
        model: modelConfig.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.7,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }) as never,
    );
    recordAuxUsage({ kind: "initiative_plan", model: modelConfig.model, startedAtMs }, response.usage);
    return response.choices[0]?.message?.content ?? null;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "unknown";
    console.log(`  [主动计划] 生成失败（${name}），下次心跳重试`);
    return null;
  }
}

/** 把解析后的计划序列化（存表用；紧凑 JSON，省空间）。 */
export function serializePlan(plan: DailyInitiativePlan): string {
  return JSON.stringify(plan);
}

/** 反序列化（容错：坏数据返回 null）。 */
export function deserializePlan(json: string): DailyInitiativePlan | null {
  try {
    const parsed = JSON.parse(json) as DailyInitiativePlan;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}
