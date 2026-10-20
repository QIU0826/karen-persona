/**
 * 日志正文脱敏单测（纯函数 + env 开关）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_CHARS, previewError, previewText } from "./safe-text.js";

let savedLogContent: string | undefined;

beforeEach(() => {
  savedLogContent = process.env.LOG_CONTENT;
  delete process.env.LOG_CONTENT;
});

afterEach(() => {
  if (savedLogContent === undefined) delete process.env.LOG_CONTENT;
  else process.env.LOG_CONTENT = savedLogContent;
});

describe("previewText", () => {
  it("默认只输出长度，不落正文", () => {
    expect(previewText("今天真的好累啊")).toBe("[redacted 7 chars]");
    expect(previewText("")).toBe("");
    expect(previewText(null)).toBe("");
    expect(previewText(undefined)).toBe("");
  });

  it("LOG_CONTENT=1 时输出前 N 字预览（超长加省略号）", () => {
    process.env.LOG_CONTENT = "1";
    expect(previewText("今天真的好累啊")).toBe("今天真的好累啊");
    const long = "今天".repeat(40);
    const preview = previewText(long);
    expect(Array.from(preview).length).toBe(DEFAULT_PREVIEW_CHARS + 1); // 40 字 + …
    expect(preview.endsWith("…")).toBe(true);
  });

  it("emoji 按码点计数，不误算成两个字符", () => {
    expect(previewText("😂")).toBe("[redacted 1 chars]");
  });
});

describe("previewError", () => {
  it("短错误原样、长错误截断", () => {
    expect(previewError(new Error("timeout"))).toBe("timeout");
    const long = new Error("x".repeat(300));
    expect(previewError(long).length).toBe(121);
    expect(previewError(long).endsWith("…")).toBe(true);
    expect(previewError("plain")).toBe("plain");
  });
});
