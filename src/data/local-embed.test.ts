import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_EMBED_URL,
  LOCAL_EMBEDDING_DIM,
  LOCAL_EMBEDDING_MODEL,
  embedLocal,
  embedLocalBatch,
  isLocalEmbeddingEnabled,
  localEmbedUrl,
  probeLocalEmbedding,
  resetLocalEmbeddingState,
} from "./local-embed.js";

const ENV_KEYS = ["KAREN_EMBED", "KAREN_EMBED_URL", "EMBEDDING_PROVIDER"] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetLocalEmbeddingState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
  resetLocalEmbeddingState();
});

function vec(dim = LOCAL_EMBEDDING_DIM, fill = 0.01): number[] {
  return Array.from({ length: dim }, () => fill);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("配置与地址", () => {
  it("默认地址与模型标记", () => {
    expect(localEmbedUrl()).toBe(DEFAULT_LOCAL_EMBED_URL);
    expect(LOCAL_EMBEDDING_MODEL).toBe("local-qwen3-embedding-0.6b");
    expect(LOCAL_EMBEDDING_DIM).toBe(768);
  });

  it("KAREN_EMBED_URL 可覆盖（去掉结尾斜杠）", () => {
    process.env.KAREN_EMBED_URL = "http://10.0.0.2:9999/";
    expect(localEmbedUrl()).toBe("http://10.0.0.2:9999");
  });

  it("默认关闭（显式开启才用），KAREN_EMBED=off / EMBEDDING_PROVIDER=ngram 也关闭", () => {
    expect(isLocalEmbeddingEnabled()).toBe(false);
    process.env.KAREN_EMBED = "on";
    expect(isLocalEmbeddingEnabled()).toBe(true);
    process.env.KAREN_EMBED = "off";
    expect(isLocalEmbeddingEnabled()).toBe(false);
    delete process.env.KAREN_EMBED;
    process.env.EMBEDDING_PROVIDER = "ngram";
    process.env.KAREN_EMBED = "on";
    expect(isLocalEmbeddingEnabled()).toBe(false);
  });
});

describe("健康探测", () => {
  it("服务正常时 ok=true，并缓存结果（不重复请求）", async () => {
    process.env.KAREN_EMBED = "on";
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, model: "qwen", dim: 768 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await probeLocalEmbedding()).ok).toBe(true);
    expect((await probeLocalEmbedding()).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("服务不可用时进入冷却，不反复探测", async () => {
    process.env.KAREN_EMBED = "on";
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await probeLocalEmbedding()).ok).toBe(false);
    expect((await probeLocalEmbedding()).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("embedLocalBatch", () => {
  it("正常返回 Float32Array 且维度正确", async () => {
    process.env.KAREN_EMBED = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/health")) return jsonResponse({ ok: true, dim: 768 });
        return jsonResponse({ vectors: [vec(), vec(768, 0.02)], dim: 768 });
      }),
    );
    const out = await embedLocalBatch(["你好", "世界"]);
    expect(out).toHaveLength(2);
    expect(out![0]).toBeInstanceOf(Float32Array);
    expect(out![0]).toHaveLength(768);
  });

  it("维度不符时返回 null（避免写入脏向量）", async () => {
    process.env.KAREN_EMBED = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/health")) return jsonResponse({ ok: true, dim: 1024 });
        return jsonResponse({ vectors: [vec(1024)], dim: 1024 });
      }),
    );
    expect(await embedLocalBatch(["你好"])).toBeNull();
  });

  it("条数不匹配时返回 null", async () => {
    process.env.KAREN_EMBED = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/health")) return jsonResponse({ ok: true });
        return jsonResponse({ vectors: [vec()] });
      }),
    );
    expect(await embedLocalBatch(["a", "b"])).toBeNull();
  });

  it("关闭或空输入直接返回 null（不联网）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await embedLocalBatch([])).toBeNull();
    process.env.KAREN_EMBED = "off";
    expect(await embedLocalBatch(["x"])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("失败后进入冷却期，后续调用直接降级不重试", async () => {
    process.env.KAREN_EMBED = "on";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) return jsonResponse({ ok: true });
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await embedLocalBatch(["x"])).toBeNull();
    const callsAfterFailure = fetchMock.mock.calls.length;
    expect(await embedLocalBatch(["y"])).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailure);
  });

  it("embedLocal 返回单条向量", async () => {
    process.env.KAREN_EMBED = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/health")) return jsonResponse({ ok: true });
        return jsonResponse({ vectors: [vec()] });
      }),
    );
    const one = await embedLocal("今天的晚霞", "query");
    expect(one).toHaveLength(768);
  });
});
