/**
 * 日记忆的 LLM 生成器（v0.5）。
 *
 * 放在独立文件的原因：调度逻辑（jobs.ts）保持纯函数可测，LLM 调用与记账在这里，
 * 便于单独 mock、单独统计成本（llm_usage.kind = "daily_digest"）。
 */
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";
import type { DailyDigestPrompt } from "./jobs.js";

/**
 * 调用一次模型生成日记忆 JSON。失败返回 null（调度层会当作 parse/chat 失败，下次重试）。
 */
export async function summarizeDayWithLLM(prompt: DailyDigestPrompt): Promise<string | null> {
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
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }) as never,
    );
    recordAuxUsage({ kind: "daily_digest", model: modelConfig.model, startedAtMs }, response.usage);
    return response.choices[0]?.message?.content ?? null;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "unknown";
    console.log(`  [日记忆] 生成失败（${name}），下次心跳重试`);
    return null;
  }
}
