/**
 * 跨轮自我重复治理单测。
 *
 * 覆盖：文本归一化 → 最近回复抽取 → 提示块生成 → 复读检测（exact/prefix/
 * similar/opener/none 五种判定）。全部纯函数，无 IO。
 */
import { describe, expect, it } from "vitest";
import { isWithinTurnDuplicate } from "./anti-repetition.js";
import {
  bigramSimilarity,
  buildAvoidRepeatNote,
  detectRepetition,
  extractRecentReplies,
  extractRepeatedFormulaicPatterns,
  normalizeReplyText,
} from "./anti-repetition.js";

describe("normalizeReplyText", () => {
  it("去掉 CQ 码与媒体占位符，压掉空白与首尾软标点", () => {
    expect(normalizeReplyText("  [CQ:face,id=1] 哈哈 是吗， ")).toBe("哈哈 是吗");
    expect(normalizeReplyText("[图片] 你看这个 😂")).toBe("你看这个 😂");
    expect(normalizeReplyText("嗯\n\n 好")).toBe("嗯 好");
    expect(normalizeReplyText("   ")).toBe("");
  });
});

describe("extractRecentReplies", () => {
  it("只取 assistant 消息，多行拆成多条，过滤过短片段", () => {
    const messages = [
      { role: "user" as const, content: "在干嘛" },
      { role: "assistant" as const, content: "刚下班" },
      { role: "assistant" as const, content: "累死了\n地铁上人好多\n。\n你吃了吗" },
    ];
    expect(extractRecentReplies(messages, 3)).toEqual([
      "累死了",
      "地铁上人好多",
      "你吃了吗",
    ]);
  });

  it("相邻完全重复的片段只保留一条，且只返回最后 count 条", () => {
    const messages = [
      { role: "assistant" as const, content: "确实呢" },
      { role: "assistant" as const, content: "确实呢" },
      { role: "assistant" as const, content: "我也是这么想的" },
      { role: "assistant" as const, content: "今天好热啊" },
    ];
    expect(extractRecentReplies(messages, 2)).toEqual(["我也是这么想的", "今天好热啊"]);
  });

  it("没有历史回复时返回空数组", () => {
    expect(extractRecentReplies([{ role: "user" as const, content: "嗨" }])).toEqual([]);
    expect(extractRecentReplies([], 3)).toEqual([]);
  });
});

describe("buildAvoidRepeatNote", () => {
  it("没有最近回复时返回空串（不浪费 token）", () => {
    expect(buildAvoidRepeatNote([])).toBe("");
  });

  it("full 模式包含最近回复摘录与换说法的要求", () => {
    const note = buildAvoidRepeatNote(["今天真的好热啊", "我刚下班累死了", "你吃了吗"], "full");
    expect(note).toContain("## 避免重复自己");
    expect(note).toContain("今天真的好热啊");
    expect(note).toContain("我刚下班累死了");
    expect(note).toContain("换个开头和句式");
    // 没有连续同开头时不点名 banning
    expect(note).not.toContain("这个开头你已经连着用了");
  });

  it("检测到连续同开头词时点名提醒", () => {
    const note = buildAvoidRepeatNote(["哈哈是吗 我记性不太行", "哈哈真的假的", "行吧"], "full");
    expect(note).toContain("「哈哈」这个开头你已经连着用了");
  });

  it("默认 openers 模式：不回放整句（生产默认，避免模型照抄）", () => {
    const note = buildAvoidRepeatNote(["刚坐下歇会儿 今天店里人不多", "嗯呐 那就别动了"]);
    expect(note).toContain("## 避免重复自己");
    expect(note).toContain("你最近几轮的开头");
    expect(note).not.toContain("今天店里人不多");
    expect(note).not.toContain("那就别动了");
  });

  it("openers 模式只给开头片段，不回放整句（避免模型照抄）", () => {
    const note = buildAvoidRepeatNote(
      ["刚坐下歇会儿 今天店里人不多", "嗯呐 那就别动了", "跟我说说 累哪了"],
      "openers",
    );
    expect(note).toContain("## 避免重复自己");
    expect(note).toContain("「刚坐下」「嗯呐」「跟我说」");
    // 整句内容不应回放
    expect(note).not.toContain("今天店里人不多");
    expect(note).not.toContain("那就别动了");
    expect(note).toContain("换个角度回");
  });

  it("full 模式长回复截断，避免每轮提示块过长", () => {
    const long = "今天".repeat(40);
    const note = buildAvoidRepeatNote([long], "full");
    expect(note).toContain("…");
    expect(note.length).toBeLessThan(260);
  });
});

describe("extractRepeatedFormulaicPatterns（句式复读）", () => {
  it("同一套话句式出现 ≥2 次才点名", () => {
    expect(
      extractRepeatedFormulaicPatterns(["是不是最近太累了", "是不是没睡好啊", "行吧"]),
    ).toEqual(["是不是…"]);
    expect(extractRepeatedFormulaicPatterns(["是不是最近太累了", "我睡了"])).toEqual([]);
  });

  it("多个句式同时重复都能识别", () => {
    const patterns = extractRepeatedFormulaicPatterns([
      "其实我觉得还好 是不是没睡好",
      "其实还行 要不要先休息",
      "是不是要早点睡",
    ]);
    expect(patterns).toContain("是不是…");
    expect(patterns).toContain("其实…");
  });

  it("openers 提示块点名重复句式", () => {
    const note = buildAvoidRepeatNote([
      "是不是最近太累了",
      "是不是没睡好啊",
      "行吧",
    ]);
    expect(note).toContain("「是不是…」这种句式你最近连着用了");
    expect(note).toContain("换成陈述句或别的问法");
  });
});

describe("bigramSimilarity", () => {
  it("完全相同为 1，完全无关接近 0", () => {
    expect(bigramSimilarity("今天好热", "今天好热")).toBe(1);
    expect(bigramSimilarity("今天好热", "猫咪又踩我脸")).toBeLessThan(0.1);
  });

  it("部分重合时介于 0 和 1 之间且对称", () => {
    const a = "今天真的好热啊";
    const b = "今天真的好热";
    const score = bigramSimilarity(a, b);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
    expect(bigramSimilarity(b, a)).toBeCloseTo(score, 10);
  });
});

describe("detectRepetition", () => {
  it("整句完全相同 → exact", () => {
    const result = detectRepetition("我记性不太行", ["我记性不太行"]);
    expect(result).toMatchObject({ duplicate: true, kind: "exact", score: 1 });
  });

  it("只多了语气词/标点也算重复（prefix）", () => {
    const result = detectRepetition("我记性不太行啊", ["我记性不太行"]);
    expect(result.duplicate).toBe(true);
    expect(result.kind).toBe("prefix");
  });

  it("高度相似的改写 → similar，且达到阈值", () => {
    const result = detectRepetition("今天真的好热啊", ["今天真的好热"]);
    expect(result.duplicate).toBe(true);
    expect(["similar", "prefix"]).toContain(result.kind);
  });

  it("正常换一句话说 → 不判重复", () => {
    const result = detectRepetition("猫咪又踩我脸叫我起床", ["今天真的好热啊"]);
    expect(result.duplicate).toBe(false);
    expect(result.score).toBeLessThan(0.3);
  });

  it("连续两轮同开头词（句式不同）→ opener", () => {
    const result = detectRepetition("哈哈真的假的啊", [
      "哈哈是吗 我记性不太行",
      "哈哈那可太巧了",
    ]);
    expect(result.duplicate).toBe(true);
    expect(result.kind).toBe("opener");
    expect(result.opener).toBe("哈哈");
    expect(result.score).toBe(0.55);
  });

  it("只有一次同开头不算复读", () => {
    const result = detectRepetition("哈哈真的假的啊", ["哈哈是吗 我记性不太行"]);
    expect(result.duplicate).toBe(false);
  });

  it("空回复不判重复", () => {
    expect(detectRepetition("  ", ["今天好热"])).toMatchObject({ score: 0, duplicate: false, kind: "none" });
  });
});

describe("isWithinTurnDuplicate（当轮去重）", () => {
  it("同一轮里几乎相同的话会被判为重复", () => {
    expect(isWithinTurnDuplicate("被说啦？", ["被说啦"])).toBe(true);
  });

  it("不同的话不算重复", () => {
    expect(isWithinTurnDuplicate("你老板真会挑时候", ["被说啦"])).toBe(false);
  });

  it("没有已发内容时永远不重复", () => {
    expect(isWithinTurnDuplicate("被说啦", [])).toBe(false);
  });
});

describe("长程复读（v0.8.10 回归驱动）", () => {
  it("隔 8 轮的逐字重复也能检出（生产窗口已放宽到 10 条）", () => {
    const earlier = [
      "嗯呐 我在呢",
      "今天店里人手不够 忙死了",
      "你先忙你的",
      "我这边刚收拾完",
      "笑死 那你也太惨了",
      "外面雨还没停",
      "我刚煮了面",
      "喏 就这个",
    ];
    const repeated = "喏 就这个";
    const result = detectRepetition(repeated, earlier);
    expect(result.duplicate).toBe(true);
    expect(result.kind).toBe("exact");
  });

  it("长程窗口不会把单纯句式重复误判成逐字复读", () => {
    const earlier = [
      "你今天怎么样呀我想知道",
      "外面雨好像小了点吧",
      "我这边刚收拾完东西",
      "笑死 那你也太惨了哈哈",
    ];
    const result = detectRepetition("晚上吃点什么好呢", earlier);
    expect(result.duplicate).toBe(false);
  });
});
