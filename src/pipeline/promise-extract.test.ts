import { describe, expect, it } from "vitest";
import { extractPromises, inferDueAt } from "./promise-extract.js";

const NOW = new Date(2026, 9, 23, 15, 0).getTime(); // 2026-10-23 15:00 本地

function msg(role: "user" | "assistant", content: string, minutesAgo = 1) {
  return { role, content, timestamp: NOW - minutesAgo * 60_000 };
}

describe("inferDueAt", () => {
  it("等会儿 → +30min；明天/后天/周末 → 对应日期 20:00", () => {
    expect(inferDueAt("等会儿给你录", NOW)).toBe(NOW + 30 * 60_000);
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(20, 0, 0, 0);
    expect(inferDueAt("明天带你去吃", NOW)).toBe(tomorrow.getTime());
    expect(inferDueAt("改天再说", NOW)).toBeUndefined();
  });
});

describe("extractPromises", () => {
  it("抽她答应的语音/照片", () => {
    const list = extractPromises(
      [
        msg("assistant", "店里还有客人呢\n等会儿闲下来给你录"),
        msg("assistant", "等我忙完给你拍张照片"),
      ],
      NOW,
    );
    expect(list.some((item) => item.kind === "voice")).toBe(true);
    expect(list.some((item) => item.kind === "photo")).toBe(true);
    expect(list[0]?.kind).toBe("voice");
    expect(list[0]?.sourceRole).toBe("assistant");
    expect(list[0]?.dueAt).toBe(NOW - 60_000 + 30 * 60_000);
  });

  it("只有“忙”没有交付物 → 不记", () => {
    const list = extractPromises([msg("assistant", "等忙完这阵再说吧")], NOW);
    expect(list).toEqual([]);
  });

  it("抽用户的重要日程（event）", () => {
    const list = extractPromises([msg("user", "我明天下午面试，有点紧张")], NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "event", sourceRole: "user" });
    expect(list[0]?.content).toContain("面试");
    expect(list[0]?.dueAt).toBeDefined();
  });

  it("否定句不记", () => {
    const list = extractPromises([msg("assistant", "我不答应给你录音")], NOW);
    expect(list).toEqual([]);
  });

  it("重复句子去重；超过 48 小时的消息不参与", () => {
    const list = extractPromises(
      [
        msg("assistant", "等会儿给你录", 1),
        msg("assistant", "等会儿给你录", 2),
        msg("assistant", "等会儿给你录", 60 * 49),
      ],
      NOW,
    );
    expect(list.filter((item) => item.kind === "voice")).toHaveLength(1);
  });
});
