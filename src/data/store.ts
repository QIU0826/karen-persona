import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// ── 配置类型 ──────────────────────────────────

export interface AppConfig {
  persona: string;
  her_name: string;
  your_name: string;
  location: string;
  tags: string[];
  zodiac?: string;
  mbti?: string;
  relationship_background?: string;
  message_frequency_limit: number;
  log_level: "debug" | "info" | "warn" | "error";
  /** QQ 用户 ID → 人设 ID 映射。未在此映射中的用户使用默认 persona。 */
  user_personas?: Record<string, string>;
  /** QQ 桥接 WS 监听地址（默认仅本机回环）。 */
  one_bot_ws_host: string;
  /** QQ 桥接 WS 监听端口（默认 18080，与文档/.env 一致）。 */
  one_bot_ws_port: number;
  /** QQ 桥接 WS 路径（NapCat 反向 WS 地址必须与此一致）。 */
  one_bot_ws_path: string;
  /** 可选的握手 token（query access_token 或 Authorization: Bearer）。 */
  one_bot_token?: string;
  /** QQ 用户白名单。空数组 = 允许全部（仅建议个人单用户阶段）。 */
  allowed_users: number[];
}

/** 配置错误。消息面向用户，可直接打印。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`[配置错误] ${message}`);
    this.name = "ConfigError";
  }
}

// ── 默认值 ────────────────────────────────────

export const DEFAULT_ONE_BOT_WS_HOST = "127.0.0.1";
export const DEFAULT_ONE_BOT_WS_PORT = 18080;
export const DEFAULT_ONE_BOT_WS_PATH = "/onebot/v11/ws";
export const DEFAULT_MESSAGE_FREQUENCY_LIMIT = 10;
/** 每分钟消息数上限的合理范围（防封号） */
const MIN_MESSAGE_FREQUENCY_LIMIT = 1;
const MAX_MESSAGE_FREQUENCY_LIMIT = 120;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const CONFIG_PATH = path.resolve("config.yaml");

// ── 校验工具 ──────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readRawConfig(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new ConfigError(
      "找不到 config.yaml，请先复制模板：cp config.yaml.example config.yaml（然后按注释修改）",
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : "未知 YAML 错误";
    throw new ConfigError(`config.yaml 解析失败（YAML 语法错误）: ${detail}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError("config.yaml 顶层必须是一个映射（例如 `persona: \"xiaoya\"`）");
  }
  return parsed;
}

/** 取配置值：config.yaml 优先，其次环境变量，最后默认值 */
function pickOption(
  raw: Record<string, unknown>,
  configKey: string,
  envKey: string,
): { value: unknown; source: string } | null {
  if (raw[configKey] !== undefined && raw[configKey] !== null) {
    return { value: raw[configKey], source: `config.yaml 中的 "${configKey}"` };
  }
  const env = envValue(envKey);
  if (env !== undefined) {
    return { value: env, source: `环境变量 ${envKey}` };
  }
  return null;
}

function parseStringOption(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${source} 必须是字符串（当前: ${JSON.stringify(value)}）`);
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new ConfigError(`${source} 不能为空`);
  return trimmed;
}

function parseIntegerOption(
  value: unknown,
  source: string,
  min: number,
  max: number,
): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new ConfigError(
      `${source} 必须是整数（当前: ${JSON.stringify(value)}，允许范围 ${min}-${max}）`,
    );
  }
  if (num < min || num > max) {
    throw new ConfigError(`${source} 必须在 ${min}-${max} 之间（当前: ${num}）`);
  }
  return num;
}

const QQ_NUMBER_PATTERN = /^\d{5,12}$/;

function formatQqNumberHint(value: unknown): string {
  return `"${String(value)}"（应为 5-12 位数字）`;
}

/**
 * 解析白名单：支持 [123, 456] 数组，或 "123,456" 逗号分隔字符串。
 * 空值/空字符串 → 空数组（= 允许全部，由调用方打印警告）。
 */
export function parseAllowedUsers(value: unknown, source = "allowed_users"): number[] {
  if (value === undefined || value === null) return [];
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\s]+/).filter(Boolean)
      : [value];

  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    const text = typeof item === "number" ? String(item) : typeof item === "string" ? item.trim() : "";
    if (!QQ_NUMBER_PATTERN.test(text)) {
      throw new ConfigError(
        `${source} 中含无效 QQ 号 ${formatQqNumberHint(item)}；示例：allowed_users: [123456789]`,
      );
    }
    const qq = Number(text);
    if (!seen.has(qq)) {
      seen.add(qq);
      result.push(qq);
    }
  }
  return result;
}

function parseUserPersonas(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new ConfigError(
      'config.yaml 中的 "user_personas" 必须是 QQ 号 → 人设 ID 的映射，例如 { 123456789: "qiuyao" }',
    );
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const qq = rawKey.trim();
    if (!QQ_NUMBER_PATTERN.test(qq)) {
      throw new ConfigError(
        `config.yaml 中 "user_personas" 的键 ${formatQqNumberHint(rawKey)}；` +
          `为避免 YAML 把 QQ 号解析成数字，建议写成带引号的键："${qq}"`,
      );
    }
    if (typeof rawValue !== "string" || rawValue.trim() === "") {
      throw new ConfigError(
        `config.yaml 中 "user_personas.${qq}" 必须是非空的人设 ID 字符串（当前: ${JSON.stringify(rawValue)}）`,
      );
    }
    result[qq] = rawValue.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError('config.yaml 中的 "tags" 必须是数组，例如 tags: ["话痨", "粘人"]');
  }
  return value.map((tag) => {
    if (typeof tag !== "string") {
      throw new ConfigError(`config.yaml 中 "tags" 的每一项都必须是字符串（当前: ${JSON.stringify(tag)}）`);
    }
    return tag.trim();
  }).filter(Boolean);
}

function parseOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`config.yaml 中的 "${key}" 必须是字符串（当前: ${JSON.stringify(value)}）`);
  }
  return value;
}

function parseLogLevel(value: unknown): LogLevel {
  if (value === undefined || value === null) return "info";
  if (typeof value !== "string" || !LOG_LEVELS.includes(value.trim() as LogLevel)) {
    throw new ConfigError(
      `config.yaml 中的 "log_level" 必须是 ${LOG_LEVELS.join(" / ")} 之一（当前: ${JSON.stringify(value)}）`,
    );
  }
  return value.trim() as LogLevel;
}

function parseWsHost(value: unknown, source: string): string {
  const host = parseStringOption(value, source);
  if (/[\s/?#]/.test(host)) {
    throw new ConfigError(
      `${source} 格式无效（当前: ${JSON.stringify(host)}）；只接受主机名或 IP，如 127.0.0.1`,
    );
  }
  return host;
}

function parseWsPath(value: unknown, source: string): string {
  const wsPath = parseStringOption(value, source);
  if (!wsPath.startsWith("/")) {
    throw new ConfigError(`${source} 必须以 "/" 开头（当前: ${JSON.stringify(wsPath)}）`);
  }
  if (/[\s?#]/.test(wsPath)) {
    throw new ConfigError(`${source} 不能包含空格、? 或 #（当前: ${JSON.stringify(wsPath)}）`);
  }
  return wsPath;
}

function parseToken(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`${source} 必须是字符串（当前: ${JSON.stringify(value)}）`);
  }
  const token = value.trim();
  return token === "" ? undefined : token;
}

// ── 加载配置 ──────────────────────────────────

export function loadConfig(): AppConfig {
  const raw = readRawConfig();

  // 必填/数值项校验
  const messageFrequencyLimit = (() => {
    const picked = pickOption(raw, "message_frequency_limit", "MESSAGE_FREQUENCY_LIMIT");
    if (!picked) return DEFAULT_MESSAGE_FREQUENCY_LIMIT;
    return parseIntegerOption(
      picked.value,
      picked.source,
      MIN_MESSAGE_FREQUENCY_LIMIT,
      MAX_MESSAGE_FREQUENCY_LIMIT,
    );
  })();

  const logLevel = parseLogLevel(raw.log_level ?? envValue("LOG_LEVEL"));

  // QQ 桥接项：config.yaml 优先，环境变量兜底，默认绑定本机 127.0.0.1:18080
  const hostPicked = pickOption(raw, "one_bot_ws_host", "ONE_BOT_HOST");
  const oneBotWsHost = hostPicked
    ? parseWsHost(hostPicked.value, hostPicked.source)
    : DEFAULT_ONE_BOT_WS_HOST;

  const portPicked = pickOption(raw, "one_bot_ws_port", "ONE_BOT_WS_PORT");
  const oneBotWsPort = portPicked
    ? parseIntegerOption(portPicked.value, portPicked.source, 1, 65535)
    : DEFAULT_ONE_BOT_WS_PORT;

  const pathPicked = pickOption(raw, "one_bot_ws_path", "ONE_BOT_WS_PATH");
  const oneBotWsPath = pathPicked
    ? parseWsPath(pathPicked.value, pathPicked.source)
    : DEFAULT_ONE_BOT_WS_PATH;

  const tokenPicked = pickOption(raw, "one_bot_token", "ONE_BOT_TOKEN");
  const oneBotToken = tokenPicked
    ? parseToken(tokenPicked.value, tokenPicked.source)
    : undefined;

  const allowedPicked = pickOption(raw, "allowed_users", "ALLOWED_USERS");
  const allowedUsers = allowedPicked
    ? parseAllowedUsers(allowedPicked.value, allowedPicked.source)
    : [];

  // 其余字段：保留默认值/原值，类型错误时清晰报错
  const persona = raw.persona === undefined || raw.persona === null
    ? "xiaoya"
    : parseStringOption(raw.persona, 'config.yaml 中的 "persona"');
  const herName = raw.her_name === undefined || raw.her_name === null
    ? "小雅"
    : parseStringOption(raw.her_name, 'config.yaml 中的 "her_name"');
  const yourName = raw.your_name === undefined || raw.your_name === null
    ? "你"
    : parseStringOption(raw.your_name, 'config.yaml 中的 "your_name"');
  const location = raw.location === undefined || raw.location === null
    ? "上海"
    : parseStringOption(raw.location, 'config.yaml 中的 "location"');

  const userPersonas = parseUserPersonas(raw.user_personas);

  return {
    persona,
    her_name: herName,
    your_name: yourName,
    location,
    tags: parseTags(raw.tags),
    zodiac: parseOptionalString(raw.zodiac, "zodiac"),
    mbti: parseOptionalString(raw.mbti, "mbti"),
    relationship_background: parseOptionalString(raw.relationship_background, "relationship_background"),
    message_frequency_limit: messageFrequencyLimit,
    log_level: logLevel,
    user_personas: userPersonas,
    one_bot_ws_host: oneBotWsHost,
    one_bot_ws_port: oneBotWsPort,
    one_bot_ws_path: oneBotWsPath,
    one_bot_token: oneBotToken,
    allowed_users: allowedUsers,
  };
}

// ── 日志级别 ──────────────────────────────────

const LOG_LEVEL_VALUES: Record<string, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

let currentLogLevel = 1; // info

export function setLogLevel(level: string): void {
  currentLogLevel = LOG_LEVEL_VALUES[level] ?? 1;
}

export function getLogLevel(): "debug" | "info" | "warn" | "error" {
  const entry = Object.entries(LOG_LEVEL_VALUES).find(([, value]) => value === currentLogLevel);
  return (entry?.[0] as "debug" | "info" | "warn" | "error") ?? "info";
}

function logAt(level: number): boolean {
  return level >= currentLogLevel;
}

/** 仅 debug 模式下打印 */
export function debugLog(msg: string): void {
  if (logAt(0)) console.log(msg);
}

/** 仅 warn 及更严重时打印 */
export function warnLog(msg: string): void {
  if (logAt(2)) console.warn(msg);
}

/** 仅 error 时打印 */
export function errorLog(msg: string): void {
  if (logAt(3)) console.error(msg);
}
