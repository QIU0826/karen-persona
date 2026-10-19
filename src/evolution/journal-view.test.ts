/**
 * M1-3 演化可见化测试。
 *
 * 1) format* 纯函数：空数据有友好提示、有数据内容正确、不暴露内部英文枚举
 * 2) getJournalEntries：用 KAREN_DATA_DIR 指向临时目录 + vi.resetModules 动态 import，
 *    验证来源过滤、强度过滤、人设过滤、时间倒序（不联网、不碰仓库根 data/）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedHerView } from "../data/state-store.js";
import type { RelationshipState } from "../persona/relationship.js";
import type { DriftState } from "./baseline-drift.js";
import type { NarrativeArc } from "./narrative-reconstruct.js";
import type { EmotionState } from "../persona/emotion.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-journal-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── fixture ──────────────────────────────────

const OCT_18 = new Date("2026-10-18T13:00:00Z").getTime();

function relationshipFixture(): RelationshipState {
  return {
    closeness: 3.55,
    events: [
      { at: OCT_18 - 24 * 3600 * 1000, delta: 0.02, closeness: 3.22, reason: "连续几天都有联系" },
      { at: OCT_18, delta: 0.33, closeness: 3.55, reason: "聊到了一些更深的东西" },
    ],
    milestones: [
      { id: "getting-familiar", at: OCT_18, title: "开始熟络起来", closeness: 3.55 },
    ],
    lastEvaluatedAt: OCT_18,
    lastInteractionDay: "2026-10-18",
    interactionStreak: 2,
    dailyGain: 0.03,
    dailyGainDay: "2026-10-18",
  };
}

function driftFixture(): DriftState {
  return {
    actualBaseline: 0.08,
    perceivedBaseline: 0.02,
    pressure: 0.1,
    lastAwareness: OCT_18,
    history: [],
  };
}

function arcFixture(): NarrativeArc {
  return {
    stage: "noticing",
    lastAdvance: OCT_18,
    direction: "positive",
    currentNarrative: "最近好像心情好一点了……说不上来为什么。",
    expressed: false,
  };
}

function emotionFixture(): EmotionState {
  return { vector: 0.25, baseline: 0.05, arousal: 0.3, lastUpdated: OCT_18 };
}

function herViewFixture(): PersistedHerView {
  return {
    current: "你好像总在她没说累的时候先发现。",
    previous: "你是个话不多但会听的人。",
    lastUpdateCloseness: 3.55,
    lastUpdateAt: OCT_18,
  };
}

function joined(lines: string[]): string {
  return lines.join("\n");
}

// ── 日记格式化 ────────────────────────────────

describe("formatJournal", () => {
  it("没有数据时给出友好提示而不是空输出", async () => {
    const view = await import("./journal-view.js");
    const lines = view.formatJournal([]);
    expect(lines[0]).toBe("她的日记与独白");
    expect(joined(lines)).toContain("没有写日记");
    expect(joined(lines)).not.toContain("undefined");
  });

  it("有数据时展示来源、本地时间与剥掉前缀的正文", async () => {
    const view = await import("./journal-view.js");
    const lines = view.formatJournal([
      { source: "t3_summary", content: "[T3记忆] 那段时间我们聊了很多。", createdAt: "2026-10-20T09:05:00.000Z" },
      { source: "internal_monologue", content: "[独白] 今天的风有点凉。", createdAt: "2026-10-19T14:30:00.000Z" },
    ]);
    const text = joined(lines);
    expect(text).toContain("独白 · 今天的风有点凉。");
    expect(text).toContain("长期记忆 · 那段时间我们聊了很多。");
    expect(text).not.toContain("[独白]");
    expect(text).not.toContain("[T3记忆]");
    // 不把内部英文枚举暴露给用户
    expect(text).not.toContain("internal_monologue");
    expect(text).not.toContain("t3_summary");
    // 时间形如 10-19 22:30（跨年时带年份）
    expect(text).toMatch(/\[\d{2}-\d{2} \d{2}:\d{2}\]/);
    // 入参顺序即展示顺序（最新在前）
    expect(lines.findIndex((l) => l.includes("长期记忆"))).toBeLessThan(
      lines.findIndex((l) => l.includes("独白 ·")),
    );
  });

  it("超长正文会截断，空正文有占位文案", async () => {
    const view = await import("./journal-view.js");
    const long = "啊".repeat(400);
    const text = joined(
      view.formatJournal([
        { source: "internal_monologue", content: long, createdAt: "2026-10-19T14:30:00.000Z" },
        { source: "persona_journal", content: "[进化日志]   ", createdAt: "2026-10-19T14:00:00.000Z" },
      ]),
    );
    expect(text).toContain("…");
    expect(text).toContain("（这条没写下什么）");
    expect(text).toContain("进化日志");
  });
});

// ── 关系时间线格式化 ──────────────────────────

describe("formatRelationshipTimeline", () => {
  it("没有状态时给出友好提示", async () => {
    const view = await import("./journal-view.js");
    const text = joined(view.formatRelationshipTimeline(null));
    expect(text).toContain("还没有关系记录");
  });

  it("有状态但没有变化时展示当前亲密度并提示关系需要时间", async () => {
    const view = await import("./journal-view.js");
    const state = relationshipFixture();
    state.events = [];
    state.milestones = [];
    state.closeness = 3;
    const text = joined(view.formatRelationshipTimeline(state));
    expect(text).toContain("有点眼熟（3.00/10）");
    expect(text).toContain("还没有关系变化记录");
  });

  it("有事件与里程碑时按最近在前展示，并翻译成中文", async () => {
    const view = await import("./journal-view.js");
    const text = joined(view.formatRelationshipTimeline(relationshipFixture()));
    expect(text).toContain("开始熟络（3.55/10）");
    expect(text).toContain("连续互动 2 天");
    expect(text).toContain("+0.33");
    expect(text).toContain("聊到了一些更深的东西");
    expect(text).toContain("开始熟络起来");
    // 不暴露内部里程碑 id
    expect(text).not.toContain("getting-familiar");
  });
});

// ── 她眼中的你 ────────────────────────────────

describe("formatHerView", () => {
  it("没写过时给出友好提示", async () => {
    const view = await import("./journal-view.js");
    const text = joined(view.formatHerView(null));
    expect(text).toContain("还没把对你的看法写下来");
  });

  it("有当前版本时展示内容、时间与亲密度，并附上更早的版本", async () => {
    const view = await import("./journal-view.js");
    const text = joined(view.formatHerView(herViewFixture()));
    expect(text).toContain("你好像总在她没说累的时候先发现");
    expect(text).toContain("亲密度 3.55 时写下");
    expect(text).toContain("更早的时候她写的是");
    expect(text).toContain("你是个话不多但会听的人");
  });

  it("只有人设初始印象（没有更新时间）时说明这是最初写下的", async () => {
    const view = await import("./journal-view.js");
    const text = joined(
      view.formatHerView({
        current: "一个会在深夜陪她说话的人。",
        previous: null,
        lastUpdateCloseness: 3,
        lastUpdateAt: null,
      }),
    );
    expect(text).toContain("一个会在深夜陪她说话的人");
    expect(text).toContain("最初写在人设里的印象");
  });
});

// ── 演化总览 ──────────────────────────────────

describe("formatEvolutionSummary", () => {
  it("没有数据时给出友好提示", async () => {
    const view = await import("./journal-view.js");
    expect(joined(view.formatEvolutionSummary(undefined))).toContain("还没有足够的演化记录");
    expect(joined(view.formatEvolutionSummary({}))).toContain("还没有足够的演化记录");
  });

  it("完整数据时展示关系 / 情绪 / 基线 / 心理阶段", async () => {
    const view = await import("./journal-view.js");
    const text = joined(
      view.formatEvolutionSummary({
        drift: driftFixture(),
        narrativeArc: arcFixture(),
        relationship: relationshipFixture(),
        emotion: emotionFixture(),
      }),
    );
    expect(text).toContain("关系：开始熟络（3.55/10）");
    expect(text).toContain("情绪：愉悦");
    expect(text).toContain("情绪基线：实际 +0.08 / 她以为 +0.02");
    expect(text).toContain("还没完全察觉");
    expect(text).toContain("心理阶段：觉察");
    expect(text).toContain("在往好的方向走");
    expect(text).toContain("她心里的话");
    // 不暴露内部英文枚举
    expect(text).not.toContain("noticing");
    expect(text).not.toContain("positive");
    expect(text).not.toContain("none");
  });

  it("部分数据缺失时逐项提示，不崩溃", async () => {
    const view = await import("./journal-view.js");
    const text = joined(view.formatEvolutionSummary({ relationship: relationshipFixture() }));
    expect(text).toContain("关系：开始熟络");
    expect(text).toContain("情绪：（还没有记录）");
    expect(text).toContain("情绪基线：（还没有记录）");
    expect(text).toContain("心理阶段：（还没有记录）");
  });
});

// ── 本地时间 ──────────────────────────────────

describe("formatLocalTime", () => {
  it("把 SQLite 的无时区 UTC 文本按 UTC 解析后显示为本地时间", async () => {
    const view = await import("./journal-view.js");
    const utc = new Date("2026-10-20T09:05:00Z");
    const two = (n: number) => String(n).padStart(2, "0");
    const yearPrefix =
      utc.getFullYear() === new Date().getFullYear() ? "" : `${utc.getFullYear()}-`;
    const expected = `${yearPrefix}${two(utc.getMonth() + 1)}-${two(utc.getDate())} ${two(
      utc.getHours(),
    )}:${two(utc.getMinutes())}`;
    expect(view.formatLocalTime("2026-10-20 09:05:00")).toBe(expected);
    expect(view.formatLocalTime(null)).toBe("时间未知");
    expect(view.formatLocalTime("不是时间")).toBe("时间未知");
  });
});

// ── getJournalEntries（临时数据目录）────────────

describe("getJournalEntries", () => {
  it("空库返回空数组，不报错", async () => {
    const vector = await import("../data/vector.js");
    const view = await import("./journal-view.js");
    vector.getVectorDb();
    vector.setCurrentPersona("xiaoya");
    expect(view.getJournalEntries()).toEqual([]);
    vector.closeVectorDb();
  });

  it("只取独白 / 进化日志 / T3，过滤低强度与其他来源，并按时间倒序", async () => {
    const vector = await import("../data/vector.js");
    const view = await import("./journal-view.js");
    const db = vector.getVectorDb();
    vector.setCurrentPersona("xiaoya");

    const olderMonologue = vector.insertEpisode("[独白] 今天的风有点凉。", "internal_monologue", 0.3);
    const newerSummary = vector.insertEpisode("[T3记忆] 那段时间我们聊了很多。", "t3_summary", 0);
    const chat = vector.insertEpisode("普通对话，不该出现", "chat", 0);
    const decayed = vector.insertEpisode("[独白] 已经快忘了", "internal_monologue", 0);

    db.prepare("UPDATE t2_episodes SET created_at = ? WHERE id = ?").run(
      "2026-10-19 14:30:00",
      olderMonologue,
    );
    db.prepare("UPDATE t2_episodes SET created_at = ? WHERE id = ?").run(
      "2026-10-20 09:05:00",
      newerSummary,
    );
    db.prepare("UPDATE t2_episodes SET created_at = ? WHERE id = ?").run(
      "2026-10-21 08:00:00",
      chat,
    );
    db.prepare("UPDATE t2_episodes SET created_at = ?, strength = 0.01 WHERE id = ?").run(
      "2026-10-22 08:00:00",
      decayed,
    );

    const entries = view.getJournalEntries();
    expect(entries.map((e) => e.source)).toEqual(["t3_summary", "internal_monologue"]);
    expect(entries.map((e) => e.content)).toEqual([
      "那段时间我们聊了很多。",
      "今天的风有点凉。",
    ]);
    // SQLite 的 UTC 文本被转成带时区的 ISO 时间
    expect(entries[0].createdAt).toBe("2026-10-20T09:05:00.000Z");
    expect(entries[1].createdAt).toBe("2026-10-19T14:30:00.000Z");

    // limit 生效
    const one = view.getJournalEntries(1);
    expect(one).toHaveLength(1);
    expect(one[0].source).toBe("t3_summary");

    vector.closeVectorDb();
  });

  it("按当前人设隔离：换人设后读不到别人设的日记", async () => {
    const vector = await import("../data/vector.js");
    const view = await import("./journal-view.js");
    vector.getVectorDb();

    vector.setCurrentPersona("xiaoya");
    vector.insertEpisode("[独白] 只属于小雅的日记。", "internal_monologue", 0.2);
    expect(view.getJournalEntries()).toHaveLength(1);

    vector.setCurrentPersona("qiuyao");
    expect(view.getJournalEntries()).toEqual([]);
    vector.closeVectorDb();
  });
});
