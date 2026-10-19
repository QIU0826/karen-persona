/**
 * DeepSeek 路由 / 复杂度 token / 思考模式配置测试。
 * 纯环境变量与纯函数检查，不联网。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLEXITY_TOKENS,
  classifyComplexity,
  getChatModel,
  getThinkingConfig,
  hasVisionModel,
} from "./router.js";

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_FLASH_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "DEEPSEEK_THINKING",
  "DEEPSEEK_REASONING_EFFORT",
  "QWEN_VL_API_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DEEPSEEK_API_KEY = "sk-test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("getChatModel：canonical 模型名", () => {
  it("simple / normal 使用 deepseek-flash", () => {
    expect(getChatModel("simple").model).toBe("deepseek-flash");
    expect(getChatModel("normal").model).toBe("deepseek-flash");
    expect(getChatModel().model).toBe("deepseek-flash");
  });

  it("complex 使用 deepseek-v4-pro", () => {
    expect(getChatModel("complex").model).toBe("deepseek-v4-pro");
  });

  it("provider / baseUrl 默认值正确", () => {
    const config = getChatModel("normal");
    expect(config.provider).toBe("deepseek");
    expect(config.baseUrl).toBe("https://api.deepseek.com");
    expect(config.apiKey).toBe("sk-test-key");
  });

  it("env 仍可覆盖模型名与 Base URL", () => {
    process.env.DEEPSEEK_FLASH_MODEL = "custom-fast";
    process.env.DEEPSEEK_PRO_MODEL = "custom-pro";
    process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com/v1";
    expect(getChatModel("simple").model).toBe("custom-fast");
    expect(getChatModel("complex").model).toBe("custom-pro");
    expect(getChatModel("complex").baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("缺少 Key 时抛出可读错误", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => getChatModel("normal")).toThrow(/未配置 DEEPSEEK_API_KEY/);
  });

  it("占位符 Key 视为未配置", () => {
    process.env.DEEPSEEK_API_KEY = "sk-your-key-here";
    expect(() => getChatModel("normal")).toThrow(/未配置 DEEPSEEK_API_KEY/);
  });
});

describe("COMPLEXITY_TOKENS：非思考模式预算", () => {
  it("按实测调整为 160 / 320 / 640", () => {
    expect(COMPLEXITY_TOKENS.simple).toBe(160);
    expect(COMPLEXITY_TOKENS.normal).toBe(320);
    expect(COMPLEXITY_TOKENS.complex).toBe(640);
  });

  it("复杂度越高预算越大", () => {
    expect(COMPLEXITY_TOKENS.simple).toBeLessThan(COMPLEXITY_TOKENS.normal);
    expect(COMPLEXITY_TOKENS.normal).toBeLessThan(COMPLEXITY_TOKENS.complex);
  });
});

describe("getThinkingConfig：思考模式开关与强度", () => {
  it("默认关闭思考模式（修复空回复 bug）", () => {
    const config = getThinkingConfig("normal");
    expect(config.enabled).toBe(false);
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  it("DEEPSEEK_THINKING=enabled 可开启，并按复杂度映射强度", () => {
    process.env.DEEPSEEK_THINKING = "enabled";
    expect(getThinkingConfig("simple")).toMatchObject({
      enabled: true,
      thinking: { type: "enabled" },
      reasoningEffort: "low",
    });
    expect(getThinkingConfig("normal").reasoningEffort).toBe("high");
    expect(getThinkingConfig("complex").reasoningEffort).toBe("max");
  });

  it("DEEPSEEK_THINKING 支持 on/true/1 与 off/false/0", () => {
    process.env.DEEPSEEK_THINKING = "true";
    expect(getThinkingConfig().enabled).toBe(true);
    process.env.DEEPSEEK_THINKING = "0";
    expect(getThinkingConfig().enabled).toBe(false);
  });

  it("DEEPSEEK_THINKING=disabled 显式关闭", () => {
    process.env.DEEPSEEK_THINKING = "disabled";
    const config = getThinkingConfig("complex");
    expect(config.enabled).toBe(false);
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  it("非法 DEEPSEEK_THINKING 值回退默认关闭", () => {
    process.env.DEEPSEEK_THINKING = "maybe";
    expect(getThinkingConfig().enabled).toBe(false);
  });

  it("DEEPSEEK_REASONING_EFFORT 可覆盖复杂度映射，非法值忽略", () => {
    process.env.DEEPSEEK_THINKING = "enabled";
    process.env.DEEPSEEK_REASONING_EFFORT = "max";
    expect(getThinkingConfig("simple").reasoningEffort).toBe("max");

    process.env.DEEPSEEK_REASONING_EFFORT = "ultra";
    expect(getThinkingConfig("simple").reasoningEffort).toBe("low");
  });
});

describe("hasVisionModel：视觉由 DeepSeek Key 决定", () => {
  it("有可用 DeepSeek Key → true", () => {
    expect(hasVisionModel()).toBe(true);
  });

  it("无 Key / 占位符 → false", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(hasVisionModel()).toBe(false);
    process.env.DEEPSEEK_API_KEY = "sk-your-key-here";
    expect(hasVisionModel()).toBe(false);
  });

  it("QWEN_VL_API_KEY 不再决定视觉可用性", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.QWEN_VL_API_KEY = "qwen-key";
    expect(hasVisionModel()).toBe(false);
  });
});

describe("classifyComplexity：规则分级回归", () => {
  it("短寒暄 → simple", () => {
    expect(classifyComplexity("嗯")).toBe("simple");
    expect(classifyComplexity("在吗？")).toBe("simple");
  });

  it("普通闲聊 → normal", () => {
    expect(classifyComplexity("今天吃了碗牛肉面")).toBe("normal");
  });

  it("长倾诉 / 多情绪信号 → complex", () => {
    expect(
      classifyComplexity("最近工作压力好大，晚上老是失眠，你说我该怎么办？")
    ).toBe("complex");
  });
});
