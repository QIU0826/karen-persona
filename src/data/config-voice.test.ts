/**
 * 语音消息配置：默认开启、门槛/概率/冷却可调、非法值清晰报错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let originalCwd: string;

const ENV_KEYS = [
  "VOICE_ENABLED",
  "VOICE_PROBABILITY",
  "VOICE_MIN_CLOSENESS",
  "VOICE_COOLDOWN_MINUTES",
  "VOICE_MAX_CHARS",
  "VOICE_GROUP",
  "TYPO_RECALL_ENABLED",
  "TYPO_RECALL_PROBABILITY",
  "TYPO_RECALL_DELAY_MS",
  "TYPO_RECALL_COOLDOWN_MINUTES",
] as const;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-voice-config-"));
  originalCwd = process.cwd();
  process.chdir(dir);
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE_CONFIG = [
  'persona: "xiaoya"',
  'her_name: "小雅"',
  'your_name: "你"',
  'location: "上海"',
].join("\n");

async function loadWith(extra: string) {
  fs.writeFileSync(path.join(dir, "config.yaml"), `${BASE_CONFIG}\n${extra}\n`, "utf8");
  const { loadConfig } = await import("./store.js");
  return loadConfig();
}

describe("语音消息配置", () => {
  it("默认开启，且有保守的概率/门槛/冷却", async () => {
    const config = await loadWith("");
    expect(config.voice_enabled).toBe(true);
    expect(config.voice_probability).toBe(0.12);
    expect(config.voice_min_closeness).toBe(2.5);
    expect(config.voice_cooldown_minutes).toBe(8);
    expect(config.voice_max_chars).toBe(40);
    expect(config.voice_group_enabled).toBe(false);
  });

  it("config.yaml 可以覆盖每一项", async () => {
    const config = await loadWith(
      [
        "voice_enabled: false",
        "voice_probability: 0.5",
        "voice_min_closeness: 6",
        "voice_cooldown_minutes: 30",
        "voice_max_chars: 24",
        "voice_group_enabled: true",
      ].join("\n"),
    );
    expect(config.voice_enabled).toBe(false);
    expect(config.voice_probability).toBe(0.5);
    expect(config.voice_min_closeness).toBe(6);
    expect(config.voice_cooldown_minutes).toBe(30);
    expect(config.voice_max_chars).toBe(24);
    expect(config.voice_group_enabled).toBe(true);
  });

  it("环境变量可以覆盖", async () => {
    process.env.VOICE_ENABLED = "false";
    process.env.VOICE_PROBABILITY = "0.3";
    const config = await loadWith("");
    expect(config.voice_enabled).toBe(false);
    expect(config.voice_probability).toBe(0.3);
  });

  it("概率越界/字数过短会给出可读的配置错误", async () => {
    await expect(loadWith("voice_probability: 1.5")).rejects.toThrow(/voice_probability|VOICE_PROBABILITY/);
    await expect(loadWith("voice_max_chars: 2")).rejects.toThrow(/voice_max_chars|VOICE_MAX_CHARS/);
  });
});

describe("打字错字→撤回→改对 配置", () => {
  it("默认开启、低概率、1.5s 撤回、20 分钟冷却", async () => {
    const config = await loadWith("");
    expect(config.typo_recall_enabled).toBe(true);
    expect(config.typo_recall_probability).toBe(0.04);
    expect(config.typo_recall_delay_ms).toBe(1500);
    expect(config.typo_recall_cooldown_minutes).toBe(20);
  });

  it("可以关闭并覆盖各项", async () => {
    const config = await loadWith(
      [
        "typo_recall_enabled: false",
        "typo_recall_probability: 0.2",
        "typo_recall_delay_ms: 800",
        "typo_recall_cooldown_minutes: 0",
      ].join("\n"),
    );
    expect(config.typo_recall_enabled).toBe(false);
    expect(config.typo_recall_probability).toBe(0.2);
    expect(config.typo_recall_delay_ms).toBe(800);
    expect(config.typo_recall_cooldown_minutes).toBe(0);
  });

  it("撤回延迟越界会报配置错误", async () => {
    await expect(loadWith("typo_recall_delay_ms: 100")).rejects.toThrow(/typo_recall_delay_ms|TYPO_RECALL_DELAY_MS/);
  });
});
