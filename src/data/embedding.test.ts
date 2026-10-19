/**
 * 语义 embedding（Qwen text-embedding-v3）+ n-gram 回退测试。
 *
 * ⚠️ 本机/CI 没有真实 Qwen Key：所有语义 API 调用都用 `vi.stubGlobal("fetch", ...)` mock，
 * 不联网。真实链路需配置 QWEN_VL_API_KEY / QWEN_EMBEDDING_API_KEY 才能验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIM,
  NGRAM_EMBEDDING_MODEL,
  QWEN_EMBEDDING_MODEL,
  embedText,
  generateEmbedding,
  generateSemanticEmbedding,
  isSemanticEmbeddingConfigured,
  normalizeToDim,
  resetEmbeddingApiState,
} from "./embedding.js";

/** 测试用确定性「语义」向量：按字符哈希累加后归一化（共享字符越多越相似）。 */
function fakeSemanticVector(text: string): number[] {
  const vec = new Array(EMBEDDING_DIM).fill(0) as number[];
  for (const ch of Array.from(text.replace(/\s+/g, ""))) {
    vec[(ch.codePointAt(0) ?? 0) % EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

function stubEmbeddingApi(
  factory: (text: string) => number[] = fakeSemanticVector,
  status = 200,
  bodyOverride?: string
) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (bodyOverride !== undefined) {
      return new Response(bodyOverride, { status, headers: { "Content-Type": "application/json" } });
    }
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
    return new Response(
      JSON.stringify({ data: [{ embedding: factory(String(requestBody.input ?? "")) }] }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setQwenKey(): void {
  process.env.QWEN_VL_API_KEY = "test-qwen-key";
}

beforeEach(() => {
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  resetEmbeddingApiState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEmbeddingApiState();
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
});

// ── n-gram 回退（同步、确定性）────────────────────

describe("generateEmbedding（n-gram 回退）", () => {
  it("确定性：同一文本生成同一向量，且 L2 归一化", () => {
    const a = generateEmbedding("今天下雨了，想喝咖啡");
    const b = generateEmbedding("今天下雨了，想喝咖啡");
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a).toHaveLength(EMBEDDING_DIM);

    const norm = Math.sqrt(Array.from(a).reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("空字符串返回零向量；不同文本向量不同", () => {
    const empty = generateEmbedding("");
    expect(Array.from(empty).every((v) => v === 0)).toBe(true);

    const a = Array.from(generateEmbedding("咖啡"));
    const b = Array.from(generateEmbedding("下雨"));
    expect(a).not.toEqual(b);
  });
});

// ── normalizeToDim：不允许悄悄丢信息 ───────────────

describe("normalizeToDim", () => {
  it("768 维：直接使用并归一化", () => {
    const input = new Array(EMBEDDING_DIM).fill(1);
    const out = normalizeToDim(input);
    expect(out).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(Array.from(out).reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("1024 维：按 MRL 前缀截断到 768（保留前 768 维语义）并归一化", () => {
    const input = Array.from({ length: 1024 }, (_, i) => i + 1);
    const out = normalizeToDim(input);
    expect(out).toHaveLength(EMBEDDING_DIM);
    // 前缀方向保留（归一化后第 1 维 = 1/sqrt(sum(1..768^2))）
    expect(out[0]).toBeGreaterThan(0);
    const norm = Math.sqrt(Array.from(out).reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("维度不足（512）直接抛错（拒绝补零静默失真）", () => {
    expect(() => normalizeToDim(new Array(512).fill(0.1))).toThrow(/维度不足/);
  });

  it("空/非数值向量抛错", () => {
    expect(() => normalizeToDim([])).toThrow();
    expect(() => normalizeToDim([1, Number.NaN])).toThrow();
  });
});

// ── embedText：无 Key / 有 Key / 失败降级 ─────────

describe("embedText", () => {
  it("无 Qwen Key 时直接走 n-gram，且不发网络请求", async () => {
    const fetchMock = stubEmbeddingApi();
    expect(isSemanticEmbeddingConfigured()).toBe(false);

    const result = await embedText("今天下雨了");
    expect(result.model).toBe(NGRAM_EMBEDDING_MODEL);
    expect(result.degraded).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("EMBEDDING_PROVIDER=ngram 时有 Key 也不联网", async () => {
    setQwenKey();
    process.env.EMBEDDING_PROVIDER = "ngram";
    const fetchMock = stubEmbeddingApi();

    const result = await embedText("今天下雨了");
    expect(result.model).toBe(NGRAM_EMBEDDING_MODEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("有 Key 时请求 dimensions=768 并记录 qwen 模型", async () => {
    setQwenKey();
    const fetchMock = stubEmbeddingApi();

    const result = await embedText("今天下雨了");
    expect(result.model).toBe(QWEN_EMBEDDING_MODEL);
    expect(result.degraded).toBe(false);
    expect(result.vector).toHaveLength(EMBEDDING_DIM);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/embeddings");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      input: string;
      dimensions?: number;
    };
    expect(body.dimensions).toBe(EMBEDDING_DIM);
    expect(body.input).toBe("今天下雨了");
    expect(body.model).toBe("text-embedding-v3");
  });

  it("API 返回 1024 维时按 MRL 前缀截断到 768（并打一次告警）", async () => {
    setQwenKey();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stubEmbeddingApi((text) =>
      Array.from({ length: 1024 }, (_, i) => (i + text.length) % 97 + 1)
    );

    const result = await embedText("咖啡");
    expect(result.model).toBe(QWEN_EMBEDDING_MODEL);
    expect(result.vector).toHaveLength(EMBEDDING_DIM);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("MRL"))).toBe(true);
  });

  it("API 返回维度不足时降级 n-gram（不写假向量）", async () => {
    setQwenKey();
    stubEmbeddingApi(() => new Array(512).fill(0.1));

    const result = await embedText("咖啡");
    expect(result.model).toBe(NGRAM_EMBEDDING_MODEL);
    expect(result.degraded).toBe(true);
  });

  it("API 失败时降级 n-gram；冷却期内不再重复请求", async () => {
    setQwenKey();
    stubEmbeddingApi(() => [], 500, "internal error");

    const first = await embedText("咖啡");
    expect(first.model).toBe(NGRAM_EMBEDDING_MODEL);
    expect(first.degraded).toBe(true);

    const second = await embedText("下雨");
    expect(second.model).toBe(NGRAM_EMBEDDING_MODEL);
    // 失败后进入冷却期：不应再次发请求
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("兼容旧接口 generateSemanticEmbedding：无 Key 时返回 n-gram 向量", async () => {
    const vector = await generateSemanticEmbedding("今天下雨了");
    expect(vector).toHaveLength(EMBEDDING_DIM);
    expect(Array.from(vector)).toEqual(Array.from(generateEmbedding("今天下雨了")));
  });
});
