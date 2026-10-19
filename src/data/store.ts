import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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
}

const CONFIG_PATH = path.resolve("config.yaml");

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `找不到 config.yaml，请复制 config.yaml.example 并修改为你的配置`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parseYaml(raw) as Partial<AppConfig>;

  // 必要字段默认值
  return {
    persona: parsed.persona ?? "xiaoya",
    her_name: parsed.her_name ?? "小雅",
    your_name: parsed.your_name ?? "你",
    location: parsed.location ?? "上海",
    tags: parsed.tags ?? [],
    zodiac: parsed.zodiac,
    mbti: parsed.mbti,
    relationship_background: parsed.relationship_background,
    message_frequency_limit: parsed.message_frequency_limit ?? 10,
    log_level: parsed.log_level ?? "info",
  };
}

// ── 日志级别 ──────────────────────────────────

const LOG_LEVELS: Record<string, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

let currentLogLevel = 1; // info

export function setLogLevel(level: string): void {
  currentLogLevel = LOG_LEVELS[level] ?? 1;
}

function logAt(level: number): boolean {
  return level >= currentLogLevel;
}

/** 仅 debug 模式下打印 */
export function debugLog(msg: string): void {
  if (logAt(0)) console.log(msg);
}
