/**
 * /why 的主动消息部分：最近决策留痕、原因可读、被门控时如实标注。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildProactiveExplain,
  recordProactiveDecision,
  resetProactiveWindows,
} from "./orchestrator.js";

const OWNER = "qq:10001";

beforeEach(() => {
  resetProactiveWindows();
});

describe("buildProactiveExplain", () => {
  it("没有记录时给出说明，而不是留空", () => {
    const lines = buildProactiveExplain(OWNER).join("\n");
    expect(lines).toContain("她最近怎么决定要不要主动找你");
    expect(lines).toContain("还没有记录");
  });

  it("跳过决策带上链路名与跳过原因", () => {
    recordProactiveDecision(OWNER, {
      action: "skip",
      reason: "follow_up_too_soon",
      detail: "没人接话补一句：她刚说完，还不该催",
    });
    const lines = buildProactiveExplain(OWNER).join("\n");
    expect(lines).toContain("跳过");
    expect(lines).toContain("她刚说完，还不该催");
  });

  it("发送决策显示走了哪条链路", () => {
    recordProactiveDecision(OWNER, {
      action: "send",
      channel: "open_topic",
      detail: "几小时没说话了，我想主动找个话头",
    });
    const lines = buildProactiveExplain(OWNER).join("\n");
    expect(lines).toContain("发送");
    expect(lines).toContain("冷场开话题");
  });

  it("最新决策在最前面，最多保留 5 条给用户看", () => {
    for (let i = 0; i < 8; i++) {
      recordProactiveDecision(OWNER, {
        action: "skip",
        reason: "probability_miss",
        detail: `第 ${i} 次`,
      });
    }
    const lines = buildProactiveExplain(OWNER).join("\n");
    const bullets = lines.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(5);
    expect(lines).toContain("第 7 次");
    expect(lines).not.toContain("第 0 次");
  });

  it("不同 owner 之间互不串记录", () => {
    recordProactiveDecision(OWNER, {
      action: "skip",
      reason: "daily_cap",
      detail: "今天已主动 4/4 次",
    });
    expect(buildProactiveExplain("qq:20002").join("\n")).toContain("还没有记录");
    expect(buildProactiveExplain(OWNER).join("\n")).toContain("4/4");
  });
});
