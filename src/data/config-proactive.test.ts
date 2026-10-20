/**
 * 主动消息链路开关配置：默认全开、可单独关、写错要报错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let originalCwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-proactive-config-"));
  originalCwd = process.cwd();
  process.chdir(dir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
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

describe("主动消息链路配置 proactive_channels", () => {
  it("不写时返回 undefined（运行时按四条全开处理）", async () => {
    const config = await loadWith("");
    expect(config.proactive_channels).toBeUndefined();
  });

  it("可以单独关掉一条链路", async () => {
    const config = await loadWith(
      ["proactive_channels:", "  follow_up: false", "  open_topic: false"].join("\n"),
    );
    expect(config.proactive_channels).toEqual({ follow_up: false, open_topic: false });
  });

  it("四条链路都认识", async () => {
    const config = await loadWith(
      [
        "proactive_channels:",
        "  follow_up: true",
        "  open_topic: false",
        "  life_share: false",
        "  silence_revive: true",
      ].join("\n"),
    );
    expect(config.proactive_channels).toEqual({
      follow_up: true,
      open_topic: false,
      life_share: false,
      silence_revive: true,
    });
  });

  it("空对象视为未配置", async () => {
    const config = await loadWith("proactive_channels: {}");
    expect(config.proactive_channels).toBeUndefined();
  });

  it("写错链路名要报错（避免「以为关了其实没关」）", async () => {
    await expect(loadWith(["proactive_channels:", "  followup: false"].join("\n"))).rejects.toThrow(
      /未知链路 "followup"/,
    );
  });

  it("非布尔值要报错", async () => {
    await expect(
      loadWith(["proactive_channels:", "  follow_up: sometimes"].join("\n")),
    ).rejects.toThrow(/必须是 true 或 false/);
  });

  it("不是对象要报错", async () => {
    await expect(loadWith('proactive_channels: "off"')).rejects.toThrow(/必须是对象/);
  });
});
