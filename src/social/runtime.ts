/**
 * 社会化运行时状态：模式 override / 风控冷却 / 最近 tick。
 *
 * 不存 Cookie；文件 0600，损坏/缺失时回退空状态（不阻塞聊天）。
 */
import fs from "node:fs";
import { dataFile } from "../data/paths.js";
import { loadSocialConfig } from "./config.js";
import type { SocialConfig, SocialMode } from "./types.js";

export interface SocialRuntimeState {
  modeOverride?: SocialMode;
  circuitOpenUntil?: number;
  lastTickAt?: number;
  lastActionAt?: number;
  lastError?: string;
}

const FILE = "social-state.json";

function safeMode(value: unknown): SocialMode | undefined {
  return value === "off" || value === "observe" || value === "approve" || value === "auto" || value === "high"
    ? value
    : undefined;
}

export function loadSocialRuntime(): SocialRuntimeState {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(FILE), "utf8")) as Record<string, unknown>;
    return {
      ...(safeMode(raw.modeOverride) ? { modeOverride: safeMode(raw.modeOverride) } : {}),
      ...(typeof raw.circuitOpenUntil === "number" && Number.isFinite(raw.circuitOpenUntil)
        ? { circuitOpenUntil: Math.max(0, Math.floor(raw.circuitOpenUntil)) }
        : {}),
      ...(typeof raw.lastTickAt === "number" ? { lastTickAt: Math.floor(raw.lastTickAt) } : {}),
      ...(typeof raw.lastActionAt === "number" ? { lastActionAt: Math.floor(raw.lastActionAt) } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError.slice(0, 120) } : {}),
    };
  } catch {
    return {};
  }
}

export function saveSocialRuntime(state: SocialRuntimeState): void {
  try {
    const path = dataFile(FILE);
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, path);
    try {
      fs.chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  } catch {
    // 运行时状态失败不影响主流程
  }
}

/** env 配置 + 运行时 override；调用方不需要知道 override 细节。 */
export function effectiveSocialConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: SocialRuntimeState = loadSocialRuntime(),
): SocialConfig {
  const base = loadSocialConfig(env);
  return runtime.modeOverride ? { ...base, mode: runtime.modeOverride } : base;
}

export function setSocialModeOverride(mode: SocialMode): SocialConfig {
  const runtime = loadSocialRuntime();
  runtime.modeOverride = mode;
  saveSocialRuntime(runtime);
  return effectiveSocialConfig(process.env, runtime);
}

export function isCircuitOpen(runtime: SocialRuntimeState, now = Date.now()): boolean {
  return typeof runtime.circuitOpenUntil === "number" && runtime.circuitOpenUntil > now;
}

export function openCircuit(hours: number, reason: string, now = Date.now()): SocialRuntimeState {
  const runtime = loadSocialRuntime();
  runtime.circuitOpenUntil = now + Math.max(1, Math.min(72, hours)) * 3600_000;
  runtime.lastError = reason.slice(0, 120);
  saveSocialRuntime(runtime);
  return runtime;
}
