/**
 * M1-7 混合检索测试：FTS5 中文 BM25 + n-gram/语义双路 RRF + sqlite-vec 同步。
 *
 * 无 Qwen Key 环境：同步混合检索全部真实验证。
 * 语义路径：用 `vi.stubGlobal("fetch", ...)` mock Qwen embedding API，不联网；
 * ⚠️ 真实语义质量/真实 API 行为需配置 QWEN Key 后才能验证。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEmbedding } from "./embedding.js";

const QWEN_MODEL = "qwen-text-embedding-v3";
const NGRAM_MODEL = "ngram-v1";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-retrieval-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** 测试用确定性「语义」向量：按字符哈希累加后归一化（共享字符越多越相似）。 */
function fakeSemanticVector(text: string): number[] {
  const dim = 768;
  const vec = new Array(dim).fill(0) as number[];
  for (const ch of Array.from(text.replace(/\s+/g, ""))) {
    vec[(ch.codePointAt(0) ?? 0) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

function stubQwenEmbeddingApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
    return new Response(
      JSON.stringify({ data: [{ embedding: fakeSemanticVector(String(requestBody.input ?? "")) }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 动态加载同一模块图（vi.resetModules 后调用，保证 embedding/vector/retriever 共享实例）。 */
async function loadModules() {
  const embedding = await import("./embedding.js");
  const vector = await import("./vector.js");
  const retriever = await import("./retriever.js");
  return { embedding, vector, retriever };
}

// ── FTS5 中文 BM25 ─────────────────────────────

describe("FTS5 中文 BM25", () => {
  it("2 字词（咖啡/下雨/上海）与 ≥3 字词都能命中，BM25 把最相关排前", async () => {
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    const ids: Record<string, number> = {};
    for (const content of [
      "用户说最喜欢喝咖啡",
      "外面下雨了记得带伞",
      "下周要去上海出差，顺便见朋友",
    ]) {
      ids[content] = vector.insertEpisodeWithEmbedding(content, "chat", generateEmbedding(content));
    }

    // OR 语义下可能召回「部分字命中」的记忆，但 BM25 会把最相关的排第一
    expect(vector.searchEpisodesByFts("咖啡")[0]?.id).toBe(ids["用户说最喜欢喝咖啡"]);
    expect(vector.searchEpisodesByFts("下雨")[0]?.id).toBe(ids["外面下雨了记得带伞"]);
    expect(vector.searchEpisodesByFts("上海")[0]?.id).toBe(ids["下周要去上海出差，顺便见朋友"]);
    expect(vector.searchEpisodesByFts("上海出差")[0]?.id).toBe(ids["下周要去上海出差，顺便见朋友"]);
    // OR 语义：多一个不存在的字（豆）仍能通过 BM25 召回同主题的咖啡记忆
    expect(vector.searchEpisodesByFts("咖啡豆")[0]?.id).toBe(ids["用户说最喜欢喝咖啡"]);

    // 人设隔离
    vector.setCurrentPersona("秋瑶");
    expect(vector.searchEpisodesByFts("咖啡")).toHaveLength(0);
  });

  it("自然问句能召回相关记忆（旧 AND 语义下 FTS 命中为 0）", async () => {
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    const project = vector.insertEpisodeWithEmbedding(
      "我在做一个咖啡品牌包装项目，最近在改排版",
      "chat",
      generateEmbedding("我在做一个咖啡品牌包装项目，最近在改排版"),
    );
    vector.insertEpisodeWithEmbedding(
      "今天公司楼下新开了家面馆",
      "chat",
      generateEmbedding("今天公司楼下新开了家面馆"),
    );

    const hits = vector.searchEpisodesByFts("我最近那个咖啡包装项目做到哪了");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe(project);
  });

  it("deleteEpisode 同步删除 FTS 索引；source 过滤生效", async () => {
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    const keep = vector.insertEpisodeWithEmbedding("喜欢喝咖啡", "chat", generateEmbedding("喜欢喝咖啡"));
    const removed = vector.insertEpisodeWithEmbedding(
      "用户不喜欢咖啡",
      "chat",
      generateEmbedding("用户不喜欢咖啡")
    );
    const monologue = vector.insertEpisodeWithEmbedding(
      "[独白] 咖啡的香气让我想起他",
      "internal_monologue",
      generateEmbedding("[独白] 咖啡的香气让我想起他")
    );

    expect(vector.searchEpisodesByFts("咖啡")).toHaveLength(3);
    expect(vector.searchEpisodesByFts("咖啡", 10, { excludeSources: ["internal_monologue"] })).toHaveLength(2);

    expect(vector.deleteEpisode(removed)).toBe(true);
    const left = vector.searchEpisodesByFts("咖啡");
    expect(new Set(left.map((row) => row.id))).toEqual(new Set([keep, monologue]));
    const withoutMonologue = vector.searchEpisodesByFts("咖啡", 10, {
      excludeSources: ["internal_monologue"],
    });
    expect(withoutMonologue.map((row) => row.id)).toEqual([keep]);
    vector.closeVectorDb();
  });
});

// ── 同步混合检索（无 Qwen Key 的降级主路径）────────

describe("同步混合检索 retrieveRelevantMemories（无 Key）", () => {
  it("关键词/向量双路 RRF：相关记忆召回，source 过滤 + 内容去重", async () => {
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");

    const coffee = "用户说最喜欢喝咖啡，尤其是手冲咖啡";
    vector.insertEpisodeWithEmbedding(coffee, "chat", generateEmbedding(coffee), 0.3);
    // 重复内容（模拟重复写入）→ 结果去重为 1 条
    vector.insertEpisodeWithEmbedding(coffee, "chat", generateEmbedding(coffee), 0.3);
    const work = "今天在公司加班到很晚，有点累";
    vector.insertEpisodeWithEmbedding(work, "chat", generateEmbedding(work));
    // 内心独白：包含关键词但不应作为普通 RAG 记忆注入
    const monologue = "[独白] 咖啡的香气让我想起他";
    vector.insertEpisodeWithEmbedding(monologue, "internal_monologue", generateEmbedding(monologue), 0.5);

    const memories = retriever.retrieveRelevantMemories("咖啡");
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain("咖啡");
    expect(memories[0].content).not.toContain("独白");
    expect(memories[0].confidence).toBe("high");
    expect(memories[0].relevance).toBeGreaterThan(0);
    expect(memories[0].relevance).toBeLessThanOrEqual(1);
    expect(memories[0].strength).toBeGreaterThan(0.05);

    // 排序：向量 + 关键词双路命中优先于无关记忆（work 不应出现）
    expect(memories.some((m) => m.content === work)).toBe(false);
    vector.closeVectorDb();
  });

  it("显式 personaId 可跨人设只读检索（Web 控制台回放用）", async () => {
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    vector.insertEpisodeWithEmbedding(
      "用户说最喜欢喝咖啡，尤其是手冲咖啡",
      "chat",
      generateEmbedding("用户说最喜欢喝咖啡，尤其是手冲咖啡"),
    );
    // 切到另一个人设：默认检索查不到；显式 personaId 能查到
    vector.setCurrentPersona("秋瑶");
    expect(retriever.retrieveRelevantMemories("咖啡")).toEqual([]);
    const hits = retriever.retrieveRelevantMemories("咖啡", 5, { personaId: "小雅" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("咖啡");
    vector.closeVectorDb();
  });

  it("相似度阈值生效：完全无关查询返回空数组", async () => {
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    const coffee = "用户说最喜欢喝咖啡";
    vector.insertEpisodeWithEmbedding(coffee, "chat", generateEmbedding(coffee));

    expect(retriever.retrieveRelevantMemories("量子纠缠与引力波")).toEqual([]);
    vector.closeVectorDb();
  });

  it("confidence 用 relevance 而非仅 strength：衰减后的强相关记忆降为 medium", async () => {
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    const id = vector.insertEpisodeWithEmbedding(
      "用户说喜欢下雨天窝在家里",
      "chat",
      generateEmbedding("用户说喜欢下雨天窝在家里")
    );
    vector.updateStrength(id, 0.2);

    const memories = retriever.retrieveRelevantMemories("下雨");
    const hit = memories.find((m) => m.id === id);
    expect(hit).toBeDefined();
    // applyDecay 会按秒级 last_recalled_at 微衰减（0.2 * e^-ε），只断言近似值
    expect(hit!.strength).toBeGreaterThan(0.19);
    expect(hit!.strength).toBeLessThan(0.21);
    expect(hit!.confidence).toBe("medium");
    vector.closeVectorDb();
  });

  it("排序合理：关键词密度更高的记忆排在前面", async () => {
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    const strong = "咖啡咖啡咖啡，每天都要喝";
    const weak = "今天路过一家店，顺便买了咖啡";
    vector.insertEpisodeWithEmbedding(weak, "chat", generateEmbedding(weak));
    vector.insertEpisodeWithEmbedding(strong, "chat", generateEmbedding(strong));

    const memories = retriever.retrieveRelevantMemories("咖啡", 5);
    expect(memories.length).toBeGreaterThanOrEqual(2);
    expect(memories[0].content).toBe(strong);
    vector.closeVectorDb();
  });
});

// ── 异步语义混合检索（mock Qwen API）────────────

describe("异步语义检索 retrieveRelevantMemoriesAsync（mock Qwen）", () => {
  it("语义向量 + FTS 双路召回；同时落 legacy ngram 列与 semantic 列 + vec0", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");

    const coffeeId = await retriever.storeConversationEpisodeAsync(
      "昨天喝了手冲咖啡很开心",
      "我也喜欢咖啡的味道"
    );
    await retriever.storeConversationEpisodeAsync("外面下雨了记得带伞", "好的");

    // 双向量空间独立记录 model，绝不混写
    const db = vector.getVectorDb();
    const row = db
      .prepare(
        `SELECT embedding_model, semantic_model, embedding, semantic_embedding
         FROM t2_episodes WHERE id = ?`
      )
      .get(coffeeId) as {
      embedding_model: string;
      semantic_model: string;
      embedding: string;
      semantic_embedding: string;
    };
    expect(row.embedding_model).toBe(NGRAM_MODEL);
    expect(row.semantic_model).toBe(QWEN_MODEL);
    expect(JSON.parse(row.embedding)).toHaveLength(768);
    expect(JSON.parse(row.semantic_embedding)).toHaveLength(768);

    // vec0 同步写入 + KNN 可读
    expect(vector.isVecIndexAvailable()).toBe(true);
    expect(vector.getIndexStats().vecRows).toBe(2);
    const queryVector = Float32Array.from(fakeSemanticVector("咖啡"));
    const knn = vector.searchSemanticEpisodes(queryVector, 5, QWEN_MODEL);
    expect(knn[0]?.id).toBe(coffeeId);
    expect(knn[0]?.similarity).toBeGreaterThan(0.35);

    const memories = await retriever.retrieveRelevantMemoriesAsync("咖啡");
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain("咖啡");
    vector.closeVectorDb();
  });

  it("禁止跨模型混比：vec0 与 JS 回退都只返回 semantic_model 匹配的行", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");

    const legacy = generateEmbedding("喜欢喝咖啡");
    const qwenVec = Float32Array.from(fakeSemanticVector("喜欢喝咖啡"));
    const qwenId = vector.insertEpisodeWithSemanticEmbedding(
      "喜欢喝咖啡（qwen）",
      "chat",
      legacy,
      qwenVec,
      QWEN_MODEL
    );
    const otherId = vector.insertEpisodeWithSemanticEmbedding(
      "喜欢喝咖啡（其他模型）",
      "chat",
      legacy,
      qwenVec,
      "some-other-embedding-model"
    );

    const hits = vector.searchSemanticEpisodes(qwenVec, 10, QWEN_MODEL);
    expect(hits.map((h) => h.id)).toEqual([qwenId]);
    expect(hits.map((h) => h.id)).not.toContain(otherId);
    vector.closeVectorDb();
  });

  it("sqlite-vec 表为空时回退 JS 余弦（semantic_embedding JSON），检索仍工作", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");

    const id = await retriever.storeConversationEpisodeAsync("昨天喝了手冲咖啡很开心", "我也喜欢");
    // 模拟 vec 索引不可用/表为空
    const db = vector.getVectorDb();
    db.prepare("DELETE FROM t2_vec").run();
    expect(vector.getIndexStats().vecRows).toBe(0);

    const memories = await retriever.retrieveRelevantMemoriesAsync("咖啡");
    expect(memories.map((m) => m.id)).toContain(id);
    vector.closeVectorDb();
  });

  it("语义 API 失败时自动降级 n-gram，检索不抛错", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    const fetchMock = vi.fn(async () =>
      new Response("upstream down", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");

    const content = "用户说最喜欢喝咖啡";
    vector.insertEpisodeWithEmbedding(content, "chat", generateEmbedding(content));

    const memories = await retriever.retrieveRelevantMemoriesAsync("咖啡");
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0].content).toContain("咖啡");
    vector.closeVectorDb();
  });

  it("无 Qwen Key 时异步接口等价于同步降级路径，且不联网", async () => {
    const fetchMock = stubQwenEmbeddingApi();
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    const content = "用户说最喜欢喝咖啡";
    vector.insertEpisodeWithEmbedding(content, "chat", generateEmbedding(content));

    const memories = await retriever.retrieveRelevantMemoriesAsync("咖啡");
    expect(memories.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    vector.closeVectorDb();
  });
});

// ── sqlite-vec 同步：写入 / 删除 / 归档 ─────────────

describe("sqlite-vec 索引同步", () => {
  it("写入 semantic 行时同步 t2_vec；deleteEpisode 三表同步删除", async () => {
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    const legacy = generateEmbedding("喜欢喝咖啡");
    const semantic = Float32Array.from(fakeSemanticVector("喜欢喝咖啡"));
    const id = vector.insertEpisodeWithSemanticEmbedding(
      "喜欢喝咖啡",
      "chat",
      legacy,
      semantic,
      QWEN_MODEL
    );

    expect(vector.isVecIndexAvailable()).toBe(true);
    const db = vector.getVectorDb();
    const vecCount = (): number =>
      Number((db.prepare("SELECT COUNT(*) AS c FROM t2_vec WHERE id = ?").get(id) as { c: number }).c);
    expect(vecCount()).toBe(1);

    expect(vector.deleteEpisode(id)).toBe(true);
    expect(vecCount()).toBe(0);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM t2_fts WHERE rowid = ?").get(id) as { c: number }).c)
    ).toBe(0);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM t2_episodes WHERE id = ?").get(id) as { c: number }).c)
    ).toBe(0);
    vector.closeVectorDb();
  });

  it("archiveDecayedEpisodes 同步清理 vec / FTS", async () => {
    const { vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    const legacy = generateEmbedding("快忘掉的记忆");
    const id = vector.insertEpisodeWithSemanticEmbedding(
      "快忘掉的记忆",
      "chat",
      legacy,
      Float32Array.from(fakeSemanticVector("快忘掉的记忆")),
      QWEN_MODEL
    );
    vector.updateStrength(id, 0);

    expect(vector.archiveDecayedEpisodes()).toBe(1);
    const stats = vector.getIndexStats();
    expect(stats.vecRows).toBe(0);
    expect(stats.ftsRows).toBe(0);
    expect(stats.semanticEpisodes).toBe(0);
    expect(vector.getAllEpisodes()).toHaveLength(0);
    vector.closeVectorDb();
  });
});

// ── 写入主路径后台语义升级 / 幂等回填 ─────────────

describe("写入后台语义升级 + 幂等回填（mock Qwen）", () => {
  it("storeConversationEpisode 同步写入后，后台队列补齐语义向量", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { embedding, vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");

    const id = retriever.storeConversationEpisode("昨天喝了咖啡", "好喝吗");
    // 同步阶段只有 ngram 向量
    const db = vector.getVectorDb();
    const before = db
      .prepare("SELECT semantic_embedding FROM t2_episodes WHERE id = ?")
      .get(id) as { semantic_embedding: string | null };
    expect(before.semantic_embedding).toBeNull();

    await embedding.flushSemanticUpgrades();
    const after = db
      .prepare("SELECT semantic_model, semantic_embedding FROM t2_episodes WHERE id = ?")
      .get(id) as { semantic_model: string | null; semantic_embedding: string | null };
    expect(after.semantic_model).toBe(QWEN_MODEL);
    expect(after.semantic_embedding).not.toBeNull();
    expect(vector.getIndexStats().vecRows).toBe(1);
    vector.closeVectorDb();
  });

  it("upgradeEmbeddings 幂等：第一次回填 N 条，第二次返回 0", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { embedding, vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    vector.insertEpisodeWithEmbedding("旧记忆一：喜欢下雨", "chat", generateEmbedding("旧记忆一：喜欢下雨"));
    vector.insertEpisodeWithEmbedding("旧记忆二：喜欢咖啡", "chat", generateEmbedding("旧记忆二：喜欢咖啡"));
    expect(vector.countPendingSemanticBackfill()).toBe(2);

    expect(await embedding.upgradeEmbeddings()).toBe(2);
    expect(vector.countPendingSemanticBackfill()).toBe(0);
    expect(await embedding.upgradeEmbeddings()).toBe(0);
    expect(vector.getIndexStats().semanticEpisodes).toBe(2);
    expect(vector.getIndexStats().vecRows).toBe(2);
    vector.closeVectorDb();
  });

  it("无 Qwen Key 时回填直接跳过，不写假语义向量", async () => {
    const { embedding, vector } = await loadModules();
    vector.setCurrentPersona("小雅");
    vector.insertEpisodeWithEmbedding("旧记忆", "chat", generateEmbedding("旧记忆"));

    expect(await embedding.upgradeEmbeddings()).toBe(0);
    const db = vector.getVectorDb();
    const row = db
      .prepare("SELECT semantic_embedding FROM t2_episodes LIMIT 1")
      .get() as { semantic_embedding: string | null };
    expect(row.semantic_embedding).toBeNull();
    vector.closeVectorDb();
  });

  it("首次语义检索懒加载触发历史回填（后台、不阻塞本轮）", async () => {
    process.env.QWEN_VL_API_KEY = "test-qwen-key";
    stubQwenEmbeddingApi();
    const { vector, retriever } = await loadModules();
    vector.setCurrentPersona("小雅");
    vector.insertEpisodeWithEmbedding("旧记忆：喜欢下雨", "chat", generateEmbedding("旧记忆：喜欢下雨"));
    expect(vector.countPendingSemanticBackfill()).toBe(1);

    // 首次语义检索 → 后台懒加载回填
    await retriever.retrieveRelevantMemoriesAsync("下雨");

    for (let i = 0; i < 100 && vector.countPendingSemanticBackfill() > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(vector.countPendingSemanticBackfill()).toBe(0);
    expect(vector.getIndexStats().semanticEpisodes).toBe(1);
    vector.closeVectorDb();
  });
});
