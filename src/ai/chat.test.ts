import { describe, expect, it } from "vitest";
import { buildFinalMessages } from "./chat.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("buildFinalMessages：图片直进多模态（v0.9.26）", () => {
  it("把本轮图片附到最后一条 user message，文本保留", () => {
    const out = buildFinalMessages(
      [
        { role: "system", content: "你是小雅" },
        { role: "user", content: "看看这张图" },
      ],
      { images: [PNG, JPEG] },
    );
    expect(out).toHaveLength(2);
    const user = out[1]!;
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toMatchObject({ type: "text", text: "看看这张图" });
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(parts[1]!.image_url!.url).toBe(PNG);
  });

  it("最多附 2 张，非 data:image 过滤掉", () => {
    const out = buildFinalMessages(
      [{ role: "user", content: "图" }],
      { images: [PNG, JPEG, PNG, "https://example.com/a.png"] },
    );
    const parts = out[0]!.content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
  });

  it("没有图片时保持字符串 content（旧行为）", () => {
    const out = buildFinalMessages([{ role: "user", content: "你好" }]);
    expect(out[0]!.content).toBe("你好");
  });

  it("system 的 RAG/短期上下文仍然拼在 system，不影响 user 图片", () => {
    const out = buildFinalMessages(
      [
        { role: "system", content: "人设" },
        { role: "assistant", content: "在" },
        { role: "user", content: "看" },
      ],
      { ragContext: "记忆块", shortTermContext: "上下文", images: [PNG] },
    );
    expect(String(out[0]!.content)).toContain("记忆块");
    expect(String(out[0]!.content)).toContain("上下文");
    const user = out[2]!;
    expect(Array.isArray(user.content)).toBe(true);
  });

  it("最后一条不是 user 时（异常调用）不抛异常", () => {
    const out = buildFinalMessages([{ role: "system", content: "x" }], { images: [PNG] });
    expect(out).toHaveLength(1);
    expect(typeof out[0]!.content).toBe("string");
  });
});
