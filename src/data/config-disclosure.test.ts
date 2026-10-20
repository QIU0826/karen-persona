/**
 * 合规默认值：聊天内 AI 披露默认关闭（个人自用体验优先），18+ 年龄门仍默认开启。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let originalCwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-config-"));
  originalCwd = process.cwd();
  process.chdir(dir);
  vi.resetModules();
  delete process.env.AI_DISCLOSURE;
  delete process.env.AGE_GATE;
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.AI_DISCLOSURE;
  delete process.env.AGE_GATE;
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE_CONFIG = [
  'persona: "xiaoya"',
  'her_name: "小雅"',
  'your_name: "你"',
  'location: "上海"',
].join("\n");

describe("合规默认值", () => {
  it("默认不在聊天里做 AI 披露；18+ 年龄门仍默认开启", async () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), BASE_CONFIG + "\n", "utf8");
    const { loadConfig } = await import("./store.js");
    const config = loadConfig();
    expect(config.ai_disclosure).toBe(false);
    expect(config.age_gate_enabled).toBe(true);
  });

  it("可通过 config.yaml 显式开启 ai_disclosure（公开发布场景）", async () => {
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      BASE_CONFIG + "\nai_disclosure: true\n",
      "utf8",
    );
    const { loadConfig } = await import("./store.js");
    expect(loadConfig().ai_disclosure).toBe(true);
  });

  it("可用 AI_DISCLOSURE 环境变量开启", async () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), BASE_CONFIG + "\n", "utf8");
    process.env.AI_DISCLOSURE = "true";
    const { loadConfig } = await import("./store.js");
    expect(loadConfig().ai_disclosure).toBe(true);
  });
});
