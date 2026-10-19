import OpenAI from "openai";
import {
  getChatModel,
  getThinkingConfig,
  COMPLEXITY_TOKENS,
  type MessageComplexity,
  type ModelConfig,
  type ThinkingConfig,
} from "./router.js";
import type { Persona } from "../persona/loader.js";

export interface ChatOptions {
  ragContext?: string;
  shortTermContext?: string;
  /** 消息复杂度分级。未提供时从 messages 自动推断。 */
  complexity?: MessageComplexity;
}

/** 请求超时默认值（30s），可用环境变量 LLM_TIMEOUT_MS 覆盖。 */
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
/** 首次请求之外最多再重试 3 次（仅限 429 / 5xx / 网络错误）。 */
const MAX_RETRIES = 3;
/** 指数退避基数 / 上限（含 50%~150% 抖动）。 */
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
/** 错误信息落日志前的截断长度，避免整段 HTML/JSON 刷屏。 */
const ERROR_MESSAGE_MAX_CHARS = 300;
/**
 * 非思考模式下的采样温度。
 * 官方文档：思考模式不支持 temperature / presence_penalty / frequency_penalty，
 * 传入不会报错但也不会生效；因此只在关闭思考时发送，避免误导。
 */
const CHAT_TEMPERATURE = 0.9;

/** 累计 token 用量（进程内），供日志/后续指标接入使用。 */
interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  totalTokens: number;
}

const usageTotals: UsageTotals = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0,
  totalTokens: 0,
};

/** 流式响应在两次 chunk 之间允许的最长静默时间。 */
class LlmStreamIdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmStreamIdleTimeoutError";
  }
}

/** 读取 LLM 超时配置（毫秒）。非法值回退默认 30s。 */
function getLlmTimeoutMs(): number {
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LLM_TIMEOUT_MS;
}

/** 拼接短期 + 长期上下文到首条 system message 末尾（保持原有行为）。 */
function buildFinalMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: ChatOptions
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
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
  return finalMessages;
}

/**
 * 创建 SDK 客户端。
 * 关键：timeout 显式设置；maxRetries=0 关闭 SDK 内置重试，统一由本模块按
 * 「仅 429/5xx/网络错误」重试，避免 SDK 对 400/401 也重试。
 */
function createChatClient(modelConfig: ModelConfig): OpenAI {
  return new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
    timeout: getLlmTimeoutMs(),
    maxRetries: 0,
  });
}

function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") + "…" : text;
}

/** 把 SDK / 原生错误翻译成可读的中文错误信息。 */
function describeError(err: unknown): string {
  if (!err) return "未知错误";
  if (err instanceof LlmStreamIdleTimeoutError) return err.message;
  if (err instanceof OpenAI.APIUserAbortError) return "请求已被取消";
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return `请求超时（>${getLlmTimeoutMs()}ms）`;
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return `网络连接失败：${truncateText(err.message || "无法连接 API", ERROR_MESSAGE_MAX_CHARS)}`;
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    const hints: Record<number, string> = {
      400: "请求参数错误",
      401: "API Key 无效或未授权",
      403: "无访问权限",
      404: "模型或接口不存在",
      408: "请求超时",
      429: "触发限流",
      500: "服务端内部错误",
      502: "网关错误",
      503: "服务不可用",
      504: "网关超时",
    };
    const hint = status !== undefined ? hints[status] : undefined;
    const tail = hint ?? (status !== undefined && status >= 500 ? "服务端错误" : "");
    const detail = truncateText(err.message || "无详细信息", ERROR_MESSAGE_MAX_CHARS);
    return `API 错误 ${status ?? "?"}${tail ? `（${tail}）` : ""}：${detail}`;
  }
  if (err instanceof Error) {
    return truncateText(err.message || err.name, ERROR_MESSAGE_MAX_CHARS);
  }
  return truncateText(String(err), ERROR_MESSAGE_MAX_CHARS);
}

/** 判断原生网络错误（含 cause 链，如 fetch failed → ECONNREFUSED）。 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true; // 含连接超时
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_|EHOSTUNREACH|ENETUNREACH)/.test(code)
    ) {
      return true;
    }
    const message =
      current instanceof Error ? `${current.message} ${current.name}` : String(current);
    if (/fetch failed|network|socket hang up|other side closed|ECONN|ETIMEDOUT/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 是否值得重试。
 * 只重试 429 / 5xx / 网络错误；400、401、404、403 等客户端错误不重试。
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenAI.APIUserAbortError) return false;
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (typeof status !== "number") {
      // 无状态码的 APIError 基本是连接/传输层问题
      return err instanceof OpenAI.APIConnectionError || isNetworkError(err);
    }
    return status === 429 || status >= 500;
  }
  return isNetworkError(err);
}

/** 指数退避 + 抖动：第 n 次重试等待约 500ms * 2^(n-1)，加 50%~150% 抖动。 */
function computeRetryDelayMs(retryNumber: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryNumber - 1);
  const capped = Math.min(RETRY_MAX_DELAY_MS, exponential);
  return Math.round(capped * (0.5 + Math.random()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 记录并打印 token usage。provider 不返回 usage 时静默跳过。 */
function recordUsage(
  kind: "chat" | "chatStream",
  model: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** DeepSeek：思考模式消耗的 tokens，已包含在 completion_tokens 内（按输出计费）。 */
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
    /** DeepSeek：自动 prompt 缓存命中/未命中的输入 tokens。 */
    prompt_cache_hit_tokens?: number | null;
    prompt_cache_miss_tokens?: number | null;
  } | null | undefined
): void {
  if (!usage) return;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;

  usageTotals.calls += 1;
  usageTotals.promptTokens += promptTokens;
  usageTotals.completionTokens += completionTokens;
  usageTotals.reasoningTokens += reasoningTokens;
  usageTotals.cacheHitTokens += cacheHitTokens;
  usageTotals.totalTokens += totalTokens;

  console.log(
    `[LLM] usage(${kind}, ${model}): prompt=${promptTokens} (cache_hit=${cacheHitTokens})` +
      ` completion=${completionTokens} (reasoning=${reasoningTokens}) total=${totalTokens}` +
      ` | 累计 total=${usageTotals.totalTokens} (${usageTotals.calls} 次, cache_hit=${usageTotals.cacheHitTokens})`
  );
}

/** 判断 4xx 错误是否是「provider 不认识 stream_options」→ 可降级重发。 */
function isUnsupportedStreamOptionsError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  const text = `${err.message} ${JSON.stringify(err.error ?? "")}`.toLowerCase();
  return /stream_options|include_usage|unsupported|unknown (field|parameter)|unrecognized/.test(text);
}

/** 读取下一个 chunk，超过 timeoutMs 没有新内容则报超时（防止流式永久挂起）。 */
function nextChunkWithTimeout(
  iterator: AsyncIterator<OpenAI.Chat.Completions.ChatCompletionChunk>,
  timeoutMs: number
): Promise<IteratorResult<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LlmStreamIdleTimeoutError(`流式响应超过 ${timeoutMs}ms 没有新内容`)),
      timeoutMs
    );
  });
  return Promise.race([iterator.next(), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * DeepSeek 在 OpenAI 兼容接口上的扩展请求体字段。
 *
 * 官方文档（思考模式）：OpenAI 格式下 `thinking` 属于 `extra_body`；Python SDK 用
 * `extra_body=` 传入。Node SDK 没有 extra_body——直接把字段放进请求对象即可：
 * SDK 用 JSON.stringify 序列化整个 body，不会过滤未知字段（已用真实 Key 实测生效）。
 */
interface DeepSeekChatBody {
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  max_tokens: number;
  /** DeepSeek 扩展字段：思考模式开关 */
  thinking: { type: "enabled" | "disabled" };
  /** 仅非思考模式发送（思考模式官方会忽略 temperature） */
  temperature?: number;
  /** DeepSeek 思考强度，仅思考模式发送 */
  reasoning_effort?: "low" | "high" | "max";
}

/**
 * 组装 DeepSeek 请求体。
 * - 默认（DEEPSEEK_THINKING 未开）发送 `thinking:{type:"disabled"}` + temperature；
 * - DEEPSEEK_THINKING=enabled 时发送 `thinking:{type:"enabled"}` + reasoning_effort，
 *   不发送 temperature（官方文档：思考模式不支持该参数）。
 */
function buildChatBody(args: {
  modelConfig: ModelConfig;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  thinking: ThinkingConfig;
}): DeepSeekChatBody {
  const { modelConfig, messages, maxTokens, thinking } = args;
  const body: DeepSeekChatBody = {
    model: modelConfig.model,
    messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    max_tokens: maxTokens,
    thinking: thinking.thinking,
  };
  if (thinking.enabled) {
    body.reasoning_effort = thinking.reasoningEffort;
  } else {
    body.temperature = CHAT_TEMPERATURE;
  }
  return body;
}

/**
 * 给「直接调用 openai SDK」的旁路 LLM 调用补上 DeepSeek 思考模式参数。
 *
 * 背景：DeepSeek 思考模式默认开启，且 reasoning_content 与正文共用 max_tokens；
 * 旁路调用（内心独白/T3/hers view/进化日志/热点摘要等）没有统一入口，
 * 若不显式关闭思考，小 max_tokens 会得到空正文（实测复现）。
 *
 * 用法：client.chat.completions.create(withThinking({ model, messages, max_tokens }))
 * 返回类型保持入参类型，运行时额外携带 thinking / reasoning_effort。
 */
export function withThinking(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  complexity: MessageComplexity = "normal",
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const thinking = getThinkingConfig(complexity);
  const body: Record<string, unknown> = { ...params, thinking: thinking.thinking };
  if (thinking.enabled) {
    body.reasoning_effort = thinking.reasoningEffort;
    // 官方文档：思考模式不支持 temperature，传了也不生效
    delete body.temperature;
  }
  return body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

/**
 * 取出正文；空回复时抛出可读错误。
 * 思考模式下 reasoning_content 与 content 共用 max_tokens：若预算被思考耗尽，
 * content 会是 null（实测复现）。这里给出明确的排查提示。
 */
function extractContentOrThrow(response: OpenAI.Chat.Completions.ChatCompletion): string {
  const message = response.choices[0]?.message;
  const content = message?.content;
  if (content) return content;

  const reasoning = (message as { reasoning_content?: string | null } | undefined)?.reasoning_content;
  if (reasoning) {
    const reasoningChars = Array.from(reasoning).length;
    throw new Error(
      `AI 思考占满 max_tokens（reasoning ≈ ${reasoningChars} 字），没有产出正文；` +
        "请关闭思考模式（DEEPSEEK_THINKING=disabled）或提高 max_tokens"
    );
  }
  throw new Error("AI 返回了空回复");
}

/**
 * 发送消息到 AI 模型并获取回复。
 * Phase 2: 支持 RAG 上下文注入。
 *
 * 健壮性（M0）：
 * - 显式 30s 超时（LLM_TIMEOUT_MS 可配）
 * - 关闭 SDK 内置重试，自行对 429/5xx/网络错误做指数退避重试（最多 3 次）
 * - 打印 token usage（含 reasoning / prompt 缓存命中）；错误信息可读
 *
 * DeepSeek 思考模式（2026-10）：
 * - 默认发送 thinking:{type:"disabled"}（可用 DEEPSEEK_THINKING=enabled 覆盖）；
 * - 思考模式默认开启时 max_tokens 会被 reasoning_content 耗尽 → content=null 空回复，
 *   这是本次修复的生产 bug。
 */
export async function chat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  _persona?: Persona,
  options?: ChatOptions
): Promise<string> {
  const complexity = options?.complexity ?? "normal";
  const modelConfig = getChatModel(complexity);
  const finalMessages = buildFinalMessages(messages, options);
  const client = createChatClient(modelConfig);
  const maxTokens = COMPLEXITY_TOKENS[complexity];
  const thinking = getThinkingConfig(complexity);
  const startMs = Date.now();

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const attemptStartMs = Date.now();
    try {
      const body = buildChatBody({ modelConfig, messages: finalMessages, maxTokens, thinking });
      const response = await client.chat.completions.create(
        // 类型断言：thinking/reasoning_effort 是 DeepSeek 扩展字段，OpenAI SDK 类型未声明
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
      );

      const attemptMs = Date.now() - attemptStartMs;
      const totalMs = Date.now() - startMs;
      if (attemptMs > 5000) {
        console.log(`[LLM] 慢响应: ${attemptMs}ms (attempt ${attempt}, 总 ${totalMs}ms)`);
      }

      recordUsage("chat", modelConfig.model, response.usage);
      return extractContentOrThrow(response);
    } catch (err) {
      lastError = err;

      const canRetry = attempt <= MAX_RETRIES && isRetryableError(err);
      if (!canRetry) break;

      const delayMs = computeRetryDelayMs(attempt);
      console.log(
        `[LLM] 第 ${attempt} 次调用失败（${describeError(err)}），${delayMs}ms 后重试（${attempt}/${MAX_RETRIES}）`
      );
      await sleep(delayMs);
    }
  }

  const totalMs = Date.now() - startMs;
  console.log(`[LLM] 失败: ${totalMs}ms total, last error: ${describeError(lastError)}`);
  throw new Error(
    `[LLM] 调用失败（耗时 ${totalMs}ms）：${describeError(lastError)}`,
    { cause: lastError }
  );
}

/**
 * 流式版本：逐个 token 产出，模拟"边想边打"。
 * 用于 QQ 桥接的实时打字效果。
 *
 * 健壮性（M0）：
 * - 连接/响应头 30s 超时（LLM_TIMEOUT_MS 可配），chunk 之间超过同样时长视为卡死
 * - 流式 usage 用 stream_options.include_usage 采集；provider 不支持时静默降级
 * - 未产出任何 token 前可对 429/5xx/网络错误重试；已产出后不重试（避免重复内容）
 * - 错误信息可读
 *
 * DeepSeek 思考模式（2026-10）：与非流式一致，默认发送 thinking:{type:"disabled"}；
 * 思考模式下 delta.reasoning_content 会先于正文到达，本函数只透传正文（不影响 QQ 打字效果）。
 */
export async function* chatStream(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  _persona?: Persona,
  options?: ChatOptions
): AsyncGenerator<string> {
  const complexity = options?.complexity ?? "normal";
  const modelConfig = getChatModel(complexity);
  const finalMessages = buildFinalMessages(messages, options);
  const client = createChatClient(modelConfig);
  const maxTokens = COMPLEXITY_TOKENS[complexity];
  const thinking = getThinkingConfig(complexity);
  const timeoutMs = getLlmTimeoutMs();
  const startMs = Date.now();

  let includeUsage = true;
  let retriesUsed = 0;
  let attempts = 0;
  let lastError: unknown;

  while (attempts < MAX_RETRIES + 1) {
    attempts++;
    const controller = new AbortController();
    let emitted = false;
    let firstTokenAt = 0;
    let reasoningChars = 0;

    try {
      const params: DeepSeekChatBody & {
        stream: true;
        stream_options?: OpenAI.Chat.Completions.ChatCompletionStreamOptions;
      } = {
        ...buildChatBody({ modelConfig, messages: finalMessages, maxTokens, thinking }),
        stream: true,
      };
      if (includeUsage) {
        params.stream_options = { include_usage: true };
      }

      const stream = await client.chat.completions.create(
        // 类型断言：thinking/reasoning_effort 是 DeepSeek 扩展字段，OpenAI SDK 类型未声明
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        {
          signal: controller.signal,
          timeout: timeoutMs,
        }
      );
      const iterator = stream[Symbol.asyncIterator]();

      for (;;) {
        const result = await nextChunkWithTimeout(iterator, timeoutMs);
        if (result.done) break;

        const chunk = result.value;
        // provider 支持 include_usage 时，最后一个 chunk 带 usage
        if (chunk.usage) {
          recordUsage("chatStream", modelConfig.model, chunk.usage);
        }

        const delta = chunk.choices?.[0]?.delta;
        // 思考模式的思维链：不输出给用户（QQ 里只发正文），仅计数用于诊断
        const reasoningDelta = (delta as { reasoning_content?: string | null } | undefined)
          ?.reasoning_content;
        if (reasoningDelta) reasoningChars += Array.from(reasoningDelta).length;

        const contentDelta = delta?.content;
        if (!contentDelta) continue;

        emitted = true;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          console.log(`[LLM] 首 token: ${firstTokenAt - startMs}ms (attempt ${attempts})`);
        }
        yield contentDelta;
      }

      if (!emitted) {
        // 思考模式可能把 max_tokens 全花在 reasoning_content 上 → 用户收不到任何回复
        console.log(
          `[LLM] 警告：流式响应未产出正文（thinking=${thinking.enabled ? "enabled" : "disabled"}，` +
            `reasoning≈${reasoningChars} 字）；若已开启思考模式请提高 max_tokens`
        );
      }

      const totalMs = Date.now() - startMs;
      if (totalMs > 5000) {
        console.log(`[LLM] 慢响应(stream): ${totalMs}ms`);
      }
      return;
    } catch (err) {
      lastError = err;
      controller.abort();

      // stream_options 不被 provider 支持 → 关掉 usage 采集重发，不消耗重试次数
      if (!emitted && includeUsage && isUnsupportedStreamOptionsError(err)) {
        includeUsage = false;
        attempts--;
        console.log("[LLM] 当前服务不支持流式 usage 统计，已静默降级（不影响回复）");
        continue;
      }

      const canRetry =
        !emitted &&
        retriesUsed < MAX_RETRIES &&
        (isRetryableError(err) || err instanceof LlmStreamIdleTimeoutError);

      if (!canRetry) {
        const totalMs = Date.now() - startMs;
        const prefix = emitted ? "流式回复中断（已输出部分内容）" : "流式调用失败";
        const error = new Error(
          `[LLM] ${prefix}（尝试 ${attempts} 次，耗时 ${totalMs}ms）：${describeError(err)}`,
          { cause: err }
        );
        console.log(error.message);
        throw error;
      }

      retriesUsed++;
      const delayMs = computeRetryDelayMs(retriesUsed);
      console.log(
        `[LLM] 流式第 ${attempts} 次尝试失败（${describeError(err)}），` +
          `${delayMs}ms 后重试（${retriesUsed}/${MAX_RETRIES}）`
      );
      await sleep(delayMs);
    } finally {
      // 正常结束 / 提前关闭生成器 / 出错都释放底层连接
      controller.abort();
    }
  }

  const totalMs = Date.now() - startMs;
  console.log(`[LLM] 流式失败: ${totalMs}ms total, last error: ${describeError(lastError)}`);
  throw new Error(
    `[LLM] 流式调用失败（耗时 ${totalMs}ms）：${describeError(lastError)}`,
    { cause: lastError }
  );
}
