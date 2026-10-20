/**
 * Web 控制台服务端测试（步骤 5）。
 *
 * 使用 KAREN_DATA_DIR 临时目录 + 随机空闲端口，通过真实 HTTP 请求断言：
 * 鉴权（401 / token query+header）、页面 200 DOM（含用户事实/记忆回放卡片）、
 * 8 个 API 字段（overview/session/memory/facts/memory-probe/timeline/health/cost）、
 * 404/405、q/owner 参数校验、CSP 等安全头、127.0.0.1 绑定、端口 0/冲突容错；
 * 以及 data helpers 的 JSON 结构。
 * 全程不联网（无 Qwen Key 时检索自动走本地 n-gram + FTS5），不触碰仓库根 data/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let handles: Array<{ stop(): void; server: http.Server }> = [];
let vectorModule: typeof import("../data/vector.js") | null = null;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-web-"));
  process.env.KAREN_DATA_DIR = dir;
  // 无 Key：检索自动走本地 n-gram + FTS5，测试不联网
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.WEB_PORT;
  delete process.env.WEB_TOKEN;
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  vi.resetModules();
  handles = [];
  vectorModule = null;
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  for (const handle of handles) {
    try {
      handle.stop();
    } catch {
      // ignore
    }
  }
  handles = [];
  try {
    vectorModule?.closeVectorDb();
  } catch {
    // ignore
  }
  vectorModule = null;
  delete process.env.KAREN_DATA_DIR;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.WEB_PORT;
  delete process.env.WEB_TOKEN;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── 工具 ────────────────────────────────────────

async function loadCore() {
  const server = await import("./server.js");
  const data = await import("./data.js");
  const vector = await import("../data/vector.js");
  const history = await import("../data/history.js");
  const stateStore = await import("../data/state-store.js");
  const cost = await import("../obs/cost-tracker.js");
  const relationship = await import("../persona/relationship.js");
  const retriever = await import("../data/retriever.js");
  const userFacts = await import("../data/user-facts.js");
  const logger = await import("../obs/logger.js");
  vectorModule = vector;
  return { server, data, vector, history, stateStore, cost, relationship, retriever, userFacts, logger };
}

type Core = Awaited<ReturnType<typeof loadCore>>;

/** 构造一份有数据的环境：2 条会话（含 XSS payload）+ 2 条 T2 + 关系状态 + 成本记录。 */
function seed(core: Core): void {
  core.vector.setCurrentPersona("xiaoya");

  // T2：一条对话（可被「下雨」检索命中）+ 一条事件
  core.retriever.storeConversationEpisode("用户说喜欢下雨天", "嗯，我也喜欢下雨。", 0.3);
  core.vector.insertEpisode("用户说今天加班到很晚", "event", 0.2);

  // 会话（含 XSS payload，用于断言页面转义）
  const session = core.history.loadSession("小雅");
  core.history.addMessage(session, "user", `你好呀 <script>alert(1)</script>`);
  core.history.addMessage(session, "assistant", "嗯，在呢。");

  // 持久化人格状态：亲密度 3 → 3.55（跨过 3.5 里程碑）+ herView + 叙事/情绪
  const state = core.stateStore.createPersistedPersonaState("小雅", 3);
  state.relationship = core.relationship.applyRelationshipEvent(
    state.relationship,
    0.55,
    "聊到了一些更深的东西",
    new Date("2026-10-18T13:00:00Z"),
  );
  state.herView = {
    current: "你是个会记住细节的人。",
    previous: null,
    lastUpdateCloseness: 3.55,
    lastUpdateAt: Date.now(),
  };
  state.narrativeArc = {
    ...state.narrativeArc,
    stage: "noticing",
    direction: "positive",
    currentNarrative: "最近好像心情好一点了……",
    lastAdvance: Date.now(),
  };
  state.emotion = { vector: 0.25, baseline: 0.08, arousal: 0.3, lastUpdated: Date.now() };
  state.drift = {
    actualBaseline: 0.08,
    perceivedBaseline: 0.02,
    pressure: 0.12,
    lastAwareness: Date.now(),
    history: [],
  };
  core.stateStore.savePersonaState(state);

  // 成本记录（今日）
  core.cost.recordLlmUsage({
    model: "deepseek-flash",
    promptTokens: 1000,
    completionTokens: 500,
    cachedTokens: 300,
  });

  // 用户事实（主用户 qq:2889386774；用于 /api/facts 与页面用户事实卡片）
  core.userFacts.upsertUserFacts(core.data.DEFAULT_FACTS_OWNER, [
    { key: "name", value: "林哲", category: "profile" },
    { key: "pet", value: "一只叫团子的猫", category: "pet" },
  ]);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitListening(server: http.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function startServer(
  core: Core,
  options: { token?: string } = {},
): Promise<{ handle: { port: number | null; server: http.Server; stop(): void }; port: number }> {
  const port = await getFreePort();
  const handle = core.server.startWebServer({
    port,
    token: options.token,
    personaId: "xiaoya",
    personaName: "小雅",
    initialCloseness: 3,
    getWsConnections: () => 2,
    getPendingReplies: () => 1,
    startedAt: Date.now() - 65_000,
  });
  expect(handle).not.toBeNull();
  handles.push(handle!);
  await waitListening(handle!.server);
  return { handle: handle!, port: handle!.port ?? port };
}

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown> | null;
}

async function request(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function getJson(port: number, pathname: string, init?: RequestInit) {
  const result = await request(port, pathname, init);
  return { ...result, json: result.json as Record<string, never> };
}

// ── 数据层 ──────────────────────────────────────

describe("data helpers（临时数据目录）", () => {
  it("从 state/session/记忆/成本读取并返回结构化 JSON", async () => {
    const core = await loadCore();
    seed(core);
    const override = { id: "xiaoya", name: "小雅" };

    const session = core.data.getSessionData(10, override);
    expect(session.ok).toBe(true);
    expect(session.total).toBe(2);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const memory = core.data.getRecentMemories(30, override);
    expect(memory.total).toBeGreaterThanOrEqual(2);
    expect(memory.items.length).toBeGreaterThanOrEqual(2);
    expect(memory.items[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof memory.items[0].source_label).toBe("string");
    // 内部英文枚举不直接当标签暴露
    expect(memory.items[0].source_label).not.toBe(memory.items[0].source);

    const timeline = core.data.getTimeline(override, 3);
    expect(timeline.has_state).toBe(true);
    expect(timeline.closeness).toBeCloseTo(3.55, 2);
    expect(timeline.label).toBe("开始熟络");
    expect(timeline.milestones.length).toBe(1);
    expect(timeline.events.length).toBe(1);
    expect(timeline.her_view.current).toContain("会记住细节");
    expect(timeline.emotion?.label).toBe("愉悦");
    expect(timeline.narrative?.stage_label).toBe("觉察");

    const health = core.data.getHealthData({ getWsConnections: () => 2, getPendingReplies: () => 1 });
    expect(health.health.db_ok).toBe(true);
    expect(health.health.ws_connections).toBe(2);
    expect(health.health.pending_replies).toBe(1);

    const cost = core.data.getCostData(7);
    expect(cost.today.calls).toBeGreaterThanOrEqual(1);
    expect(cost.week.by_day).toHaveLength(7);

    const overview = core.data.getOverview(override, {
      initialCloseness: 3,
      health: { getWsConnections: () => 2, getPendingReplies: () => 1 },
    });
    expect(overview.persona).toEqual({ id: "xiaoya", name: "小雅" });
    expect(overview.session.messages).toBe(2);
    expect(overview.relationship.closeness).toBeCloseTo(3.55, 2);
  });
});

// ── 页面 + 安全头 ───────────────────────────────

describe("页面与安全头", () => {
  it("GET / 返回 200 单页（四视图 DOM），并带 CSP / no-store / nosniff", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);

    const page = await request(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    for (const id of [
      "panel-chat",
      "panel-memory",
      "panel-timeline",
      "panel-status",
      "facts-card",
      "memory-probe-card",
    ]) {
      expect(page.text).toContain(`id="${id}"`);
    }
    for (const text of ["聊天", "记忆", "关系", "状态", "暂停刷新", "自动刷新", "用户事实", "记忆命中回放", "林哲"]) {
      expect(page.text).toContain(text);
    }
    // 首屏回放用示例 query（下雨天）服务端预渲染了命中项（相关度只出现在回放卡片）
    expect(page.text).toContain("回放「下雨天」");
    expect(page.text).toContain("相关度");

    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("http://");
    expect(csp).not.toContain("https://");
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    // 页面不引外域脚本/样式
    expect(page.text).not.toContain("<script src=");
    expect(page.text).not.toContain("<link ");
  });

  it("用户内容在页面上被 HTML 转义（XSS）", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const page = await request(port, "/");

    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.text).toContain("你好呀");
  });

  it("宣传页 /promo/ 返回 200（含角色素材），/promo 做 308 跳转，路径穿越被拒", async () => {
    const core = await loadCore();
    const { port } = await startServer(core);

    const redirect = await request(port, "/promo", { redirect: "manual" });
    expect(redirect.status).toBe(308);

    const page = await request(port, "/promo/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("KAREN");
    expect(page.text).toContain("CONFIG");

    const svg = await request(port, "/promo/assets/character.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg");

    const traversal = await request(port, "/promo/assets/../../.env");
    expect(traversal.status).toBe(404);
  });

  it("只绑定 127.0.0.1", async () => {
    const core = await loadCore();
    const { handle } = await startServer(core);
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    expect((address as net.AddressInfo).address).toBe("127.0.0.1");
  });

  it("port=0 / 非法端口返回 null，不抛错", async () => {
    const core = await loadCore();
    expect(core.server.startWebServer({ port: 0 })).toBeNull();
    expect(() => core.server.startWebServer({ port: 99999 })).not.toThrow();
    expect(core.server.startWebServer({ port: 99999 })).toBeNull();
    expect(core.server.startWebServer({ port: Number.NaN })).toBeNull();
  });

  it("端口冲突只记 web.server_error，主进程不崩", async () => {
    const core = await loadCore();
    const { port } = await startServer(core);
    let second: ReturnType<typeof core.server.startWebServer> = null;
    expect(() => {
      second = core.server.startWebServer({ port });
    }).not.toThrow();
    if (second) handles.push(second);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(String(core.logger.getLastError())).toContain("web.server_error");
  });

  it("stop() 幂等，关闭后连接被拒绝", async () => {
    const core = await loadCore();
    const { handle, port } = await startServer(core);
    const closed = new Promise<void>((resolve) => handle.server.once("close", () => resolve()));
    handle.stop();
    handle.stop();
    await closed;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

// ── API ─────────────────────────────────────────

describe("API", () => {
  it("/api/overview 返回人设、会话/记忆计数、关系、健康与今日成本", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(port, "/api/overview");

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.persona).toEqual({ id: "xiaoya", name: "小雅" });
    expect((json.session as Record<string, number>).messages).toBe(2);
    expect((json.memory as Record<string, number>).total).toBeGreaterThanOrEqual(2);
    expect((json.relationship as Record<string, unknown>).closeness).toBeCloseTo(3.55, 2);
    expect((json.relationship as Record<string, unknown>).label).toBe("开始熟络");
    expect((json.health as Record<string, unknown>).db_ok).toBe(true);
    expect(((json.cost_today as Record<string, unknown>).calls as number)).toBeGreaterThanOrEqual(1);
    expect(typeof json.generated_at).toBe("string");
    // 不返回任何 token / Key / 环境变量
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("api_key");
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain("TOKEN");
  });

  it("/api/session 支持 limit 且返回最近消息", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);

    const one = await getJson(port, "/api/session?limit=1");
    expect(one.status).toBe(200);
    expect((one.json.messages as unknown[]).length).toBe(1);
    expect(one.json.total).toBe(2);
    const messages = one.json.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("assistant");

    // 非法/超大 limit 走安全默认与上限
    const fallback = await getJson(port, "/api/session?limit=abc");
    expect((fallback.json.messages as unknown[]).length).toBe(2);
    const capped = await getJson(port, "/api/session?limit=9999");
    expect(capped.json.limit).toBe(100);
  });

  it("/api/memory 返回最近 T2（来源中文标签 / ISO 时间）", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(port, "/api/memory?limit=30");

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.total as number)).toBeGreaterThanOrEqual(2);
    const items = json.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(typeof items[0].source_label).toBe("string");
    expect(String(items[0].created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof items[0].strength).toBe("number");
  });

  it("/api/memory?query= 复用混合检索并返回 relevance/confidence", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(
      port,
      `/api/memory?query=${encodeURIComponent("下雨")}&limit=10`,
    );

    expect(status).toBe(200);
    expect(json.mode).toBe("search");
    expect(json.query).toBe("下雨");
    const items = json.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => String(item.content).includes("下雨"))).toBe(true);
    for (const item of items) {
      expect(typeof item.relevance).toBe("number");
      expect(Number(item.relevance)).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(item.confidence);
      expect(typeof item.confidence_label).toBe("string");
    }
  });

  it("/api/facts 返回主用户事实（分类计数、ISO 时间），支持按 owner 隔离", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);

    const { status, json } = await getJson(port, "/api/facts");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.owner).toBe("qq:2889386774");
    expect(json.count).toBe(2);
    expect(json.categories).toEqual({ profile: 1, pet: 1 });
    const items = json.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    expect(items.map((item) => item.key)).toEqual(["name", "pet"]);
    expect(items[0].value).toBe("林哲");
    expect(String(items[0].updatedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 其他好友：同一张表按 owner 隔离，读不到主用户事实
    const other = await getJson(port, "/api/facts?owner=qq:10001");
    expect(other.status).toBe(200);
    expect(other.json.count).toBe(0);
    expect(other.json.items).toEqual([]);

    // 非法 owner → 400 JSON，不泄漏堆栈
    const invalid = await getJson(port, "/api/facts?owner=not-an-owner");
    expect(invalid.status).toBe(400);
    expect(invalid.json).toEqual({ ok: false, error: "invalid_owner" });
    expect(invalid.text).not.toContain("at ");
    expect(invalid.text).not.toContain("SQLITE");
  });

  it("/api/memory-probe 返回命中内容/相关度/置信度/来源", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(
      port,
      `/api/memory-probe?q=${encodeURIComponent("下雨")}&limit=5`,
    );

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.query).toBe("下雨");
    expect(json.limit).toBe(5);
    const hits = json.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((hit) => String(hit.content).includes("下雨"))).toBe(true);
    for (const hit of hits) {
      expect(typeof hit.id).toBe("number");
      expect(typeof hit.relevance).toBe("number");
      expect(Number(hit.relevance)).toBeGreaterThan(0);
      expect(Number(hit.relevance)).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(hit.confidence);
      expect(typeof hit.confidence_label).toBe("string");
      expect(typeof hit.source_label).toBe("string");
    }

    // limit 走 normalizeLimit：20 封顶
    const capped = await getJson(port, `/api/memory-probe?q=${encodeURIComponent("下雨")}&limit=999`);
    expect(capped.json.limit).toBe(20);
  });

  it("/api/memory-probe 缺 q / 空白 / 超长都返回 400 JSON（不泄漏堆栈）", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);

    const missing = await getJson(port, "/api/memory-probe");
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ ok: false, error: "invalid_query" });

    const blank = await getJson(port, "/api/memory-probe?q=%20%20%20");
    expect(blank.status).toBe(400);
    expect(blank.json).toEqual({ ok: false, error: "invalid_query" });

    const tooLong = await getJson(
      port,
      `/api/memory-probe?q=${encodeURIComponent("下".repeat(201))}`,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.json).toEqual({ ok: false, error: "invalid_query" });
    for (const result of [missing, blank, tooLong]) {
      expect(result.text).not.toContain("at ");
      expect(result.text).not.toContain("SQLITE");
      expect(result.text).not.toContain("Error");
    }

    // 边界 200 字可以正常回放
    const boundary = await getJson(
      port,
      `/api/memory-probe?q=${encodeURIComponent("下".repeat(200))}`,
    );
    expect(boundary.status).toBe(200);
    expect((boundary.json.hits as unknown[]).length).toBeGreaterThanOrEqual(0);
  });

  it("/api/timeline 返回亲密度/标签/里程碑/事件/herView/情绪/漂移/叙事", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(port, "/api/timeline");

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.closeness).toBeCloseTo(3.55, 2);
    expect(json.label).toBe("开始熟络");
    expect(json.has_state).toBe(true);
    expect((json.milestones as unknown[]).length).toBe(1);
    expect((json.events as unknown[]).length).toBe(1);
    expect((json.her_view as Record<string, unknown>).current).toContain("会记住细节");
    expect((json.emotion as Record<string, unknown>).label).toBe("愉悦");
    expect((json.drift as Record<string, unknown>).alert).toBe("她还没完全察觉");
    expect((json.narrative as Record<string, unknown>).stage_label).toBe("觉察");
    // 内部英文枚举不直接暴露给 UI 标签
    expect((json.narrative as Record<string, unknown>).stage_label).not.toBe(
      (json.narrative as Record<string, unknown>).stage,
    );
  });

  it("/api/health 复用 DB/WS/队列数据", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(port, "/api/health");

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const health = json.health as Record<string, unknown>;
    expect(health.db_ok).toBe(true);
    expect(health.ws_connections).toBe(2);
    expect(health.pending_replies).toBe(1);
    expect(Number(health.uptime_seconds)).toBeGreaterThanOrEqual(65);
    expect(typeof health.version).toBe("string");
    expect(health.last_error).toBeNull();
  });

  it("/api/cost 返回今日 + 最近 7 天成本", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core);
    const { status, json } = await getJson(port, "/api/cost");

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const today = json.today as Record<string, unknown>;
    expect(today.calls).toBeGreaterThanOrEqual(1);
    expect(typeof today.cost_cny).toBe("number");
    const week = json.week as Record<string, unknown>;
    expect(week.window_days).toBe(7);
    expect((week.by_day as unknown[]).length).toBe(7);
    expect(Array.isArray(week.by_model)).toBe(true);
  });

  it("未知路径 404、非 GET 405，错误统一 {ok:false,error}", async () => {
    const core = await loadCore();
    const { port } = await startServer(core);

    const notFound = await getJson(port, "/nope");
    expect(notFound.status).toBe(404);
    expect(notFound.json).toEqual({ ok: false, error: "not_found" });

    const apiNotFound = await getJson(port, "/api/nope");
    expect(apiNotFound.status).toBe(404);

    const post = await request(port, "/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.json).toEqual({ ok: false, error: "method_not_allowed" });
  });
});

// ── token 鉴权 ──────────────────────────────────

describe("web_token 鉴权", () => {
  const TOKEN = "local-web-token-123";

  it("未授权 401；query 与 header 两种方式都生效；页面不泄露 token", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await startServer(core, { token: TOKEN });

    const unauthorizedPage = await request(port, "/");
    expect(unauthorizedPage.status).toBe(401);
    expect(unauthorizedPage.json).toEqual({ ok: false, error: "unauthorized" });

    const unauthorizedApi = await request(port, "/api/overview");
    expect(unauthorizedApi.status).toBe(401);

    const wrongToken = await request(port, `/api/overview?token=wrong-token`);
    expect(wrongToken.status).toBe(401);

    const byQuery = await request(port, `/?token=${TOKEN}`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.text).toContain("panel-chat");
    // token 不写进页面内容（页面 JS 从 location.search 读取）
    expect(byQuery.text).not.toContain(TOKEN);

    const byHeader = await request(port, "/api/overview", {
      headers: { "X-Web-Token": TOKEN },
    });
    expect(byHeader.status).toBe(200);
    expect(byHeader.json?.ok).toBe(true);

    const apiByQuery = await request(port, `/api/timeline?token=${TOKEN}`);
    expect(apiByQuery.status).toBe(200);
  });
});

// ── 配置 ────────────────────────────────────────

describe("配置 web_port / web_token", () => {
  it("默认 18082 且无 token；支持自定义；0 = 关闭", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-web-config-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(configDir);
    const writeConfig = (content: string): void => {
      fs.writeFileSync(path.join(configDir, "config.yaml"), content, "utf-8");
    };
    try {
      writeConfig("persona: xiaoya\n");
      vi.resetModules();
      let store = await import("../data/store.js");
      let config = store.loadConfig();
      expect(config.web_port).toBe(18082);
      expect(config.web_token).toBeUndefined();
      expect(store.DEFAULT_WEB_PORT).toBe(18082);

      writeConfig('persona: xiaoya\nweb_port: 19090\nweb_token: "local-token-abc"\n');
      vi.resetModules();
      store = await import("../data/store.js");
      config = store.loadConfig();
      expect(config.web_port).toBe(19090);
      expect(config.web_token).toBe("local-token-abc");

      writeConfig("persona: xiaoya\nweb_port: 0\n");
      vi.resetModules();
      store = await import("../data/store.js");
      expect(store.loadConfig().web_port).toBe(0);
    } finally {
      cwdSpy.mockRestore();
      vi.resetModules();
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
