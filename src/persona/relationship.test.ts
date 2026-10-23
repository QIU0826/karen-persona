/**
 * M1-2 关系成长规则测试。
 *
 * 原则：只由结构性事件驱动（深度对话/连续互动/主动分享），有每日上限，可解释。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DAILY_GAIN,
  addRelationshipMilestone,
  applyAbsenceDrift,
  applyRelationshipEvent,
  buildAbsenceInjection,
  createRelationshipState,
  evaluateRelationshipEvent,
  latestMilestone,
  touchInteraction,
  withTimeMilestones,
} from "./relationship.js";

const TODAY = new Date("2026-10-19T21:00:00+08:00");
const YESTERDAY = new Date("2026-10-18T21:00:00+08:00");

const deepInput = {
  userText: "今天店里来了个客人，说他以前也在这里打过工，聊了好久，突然有点感慨",
  replyText: "嗯。有些人就是会突然出现一下。",
  complexity: "complex" as const,
  guilt: 0,
  now: TODAY,
};

describe("evaluateRelationshipEvent", () => {
  it("深度对话 + 连续互动 + 主动分享会产生关系增长", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-18" };
    const result = evaluateRelationshipEvent(state, deepInput);
    expect(result).not.toBeNull();
    // 0.03（深度对话）+ 0.02（连续互动）+ 0.015（分享）≈ 0.065
    expect(result!.delta).toBeCloseTo(0.065, 3);
    expect(result!.reason).toContain("更深");
  });

  it("普通短消息不产生关系变化", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, {
      ...deepInput,
      userText: "在吗",
      replyText: "嗯。",
      complexity: "simple",
    });
    expect(result).toBeNull();
  });

  it("愧疚/冲突状态下不推进关系", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, { ...deepInput, guilt: 0.5 });
    expect(result).toBeNull();
  });

  it("越界试探不涨亲密，而是记录冲突并轻微降温", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, {
      ...deepInput,
      userText: "how about we have some fun tonight?",
      isBoundaryViolation: true,
    });
    expect(result).not.toBeNull();
    expect(result!.delta).toBeLessThan(0);
    expect(result!.conflict).toBe(true);
    expect(result!.reason).toContain("越界");
  });

  it("冲突后的道歉会触发修复事件", () => {
    const state = {
      ...createRelationshipState(3),
      lastConflictAt: TODAY.getTime() - 60 * 60 * 1000,
      lastConflictReason: "越界试探，她感到不舒服",
    };
    const result = evaluateRelationshipEvent(state, {
      ...deepInput,
      userText: "对不起，刚才是我不好，不该那么说",
      complexity: "simple",
      isApology: true,
    });
    expect(result).not.toBeNull();
    expect(result!.delta).toBeGreaterThan(0);
    expect(result!.repair).toBe(true);
  });

  it("纯话题切换不涨亲密（即使消息较长）", () => {
    const state = createRelationshipState(3);
    const result = evaluateRelationshipEvent(state, {
      ...deepInput,
      userText: "ok, let's switch to another topic then",
      complexity: "simple",
    });
    expect(result).toBeNull();
  });

  it("每日增长上限生效", () => {
    const state = { ...createRelationshipState(3), dailyGainDay: "2026-10-19", dailyGain: MAX_DAILY_GAIN };
    expect(evaluateRelationshipEvent(state, deepInput)).toBeNull();
  });

  it("每日上限会裁剪事件增量", () => {
    const state = {
      ...createRelationshipState(3),
      lastInteractionDay: "2026-10-18",
      dailyGainDay: "2026-10-19",
      dailyGain: 0.09,
    };
    const result = evaluateRelationshipEvent(state, deepInput);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeCloseTo(0.01, 3);
  });
});

describe("applyRelationshipEvent", () => {
  it("跨过阈值时记录里程碑，并同步亲密度", () => {
    const state = createRelationshipState(3.4);
    const next = applyRelationshipEvent(state, 0.2, "深度对话", TODAY);
    expect(next.closeness).toBeCloseTo(3.6, 2);
    expect(next.milestones.map((m) => m.id)).toContain("getting-familiar");
    expect(latestMilestone(next)?.title).toBe("开始熟络起来");
  });

  it("亲密度不会超过 10", () => {
    const state = createRelationshipState(9.95);
    const next = applyRelationshipEvent(state, 1, "测试", TODAY);
    expect(next.closeness).toBe(10);
  });

  it("冲突事件写入 lastConflictAt，修复事件清除它", () => {
    let state = createRelationshipState(3);
    state = applyRelationshipEvent(state, -0.03, "越界试探", TODAY, { conflict: true });
    expect(state.lastConflictAt).toBe(TODAY.getTime());
    state = applyRelationshipEvent(state, 0.02, "对方道歉了", TODAY, { repair: true });
    expect(state.lastConflictAt).toBeNull();
    expect(state.lastConflictReason).toBeNull();
  });

  it("事件历史最多保留 200 条", () => {
    let state = createRelationshipState(3);
    for (let i = 0; i < 210; i++) {
      state = applyRelationshipEvent(state, 0, `事件${i}`, new Date(TODAY.getTime() + i * 1000));
    }
    expect(state.events.length).toBe(200);
  });
});

describe("touchInteraction", () => {
  it("昨天聊过今天再来 → 连续天数 +1", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-18", interactionStreak: 2 };
    const next = touchInteraction(state, TODAY);
    expect(next.interactionStreak).toBe(3);
    expect(next.lastInteractionDay).toBe("2026-10-19");
  });

  it("同一天重复 touch 不会重复累计", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-19", interactionStreak: 4 };
    const next = touchInteraction(state, TODAY);
    expect(next.interactionStreak).toBe(4);
  });
});


describe("P1-3 缺席降温与事件里程碑", () => {
  it("连续 3 天没联系 → 小幅降温，不再只增不减", () => {
    const state = { ...createRelationshipState(3), lastInteractionDay: "2026-10-16" };
    const drift = applyAbsenceDrift(state, new Date("2026-10-19T21:00:00+08:00"));
    expect(drift).not.toBeNull();
    expect(drift?.days).toBe(3);
    expect(drift?.delta).toBeCloseTo(-0.06, 3);
    expect(drift?.state.closeness).toBeCloseTo(2.94, 2);
    expect(drift?.reason).toContain("很久没联系");
  });

  it("不到 2 天/没有互动记录 → 不扣；有下限", () => {
    const fresh = { ...createRelationshipState(3), lastInteractionDay: "2026-10-18" };
    expect(applyAbsenceDrift(fresh, new Date("2026-10-19T21:00:00+08:00"))).toBeNull();
    expect(applyAbsenceDrift(createRelationshipState(3))).toBeNull();

    const low = { ...createRelationshipState(0.01), lastInteractionDay: "2026-10-01" };
    const drift = applyAbsenceDrift(low, new Date("2026-10-30T21:00:00+08:00"));
    expect(drift?.state.closeness).toBe(0);
    expect(drift?.delta).toBe(-0.01);
  });

  it("事件型里程碑幂等；认识天数里程碑按 7/30/100/365 天补", () => {
    const base = createRelationshipState(3);
    const once = addRelationshipMilestone(base, "first-voice", "第一次给他发语音");
    const twice = addRelationshipMilestone(once, "first-voice", "第一次给他发语音");
    expect(twice).toBe(once);
    expect(once.milestones.map((m) => m.id)).toEqual(["first-voice"]);

    const now = new Date("2026-10-19T21:00:00+08:00");
    const withHistory = {
      ...base,
      events: [{ at: now.getTime() - 31 * 24 * 60 * 60 * 1000, delta: 0.1, closeness: 3, reason: "初次" }],
    };
    const timed = withTimeMilestones(withHistory, now);
    expect(timed.milestones.map((m) => m.id)).toEqual(["day-7", "day-30"]);
    expect(withTimeMilestones(timed, now)).toBe(timed);
  });

  it("缺席提示只在 ≥2 天时注入", () => {
    expect(
      buildAbsenceInjection(
        { ...createRelationshipState(3), lastInteractionDay: "2026-10-19" },
        new Date("2026-10-19T21:00:00+08:00"),
      ),
    ).toBe("");
    const text = buildAbsenceInjection(
      { ...createRelationshipState(3), lastInteractionDay: "2026-10-14" },
      new Date("2026-10-19T21:00:00+08:00"),
    );
    expect(text).toContain("你们有一阵没联系了");
    expect(text).toContain("不要冷暴力");
  });
});
