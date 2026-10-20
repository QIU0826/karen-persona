/**
 * Web 控制台数据层扩展测试：用户事实（只读 user_facts）与记忆命中回放（同步检索）。
 *
 * 每个用例使用 KAREN_DATA_DIR 临时目录 + vi.resetModules()，不触碰仓库根 data/，
 * 无 Qwen Key（检索走本地 n-gram + FTS5），全程不联网。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let vectorModule: typeof import("../data/vector.js") | null = null;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-web-data-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  vi.resetModules();
  vectorModule = null;
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
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
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function loadCore() {
  const data = await import("./data.js");
  const vector = await import("../data/vector.js");
  const userFacts = await import("../data/user-facts.js");
  const retriever = await import("../data/retriever.js");
  vectorModule = vector;
  return { data, vector, userFacts, retriever };
}

type Core = Awaited<ReturnType<typeof loadCore>>;

/** 判断 sqlite_master 里是否已有 user_facts 表。 */
function hasFactsTable(core: Core): boolean {
  return Boolean(
    core.vector
      .getVectorDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_facts'")
      .get(),
  );
}

describe("getUserFactsData（只读 user_facts）", () => {
  it("表不存在时返回空结构，且不会建表（保持只读边界）", async () => {
    const core = await loadCore();
    const facts = core.data.getUserFactsData();

    expect(facts.ok).toBe(true);
    expect(facts.owner).toBe(core.data.DEFAULT_FACTS_OWNER);
    expect(facts.count).toBe(0);
    expect(facts.items).toEqual([]);
    expect(facts.categories).toEqual({});
    expect(typeof facts.generated_at).toBe("string");
    // 关键：控制台查询不能创建 user_facts 表（写入留给事实抽取层）
    expect(hasFactsTable(core)).toBe(false);
  });

  it("按 owner 读取事实、分类计数并返回 ISO 时间", async () => {
    const core = await loadCore();
    const owner = core.data.DEFAULT_FACTS_OWNER;
    core.userFacts.upsertUserFacts(owner, [
      { key: "name", value: "林哲", category: "profile" },
      { key: "job", value: "做后端的", category: "work" },
      { key: "pet", value: "一只叫团子的猫", category: "pet" },
    ]);

    const facts = core.data.getUserFactsData(owner);
    expect(facts.count).toBe(3);
    expect(facts.owner).toBe(owner);
    expect(facts.categories).toEqual({ profile: 1, work: 1, pet: 1 });
    expect(facts.items.map((item) => item.key)).toEqual(["name", "job", "pet"]);
    for (const item of facts.items) {
      expect(typeof item.value).toBe("string");
      expect(typeof item.category).toBe("string");
      expect(String(item.updatedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }

    // 其他 owner 天然隔离
    const other = core.data.getUserFactsData("qq:10001");
    expect(other.count).toBe(0);
    expect(other.items).toEqual([]);
  });

  it("空 owner 回退主用户，未知分类归入其他", async () => {
    const core = await loadCore();
    const owner = core.data.DEFAULT_FACTS_OWNER;
    core.vector.getVectorDb().exec(`
      CREATE TABLE IF NOT EXISTS user_facts (
        owner_id TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, fact_key)
      );
    `);
    core.vector
      .getVectorDb()
      .prepare(
        "INSERT INTO user_facts (owner_id, fact_key, fact_value, category, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(owner, "weird", "旧版本写入的未知分类", "legacy_category", Date.now());

    const facts = core.data.getUserFactsData("   ");
    expect(facts.owner).toBe(owner);
    expect(facts.items[0].category).toBe("other");
    expect(facts.categories).toEqual({ other: 1 });
  });
});

describe("getMemoryHitProbe（同步检索回放）", () => {
  it("命中记忆时返回内容/相关度/置信度/来源标签", async () => {
    const core = await loadCore();
    core.vector.setCurrentPersona("xiaoya");
    core.retriever.storeConversationEpisode("用户说喜欢下雨天", "嗯，我也喜欢下雨。", 0.3);

    const probe = core.data.getMemoryHitProbe("下雨", 8, { id: "xiaoya", name: "小雅" });
    expect(probe.ok).toBe(true);
    expect(probe.query).toBe("下雨");
    expect(probe.limit).toBe(8);
    expect(probe.persona).toEqual({ id: "xiaoya", name: "小雅" });
    expect(probe.hits.length).toBeGreaterThanOrEqual(1);

    const hit = probe.hits[0];
    expect(hit.content).toContain("下雨");
    expect(hit.relevance).toBeGreaterThan(0);
    expect(hit.relevance).toBeLessThanOrEqual(1);
    expect(["high", "medium", "low"]).toContain(hit.confidence);
    expect(typeof hit.confidence_label).toBe("string");
    expect(hit.source).toBe("chat");
    expect(hit.source_label).toBe("对话");
  });

  it("无命中时返回空列表；空 query 不触发检索", async () => {
    const core = await loadCore();
    core.vector.setCurrentPersona("xiaoya");
    core.retriever.storeConversationEpisode("今天加班到很晚", "辛苦了。", 0);

    const noHit = core.data.getMemoryHitProbe("量子纠缠光谱仪", 8, {
      id: "xiaoya",
      name: "小雅",
    });
    expect(noHit.hits).toEqual([]);

    const empty = core.data.getMemoryHitProbe("   ", 8, { id: "xiaoya", name: "小雅" });
    expect(empty.query).toBe("");
    expect(empty.hits).toEqual([]);
  });

  it("limit 走 normalizeLimit 夹在 1..20，默认 8；query 截断到 200 字", async () => {
    const core = await loadCore();
    core.vector.setCurrentPersona("xiaoya");

    expect(core.data.getMemoryHitProbe("下雨", 8).limit).toBe(8);
    expect(core.data.getMemoryHitProbe("下雨", 0).limit).toBe(1);
    expect(core.data.getMemoryHitProbe("下雨", 999).limit).toBe(20);
    expect(core.data.getMemoryHitProbe("下雨", Number.NaN).limit).toBe(8);

    const long = core.data.getMemoryHitProbe("下".repeat(260), 8);
    expect(long.query.length).toBe(200);
  });
});
