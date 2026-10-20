import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCooldown, trySharePhoto } from "./unsplash-trigger.js";

/** 构造最小 ConversationState（trySharePhoto 只读取这些字段） */
function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    persona: {
      name: "小雅",
      relationship: { closeness: 3.5 },
      photoShare: {
        enabled: true,
        aesthetic: "日系",
        vibeKeywords: ["温暖"],
        captionStyle: "轻描淡写",
        cooldownHours: 2,
        minCloseness: 4,
      },
    },
    config: {
      photo_share_min_closeness: 3,
      photo_share_probability: 1,
      photo_share_cooldown_minutes: 1,
    },
    emotionState: { vector: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.UNSPLASH_ACCESS_KEY;
  resetCooldown();
  vi.spyOn(Math, "random").mockReturnValue(0.1);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCooldown();
});

describe("trySharePhoto 本地兜底", () => {
  it("无 Unsplash Key 时回退本地图库并返回可读配文", async () => {
    const photo = await trySharePhoto(makeState() as never, "嗯，今天店里挺忙的");
    expect(photo).not.toBeNull();
    expect(photo!.source).toBe("local");
    expect(photo!.imageFile).toBeTruthy();
    expect(fs.existsSync(photo!.imageFile!)).toBe(true);
    expect(photo!.caption.length).toBeGreaterThan(0);
  });

  it("亲密度低于门槛不发", async () => {
    const state = makeState({ persona: { ...makeState().persona as object, relationship: { closeness: 2 } } });
    expect(await trySharePhoto(state as never, "在吗")).toBeNull();
  });

  it("photoShare 关闭时不发", async () => {
    const persona = makeState().persona as Record<string, unknown>;
    const state = makeState({ persona: { ...persona, photoShare: { ...(persona.photoShare as object), enabled: false } } });
    expect(await trySharePhoto(state as never, "在吗")).toBeNull();
  });

  it("概率未命中时不发", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const state = makeState({
      config: { photo_share_min_closeness: 3, photo_share_probability: 0, photo_share_cooldown_minutes: 1 },
    });
    expect(await trySharePhoto(state as never, "在吗")).toBeNull();
  });

  it("用户点名要照片时跳过概率判定（概率 0 也会发）", async () => {
    const state = makeState({
      config: { photo_share_min_closeness: 3, photo_share_probability: 0, photo_share_cooldown_minutes: 1 },
    });
    const photo = await trySharePhoto(state as never, "店里就剩两桌人", { requested: true });
    expect(photo).not.toBeNull();
  });

  it("点名要照片也仍受亲密度约束（不熟就婉拒）", async () => {
    const base = makeState();
    const state = makeState({
      persona: { ...(base.persona as object), relationship: { closeness: 1 } },
    });
    expect(await trySharePhoto(state as never, "拍张照片看看", { requested: true })).toBeNull();
  });

  it("冷却期内不重复发", async () => {
    const state = makeState({
      config: { photo_share_min_closeness: 3, photo_share_probability: 1, photo_share_cooldown_minutes: 10 },
    });
    // v0.9：需要"生活信号"才发图（这里模拟她刚说自己在回家的路上）
    expect(
      await trySharePhoto(state as never, "我刚下班，路上买了点吃的"),
    ).not.toBeNull();
    expect(await trySharePhoto(state as never, "我刚到家")).toBeNull();
  });
});

describe("v0.9 多媒体相关性：没有钩子就不发图", () => {
  it("抽象话题 + 回复没有生活信号 → 不发（宁可少发）", async () => {
    const state = makeState({
      config: { photo_share_min_closeness: 0, photo_share_probability: 1, photo_share_cooldown_minutes: 0 },
    });
    const photo = await trySharePhoto(state as never, "你觉得人为什么要上班？", {
      lastReply: "大概是没得选吧",
      userText: "你觉得人为什么要上班？",
    });
    expect(photo).toBeNull();
  });

  it("场景命中（他说晚霞 + 图库有晚霞图）→ 发，且用场景配文", async () => {
    const state = makeState({
      config: { photo_share_min_closeness: 0, photo_share_probability: 1, photo_share_cooldown_minutes: 0 },
    });
    const photo = await trySharePhoto(state as never, "外面晚霞好漂亮", {
      lastReply: "嗯？",
      userText: "外面晚霞好漂亮",
      preferredTags: ["sunset"],
    });
    expect(photo).not.toBeNull();
    expect(["天这样了", "刚抬头看到的", "这会儿外面挺好看"]).toContain(photo!.caption);
  });
});
