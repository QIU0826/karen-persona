import { describe, expect, it, vi } from "vitest";
import {
  buildReflectText,
  buildFactListText,
  buildRelationsText,
  buildHelpText,
  buildWhyText,
  handleControlCommand,
  parseControlCommand,
} from "./control.js";

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lastGate: {
      action: "delay",
      reason: "需要时间想怎么回",
      at: Date.now(),
      remainingMs: 30 * 60 * 1000,
    },
    relationshipState: { closeness: 3.2 },
    emotionState: { vector: 0.2, baseline: 0, arousal: 0.3, lastUpdated: Date.now() },
    session: { messages: [] },
    config: { quiet_hours_start: 2, quiet_hours_end: 7 },
    proactivePaused: false,
    consecutiveSilences: 1,
    ...overrides,
  };
}

describe("parseControlCommand", () => {
  it("解析命令名并小写化", () => {
    expect(parseControlCommand("/why")!.name).toBe("why");
    expect(parseControlCommand("  /PAUSE  ")!.name).toBe("pause");
    expect(parseControlCommand("/export backup")!.arg).toBe("backup");
  });

  it("非命令返回 null", () => {
    expect(parseControlCommand("你好呀")).toBeNull();
    expect(parseControlCommand("/")).toBeNull();
  });
});

describe("buildWhyText", () => {
  it("解释最近一次裁决与当前处境", () => {
    const text = buildWhyText(makeState() as never);
    expect(text).toContain("最近一次消息门裁决");
    expect(text).toContain("晚点回复");
    expect(text).toContain("需要时间想怎么回");
    expect(text).toContain("约 30 分钟后");
    expect(text).toContain("亲密度：3.2");
    expect(text).toContain("免打扰时段：02:00-07:00");
  });

  it("没有裁决记录时给出提示", () => {
    const text = buildWhyText(makeState({ lastGate: null }) as never);
    expect(text).toContain("还没有记录");
  });
});

describe("handleControlCommand", () => {
  it("/pause 设置暂停并持久化", async () => {
    const state = makeState() as never as { proactivePaused: boolean };
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    expect(await handleControlCommand("/pause", state as never, deps)).toBe(true);
    expect((state as { proactivePaused: boolean }).proactivePaused).toBe(true);
    expect(deps.persist).toHaveBeenCalledOnce();
    expect(deps.reply.mock.calls[0][0]).toContain("已暂停主动消息");
  });

  it("/resume 恢复主动消息", async () => {
    const state = makeState({ proactivePaused: true }) as never;
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    expect(await handleControlCommand("/resume", state as never, deps)).toBe(true);
    expect((state as { proactivePaused: boolean }).proactivePaused).toBe(false);
    expect(deps.reply.mock.calls[0][0]).toContain("已恢复主动消息");
  });

  it("/export 调用导出并回报数量与路径", async () => {
    const deps = {
      reply: vi.fn(),
      persist: vi.fn(),
      exportData: vi.fn(() => ({
        path: "/tmp/export.json",
        counts: { messages: 12, memories: 34, relationshipEvents: 5 },
      })),
    };
    expect(await handleControlCommand("/export", makeState() as never, deps)).toBe(true);
    expect(deps.exportData).toHaveBeenCalledOnce();
    const text = deps.reply.mock.calls[0][0] as string;
    expect(text).toContain("对话 12 条");
    expect(text).toContain("/tmp/export.json");
  });

  it("/about 展示 AI 披露与数据去向", async () => {
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    expect(await handleControlCommand("/about", makeState() as never, deps)).toBe(true);
    const text = deps.reply.mock.calls[0][0] as string;
    expect(text).toContain("AI 虚拟人角色");
    expect(text).toContain("DeepSeek");
    expect(text).toContain("12356");
    expect(text).toContain("18 岁");
  });

  it("/age 在未传 owner 时提示尚未确认", async () => {
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    const handled = await handleControlCommand("/age", makeState() as never, deps);
    expect(handled).toBe(true);
    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(String(deps.reply.mock.calls[0][0])).toContain("尚未确认");
  });

  it("/help 与未知指令", async () => {
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    expect(await handleControlCommand("/help", makeState() as never, deps)).toBe(true);
    expect(deps.reply.mock.calls[0][0]).toContain("/why");
    expect(await handleControlCommand("/nope", makeState() as never, deps)).toBe(false);
    expect(buildHelpText()).toContain("/export");
  });
});

describe("/fact：她记得的关于你的事", () => {
  it("没有事实时给出引导，而不是空白", () => {
    expect(buildFactListText([])).toContain("还没记住");
  });

  it("列出事实并标注状态（待确认/已确认/有冲突）", () => {
    const text = buildFactListText([
      { ownerId: "qq:1", key: "city", value: "杭州", category: "profile", updatedAt: 1, status: "confirmed" },
      { ownerId: "qq:1", key: "pet", value: "橘猫团子", category: "pet", updatedAt: 2, status: "pending" },
      { ownerId: "qq:1", key: "job", value: "产品设计", category: "work", updatedAt: 3, status: "disputed" },
    ] as never);
    expect(text).toContain("city：杭州（已确认）");
    expect(text).toContain("pet：橘猫团子（待确认）");
    expect(text).toContain("job：产品设计（有冲突）");
    expect(text).toContain("/fact ok <key>");
  });

  it("参数不完整时给出用法", async () => {
    const state = makeState({ owner: "qq:1" }) as never;
    const deps = { reply: vi.fn(), persist: vi.fn(), exportData: vi.fn() };
    expect(await handleControlCommand("/fact ok", state, deps)).toBe(true);
    expect(deps.reply.mock.calls[0][0]).toContain("用法");
  });
});

describe("/relations：五维关系", () => {
  it("展示阶段、五维与可读描述", () => {
    const state = makeState({
      relationshipState: {
        closeness: 6.2,
        interactionStreak: 9,
        lastConflictAt: null,
        dims: { intimacy: 6, trust: 5.5, tension: 0.5, reciprocity: 5, dependency: 4, updatedAt: 1 },
      },
    }) as never;
    const text = buildRelationsText(state);
    expect(text).toContain("关系现状");
    expect(text).toContain("亲密 6.0");
    expect(text).toContain("信任 5.5");
    expect(text).toContain("亲密度：6.20/10");
  });

  it("张力高时给出「自然会冷一点」的说明", () => {
    const state = makeState({
      relationshipState: {
        closeness: 5,
        interactionStreak: 3,
        lastConflictAt: null,
        dims: { intimacy: 5, trust: 4, tension: 6.5, reciprocity: 4, dependency: 3, updatedAt: 1 },
      },
    }) as never;
    const text = buildRelationsText(state);
    expect(text).toContain("别扭");
    expect(text).toContain("冷一点");
  });

  it("老状态没有 dims 时按亲密度兜底，不报错", () => {
    const state = makeState({
      relationshipState: { closeness: 3, interactionStreak: 1, lastConflictAt: null },
    }) as never;
    expect(buildRelationsText(state)).toContain("亲密度：3.00/10");
  });
});

describe("/reflect：反思弧线", () => {
  it("平静期只说明状态与含义", () => {
    const state = makeState({
      reflectionState: {
        phase: "none",
        topic: null,
        signalKind: null,
        pushCount: 0,
        phaseSince: Date.now(),
        changeApplied: false,
        updatedAt: Date.now(),
      },
    }) as never;
    const text = buildReflectText(state);
    expect(text).toContain("平静");
    expect(text).toContain("先察觉");
  });

  it("否认期展示由头、停留时长与心里话", () => {
    const state = makeState({
      reflectionState: {
        phase: "denying",
        topic: "他好像觉得我最近有点不一样",
        signalKind: "user_pointed_out",
        pushCount: 1,
        phaseSince: Date.now() - 30 * 60_000,
        changeApplied: false,
        updatedAt: Date.now(),
      },
    }) as never;
    const text = buildReflectText(state);
    expect(text).toContain("嘴硬");
    expect(text).toContain("他好像觉得我最近有点不一样");
    expect(text).toContain("被戳次数：1");
    expect(text).toContain("哪有");
  });

  it("改过之后有说明", () => {
    const state = makeState({
      reflectionState: {
        phase: "none",
        topic: null,
        signalKind: null,
        pushCount: 0,
        phaseSince: Date.now(),
        changeApplied: true,
        updatedAt: Date.now(),
      },
    }) as never;
    expect(buildReflectText(state)).toContain("改过一次");
  });
});
