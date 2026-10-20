import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { buildStyleContext, type StyleReference } from "./style-reference.js";

// ── buildStyleContext ─────────────────────────

describe("buildStyleContext", () => {
  it("空列表返回空字符串", () => {
    expect(buildStyleContext([])).toBe("");
  });

  it("独白来源标记为内心独白", () => {
    const refs: StyleReference[] = [
      { content: "[独白] 今天好像有点冷淡了", source: "internal_monologue", affinity: "high", daysAgo: 2 },
    ];
    const result = buildStyleContext(refs);
    expect(result).toContain("内心独白");
    expect(result).toContain("2天前");
  });

  it("对话来源标记为对话", () => {
    const refs: StyleReference[] = [
      { content: "[对话] 用户: 你好 | 回复: 嗨", source: "chat", affinity: "high", daysAgo: 0 },
    ];
    const result = buildStyleContext(refs);
    expect(result).toContain("对话");
    expect(result).toContain("今天");
  });

  it("包含免责说明", () => {
    const refs: StyleReference[] = [
      { content: "[独白] test", source: "internal_monologue", affinity: "high", daysAgo: 1 },
    ];
    const result = buildStyleContext(refs);
    expect(result).toContain("不是必须模仿的模板");
  });

  it("多条参考均被包含", () => {
    const refs: StyleReference[] = [
      { content: "第一条", source: "internal_monologue", affinity: "high", daysAgo: 1 },
      { content: "第二条", source: "chat", affinity: "high", daysAgo: 3 },
    ];
    const result = buildStyleContext(refs);
    expect(result).toContain("第一条");
    expect(result).toContain("第二条");
  });
});

describe("retrieveStyleReference 多用户隔离", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-style-ref-"));
    process.env.KAREN_DATA_DIR = dir;
    delete process.env.QWEN_VL_API_KEY;
    delete process.env.QWEN_EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_PROVIDER;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.KAREN_DATA_DIR;
    vi.resetModules();
    try {
      const vector = await import("../data/vector.js");
      vector.closeVectorDb();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("只返回当前 personaId 的片段，绝不跨用户泄漏", async () => {
    const vector = await import("../data/vector.js");
    const embedding = await import("../data/embedding.js");
    const { retrieveStyleReference } = await import("./style-reference.js");

    vector.setCurrentPersona("xiaoya");
    vector.insertEpisodeWithEmbedding(
      "平静 日常 今天心情一般 A用户说他要去看医生",
      "chat",
      embedding.generateEmbedding("平静 日常 心情一般"),
    );

    vector.setCurrentPersona("xiaoya@qq-100000002");
    vector.insertEpisodeWithEmbedding(
      "平静 日常 今天心情一般 B用户说他养了一只猫",
      "chat",
      embedding.generateEmbedding("平静 日常 心情一般"),
    );

    const params = {
      emotionVector: 0,
      guilt: 0,
      mode: "idle",
      userInput: "平静 日常",
    };

    const forA = retrieveStyleReference({ ...params, personaId: "xiaoya" });
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.every((ref) => ref.content.includes("A用户"))).toBe(true);
    expect(forA.some((ref) => ref.content.includes("B用户"))).toBe(false);

    const forB = retrieveStyleReference({ ...params, personaId: "xiaoya@qq-100000002" });
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((ref) => ref.content.includes("B用户"))).toBe(true);
    expect(forB.some((ref) => ref.content.includes("A用户"))).toBe(false);
  });

  it("缺少 personaId 时不检索（返回空）", async () => {
    const { retrieveStyleReference } = await import("./style-reference.js");
    const refs = retrieveStyleReference({
      emotionVector: 0,
      guilt: 0,
      mode: "idle",
      userInput: "在吗",
      personaId: "",
    });
    expect(refs).toEqual([]);
  });
});
