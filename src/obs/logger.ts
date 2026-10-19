/**
 * 零依赖结构化日志（可观测最小闭环，M1-9）。
 *
 * 为什么不用 pino：项目当前不允许新增依赖（package-lock / CI 稳定性优先）。
 * 本模块用纯 Node API 实现「结构化事件 + 默认脱敏 + TTY 可读」的最小闭环；
 * 后续依赖升级窗口可平滑替换成 pino（保持 event/fields 约定即可）。
 *
 * 输出约定：
 * - 非 TTY（生产 / PM2 / 管道）：单行 JSON lines
 *   `{"time":"ISO","level":"info","scope":"qq","event":"ws.connected","fields":{...}}`
 * - TTY（本地开发）：人类可读的一行文本（time level [scope] event k=v ...）
 *
 * 脱敏（默认开启，不可关闭）：
 * - 敏感字段名（message/content/text/prompt/reply/token/api_key/...）只输出长度摘要；
 * - 所有字符串值做密钥模式扫描（sk-xxx / Bearer xxx）并替换为 [redacted]；
 * - 超长字符串截断；循环引用/非法值不会让日志抛错。
 *
 * 用法：
 *   const log = createLogger("qq");
 *   log.info("message.received", { user_id: 123, chars: 7 });
 *   logEvent("error", "bridge.crash", { error: "..." });
 *
 * 注意：日志里的 token 数量（prompt_tokens 等）不是敏感信息；
 * 只有「凭据类 token / api_key / authorization」会被脱敏。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "auto" | "json" | "text";

export interface LoggerConfig {
  /** 日志级别（默认 info；也可用 LOG_LEVEL 环境变量） */
  level?: LogLevel | string;
  /** 输出格式（默认 auto：TTY → text，非 TTY → json；也可用 LOG_FORMAT） */
  format?: LogFormat | string;
  /** 仅测试用：强制 TTY 判定，避免依赖真实 stdout.isTTY */
  tty?: boolean;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// ── 级别 / 格式配置 ─────────────────────────────

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function parseLogLevel(value: string | undefined): LogLevel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_VALUES ? (normalized as LogLevel) : null;
}

function normalizeFormat(value: string | undefined): LogFormat {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "json" || normalized === "text" ? normalized : "auto";
}

const envLevel = parseLogLevel(process.env.LOG_LEVEL) ?? "info";
const envFormat = normalizeFormat(process.env.LOG_FORMAT);

let currentLevel: LogLevel = envLevel;
let currentFormat: LogFormat = envFormat;
let forcedTty: boolean | undefined;

/** 配置全局日志（qq.ts 启动时用 config.log_level 调用；测试也可显式指定）。 */
export function configureLogger(config: LoggerConfig = {}): void {
  const level = parseLogLevel(typeof config.level === "string" ? config.level : undefined);
  if (level) currentLevel = level;
  if (config.format !== undefined) currentFormat = normalizeFormat(String(config.format));
  if (typeof config.tty === "boolean") forcedTty = config.tty;
}

/** 当前日志配置快照（健康检查/测试用）。 */
export function getLoggerConfig(): { level: LogLevel; format: LogFormat; tty: boolean } {
  return {
    level: currentLevel,
    format: currentFormat,
    tty: forcedTty ?? Boolean(process.stdout.isTTY),
  };
}

// ── 脱敏 ────────────────────────────────────────

/** 这些字段名一律只保留长度/摘要，不输出内容。 */
const SENSITIVE_KEY_PATTERN =
  /^(message|messages|content|raw_message|text|raw_text|prompt|prompts|reply|response|reasoning|reasoning_content|token|access_token|refresh_token|auth|authorization|api[_-]?key|apikey|secret|password|cookie|nickname|user_name|display_name|qq_name|sig)$/i;

/** 字符串值里的凭据模式（DeepSeek/OpenAI Key、Bearer 头）。 */
const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})/g;

/** 普通字段值最大输出长度（防日志刷屏）。 */
const MAX_VALUE_CHARS = 300;
/** 嵌套对象最大深度。 */
const MAX_DEPTH = 2;

function charLength(value: string): number {
  return Array.from(value).length;
}

function summarizeSensitive(value: unknown): string {
  if (typeof value === "string") return `[redacted ${charLength(value)} chars]`;
  if (Array.isArray(value)) return `[redacted array ${value.length}]`;
  if (value && typeof value === "object") return "[redacted object]";
  return "[redacted]";
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const replaced = value.replace(SECRET_VALUE_PATTERN, "[redacted]");
    if (charLength(replaced) > MAX_VALUE_CHARS) {
      return `${Array.from(replaced).slice(0, MAX_VALUE_CHARS).join("")}…(${charLength(replaced)} chars)`;
    }
    return replaced;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array ${value.length}]`;
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[object]";
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? summarizeSensitive(entry)
        : sanitizeValue(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** 对字段做脱敏（导出便于单测；logger 内部自动调用）。 */
export function sanitizeLogFields(fields?: LogFields): LogFields | undefined {
  if (!fields) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? summarizeSensitive(value)
      : sanitizeValue(value);
  }
  return result;
}

// ── 最后一条错误（/health last_error 用）──────────

export interface LastErrorEntry {
  time: string;
  scope: string;
  event: string;
  detail: string;
}

let lastError: LastErrorEntry | null = null;

/** 最近一条 error 级日志的摘要（/health 的 last_error）；没有则为 null。 */
export function getLastError(): string | null {
  if (!lastError) return null;
  return `${lastError.event}: ${lastError.detail}`.slice(0, 300);
}

/** 清空最近错误（测试/手动恢复用）。 */
export function clearLastError(): void {
  lastError = null;
}

/** 重置 logger 全局状态（测试用）。 */
export function resetLogger(): void {
  currentLevel = envLevel;
  currentFormat = envFormat;
  forcedTty = undefined;
  lastError = null;
}

// ── 格式化与输出 ─────────────────────────────────

function resolveFormat(): "json" | "text" {
  if (currentFormat !== "auto") return currentFormat;
  const isTty = forcedTty ?? Boolean(process.stdout.isTTY);
  return isTty ? "text" : "json";
}

function formatTime(ts: number, style: "iso" | "clock"): string {
  const date = new Date(ts);
  if (style === "iso") return date.toISOString();
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatTextValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatTextLine(
  level: LogLevel,
  scope: string,
  event: string,
  fields: LogFields | undefined,
  ts: number
): string {
  const parts = [`${formatTime(ts, "clock")} ${LEVEL_LABELS[level].padEnd(5)} [${scope}] ${event}`];
  if (fields) {
    const pairs = Object.entries(fields).map(([key, value]) => `${key}=${formatTextValue(value)}`);
    if (pairs.length > 0) parts.push(pairs.join(" "));
  }
  return parts.join(" ");
}

function formatJsonLine(
  level: LogLevel,
  scope: string,
  event: string,
  fields: LogFields | undefined,
  ts: number
): string {
  return JSON.stringify({
    time: formatTime(ts, "iso"),
    level,
    scope,
    event,
    fields: fields ?? {},
  });
}

function errorDetail(fields: LogFields | undefined): string {
  if (!fields) return "无附加信息";
  const preferred = ["error", "detail", "reason"].find((key) => fields[key] !== undefined);
  if (preferred) return String(fields[preferred]);
  try {
    return JSON.stringify(fields);
  } catch {
    return "无法序列化的字段";
  }
}

function emit(
  level: LogLevel,
  scope: string,
  event: string,
  fields?: LogFields
): void {
  if (LEVEL_VALUES[level] < LEVEL_VALUES[currentLevel]) return;

  const sanitized = sanitizeLogFields(fields);
  const ts = Date.now();

  if (level === "error") {
    lastError = {
      time: formatTime(ts, "iso"),
      scope,
      event,
      detail: errorDetail(sanitized).slice(0, 500),
    };
  }

  try {
    const line =
      resolveFormat() === "json"
        ? formatJsonLine(level, scope, event, sanitized, ts)
        : formatTextLine(level, scope, event, sanitized, ts);
    const stream = LEVEL_VALUES[level] >= LEVEL_VALUES.warn ? process.stderr : process.stdout;
    stream.write(line + "\n");
  } catch {
    // 日志失败绝不影响主流程（宁可丢日志，不可拖垮桥接）
  }
}

/** 创建带 scope 的 logger。 */
export function createLogger(scope: string): Logger {
  return {
    debug: (event, fields) => emit("debug", scope, event, fields),
    info: (event, fields) => emit("info", scope, event, fields),
    warn: (event, fields) => emit("warn", scope, event, fields),
    error: (event, fields) => emit("error", scope, event, fields),
  };
}

/** 无 scope 的全局事件（scope=app）。 */
export function logEvent(level: LogLevel, event: string, fields?: LogFields): void {
  emit(level, "app", event, fields);
}
