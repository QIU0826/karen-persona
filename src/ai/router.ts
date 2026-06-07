/**
 * AI 模型路由 + 消息复杂度分级。
 *
 * 按复杂度路由到不同模型：
 *   simple/normal → DEEPSEEK_FLASH_MODEL (默认 deepseek-v4-flash)  → 快 + 省
 *   complex       → DEEPSEEK_PRO_MODEL   (默认 deepseek-v4-pro)    → 深度对话
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

/** 复杂度 → max_tokens */
export const COMPLEXITY_TOKENS: Record<MessageComplexity, number> = {
  simple: 80,
  normal: 250,
  complex: 400,
};

/** 复杂度 → 模型选择 */
export function getChatModel(complexity?: MessageComplexity): ModelConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === "sk-your-key-here") {
    throw new Error("未配置 DEEPSEEK_API_KEY，请在 .env 文件中设置");
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  // complex 用 pro 模型，simple/normal 用 flash 模型
  const isComplex = complexity === "complex";
  const model = isComplex
    ? (process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro")
    : (process.env.DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash");

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

/** 获取语义嵌入模型配置 */
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

export function hasVisionModel(): boolean {
  const key = process.env.QWEN_VL_API_KEY;
  return !!key && key !== "your-key-here";
}

export function hasImageGenModel(): boolean {
  const key = process.env.JIMENG_API_KEY;
  return !!key && key !== "your-key-here";
}
