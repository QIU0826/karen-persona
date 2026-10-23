import { describe, expect, it } from "vitest";
import {
  isLowInformationSummary,
  validateAnchorVerdict,
  type AnchorEvidenceCandidate,
  type AnchorEvidenceVerdict,
} from "./anchor-validation.js";

function candidate(content: string, source = "chat"): AnchorEvidenceCandidate {
  return { content, source };
}

function verdict(
  kind: AnchorEvidenceVerdict["kind"],
  summary: string,
  anchor = true,
): AnchorEvidenceVerdict {
  return { anchor, kind, summary };
}

describe("isLowInformationSummary", () => {
  it("太短 / 字符种类过少 / 同词重复都算低信息", () => {
    expect(isLowInformationSummary("")).toBe(true);
    expect(isLowInformationSummary("工作工作")).toBe(true);
    expect(isLowInformationSummary("嗯嗯嗯嗯")).toBe(true);
    expect(isLowInformationSummary("他说他")).toBe(true);
  });

  it("正常摘要不算", () => {
    expect(isLowInformationSummary("约好周末一起看电影")).toBe(false);
    expect(isLowInformationSummary("他下周三要去上海签合同")).toBe(false);
  });
});

describe("shared_experience 归属校验（真实库事故回归）", () => {
  it("「我和同事一起来吃的」不是共同经历 → 拒绝", () => {
    const result = validateAnchorVerdict(
      candidate("[对话] 用户: 我和同事一起来吃的 | 回复: 好吃吗"),
      verdict("shared_experience", "我和同事一起来吃的"),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("shared_without_evidence");
  });

  it("「一起吃的鸡杂锅」只有“一起”没有双方 → 拒绝", () => {
    const result = validateAnchorVerdict(
      candidate("[对话] 用户: 我和同事一起吃的鸡杂锅"),
      verdict("shared_experience", "一起吃的鸡杂锅"),
    );
    expect(result.ok).toBe(false);
  });

  it("「我们一起去吃了鸡杂锅」是共同经历 → 通过", () => {
    const result = validateAnchorVerdict(
      candidate("[对话] 用户: 我们周末一起去吃了鸡杂锅"),
      verdict("shared_experience", "周末一起去吃鸡杂锅"),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("shared_experience");
    expect(result.summary).toBe("周末一起去吃鸡杂锅");
  });

  it("她自己的叙述里「和他一起」也算双方参与", () => {
    const result = validateAnchorVerdict(
      candidate("今天和他一起吃了火锅，他不太能吃辣", "internal_monologue"),
      verdict("shared_experience", "和他一起吃了火锅"),
    );
    expect(result.ok).toBe(true);
  });
});

describe("promise 证据校验", () => {
  it("真实约定通过", () => {
    const result = validateAnchorVerdict(
      candidate("[对话] 用户: 说好周末一起看电影"),
      verdict("promise", "说好周末一起看电影"),
    );
    expect(result.ok).toBe(true);
  });

  it("「工作工作」这种泛词不能当约定", () => {
    const result = validateAnchorVerdict(
      candidate("工作工作工作"),
      verdict("promise", "工作工作"),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("summary_low_info");
  });

  it("内容与摘要都没有约定语言 → 拒绝", () => {
    const result = validateAnchorVerdict(
      candidate("他说最近压力很大"),
      verdict("promise", "他压力很大"),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("promise_without_evidence");
  });
});

describe("first_meet 证据校验", () => {
  it("明确说过相识经过 → 通过", () => {
    const result = validateAnchorVerdict(
      candidate("[对话] 用户: 我们是在咖啡店认识的"),
      verdict("first_meet", "我们在咖啡店认识"),
    );
    expect(result.ok).toBe(true);
  });

  it("第三人称旁观叙述、没有你/我/我们 → 拒绝（防编造）", () => {
    const result = validateAnchorVerdict(
      candidate("她在咖啡店吧台常坐，两人这样认识"),
      verdict("first_meet", "两人这样认识"),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("first_meet_without_evidence");
  });

  it("她的独白/日记不能作为相识事实来源", () => {
    const result = validateAnchorVerdict(
      candidate("我想象我们第一次见面的场景", "internal_monologue"),
      verdict("first_meet", "我们第一次见面"),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("first_meet_without_evidence");
  });
});

describe("其它 kind 需要内容与摘要同时有证据", () => {
  it("冲突/和好/秘密/失去/表白", () => {
    expect(
      validateAnchorVerdict(
        candidate("用户: 我们吵架了，他说了很难听的话"),
        verdict("conflict", "我们吵架了"),
      ).ok,
    ).toBe(true);
    expect(
      validateAnchorVerdict(candidate("用户: 对不起，我道歉"), verdict("makeup", "他道歉了")).ok,
    ).toBe(true);
    expect(
      validateAnchorVerdict(candidate("用户: 我告诉你一个秘密"), verdict("secret", "他说了一个秘密"))
        .ok,
    ).toBe(true);
    expect(
      validateAnchorVerdict(candidate("用户: 我爷爷去世了"), verdict("loss", "他爷爷去世了")).ok,
    ).toBe(true);
    expect(
      validateAnchorVerdict(candidate("用户: 我喜欢你"), verdict("confession", "他表白了")).ok,
    ).toBe(true);
  });

  it("没有证据词 → 拒绝", () => {
    expect(
      validateAnchorVerdict(candidate("今天天气不错"), verdict("conflict", "今天天气不错")),
    ).toMatchObject({ ok: false, reason: "conflict_without_evidence" });
    expect(
      validateAnchorVerdict(candidate("他说周末去爬山"), verdict("makeup", "他说周末去爬山")),
    ).toMatchObject({ ok: false, reason: "makeup_without_evidence" });
  });
});

describe("基础边界", () => {
  it("LLM 判 false / 空摘要 / 非法 kind 都拒绝", () => {
    expect(validateAnchorVerdict(candidate("随便"), verdict("promise", "说好周末", false)).reason).toBe(
      "not_anchor",
    );
    expect(validateAnchorVerdict(candidate("随便"), verdict("promise", "   ")).reason).toBe(
      "summary_empty",
    );
    expect(validateAnchorVerdict(candidate("随便"), verdict("unknown_kind", "说好周末")).reason).toBe(
      "kind_invalid",
    );
  });
});
