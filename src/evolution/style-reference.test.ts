import { describe, it, expect } from "vitest";
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
