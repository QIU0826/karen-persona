/**
 * 锚点复筛的 LLM 调用（v0.8.4）。
 *
 * 与其它旁路调用一致：thinking 关闭、JSON 输出、记账到 llm_usage（kind=anchor_refine），
 * 失败返回 null（调度层下次再试，不阻塞对话）。
 */
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";

export async function refineAnchorsWithLLM(prompt: {
  system: string;
  user: string;
}): Promise<string | null> {
  try {
    const modelConfig = getChatModel();
    const client = new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl,
      timeout: 20_000,
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
    recordAuxUsage({ kind: "anchor_refine", model: modelConfig.model, startedAtMs }, response.usage);
    return response.choices[0]?.message?.content ?? null;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "unknown";
    console.log(`  [锚点复筛] LLM 调用失败（${name}）`);
    return null;
  }
}
