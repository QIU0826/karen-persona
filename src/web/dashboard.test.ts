/**
 * Web 控制台页面渲染测试（无网络、无数据库写操作）。
 *
 * 覆盖：
 * - escapeHtml / escapeJsonForScript 的 XSS 转义
 * - renderDashboard 首屏包含四视图 DOM / 内联样式脚本 / 自动刷新与暂停按钮
 * - 用户内容（会话消息、记忆、herView、人设名）一律转义，页面无外域脚本
 * - 空数据（无会话/无记忆/无状态）不崩、有友好提示
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, escapeJsonForScript, renderDashboard } from "./dashboard.js";
import type {
  CostData,
  HealthData,
  MemoryHitProbeData,
  MemoryListData,
  OverviewData,
  SessionData,
  TimelineData,
  UserFactsData,
} from "./data.js";

function overviewFixture(): OverviewData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    persona: { id: "xiaoya", name: "小雅" },
    session: { messages: 2, last_active_at: "2026-10-19T11:59:00.000Z" },
    memory: { total: 2, latest_at: "2026-10-19T11:00:00.000Z" },
    relationship: { closeness: 3.55, label: "开始熟络", interaction_streak: 3, milestones: 1, events: 1 },
    state: { saved_at: "2026-10-19T11:00:00.000Z", emotion_label: "愉悦", narrative_stage: "觉察" },
    health: {
      ok: true,
      uptime_seconds: 65,
      version: "0.1.0",
      ws_connections: 2,
      db_ok: true,
      pending_replies: 1,
      cost_today: 0.001,
      last_error: null,
    },
    cost_today: { calls: 3, cost_cny: 0.001 },
  };
}

function sessionFixture(): SessionData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    persona: { id: "xiaoya", name: "小雅" },
    limit: 30,
    total: 2,
    last_active_at: "2026-10-19T11:59:00.000Z",
    messages: [
      { role: "user", content: "你好呀", timestamp: 1, at: "2026-10-19T11:58:00.000Z" },
      { role: "assistant", content: "嗯，在呢。", timestamp: 2, at: "2026-10-19T11:59:00.000Z" },
    ],
  };
}

function memoryFixture(): MemoryListData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    persona: { id: "xiaoya", name: "小雅" },
    limit: 30,
    total: 2,
    items: [
      {
        id: 2,
        source: "chat",
        source_label: "对话",
        content: "[对话] 用户: 今天下雨了 | 回复: 记得带伞",
        strength: 0.8,
        emotional_weight: 0.2,
        created_at: "2026-10-19T11:00:00.000Z",
      },
      {
        id: 1,
        source: "internal_monologue",
        source_label: "独白",
        content: "今天有点想他。",
        strength: 0.6,
        emotional_weight: 0,
        created_at: "2026-10-18T10:00:00.000Z",
      },
    ],
  };
}

function timelineFixture(): TimelineData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    persona: { id: "xiaoya", name: "小雅" },
    has_state: true,
    state_saved_at: "2026-10-19T11:00:00.000Z",
    closeness: 3.55,
    label: "开始熟络",
    interaction_streak: 3,
    milestones: [
      { title: "开始熟络起来", closeness: 3.55, at: "2026-10-18T13:00:00.000Z" },
    ],
    events: [
      { at: "2026-10-18T13:00:00.000Z", delta: 0.32, closeness: 3.55, reason: "聊到了一些更深的东西" },
    ],
    her_view: {
      current: "你是个会记住细节的人。",
      previous: null,
      updated_at: "2026-10-18T13:00:00.000Z",
      updated_closeness: 3.55,
    },
    emotion: { vector: 0.25, baseline: 0.08, arousal: 0.3, label: "愉悦" },
    guilt: { guilt: 0.04, resentment: 0.01 },
    drift: { actual: 0.08, perceived: 0.02, pressure: 0.12, gap: 0.06, alert: "她还没完全察觉" },
    narrative: {
      stage: "noticing",
      stage_label: "觉察",
      hint: "她开始注意到自己有点不一样",
      direction: "positive",
      direction_label: "往好的方向走",
      narrative: "最近好像心情好一点了……",
    },
  };
}

function healthFixture(): HealthData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    health: {
      ok: true,
      uptime_seconds: 65,
      version: "0.1.0",
      ws_connections: 2,
      db_ok: true,
      pending_replies: 1,
      cost_today: 0.001,
      last_error: null,
    },
  };
}

function costFixture(): CostData {
  const empty = {
    calls: 0,
    cost_cny: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
  };
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    today: { date: "2026-10-19", calls: 3, cost_cny: 0.001, prompt_tokens: 3000, completion_tokens: 500, cached_tokens: 1200, reasoning_tokens: 0 },
    week: {
      generated_at: "2026-10-19T12:00:00.000Z",
      window_days: 7,
      total: { calls: 3, cost_cny: 0.001, prompt_tokens: 3000, completion_tokens: 500, cached_tokens: 1200, reasoning_tokens: 0 },
      by_day: [
        { date: "2026-10-13", ...empty },
        { date: "2026-10-14", ...empty },
        { date: "2026-10-15", ...empty },
        { date: "2026-10-16", ...empty },
        { date: "2026-10-17", ...empty },
        { date: "2026-10-18", ...empty },
        { date: "2026-10-19", calls: 3, cost_cny: 0.001, prompt_tokens: 3000, completion_tokens: 500, cached_tokens: 1200, reasoning_tokens: 0 },
      ],
      by_model: [{ model: "deepseek-flash", calls: 3, cost_cny: 0.001 }],
      by_kind: [
        { kind: "chat", calls: 2, cost_cny: 0.0008 },
        { kind: "fact_extraction", calls: 1, cost_cny: 0.0002 },
      ],
    },
  };
}

function factsFixture(): UserFactsData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    owner: "qq:2889386774",
    count: 2,
    items: [
      { key: "name", value: "林哲", category: "profile", updatedAt: "2026-10-19T10:00:00.000Z" },
      { key: "pet", value: "一只叫团子的猫", category: "pet", updatedAt: "2026-10-18T09:00:00.000Z" },
    ],
    categories: { profile: 1, pet: 1 },
  };
}

function probeFixture(): MemoryHitProbeData {
  return {
    ok: true,
    generated_at: "2026-10-19T12:00:00.000Z",
    persona: { id: "xiaoya", name: "小雅" },
    query: "下雨天",
    limit: 8,
    hits: [
      {
        id: 2,
        content: "[对话] 用户: 用户说喜欢下雨天 | 回复: 嗯，我也喜欢下雨。",
        relevance: 0.82,
        confidence: "high",
        confidence_label: "高相关",
        source: "chat",
        source_label: "对话",
        created_at: "2026-10-16T12:00:00.000Z",
        time_label: "3天前",
      },
    ],
  };
}

function renderFixture(overrides: Partial<Parameters<typeof renderDashboard>[0]> = {}): string {
  const base = {
    overview: overviewFixture(),
    session: sessionFixture(),
    memory: memoryFixture(),
    facts: factsFixture(),
    probe: probeFixture(),
    timeline: timelineFixture(),
    health: healthFixture(),
    cost: costFixture(),
  };
  return renderDashboard({ ...base, ...overrides });
}

describe("escapeHtml / escapeJsonForScript", () => {
  it("转义 < > & 引号，阻断脚本注入", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#39;c&#39;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(123)).toBe("123");
  });

  it("内联 JSON 不含能提前闭合 script 的字符", () => {
    const json = escapeJsonForScript({ name: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("</script>");
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    // 仍是合法 JSON
    expect(JSON.parse(json) as { name: string }).toEqual({
      name: "</script><script>alert(1)</script>",
    });
  });
});

describe("renderDashboard 首屏", () => {
  it("包含四视图、内联样式/脚本、自动刷新与暂停按钮", () => {
    const html = renderFixture();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    for (const id of ["panel-chat", "panel-memory", "panel-timeline", "panel-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const text of ["聊天", "记忆", "关系", "状态", "暂停刷新", "127.0.0.1"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain("5000");
    // 只内联脚本，不引外域资源
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("<link ");
  });

  it("四视图的数据都渲染进首屏（聊天/记忆/关系/状态）", () => {
    const html = renderFixture();
    expect(html).toContain("你好呀");
    expect(html).toContain("今天下雨了");
    expect(html).toContain("你是个会记住细节的人");
    expect(html).toContain("开始熟络起来");
    expect(html).toContain("聊到了一些更深的东西");
    expect(html).toContain("觉察");
    expect(html).toContain("deepseek-flash");
  });

  it("用户事实按 category 分组展示 key/value/updated_at", () => {
    const html = renderFixture();
    expect(html).toContain('id="facts-card"');
    expect(html).toContain("用户事实");
    expect(html).toContain("基本信息");
    expect(html).toContain("宠物");
    expect(html).toContain("name");
    expect(html).toContain("林哲");
    expect(html).toContain("一只叫团子的猫");
    expect(html).toContain("qq:2889386774");
    // 事实卡片放在记忆区上方，命中回放在记忆列表下方
    expect(html.indexOf('id="facts-card"')).toBeLessThan(html.indexOf('id="memory-form"'));
    expect(html.indexOf('id="memory-list"')).toBeLessThan(html.indexOf('id="memory-probe-card"'));
  });

  it("记忆命中回放展示 content 截断、confidence 徽标与 relevance 进度条", () => {
    const probe = probeFixture();
    const longContent = `下雨天的对话 ${"很长的记忆内容".repeat(30)}`;
    probe.hits[0].content = longContent;
    probe.hits[0].relevance = 0.82;
    const html = renderFixture({ probe });

    expect(html).toContain('id="memory-probe-card"');
    expect(html).toContain("记忆命中回放");
    expect(html).toContain('id="probe-form"');
    expect(html).toContain('id="probe-query"');
    expect(html).toContain('value="下雨天"');
    expect(html).toContain("高相关");
    expect(html).toContain("3天前");
    expect(html).toContain("相关度 82%");
    expect(html).toContain("width:82%");
    // content 截断显示（完整内容不出现，只保留前 159 字 + 省略号）
    expect(html).not.toContain(longContent);
    expect(html).toContain(`${longContent.slice(0, 159)}…`);
    expect(html).toContain("回放「下雨天」命中 1 条");
  });

  it("用户内容全部 HTML 转义（XSS）", () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const session = sessionFixture();
    session.messages[0].content = payload;
    const memory = memoryFixture();
    memory.items[0].content = payload;
    const facts = factsFixture();
    facts.items[1].value = payload;
    const probe = probeFixture();
    probe.hits[0].content = payload;
    const timeline = timelineFixture();
    timeline.her_view.current = payload;
    const overview = overviewFixture();
    overview.persona.name = payload;
    const html = renderFixture({ session, memory, facts, probe, timeline, overview });
    expect(html).not.toContain(payload);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // 事实与命中回放两个新面板同样转义（出现至少两次：事实 value + 回放 content）
    const escaped = html.split("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;").length - 1;
    expect(escaped).toBeGreaterThanOrEqual(4);
  });

  it("内联脚本语法有效（防止字符串转义破坏页面 JS）", () => {
    const html = renderFixture();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts.length).toBe(2);
    for (const script of scripts) {
      // 只编译不执行：语法错误会抛 SyntaxError
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("空数据（无会话/无记忆/无事实/无命中/无状态）不崩且有友好提示", () => {
    const session = sessionFixture();
    session.messages = [];
    session.total = 0;
    const memory = memoryFixture();
    memory.items = [];
    memory.total = 0;
    const facts = factsFixture();
    facts.items = [];
    facts.count = 0;
    facts.categories = {};
    const probe = probeFixture();
    probe.hits = [];
    const timeline = timelineFixture();
    timeline.has_state = false;
    timeline.state_saved_at = null;
    timeline.milestones = [];
    timeline.events = [];
    timeline.her_view = { current: null, previous: null, updated_at: null, updated_closeness: null };
    timeline.emotion = null;
    timeline.guilt = null;
    timeline.drift = null;
    timeline.narrative = null;
    const html = renderFixture({ session, memory, facts, probe, timeline });
    expect(html).toContain("还没有聊天记录");
    expect(html).toContain("还没有记忆");
    expect(html).toContain("还没有关于你的用户事实");
    expect(html).toContain("没有命中任何记忆");
    expect(html).toContain("她还没把对你的看法写下来");
    expect(html).toContain("还没有里程碑");
    expect(html).toContain("还没有演化状态");
  });
});

describe("成本按用途展示", () => {
  it("最近 7 天成本卡片展示「按用途」中文标签", () => {
    const html = renderFixture();
    expect(html).toContain("按用途");
    expect(html).toContain("事实抽取");
  });
});

describe("多用户只读切换", () => {
  it("页面含 owner 选择器与 /api/owners 拉取逻辑", () => {
    const html = renderFixture();
    expect(html).toContain('id="owner-select"');
    expect(html).toContain("/api/owners");
    expect(html).toContain("renderOwners");
    expect(html).toContain("owner=");
  });
});

describe("多用户导出按钮", () => {
  it("页面含导出当前用户按钮与 /api/export 逻辑", () => {
    const html = renderFixture();
    expect(html).toContain('id="export-owner"');
    expect(html).toContain("/api/export");
  });
});
