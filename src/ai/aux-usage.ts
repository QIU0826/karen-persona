/**
 * 旁路 LLM 用量记账（统一入口）。
 *
 * 背景：`ai/chat.ts` 的主对话会自动记录 usage，而事实抽取/内心独白/T3 摘要/
 * herView/进化日志/叙事重构/视觉描述/配图搜索词这些**旁路调用**各自 new OpenAI，
 * 之前完全没进 `llm_usage`，导致 /cost 与 `cost_today` 只是下限。
 *
 * 用法：在旁路调用成功拿到 `response.usage` 后调用 `recordAuxUsage`；
 * 失败/无 usage 时静默跳过（不估算、不造假数据）。所有函数都在 try/catch 内，
 * 记账失败绝不影响主业务。
 */
import { recordLlmUsage, type LlmUsageKind } from "../obs/cost-tracker.js";

/** 兼容 DeepSeek/OpenAI 的 usage 结构（字段都可能缺失）。 */
export interface AuxUsageLike {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
}

export interface AuxUsageMeta {
  kind: Exclude<LlmUsageKind, "chat" | "chatStream">;
  model: string;
  /** 请求开始时间（ms），用于记录延迟 */
  startedAtMs: number;
}

/**
 * 记录一次旁路调用（成功拿到 usage 后调用）。
 * @returns 是否真的写入了一行（无 usage/异常时为 false）
 */
export function recordAuxUsage(meta: AuxUsageMeta, usage: AuxUsageLike | null | undefined): boolean {
  if (!usage) return false;
  try {
    const promptTokens = Math.max(0, Math.round(usage.prompt_tokens ?? 0));
    const completionTokens = Math.max(0, Math.round(usage.completion_tokens ?? 0));
    const cachedTokens = Math.max(0, Math.round(usage.prompt_cache_hit_tokens ?? 0));
    const cacheMissTokens =
      typeof usage.prompt_cache_miss_tokens === "number"
        ? Math.max(0, Math.round(usage.prompt_cache_miss_tokens))
        : Math.max(0, promptTokens - cachedTokens);
    const reasoningTokens = Math.max(
      0,
      Math.round(usage.completion_tokens_details?.reasoning_tokens ?? 0),
    );
    recordLlmUsage({
      kind: meta.kind,
      model: meta.model,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheMissTokens,
      reasoningTokens,
      latencyMs: Math.max(0, Date.now() - meta.startedAtMs),
    });
    return true;
  } catch {
    // 记账失败不影响业务
    return false;
  }
}
