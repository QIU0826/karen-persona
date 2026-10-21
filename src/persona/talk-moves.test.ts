import { describe, expect, it } from "vitest";
import { decideTalkMove } from "./talk-moves.js";

const base = { userText: "今天店里人多吗", hour: 15, closeness: 3 };

describe("decideTalkMove", () => {
  it("关闭时不做任何动作", () => {
    const d = decideTalkMove(base, { enabled: false, random: () => 0 });
    expect(d.move).toBe("none");
    expect(d.reason).toBe("disabled");
    expect(d.note).toBe("");
  });

  it("危机轮不做说话动作", () => {
    expect(decideTalkMove({ ...base, isCrisis: true }).move).toBe("none");
  });

  it("免打扰时段不做说话动作", () => {
    const d = decideTalkMove({ ...base, hour: 2, quietHours: { start: 23, end: 7 } });
    expect(d.move).toBe("none");
    expect(d.reason).toBe("quiet_hours");
  });

  it("对方在讲糟心事 → 先接住情绪", () => {
    const d = decideTalkMove(
      { ...base, userText: "今天被老板骂了一顿，还要加班，好烦" },
      { random: () => 0.99 },
    );
    expect(d.move).toBe("empathize");
    expect(d.note).toContain("接住");
    // 不应把话题引向她自己
    expect(d.note).toMatch(/别马上|别把话题/);
  });

  it("连续两轮已接过情绪时不重复（避免变成套路）", () => {
    const d = decideTalkMove(
      {
        ...base,
        userText: "还是好丧，项目又崩了",
        recentMoves: ["empathize", "empathize"],
      },
      { random: () => 0.99 },
    );
    expect(d.move).not.toBe("empathize");
  });

  it("普通聊天低概率补一句自己的近况", () => {
    const d = decideTalkMove(base, { random: () => 0.1 });
    expect(d.move).toBe("self-disclose");
    expect(d.note).toContain("近况");
  });

  it("概率没命中时不动", () => {
    const d = decideTalkMove(base, { random: () => 0.9 });
    expect(d.move).toBe("none");
    expect(d.reason).toBe("probability_miss");
  });

  it("不熟（亲密度低）时不主动讲自己的事", () => {
    const d = decideTalkMove({ ...base, closeness: 0.5 }, { random: () => 0.01 });
    expect(d.move).toBe("none");
    expect(d.reason).toBe("low_closeness");
  });

  it("连续两轮自我暴露后有冷却", () => {
    const d = decideTalkMove(
      { ...base, recentMoves: ["self-disclose", "self-disclose"] },
      { random: () => 0.01 },
    );
    expect(d.move).toBe("none");
    expect(d.reason).toBe("cooldown");
  });

  it("CQ 码不影响行为识别", () => {
    const d = decideTalkMove(
      { ...base, userText: "[CQ:image,file=base64://xxx] 今天被裁了，太难受了" },
      { random: () => 0.99 },
    );
    expect(d.move).toBe("empathize");
  });
});

describe("self-disclose 素材注入（v0.9.5）", () => {
  const ctx = {
    userText: "今天上班好累啊",
    hour: 15,
    closeness: 5,
    lifeSignal: "最近在学会拉花（在练郁金香）",
  };

  it("有素材时提示里带一句具体的生活内容", () => {
    const decision = decideTalkMove(ctx, { random: () => 0, enabled: true });
    expect(decision.move).toBe("self-disclose");
    expect(decision.note).toContain("一件具体的小事");
    expect(decision.note).toContain("最近在学会拉花");
    expect(decision.note).toContain("不要照抄");
  });

  it("没有素材时退回空泛提示（不编素材）", () => {
    const decision = decideTalkMove({ ...ctx, lifeSignal: undefined }, { random: () => 0, enabled: true });
    expect(decision.move).toBe("self-disclose");
    expect(decision.note).not.toContain("一件具体的小事");
    expect(decision.note).toContain("自己的近况或念头");
  });

  it("KAREN_SELF_SHARE_MATERIAL=off 时走旧提示（A/B 对照用）", () => {
    const previous = process.env.KAREN_SELF_SHARE_MATERIAL;
    process.env.KAREN_SELF_SHARE_MATERIAL = "off";
    try {
      const decision = decideTalkMove(ctx, { random: () => 0, enabled: true });
      expect(decision.note).not.toContain("一件具体的小事");
      expect(decision.note).toContain("自己的近况或念头");
    } finally {
      if (previous === undefined) delete process.env.KAREN_SELF_SHARE_MATERIAL;
      else process.env.KAREN_SELF_SHARE_MATERIAL = previous;
    }
  });

  it("素材里的换行/多余空格会被压平", () => {
    const decision = decideTalkMove(
      { ...ctx, lifeSignal: "  这会儿在\n咖啡店工作  " },
      { random: () => 0, enabled: true },
    );
    expect(decision.note).toContain("「这会儿在 咖啡店工作」");
  });

  it("empathize 分支不掺入生活素材（先接情绪，不转自己）", () => {
    const decision = decideTalkMove(
      { ...ctx, userText: "今天被老板骂了一顿，好烦" },
      { random: () => 0, enabled: true },
    );
    expect(decision.move).toBe("empathize");
    expect(decision.note).not.toContain("最近在学会拉花");
  });
});
