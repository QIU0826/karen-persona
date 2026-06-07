import OpenAI from "openai";
import { getChatModel, classifyComplexity, COMPLEXITY_TOKENS, type MessageComplexity } from "./router.js";
import type { Persona } from "../persona/loader.js";

export interface ChatOptions {
  ragContext?: string;
  shortTermContext?: string;
  /** 消息复杂度分级。未提供时从 messages 自动推断。 */
  complexity?: MessageComplexity;
}

/**
 * 发送消息到 AI 模型并获取回复。
 * Phase 2: 支持 RAG 上下文注入。
 */
export async function chat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  _persona?: Persona,
  options?: ChatOptions
): Promise<string> {
  const complexity = options?.complexity ?? "normal";
  const modelConfig = getChatModel(complexity);

  // 短期在前，长期在后，均追加到 system message 末尾
  const finalMessages = [...messages];
  const contextParts: string[] = [];
  if (options?.shortTermContext) contextParts.push(options.shortTermContext);
  if (options?.ragContext) contextParts.push(options.ragContext);

  if (contextParts.length > 0 && finalMessages[0]?.role === "system") {
    finalMessages[0] = {
      ...finalMessages[0],
      content: finalMessages[0].content + "\n" + contextParts.join("\n"),
    };
  }

  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const startMs = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const maxTokens = COMPLEXITY_TOKENS[complexity];

      const response = await client.chat.completions.create({
        model: modelConfig.model,
        messages: finalMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: 0.9,
        max_tokens: maxTokens,
      });

      const elapsed = Date.now() - startMs;
      if (elapsed > 5000) {
        console.log(`[LLM] 慢响应: ${elapsed}ms (attempt ${attempt + 1})`);
      }

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("AI 返回了空回复");
      }
      return content;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        // 网络错误时短暂等待后重试一次
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  console.log(`[LLM] 失败: ${Date.now() - startMs}ms total, last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);

  throw lastError;
}

/**
 * 流式版本：逐个 token 产出，模拟"边想边打"。
 * 用于 QQ 桥接的实时打字效果。
 */
export async function* chatStream(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  _persona?: Persona,
  options?: ChatOptions
): AsyncGenerator<string> {
  const complexity = options?.complexity ?? "normal";
  const modelConfig = getChatModel(complexity);

  const finalMessages = [...messages];
  const contextParts: string[] = [];
  if (options?.shortTermContext) contextParts.push(options.shortTermContext);
  if (options?.ragContext) contextParts.push(options.ragContext);

  if (contextParts.length > 0 && finalMessages[0]?.role === "system") {
    finalMessages[0] = {
      ...finalMessages[0],
      content: finalMessages[0].content + "\n" + contextParts.join("\n"),
    };
  }

  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const startMs = Date.now();
  let firstTokenMs = 0;

  try {
    const maxTokens = COMPLEXITY_TOKENS[complexity];

    const stream = await client.chat.completions.create({
      model: modelConfig.model,
      messages: finalMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: 0.9,
      max_tokens: maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = (chunk as any).choices?.[0]?.delta?.content;
      if (delta) {
        if (!firstTokenMs) {
          firstTokenMs = Date.now();
          console.log(`[LLM] 首 token: ${firstTokenMs - startMs}ms`);
        }
        yield delta as string;
      }
    }

    const totalMs = Date.now() - startMs;
    if (totalMs > 5000) {
      console.log(`[LLM] 慢响应(stream): ${totalMs}ms`);
    }
  } catch (err) {
    console.log(`[LLM] 流式失败: ${err instanceof Error ? err.message : String(err)}`);
    // 流式失败不回退到非流式——让调用方处理
    throw err;
  }
}
