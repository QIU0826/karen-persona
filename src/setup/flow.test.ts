/**
 * Setup 纯函数单测：输入校验 / config 合并 / 第一段对话与事实生成。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_YOUR_NAME,
  buildConfigPatch,
  buildOnboardingDialogue,
  buildOnboardingFacts,
  normalizeTagsInput,
  parsePortInput,
  shouldSkipSetup,
  type SetupAnswers,
} from "./flow.js";

const baseAnswers: SetupAnswers = {
  personaId: "xiaoya",
  herName: "小雅",
  howWeMet: "在小红书刷到的",
  yourName: "林哲",
  location: "杭州",
  tags: ["话痨"],
  allowedUsers: [123456],
  oneBotPort: 18080,
};

describe("normalizeTagsInput", () => {
  it("支持空格/逗号分隔，去空去重", () => {
    expect(normalizeTagsInput("话痨 粘人, 话痨，浪漫主义")).toEqual(["话痨", "粘人", "浪漫主义"]);
    expect(normalizeTagsInput("   ")).toEqual([]);
  });
});

describe("parsePortInput", () => {
  it("空串用默认值，合法数字通过", () => {
    expect(parsePortInput("", 18080)).toBe(18080);
    expect(parsePortInput("18099", 18080)).toBe(18099);
  });

  it("非法/越界返回 null", () => {
    expect(parsePortInput("abc", 18080)).toBeNull();
    expect(parsePortInput("0", 18080)).toBeNull();
    expect(parsePortInput("70000", 18080)).toBeNull();
    expect(parsePortInput("-1", 18080)).toBeNull();
  });
});

describe("buildConfigPatch", () => {
  it("保留已有扩展字段，只覆盖 setup 负责的键", () => {
    const config = buildConfigPatch(
      { custom_field: "保留", location: "上海", message_frequency_limit: 30 },
      { ...baseAnswers, location: "" },
    );
    expect(config.custom_field).toBe("保留");
    // 用户没填城市 → 不覆盖已有 location
    expect(config.location).toBe("上海");
    expect(config.persona).toBe("xiaoya");
    expect(config.your_name).toBe("林哲");
    expect(config.allowed_users).toEqual([123456]);
    expect(config.one_bot_ws_port).toBe(18080);
    expect(config.tags).toEqual(["话痨"]);
    expect(config.message_frequency_limit).toBe(30);
    expect(config.log_level).toBe("info");
  });

  it("称呼留空时用默认「你」", () => {
    const config = buildConfigPatch({}, { ...baseAnswers, yourName: "  " });
    expect(config.your_name).toBe(DEFAULT_YOUR_NAME);
  });
});

describe("buildOnboardingDialogue", () => {
  it("包含她的三个问题与用户回答、以及收尾", () => {
    const lines = buildOnboardingDialogue("小雅", {
      howWeMet: "小红书",
      yourName: "林哲",
      location: "杭州",
      herCity: "上海",
    });
    expect(lines[0]).toEqual({ role: "assistant", content: "嘿，你是从哪知道我的？" });
    expect(lines.map((line) => line.content).join("｜")).toContain("林哲");
    expect(lines.map((line) => line.content).join("｜")).toContain("杭州");
    expect(lines.map((line) => line.content).join("｜")).toContain("上海");
    expect(lines.at(-1)?.role).toBe("assistant");
  });

  it("空回答有兜底：偶遇 / 「你」，且不生成空用户消息", () => {
    const lines = buildOnboardingDialogue("小雅", {
      howWeMet: "",
      yourName: "",
      location: "",
    });
    expect(lines.some((line) => line.content.includes("偶遇"))).toBe(true);
    expect(lines.some((line) => line.content.includes(DEFAULT_YOUR_NAME))).toBe(true);
    // 城市为空 → 不发送空的 user 消息
    expect(lines.filter((line) => line.role === "user").every((line) => line.content.trim() !== "")).toBe(
      true,
    );
  });
});

describe("buildOnboardingFacts", () => {
  it("写名字/城市/认识方式（分类正确）", () => {
    const facts = buildOnboardingFacts(baseAnswers);
    expect(facts).toEqual([
      { key: "name", value: "林哲", category: "profile" },
      { key: "city", value: "杭州", category: "profile" },
      { key: "how_we_met", value: "在小红书刷到的", category: "relationship" },
    ]);
  });

  it("默认称呼/空城市不写事实", () => {
    const facts = buildOnboardingFacts({ howWeMet: "", yourName: "你", location: "" });
    expect(facts).toEqual([]);
  });
});

describe("shouldSkipSetup", () => {
  it("已完成且非 --force 才跳过", () => {
    expect(shouldSkipSetup({ hasConfig: true, hasOnboarding: true, force: false })).toBe(true);
    expect(shouldSkipSetup({ hasConfig: true, hasOnboarding: true, force: true })).toBe(false);
    expect(shouldSkipSetup({ hasConfig: true, hasOnboarding: false, force: false })).toBe(false);
    expect(shouldSkipSetup({ hasConfig: false, hasOnboarding: true, force: false })).toBe(false);
  });
});
