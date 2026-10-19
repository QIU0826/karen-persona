/**
 * AI 模型路由 + 消息复杂度分级 + DeepSeek 思考模式配置。
 *
 * 模型名（2026-10 官方文档 canonical 名，勿再用旧名）：
 *   deepseek-flash   → DeepSeek-V4.1-Flash-1017，支持文本 + 图像理解，便宜/快
 *   deepseek-v4-pro  → DeepSeek-V4-Pro-0813，仅文本，适合复杂对话
 *
 * 旧模型名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用（服务端会映射到
 * V4.1-Flash 并按 Flash 计费），但官方已标记下线，本代码统一使用 canonical 名。
 *
 * 用户可在 .env 中覆盖模型名和 Base URL，支持任意 OpenAI 兼容 API。
 */

export type ModelProvider = "deepseek" | "claude" | "qwen-vl" | "jimeng" | "fish-audio";
export type MessageComplexity = "simple" | "normal" | "complex";

export interface ModelConfig {
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** DeepSeek 思考强度。官方支持 low/high/max（OpenAI SDK 原生类型只有 low/medium/high）。 */
export type ThinkingEffort = "low" | "high" | "max";

export interface ThinkingConfig {
  /** 是否启用思考模式。默认 false：聊天场景关闭，避免正文预算被 reasoning_content 吃光。 */
  enabled: boolean;
  /** 传给 Chat Completions 的 DeepSeek 扩展字段（等价于 Python SDK 的 extra_body）。 */
  thinking: { type: "enabled" | "disabled" };
  /** 思考强度，仅 enabled 时随请求发送。 */
  reasoningEffort: ThinkingEffort;
}

/**
 * 复杂度 → max_tokens（非思考模式下的正文预算）。
 *
 * 依据（2026-10-19 真实 API 实测，deepseek-flash）：
 * - 普通日常回复实测 completion 仅 13~26 tokens（约 20~40 个汉字）；
 * - 思考模式默认开启时，80 tokens 会被 reasoning_content 全部吃光 →
 *   finish_reason=length、content=null（这就是必须关闭思考的原因）；
 * - 关闭思考后：160 ≈ 2~4 句（约 200 个汉字）日常回复；320 ≈ 3~5 句带情绪回复；
 *   640 ≈ 长倾诉/复杂建议，余量充足。
 * - 若开启 DEEPSEEK_THINKING=enabled，reasoning 与正文共用 max_tokens，
 *   需按 2~3 倍余量设置（本项目默认关闭，保持预算可控）。
 */
export const COMPLEXITY_TOKENS: Record<MessageComplexity, number> = {
  simple: 160,
  normal: 320,
  complex: 640,
};

/** 未显式配置 DEEPSEEK_THINKING 时的默认值：关闭（生产 bug 修复）。 */
const DEFAULT_THINKING_ENABLED = false;

/** 开启思考时，按复杂度映射思考强度（耗时/成本从低到高）。 */
const COMPLEXITY_EFFORT: Record<MessageComplexity, ThinkingEffort> = {
  simple: "low",
  normal: "high",
  complex: "max",
};

/** 解析 DEEPSEEK_THINKING：enabled/on/true/1 开启；disabled/off/false/0 关闭；非法值回退默认关闭。 */
function parseThinkingEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (["enabled", "on", "true", "1", "yes"].includes(value)) return true;
  if (["disabled", "off", "false", "0", "no"].includes(value)) return false;
  return DEFAULT_THINKING_ENABLED;
}

/** 解析 DEEPSEEK_REASONING_EFFORT；非法值返回 null（回退到复杂度映射）。 */
function parseReasoningEffort(raw: string | undefined): ThinkingEffort | null {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "low" || value === "high" || value === "max" ? value : null;
}

/**
 * 计算本次请求的思考模式配置。
 *
 * 优先级：DEEPSEEK_THINKING（全局开关） > 默认关闭；
 * 强度：DEEPSEEK_REASONING_EFFORT > 按复杂度的映射。
 * 复杂度参数在关闭思考时仅用于确定 reasoningEffort（不随请求发送）。
 */
export function getThinkingConfig(complexity: MessageComplexity = "normal"): ThinkingConfig {
  const enabled = parseThinkingEnabled(process.env.DEEPSEEK_THINKING);
  const effortOverride = parseReasoningEffort(process.env.DEEPSEEK_REASONING_EFFORT);
  return {
    enabled,
    thinking: { type: enabled ? "enabled" : "disabled" },
    reasoningEffort: effortOverride ?? COMPLEXITY_EFFORT[complexity],
  };
}

function getDeepSeekApiKey(): string | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === "sk-your-key-here") return null;
  return apiKey;
}

/** 复杂度 → 模型选择 */
export function getChatModel(complexity?: MessageComplexity): ModelConfig {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY，请在 .env 文件中设置");
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  // complex 用 pro 模型，simple/normal 用 flash 模型
  const isComplex = complexity === "complex";
  const model = isComplex
    ? (process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro")
    : (process.env.DEEPSEEK_FLASH_MODEL || "deepseek-flash");

  return { provider: "deepseek", apiKey, baseUrl, model };
}

/**
 * 按消息特征分级。
 * 规则驱动，零延迟——不额外调 LLM。
 */
export function classifyComplexity(userInput: string): MessageComplexity {
  const trimmed = userInput.trim();
  const len = trimmed.length;

  // 自然收尾 → 简单
  if (/^(嗯|好|ok|哈哈|好的|行|哦|拜拜|晚安|早安|早|再见|bye|hi|嗨|哈喽|在|在吗|在不在|在干嘛|干嘛|在么|嗯嗯|好滴|okk|来了|睡了|起了|吃了|走了|到了|对对|是的|没错|知道了|明白|收到)$/i.test(trimmed)) {
    return "simple";
  }

  // 极短消息 → 简单
  if (len <= 4) return "simple";

  // 短问句 → 简单
  if (len <= 8 && /[\?？]/.test(trimmed)) return "simple";

  // 深度信号 → 复杂
  const deepSignals = [
    /累|烦|难过|不开心|压力|生病|焦虑|不太|有点|崩溃|撑不住|想哭|失眠|失恋|分手|吵|冷战/,
    /为什么|怎么[办了样]|你觉得|你觉着|你怎么看|帮我|请教|建议/,
    /记得.*吗|还记不记得|那时候|以前|小时候|当初|以前.*我们/,
    /喜欢|爱|想[你我]|在意|在乎|离不开|舍不得/,
  ];
  const deepHits = deepSignals.filter((p) => p.test(trimmed));
  if (deepHits.length >= 2) return "complex";
  if (deepHits.length === 1 && len > 20) return "complex";

  // 长消息 → 复杂
  if (len > 60) return "complex";

  // 多行合并 → 复杂
  if (trimmed.includes("\n") && len > 30) return "complex";

  return "normal";
}

/**
 * 获取语义嵌入模型配置。
 * 注意：视觉已改由 DeepSeek Flash 提供；Qwen（DashScope）Key 仅保留给语义嵌入
 * （QWEN_VL_API_KEY 是历史命名，仍然作为嵌入 Key 的兜底）。
 */
export function getEmbeddingConfig(): ModelConfig | null {
  const apiKey = process.env.QWEN_EMBEDDING_API_KEY || process.env.QWEN_VL_API_KEY;
  if (!apiKey || apiKey === "your-key-here") return null;
  return {
    provider: "qwen-vl",
    apiKey,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
  };
}

/** 视觉能力由 DeepSeek Flash 提供：只要配置了可用的 DEEPSEEK_API_KEY 即支持。 */
export function hasVisionModel(): boolean {
  return getDeepSeekApiKey() !== null;
}

export function hasImageGenModel(): boolean {
  const key = process.env.JIMENG_API_KEY;
  return !!key && key !== "your-key-here";
}
