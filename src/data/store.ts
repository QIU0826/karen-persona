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
  /** 免打扰起始小时（0-23，支持小数如 22.5；与 end 相等视为关闭免打扰）。 */
  quiet_hours_start: number;
  /** 免打扰结束小时（0-23，支持小数）。 */
  quiet_hours_end: number;
  /**
   * 可观测性 /health 探活端口（**仅绑定 127.0.0.1**）。
   * 默认 18081；设为 0 关闭（不启动 HTTP 服务）。
   */
  health_port: number;
  /**
   * 本地 Web 控制台端口（**仅绑定 127.0.0.1**）。
   * 默认 18082；设为 0 关闭（不启动 HTTP 服务）。
   */
  web_port: number;
  /**
   * Web 控制台访问 token（可选）。设置后所有请求必须携带 `?token=` 或
   * `X-Web-Token` 头，否则 401；不设置时仅本机可访问（启动会告警）。
   */
  web_token?: string;
  /** Web 控制台是否允许查看/切换所有 owner（默认 false，只展示主用户）。 */
  web_all_owners?: boolean;
  /**
   * 是否对首次对话的用户做 AI 披露（默认 true）。
   * 商用/公开发布必须保持 true（合规要求）；仅个人自用可关。
   */
  ai_disclosure: boolean;
  /**
   * 是否要求 QQ 用户确认已满 18 岁后才能对话（默认 true）。
   * 仅对 owner=qq:* 生效（CLI 开发者模式不强制）；个人自用可设 false。
   * 注意：这是自我声明式年龄门，不是身份证/生日校验。
   */
  age_gate_enabled?: boolean;
  /**
   * 主动发图调试覆盖（不设置则用人设 photoShare 里的值）：
   * 亲密度门槛 / 概率（0-1） / 冷却分钟数。仅建议测试期使用。
   */
  photo_share_min_closeness?: number;
  photo_share_probability?: number;
  photo_share_cooldown_minutes?: number;
  /**
   * 群聊是否允许她发生活照（默认 false，隐私保守）：
   * 群聊是多人语境，默认只发文字/QQ 表情/贴纸；显式开启后才把
   * processMessage 的主动发图结果发到群里。
   */
  group_photo_enabled?: boolean;
  /**
   * 语音消息（她偶尔用一条短语音代替打字）：
   * - voice_enabled：总开关（默认 true；本机没有 TTS 能力时自动静默降级为纯文字）
   * - voice_probability：每轮回复后「顺手发语音」的概率（默认 0.12）
   * - voice_min_closeness：亲密度门槛（默认 2.5，太低时不会给陌生人发语音）
   * - voice_cooldown_minutes：同一用户两次语音的最小间隔（默认 8 分钟）
   * - voice_max_chars：语音最长字数（默认 40，太长会拆句/放弃）
   * - voice_group_enabled：群聊是否允许发语音（默认 false）
   */
  voice_enabled?: boolean;
  voice_probability?: number;
  voice_min_closeness?: number;
  voice_cooldown_minutes?: number;
  voice_max_chars?: number;
  voice_group_enabled?: boolean;
  /**
   * 语音音色与语气（v0.4.1，针对「TTS 念起来太像 AI」）：
   * - voice_tts_voice：macOS `say` 发音人（默认 Tingting；也可用 Meijia/Sinji，
   *   见 `say -v '?'`；装了高质量语音的话填它的名字）
   * - voice_tts_rate：基准语速（字/分钟，默认 180；真人聊天比朗读慢一点）
   * - voice_style_enabled：是否按情绪/时间调整语速音高、加句中停顿（默认 true）
   * - voice_filler_probability：偶尔加个语气词「嗯…」的概率（默认 0.12，0 = 不加）
   */
  voice_tts_voice?: string;
  voice_tts_rate?: number;
  voice_style_enabled?: boolean;
  voice_filler_probability?: number;
  /**
   * 打字错字 → 撤回 → 改对（真人感细节）：
   * - typo_recall_enabled：总开关（默认 true）
   * - typo_recall_probability：每轮回复触发概率（默认 0.04，太高会显得手滑）
   * - typo_recall_delay_ms：发错字后多久撤回（默认 1500ms）
   * - typo_recall_cooldown_minutes：同一用户两次撤回的最小间隔（默认 20 分钟）
   */
  typo_recall_enabled?: boolean;
  typo_recall_probability?: number;
  typo_recall_delay_ms?: number;
  typo_recall_cooldown_minutes?: number;
  /**
   * 主动消息链路开关（v0.4.0）。四条链路独立，缺省全部开启：
   * - follow_up：她说完一句、你没回，隔 20 分钟~3 小时补一句（不催不追问）
   * - open_topic：冷场 3 小时以上，主动开个话头
   * - life_share：她自己生活里有事发生（因果链/天气/情绪/时段），想跟你分享
   * - silence_revive：好几天没联系，重启联系
   * 调试可用环境变量 `KAREN_PROACTIVE_CHANNELS=off` 一次性全关。
   */
  proactive_channels?: {
    follow_up?: boolean;
    open_topic?: boolean;
    life_share?: boolean;
    silence_revive?: boolean;
  };
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
/** /health 探活端口（默认 18081；0 = 关闭）。 */
export const DEFAULT_HEALTH_PORT = 18081;
/** 本地 Web 控制台端口（默认 18082；0 = 关闭）。 */
export const DEFAULT_WEB_PORT = 18082;
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

/** 解析小时配置：支持 23、"23:30"、"22.5"，范围 0-24。 */
function parseHourOption(value: unknown, source: string): number {
  let hour: number;
  if (typeof value === "number") {
    hour = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(trimmed);
    if (!m) throw new ConfigError(`${source} 需要是 0-24 的小时，如 23 或 "23:30"（当前: ${JSON.stringify(value)}）`);
    hour = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  } else {
    throw new ConfigError(`${source} 需要是 0-24 的小时，如 23 或 "23:30"（当前: ${JSON.stringify(value)}）`);
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) {
    throw new ConfigError(`${source} 超出范围 0-24（当前: ${JSON.stringify(value)}）`);
  }
  return hour === 24 ? 0 : Math.round(hour * 100) / 100;
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

  // 免打扰时段：默认 23:00-07:00；start == end 表示关闭
  const quietStartPicked = pickOption(raw, "quiet_hours_start", "QUIET_HOURS_START");
  const quietHoursStart = quietStartPicked ? parseHourOption(quietStartPicked.value, quietStartPicked.source) : 23;
  const quietEndPicked = pickOption(raw, "quiet_hours_end", "QUIET_HOURS_END");
  const quietHoursEnd = quietEndPicked ? parseHourOption(quietEndPicked.value, quietEndPicked.source) : 7;

  // 可观测性 /health 端口：默认 18081，0 = 关闭（范围 0-65535）
  const healthPortPicked = pickOption(raw, "health_port", "HEALTH_PORT");
  const healthPort = healthPortPicked
    ? parseIntegerOption(healthPortPicked.value, healthPortPicked.source, 0, 65535)
    : DEFAULT_HEALTH_PORT;

  // 本地 Web 控制台：默认 18082，0 = 关闭；token 可选（设置后所有请求需鉴权）
  const webPortPicked = pickOption(raw, "web_port", "WEB_PORT");
  const webPort = webPortPicked
    ? parseIntegerOption(webPortPicked.value, webPortPicked.source, 0, 65535)
    : DEFAULT_WEB_PORT;
  const webAllOwnersPicked = pickOption(raw, "web_all_owners", "WEB_ALL_OWNERS");
  const webAllOwners = webAllOwnersPicked
    ? parseBooleanOption(webAllOwnersPicked.value, webAllOwnersPicked.source)
    : false;
  const webTokenPicked = pickOption(raw, "web_token", "WEB_TOKEN");
  const webToken = webTokenPicked
    ? parseToken(webTokenPicked.value, webTokenPicked.source)
    : undefined;

  // AI 披露：默认关闭（个人自用体验优先，用户明确不希望聊天里出现 AI 披露）。
  // 公开发布/商用建议在 config.yaml 显式开启 ai_disclosure: true（合规）。
  const disclosurePicked = pickOption(raw, "ai_disclosure", "AI_DISCLOSURE");
  const aiDisclosure = disclosurePicked
    ? parseBooleanOption(disclosurePicked.value, disclosurePicked.source)
    : false;

  // 年龄门（18+ 确认）：默认开启（合规）；个人自用可 AGE_GATE=false 关闭
  const ageGatePicked = pickOption(raw, "age_gate_enabled", "AGE_GATE");
  const ageGateEnabled = ageGatePicked
    ? parseBooleanOption(ageGatePicked.value, ageGatePicked.source)
    : true;

  // 主动发图调试覆盖（可选；不设置时用人设 photoShare 的值）
  const photoMinClosenessPicked = pickOption(raw, "photo_share_min_closeness", "PHOTO_SHARE_MIN_CLOSENESS");
  const photoShareMinCloseness = photoMinClosenessPicked
    ? parseOptionalNumber(photoMinClosenessPicked.value, photoMinClosenessPicked.source, 0, 10)
    : undefined;
  const photoProbabilityPicked = pickOption(raw, "photo_share_probability", "PHOTO_SHARE_PROBABILITY");
  const photoShareProbability = photoProbabilityPicked
    ? parseOptionalNumber(photoProbabilityPicked.value, photoProbabilityPicked.source, 0, 1)
    : undefined;
  const photoCooldownPicked = pickOption(raw, "photo_share_cooldown_minutes", "PHOTO_SHARE_COOLDOWN_MINUTES");
  const photoShareCooldownMinutes = photoCooldownPicked
    ? parseOptionalNumber(photoCooldownPicked.value, photoCooldownPicked.source, 0, 1440)
    : undefined;

  // 群聊发图：默认关闭（隐私保守），config.yaml / GROUP_PHOTO=true 显式开启
  const groupPhotoPicked = pickOption(raw, "group_photo_enabled", "GROUP_PHOTO");
  const groupPhotoEnabled = groupPhotoPicked
    ? parseBooleanOption(groupPhotoPicked.value, groupPhotoPicked.source)
    : false;

  // 语音消息：默认开启（本机无 TTS 时自动降级），概率/门槛/冷却可调
  const voiceEnabledPicked = pickOption(raw, "voice_enabled", "VOICE_ENABLED");
  const voiceEnabled = voiceEnabledPicked
    ? parseBooleanOption(voiceEnabledPicked.value, voiceEnabledPicked.source)
    : true;
  const voiceProbabilityPicked = pickOption(raw, "voice_probability", "VOICE_PROBABILITY");
  const voiceProbability = voiceProbabilityPicked
    ? parseOptionalNumber(voiceProbabilityPicked.value, voiceProbabilityPicked.source, 0, 1)
    : 0.12;
  const voiceMinClosenessPicked = pickOption(raw, "voice_min_closeness", "VOICE_MIN_CLOSENESS");
  const voiceMinCloseness = voiceMinClosenessPicked
    ? parseOptionalNumber(voiceMinClosenessPicked.value, voiceMinClosenessPicked.source, 0, 10)
    : 2.5;
  const voiceCooldownPicked = pickOption(raw, "voice_cooldown_minutes", "VOICE_COOLDOWN_MINUTES");
  const voiceCooldownMinutes = voiceCooldownPicked
    ? parseOptionalNumber(voiceCooldownPicked.value, voiceCooldownPicked.source, 0, 1440)
    : 8;
  const voiceMaxCharsPicked = pickOption(raw, "voice_max_chars", "VOICE_MAX_CHARS");
  const voiceMaxChars = voiceMaxCharsPicked
    ? Math.round(parseOptionalNumber(voiceMaxCharsPicked.value, voiceMaxCharsPicked.source, 4, 120))
    : 40;
  const voiceGroupPicked = pickOption(raw, "voice_group_enabled", "VOICE_GROUP");
  const voiceGroupEnabled = voiceGroupPicked
    ? parseBooleanOption(voiceGroupPicked.value, voiceGroupPicked.source)
    : false;

  // 语音音色/语气（可选；缺省 Tingting + 180 + 润色开）
  const voiceTtsVoiceRaw = raw.voice_tts_voice ?? envValue("VOICE_TTS_VOICE");
  const voiceTtsVoice =
    typeof voiceTtsVoiceRaw === "string" && voiceTtsVoiceRaw.trim().length > 0
      ? voiceTtsVoiceRaw.trim()
      : undefined;
  const voiceTtsRatePicked = pickOption(raw, "voice_tts_rate", "VOICE_TTS_RATE");
  const voiceTtsRate = voiceTtsRatePicked
    ? Math.round(parseOptionalNumber(voiceTtsRatePicked.value, voiceTtsRatePicked.source, 100, 300))
    : 180;
  const voiceStylePicked = pickOption(raw, "voice_style_enabled", "VOICE_STYLE_ENABLED");
  const voiceStyleEnabled = voiceStylePicked
    ? parseBooleanOption(voiceStylePicked.value, voiceStylePicked.source)
    : true;
  const voiceFillerPicked = pickOption(raw, "voice_filler_probability", "VOICE_FILLER_PROBABILITY");
  const voiceFillerProbability = voiceFillerPicked
    ? parseOptionalNumber(voiceFillerPicked.value, voiceFillerPicked.source, 0, 1)
    : 0.12;

  // 打字错字 → 撤回 → 改对：私聊正常回复才生效，默认低概率、可关
  const typoRecallEnabledPicked = pickOption(raw, "typo_recall_enabled", "TYPO_RECALL_ENABLED");
  const typoRecallEnabled = typoRecallEnabledPicked
    ? parseBooleanOption(typoRecallEnabledPicked.value, typoRecallEnabledPicked.source)
    : true;
  const typoRecallProbabilityPicked = pickOption(raw, "typo_recall_probability", "TYPO_RECALL_PROBABILITY");
  const typoRecallProbability = typoRecallProbabilityPicked
    ? parseOptionalNumber(typoRecallProbabilityPicked.value, typoRecallProbabilityPicked.source, 0, 1)
    : 0.04;
  const typoRecallDelayPicked = pickOption(raw, "typo_recall_delay_ms", "TYPO_RECALL_DELAY_MS");
  const typoRecallDelayMs = typoRecallDelayPicked
    ? Math.round(parseOptionalNumber(typoRecallDelayPicked.value, typoRecallDelayPicked.source, 500, 5000))
    : 1500;
  const typoRecallCooldownPicked = pickOption(raw, "typo_recall_cooldown_minutes", "TYPO_RECALL_COOLDOWN_MINUTES");
  const typoRecallCooldownMinutes = typoRecallCooldownPicked
    ? Math.round(parseOptionalNumber(typoRecallCooldownPicked.value, typoRecallCooldownPicked.source, 0, 1440))
    : 20;

  // 主动消息链路开关（可选；不写则四条全开）
  const proactiveChannels = parseProactiveChannels(raw.proactive_channels);

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
    quiet_hours_start: quietHoursStart,
    quiet_hours_end: quietHoursEnd,
    health_port: healthPort,
    web_port: webPort,
    web_token: webToken,
    web_all_owners: webAllOwners,
    photo_share_min_closeness: photoShareMinCloseness,
    photo_share_probability: photoShareProbability,
    photo_share_cooldown_minutes: photoShareCooldownMinutes,
    group_photo_enabled: groupPhotoEnabled,
    voice_enabled: voiceEnabled,
    voice_probability: voiceProbability,
    voice_min_closeness: voiceMinCloseness,
    voice_cooldown_minutes: voiceCooldownMinutes,
    voice_max_chars: voiceMaxChars,
    voice_group_enabled: voiceGroupEnabled,
    voice_tts_voice: voiceTtsVoice,
    voice_tts_rate: voiceTtsRate,
    voice_style_enabled: voiceStyleEnabled,
    voice_filler_probability: voiceFillerProbability,
    typo_recall_enabled: typoRecallEnabled,
    typo_recall_probability: typoRecallProbability,
    typo_recall_delay_ms: typoRecallDelayMs,
    typo_recall_cooldown_minutes: typoRecallCooldownMinutes,
    proactive_channels: proactiveChannels,
    ai_disclosure: aiDisclosure,
    age_gate_enabled: ageGateEnabled,
  };
}

/** 主动消息链路名（与 src/impulse/proactive-plan.ts 的 ProactiveChannel 对应） */
const PROACTIVE_CHANNEL_KEYS = ["follow_up", "open_topic", "life_share", "silence_revive"] as const;

/**
 * 解析 proactive_channels（嵌套布尔映射）。
 * 严格校验：写错链路名或非布尔值直接报错，避免"以为关了其实没关"。
 */
function parseProactiveChannels(value: unknown): AppConfig["proactive_channels"] {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new ConfigError(
      'proactive_channels 必须是对象，例如：proactive_channels: { follow_up: false }',
    );
  }
  const src = value as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!(PROACTIVE_CHANNEL_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(
        `proactive_channels 里有未知链路 "${key}"（可选：${PROACTIVE_CHANNEL_KEYS.join(" / ")}）`,
      );
    }
  }
  const out: NonNullable<AppConfig["proactive_channels"]> = {};
  for (const key of PROACTIVE_CHANNEL_KEYS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") {
      throw new ConfigError(`proactive_channels.${key} 必须是 true 或 false（收到 ${JSON.stringify(v)}）`);
    }
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 解析布尔配置项（true/false、1/0、yes/no）。 */
function parseBooleanOption(value: unknown, source: string): boolean {
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${source} 必须是 true/false（当前: ${String(value)}）`);
}

/**
 * 解析可选浮点配置项（范围校验）；未设置时返回 undefined。
 * 用于测试期覆盖主动发图概率/门槛等。
 */
function parseOptionalNumber(
  value: unknown,
  source: string,
  min: number,
  max: number,
): number {
  if (value === null || value === undefined || value === "") {
    throw new ConfigError(`${source} 不能为空`);
  }
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ConfigError(`${source} 必须是 ${min}-${max} 之间的数字（当前: ${String(value)}）`);
  }
  return num;
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
