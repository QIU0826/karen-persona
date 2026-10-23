import { describe, expect, it } from "vitest";
import {
  buildConsistencyInjection,
  buildSelfConsistencyNote,
  extractMediaPromise,
  findPendingVoicePromise,
  isVoiceFollowUp,
  type ConsistencyLine,
} from "./self-consistency.js";

function line(role: string, content: string, timestamp: number): ConsistencyLine {
  return { role, content, timestamp };
}

const NOW = 1_800_000_000_000;

describe("extractMediaPromise", () => {
  it("识别「等会儿给你录」类语音承诺", () => {
    const promise = extractMediaPromise("店里还有客人呢\n等会儿闲下来给你录", NOW);
    expect(promise).toMatchObject({ kind: "voice", at: NOW });
    expect(promise?.quote).toContain("录");
  });

  it("识别「答应你的语音还没发」这种旧承诺", () => {
    expect(extractMediaPromise("答应你的语音还没发 等店里闲下来")?.kind).toBe("voice");
  });

  it("识别拍照承诺", () => {
    expect(extractMediaPromise("等我忙完给你拍张照片")?.kind).toBe("photo");
  });

  it("普通聊到语音/照片但没有“稍后”语义 → 不算承诺", () => {
    expect(extractMediaPromise("你的语音挺好听的")).toBeNull();
    expect(extractMediaPromise("这张照片真好看")).toBeNull();
  });
});

describe("findPendingVoicePromise", () => {
  const messages = [
    line("assistant", "店里还有客人呢 等会儿闲下来给你录", NOW - 60_000),
  ];

  it("没有后续语音 → pending", () => {
    expect(findPendingVoicePromise(messages, NOW)?.kind).toBe("voice");
  });

  it("之后已经发过语音 → 不再 pending", () => {
    expect(findPendingVoicePromise(messages, NOW, NOW - 30_000)).toBeNull();
  });

  it("超过 3 小时的旧承诺不再追", () => {
    const old = [line("assistant", "等会儿给你录", NOW - 4 * 60 * 60 * 1000)];
    expect(findPendingVoicePromise(old, NOW)).toBeNull();
  });

  it("普通回复不会误判", () => {
    expect(findPendingVoicePromise([line("assistant", "在擦杯子", NOW - 1000)], NOW)).toBeNull();
  });
});

describe("isVoiceFollowUp", () => {
  it("催语音/追问进度 → true", () => {
    for (const text of ["好了吗？", "怎么还没", "语音呢", "你答应我的", "录好了没"]) {
      expect(isVoiceFollowUp(text), text).toBe(true);
    }
  });

  it("普通聊天 → false", () => {
    for (const text of ["今天吃啥", "我在加班", "晚安"]) {
      expect(isVoiceFollowUp(text), text).toBe(false);
    }
  });
});

describe("buildSelfConsistencyNote", () => {
  it("先忙后闲：提示不要两头都说", () => {
    const messages = [
      line("assistant", "还没呢 刚来一桌三个人的", NOW - 8 * 60_000),
      line("assistant", "还好 就是练拉花老散", NOW - 30_000),
    ];
    const note = buildSelfConsistencyNote(messages, NOW);
    expect(note).toContain("刚才的你");
    expect(note).toContain("两头");
  });

  it("在店/在家混说：提示明确位置", () => {
    const messages = [
      line("assistant", "我在店里呢", NOW - 10 * 60_000),
      line("assistant", "回家躺沙发上了", NOW - 5 * 60_000),
    ];
    const note = buildSelfConsistencyNote(messages, NOW);
    expect(note).toContain("一会儿说在店里");
  });

  it("只有普通回复 → 空串（不增加 token）", () => {
    expect(
      buildSelfConsistencyNote([line("assistant", "嗯呐 你先忙", NOW - 1000)], NOW),
    ).toBe("");
  });

  it("超窗消息不参与（3 小时前）", () => {
    const messages = [line("assistant", "我在店里忙着呢", NOW - 4 * 60 * 60 * 1000)];
    expect(buildSelfConsistencyNote(messages, NOW)).toBe("");
  });

  it("buildConsistencyInjection 始终带固定规则", () => {
    const text = buildConsistencyInjection([], NOW);
    expect(text).toContain("一致性（重要）");
    expect(text).toContain("不要和最近几轮自己说过的话矛盾");
    expect(text).toContain("等会儿 / 忙完");
  });
});
