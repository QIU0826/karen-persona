/**
 * 日志正文脱敏（IMP-5）。
 *
 * 背景：桥接的结构化日志已经脱敏，但 orchestrator/evolution 等模块仍有直接
 * `console.log` 打印**内容片段**（独白、日记、发图配文、主动消息、因果链描述等）。
 * 终端与 PM2 日志可能被他人看到，默认不应落正文。
 *
 * 规则：
 * - 默认只输出 `[redacted N chars]`（长度对排障足够）；
 * - `LOG_CONTENT=1` 时输出前 N 字预览（真机排障用，默认关闭）；
 * - 非字符串/空值安全处理。
 */

/** 默认预览长度（LOG_CONTENT=1 时生效）。 */
export const DEFAULT_PREVIEW_CHARS = 40;

function charCount(text: string): number {
  // 用 Array.from 按码点计数，避免 emoji 被算成 2 个字符
  return Array.from(text).length;
}

/**
 * 把一段可能含隐私内容的文本变成可安全写日志的字符串。
 *
 * @param text 原始内容（非字符串会被安全转换为 `""`/`[redacted]`）
 * @param maxChars LOG_CONTENT=1 时的预览长度
 */
export function previewText(text: unknown, maxChars: number = DEFAULT_PREVIEW_CHARS): string {
  if (text === null || text === undefined) return "";
  const value = typeof text === "string" ? text : String(text);
  if (value.length === 0) return "";
  const length = charCount(value);
  if (process.env.LOG_CONTENT === "1") {
    const chars = Array.from(value);
    const preview = chars.slice(0, Math.max(1, maxChars)).join("");
    return length > maxChars ? `${preview}…` : preview;
  }
  return `[redacted ${length} chars]`;
}

/** 错误信息脱敏：保留错误类型/摘要（截断），不打印可能夹带正文的长 message。 */
export function previewError(error: unknown, maxChars: number = 120): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars)}…`;
}
