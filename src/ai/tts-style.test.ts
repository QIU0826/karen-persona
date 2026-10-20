import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_RATE,
  MAX_ADDED_PAUSE_MS,
  STYLE_PITCH,
  applyIntonation,
  buildSayText,
  chooseStyle,
  insertPauses,
  maybeAddFiller,
  planSpeechStyle,
  splitClauses,
} from "./tts-style.js";

const fixed = (v: number) => () => v;

describe("chooseStyle：语气风格", () => {
  it("深夜/凌晨读起来是「困」", () => {
    expect(chooseStyle({ hour: 23 })).toBe("tired");
    expect(chooseStyle({ hour: 2 })).toBe("tired");
    expect(chooseStyle({ hour: 6 })).toBe("tired");
  });

  it("白天按情绪分：开心活泼 / 低落柔和 / 平常自然", () => {
    expect(chooseStyle({ hour: 14, emotionVector: 0.5 })).toBe("lively");
    expect(chooseStyle({ hour: 14, emotionVector: -0.4 })).toBe("soft");
    expect(chooseStyle({ hour: 14, emotionVector: 0.05 })).toBe("natural");
  });

  it("夜间优先于情绪（半夜不会因为开心就亢奋）", () => {
    expect(chooseStyle({ hour: 3, emotionVector: 0.9 })).toBe("tired");
  });
});

describe("planSpeechStyle：语速与音高", () => {
  const text = "今天的晚霞特别好看。";

  it("困的时候比平常慢，开心的时候更快", () => {
    const natural = planSpeechStyle({ text, hour: 14, random: fixed(0.5), fillerProbability: 0 });
    const tired = planSpeechStyle({ text, hour: 2, random: fixed(0.5), fillerProbability: 0 });
    const lively = planSpeechStyle({
      text,
      hour: 14,
      emotionVector: 0.6,
      random: fixed(0.5),
      fillerProbability: 0,
    });
    expect(tired.rate).toBeLessThan(natural.rate);
    expect(lively.rate).toBeGreaterThan(natural.rate);
    expect(natural.rate).toBe(DEFAULT_BASE_RATE);
  });

  it("音高按风格偏移（困/低落实下调低，活泼上调高）", () => {
    const natural = planSpeechStyle({ text, hour: 14, random: fixed(0.5), fillerProbability: 0 });
    const lively = planSpeechStyle({
      text,
      hour: 14,
      emotionVector: 0.6,
      random: fixed(0.5),
      fillerProbability: 0,
    });
    expect(natural.pitch).toBe(STYLE_PITCH.natural);
    expect(lively.pitch).toBeGreaterThan(natural.pitch);
  });

  it("亲密度高时语速略快", () => {
    const a = planSpeechStyle({ text, hour: 14, closeness: 2, random: fixed(0.5), fillerProbability: 0 });
    const b = planSpeechStyle({ text, hour: 14, closeness: 8, random: fixed(0.5), fillerProbability: 0 });
    expect(b.rate).toBeGreaterThanOrEqual(a.rate);
  });

  it("语速始终夹在 100-300，不会算出离谱值", () => {
    for (const baseRate of [10, 500, 180]) {
      const plan = planSpeechStyle({ text, hour: 14, baseRate, random: fixed(0.5), fillerProbability: 0 });
      expect(plan.rate).toBeGreaterThanOrEqual(100);
      expect(plan.rate).toBeLessThanOrEqual(300);
    }
  });

  it("同样的随机序列 → 同样的结果（可复现）", () => {
    const run = () =>
      planSpeechStyle({
        text: "我刚发现五花的猫粮快没了，它最近掉毛掉得厉害。",
        hour: 13,
        emotionVector: 0.1,
        random: fixed(0.3),
      });
    expect(run()).toEqual(run());
  });
});

describe("insertPauses：停顿", () => {
  it("逗号后加静音命令，末尾标点不加", () => {
    const { text, addedPauseMs } = insertPauses("天冷了，多穿点。", "natural", fixed(0.5));
    expect(text).toContain("，[[slnc ");
    expect(text.endsWith("。")).toBe(true);
    expect(addedPauseMs).toBeGreaterThan(0);
  });

  it("多个标点会累积，但不超过上限", () => {
    const long = "一，二，三，四，五，六，七，八，九，十，十一。";
    const { addedPauseMs } = insertPauses(long, "tired", fixed(1));
    expect(addedPauseMs).toBeLessThanOrEqual(MAX_ADDED_PAUSE_MS);
  });

  it("省略号只处理一次（连续 … 不重复插）", () => {
    const { text } = insertPauses("我……不知道。", "natural", fixed(0.5));
    expect(text.match(/\[\[slnc /g)?.length ?? 0).toBe(1);
  });

  it("没有标点的短句不加停顿", () => {
    const { text, addedPauseMs } = insertPauses("嗯好", "natural", fixed(0.5));
    expect(text).toBe("嗯好");
    expect(addedPauseMs).toBe(0);
  });
});

describe("maybeAddFiller：语气词", () => {
  const sentence = "我刚看到一只很胖的猫。";

  it("概率为 1 时加，且不影响原句内容", () => {
    const { text, used } = maybeAddFiller(sentence, "natural", 1, fixed(0));
    expect(used).toBe(true);
    expect(text.endsWith(sentence)).toBe(true);
    expect(text.length).toBeGreaterThan(sentence.length);
  });

  it("概率为 0 时不加", () => {
    expect(maybeAddFiller(sentence, "natural", 0, fixed(0)).used).toBe(false);
  });

  it("太短的句子不加（「好呀。」加语气词很怪）", () => {
    expect(maybeAddFiller("好呀。", "natural", 1, fixed(0)).used).toBe(false);
  });

  it("已经以语气词开头就不重复加", () => {
    expect(maybeAddFiller("嗯…我知道了。", "natural", 1, fixed(0)).used).toBe(false);
  });

  it("没有句末标点的半句不加（不像是完整一句）", () => {
    expect(maybeAddFiller("我刚看到一只很胖的猫", "natural", 1, fixed(0)).used).toBe(false);
  });
});

describe("splitClauses：分句", () => {
  it("按标点切分，标点跟着前一句", () => {
    expect(splitClauses("刚下班，路过那家店又买了一杯。")).toEqual([
      "刚下班，",
      "路过那家店又买了一杯。",
    ]);
  });

  it("连续标点不切碎（「？！」算一句）", () => {
    expect(splitClauses("真的吗？！不会吧。")).toEqual(["真的吗？！", "不会吧。"]);
  });

  it("没有标点时就是一句", () => {
    expect(splitClauses("嗯好")).toEqual(["嗯好"]);
  });
});

describe("applyIntonation：句内语调", () => {
  const text = "刚下班，路过那家店又买了一杯，跟你说过的那个。";

  it("分成多个分句，并给每个分句下发语速命令", () => {
    const plan = applyIntonation(text, "natural", { baseRate: 180, random: fixed(0.5) });
    expect(plan.clauses.length).toBeGreaterThanOrEqual(3);
    expect(plan.spokenText).toContain("[[rate ");
  });

  it("多分句时音高有起伏（不是一条直线）", () => {
    const plan = applyIntonation(text, "natural", { baseRate: 180, random: fixed(0.5) });
    const pitches = plan.clauses.map((c) => c.pitch);
    expect(new Set(pitches).size).toBeGreaterThan(1);
    expect(plan.spokenText).toContain("[[pbas ");
  });

  it("陈述句句末降调，问句句末升调", () => {
    const statement = applyIntonation("我刚下班，路上买了杯咖啡。", "natural", {
      baseRate: 180,
      random: fixed(0.5),
    });
    const question = applyIntonation("我刚下班，你猜我买了什么？", "natural", {
      baseRate: 180,
      random: fixed(0.5),
    });
    const lastS = statement.clauses[statement.clauses.length - 1].pitch;
    const lastQ = question.clauses[question.clauses.length - 1].pitch;
    expect(lastQ).toBeGreaterThan(lastS);
  });

  it("起句略慢、收尾略慢，中间正常", () => {
    const plan = applyIntonation("一，二，三。", "natural", { baseRate: 180, random: fixed(0.5) });
    const [first, middle, last] = plan.clauses;
    expect(first.rate).toBeLessThanOrEqual(middle.rate);
    expect(last.rate).toBeLessThanOrEqual(middle.rate);
  });

  it("分句之间真的有停顿，且总停顿有上限", () => {
    const plan = applyIntonation(text, "tired", { baseRate: 170, random: fixed(0.9) });
    expect(plan.addedPauseMs).toBeGreaterThan(200);
    expect(plan.addedPauseMs).toBeLessThanOrEqual(MAX_ADDED_PAUSE_MS);
    expect(plan.spokenText).toContain("[[slnc ");
  });

  it("单句、无语调变化时不下发多余的 pbas", () => {
    const plan = applyIntonation("嗯好。", "natural", { baseRate: 180, random: fixed(0.5) });
    expect(plan.spokenText).not.toContain("[[pbas");
  });

  it("可复现：同样的随机序列 → 同样的命令串", () => {
    const run = () => applyIntonation(text, "lively", { baseRate: 195, random: fixed(0.25) });
    expect(run()).toEqual(run());
  });
});

describe("buildSayText：交给 say 的最终文本", () => {
  it("直接返回已内嵌语调命令的文本（不再额外加前缀）", () => {
    const plan = planSpeechStyle({
      text: "刚下班，路过那家店又买了一杯。",
      hour: 15,
      random: fixed(0.5),
      fillerProbability: 0,
    });
    expect(buildSayText(plan)).toBe(plan.spokenText);
    expect(buildSayText(plan)).toContain("[[rate ");
  });
});
