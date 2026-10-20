import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTENT_SETTINGS,
  intentSettingsFromTypo,
  planMessageIntent,
  shortenForRewrite,
  type IntentSettings,
} from "./message-intent.js";

const fixed = (v: number) => () => v;
/** 依次返回给定序列（用完后返回最后一个） */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

function settings(patch: Partial<IntentSettings> = {}): IntentSettings {
  return { ...DEFAULT_INTENT_SETTINGS, cooldownMinutes: 0, probability: 1, ...patch };
}

describe("planMessageIntent：护栏", () => {
  it("关闭时不演", () => {
    expect(planMessageIntent({ text: "今天真的有点烦啊" }, settings({ enabled: false })).intent).toBe("none");
  });

  it("群聊不演（回收能力只在私聊）", () => {
    expect(planMessageIntent({ text: "今天真的有点烦啊", isGroup: true }, settings()).reason).toBe(
      "group_unsupported",
    );
  });

  it("危机轮绝不演", () => {
    expect(planMessageIntent({ text: "我不想活了真的", isCrisis: true }, settings()).reason).toBe("crisis");
    expect(
      planMessageIntent({ text: "我不想活了真的", safetySent: true }, settings()).reason,
    ).toBe("crisis");
  });

  it("太短的文本不演", () => {
    expect(planMessageIntent({ text: "嗯" }, settings()).reason).toBe("text_too_short");
  });

  it("冷却期内不演", () => {
    const plan = planMessageIntent(
      { text: "今天真的有点烦啊" },
      settings({ cooldownMinutes: 20 }),
      { lastRecallAt: Date.now() - 60_000 },
    );
    expect(plan.reason).toBe("cooldown");
  });
});

describe("planMessageIntent：意图分配", () => {
  it("普通文本 → 错字撤回（概率抽中且可造错字）", () => {
    const plan = planMessageIntent(
      { text: "今天在公司被老板说了一顿" },
      settings(),
      { random: seq(0, 0.2, 0.5) },
    );
    expect(plan.intent).toBe("typo_recall");
    expect(plan.sentText).not.toBe("今天在公司被老板说了一顿");
    expect(plan.followUpText).toBe("今天在公司被老板说了一顿");
  });

  it("带攻击性的气话 → 说重了撤回（撤回后语气收着）", () => {
    const plan = planMessageIntent(
      { text: "烦死了你别问了行不行", emotionVector: -0.6 },
      settings(),
      { random: seq(0, 0.7, 0.5) },
    );
    expect(plan.intent).toBe("regret_recall");
    expect(plan.followUpText!.length).toBeLessThan(plan.sentText!.length + 10);
    expect(plan.followUpText).toMatch(/算了|…/);
  });

  it("长句 → 可能重发更短的版本", () => {
    const plan = planMessageIntent(
      { text: "我今天下午去了一趟公司然后把那个方案又改了一遍，改到六点多才走" },
      settings(),
      { random: seq(0, 0.98, 0.5) },
    );
    expect(plan.intent).toBe("rewrite");
    expect(plan.followUpText!.length).toBeLessThan(plan.sentText!.length);
  });

  it("没抽中撤回时，深夜可能表现为「犹豫」", () => {
    const plan = planMessageIntent(
      { text: "今天好像有点累", isNight: true, emotionVector: -0.3 },
      settings({ probability: 0 }),
      { random: fixed(0) },
    );
    expect(plan.intent).toBe("hesitate");
  });

  it("白天且情绪正常时，没抽中就是「不演」", () => {
    const plan = planMessageIntent(
      { text: "今天好像有点累", isNight: false, emotionVector: 0.1 },
      settings({ probability: 0 }),
      { random: fixed(0.99) },
    );
    expect(plan.intent).toBe("none");
  });

  it("撤回延迟被夹在 0.5–5s", () => {
    const plan = planMessageIntent(
      { text: "今天在公司被老板说了一顿" },
      settings({ delayMs: 99 }),
      { random: seq(0, 0.2) },
    );
    expect(plan.delayMs).toBeGreaterThanOrEqual(500);
  });
});

describe("shortenForRewrite", () => {
  it("取第一句并去掉尾随标点", () => {
    expect(shortenForRewrite("我先去了公司，然后改了方案，最后回家。")).toBe("我先去了公司，然后改了方案，最后回家");
    expect(shortenForRewrite("好累啊，不想动了")).toBe("好累啊，不想动了");
  });

  it("单句时原样返回", () => {
    expect(shortenForRewrite("嗯嗯")).toBe("嗯嗯");
  });
});

describe("intentSettingsFromTypo", () => {
  it("沿用 typo 配置的开关/概率/延迟/冷却（向后兼容）", () => {
    const mapped = intentSettingsFromTypo({
      enabled: false,
      probability: 0.1,
      delayMs: 2000,
      cooldownMinutes: 30,
    });
    expect(mapped).toEqual({ enabled: false, probability: 0.1, delayMs: 2000, cooldownMinutes: 30 });
  });
});
