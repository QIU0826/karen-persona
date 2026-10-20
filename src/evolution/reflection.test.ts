import { describe, expect, it } from "vitest";
import {
  PHASE_DURATION_MS,
  applyReflectionSignal,
  buildReflectionInjection,
  buildReflectionStatement,
  createReflectionState,
  looksLikeUserPointingOut,
  shouldApplyChange,
  type ReflectionState,
} from "./reflection.js";

const T0 = new Date(2026, 9, 20, 12).getTime();
const H = 3600_000;

/** 把状态推进到某阶段（便于测试后续阶段） */
function stateAt(phase: ReflectionState["phase"], phaseSince = T0): ReflectionState {
  return {
    phase,
    topic: "最近话变少了",
    signalKind: "self_observed",
    pushCount: 2,
    phaseSince,
    changeApplied: false,
    updatedAt: phaseSince,
  };
}

describe("createReflectionState", () => {
  it("初始是平静期", () => {
    const s = createReflectionState(T0);
    expect(s.phase).toBe("none");
    expect(s.topic).toBeNull();
    expect(s.changeApplied).toBe(false);
  });
});

describe("applyReflectionSignal：达到察觉门槛才反思", () => {
  it("同一类信号只出现 1 次不反思（避免一句玩笑就被反思）", () => {
    const s = createReflectionState(T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "总在主动" }, { now: T0, recentSignalCount: 1 });
    expect(next.phase).toBe("none");
  });

  it("出现 2 次 → 进入察觉并记住由头", () => {
    const s = createReflectionState(T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "总在主动" }, { now: T0, recentSignalCount: 2 });
    expect(next.phase).toBe("noticing");
    expect(next.topic).toBe("总在主动");
  });

  it("他直接点破 → 1 次就察觉", () => {
    const s = createReflectionState(T0);
    const next = applyReflectionSignal(s, { kind: "user_pointed_out", topic: "话变少了" }, { now: T0, recentSignalCount: 1 });
    expect(next.phase).toBe("noticing");
  });
});

describe("applyReflectionSignal：三段弧线", () => {
  it("察觉待够 → 否认（先嘴硬）", () => {
    const s = stateAt("noticing", T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "x" }, { now: T0 + PHASE_DURATION_MS.noticing + H });
    expect(next.phase).toBe("denying");
  });

  it("被点破会提前进入否认", () => {
    const s = stateAt("noticing", T0);
    const next = applyReflectionSignal(s, { kind: "user_pointed_out", topic: "x" }, { now: T0 + 60_000 });
    expect(next.phase).toBe("denying");
  });

  it("否认期被戳一次还不够（pushCount 0→1，仍嘴硬）", () => {
    const s = { ...stateAt("denying", T0), pushCount: 0 };
    const first = applyReflectionSignal(s, { kind: "user_pointed_out", topic: "x" }, { now: T0 + 7 * H });
    expect(first.phase).toBe("denying");
    expect(first.pushCount).toBe(1);
    // 再被戳一次（2 次）才承认
    const second = applyReflectionSignal(first, { kind: "user_pointed_out", topic: "x" }, { now: T0 + 8 * H });
    expect(second.phase).toBe("admitting");
  });

  it("否认待够时间 → 承认", () => {
    const s = stateAt("denying", T0);
    const next = applyReflectionSignal(s, { kind: "user_pointed_out", topic: "x" }, { now: T0 + PHASE_DURATION_MS.denying + H });
    expect(next.phase).toBe("admitting");
  });

  it("承认待够时间 → 整合", () => {
    const s = stateAt("admitting", T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "x" }, { now: T0 + PHASE_DURATION_MS.admitting + H });
    expect(next.phase).toBe("integrating");
  });

  it("整合待够时间 → 回到平静，并标记已改", () => {
    const s = stateAt("integrating", T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "x" }, { now: T0 + PHASE_DURATION_MS.integrating + H });
    expect(next.phase).toBe("none");
    expect(next.changeApplied).toBe(true);
    expect(next.topic).toBeNull();
  });

  it("时间没到就保持原阶段（不会一戳就跳到承认）", () => {
    const s = stateAt("noticing", T0);
    const next = applyReflectionSignal(s, { kind: "self_observed", topic: "x" }, { now: T0 + 1000, recentSignalCount: 1 });
    expect(next.phase).toBe("noticing");
  });
});

describe("shouldApplyChange", () => {
  it("只有整合期过半且没改过才动真格", () => {
    const integrating = stateAt("integrating", T0);
    expect(shouldApplyChange(integrating, T0 + PHASE_DURATION_MS.integrating / 2 + 1)).toBe(true);
    expect(shouldApplyChange(integrating, T0 + 1000)).toBe(false);
    expect(shouldApplyChange({ ...integrating, changeApplied: true }, T0 + 999_999)).toBe(false);
    expect(shouldApplyChange(stateAt("admitting", T0), T0 + 999_999)).toBe(false);
  });
});

describe("自我陈述与注入", () => {
  it("各阶段说的话不一样（嘴硬 vs 承认）", () => {
    expect(buildReflectionStatement(stateAt("denying"))).toContain("哪有");
    expect(buildReflectionStatement(stateAt("admitting"))).toContain("我承认");
    expect(buildReflectionStatement(stateAt("integrating"))).toContain("注意点");
    expect(buildReflectionStatement(createReflectionState(T0))).toBeNull();
  });

  it("平静期不注入，非平静期注入带由头", () => {
    expect(buildReflectionInjection(createReflectionState(T0))).toBe("");
    const injection = buildReflectionInjection(stateAt("denying"));
    expect(injection).toContain("先否认");
    expect(injection).toContain("最近话变少了");
  });
});

describe("looksLikeUserPointingOut", () => {
  it("识别他说你变了/话少了/太黏", () => {
    for (const text of ["你最近是不是有点冷淡", "你怎么老是回这么慢", "你话变少了", "你太黏了吧"]) {
      expect(looksLikeUserPointingOut(text)).toBe(true);
    }
  });

  it("普通陈述不误判", () => {
    for (const text of ["我今天加班到十点", "你给我推荐首歌", "今天好热"]) {
      expect(looksLikeUserPointingOut(text)).toBe(false);
    }
  });
});
