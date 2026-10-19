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

  it("冷却期内不重复发", async () => {
    const state = makeState({
      config: { photo_share_min_closeness: 3, photo_share_probability: 1, photo_share_cooldown_minutes: 10 },
    });
    expect(await trySharePhoto(state as never, "第一句")).not.toBeNull();
    expect(await trySharePhoto(state as never, "第二句")).toBeNull();
  });
});
