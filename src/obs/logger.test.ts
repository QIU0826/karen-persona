/**
 * 结构化日志单测：JSON lines / TTY 文本 / 级别过滤 / 默认脱敏 / last_error。
 * 不联网、不依赖真实 TTY。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLastError,
  configureLogger,
  createLogger,
  getLastError,
  getLoggerConfig,
  logEvent,
  resetLogger,
  sanitizeLogFields,
} from "./logger.js";

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function captureOutput(): void {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);
}

function stdoutLines(): Array<Record<string, unknown>> {
  return stdoutChunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stderrLines(): Array<Record<string, unknown>> {
  return stderrChunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  resetLogger();
  captureOutput();
  configureLogger({ level: "debug", format: "json", tty: false });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  resetLogger();
});

describe("logger JSON lines", () => {
  it("输出 time/level/scope/event/fields", () => {
    const log = createLogger("test");
    log.info("event.alpha", { user_id: 123, chars: 7 });

    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe("info");
    expect(line.scope).toBe("test");
    expect(line.event).toBe("event.alpha");
    expect(typeof line.time).toBe("string");
    expect(new Date(String(line.time)).toString()).not.toBe("Invalid Date");
    expect(line.fields).toEqual({ user_id: 123, chars: 7 });
  });

  it("warn/error 走 stderr，info/debug 走 stdout", () => {
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(stdoutLines().map((line) => line.event)).toEqual(["d", "i"]);
    expect(stderrLines().map((line) => line.event)).toEqual(["w", "e"]);
  });

  it("默认脱敏：消息正文 / 凭据不落日志，只保留长度", () => {
    const log = createLogger("qq");
    log.info("message.received", {
      user_id: 123,
      content: "今晚一起吃饭吗",
      message: "hello there",
      raw_message: "原始消息",
      text: "hi",
      token: "sk-abcdef123456789",
      api_key: "super-secret-key-value",
      nickname: "小雅",
      char_count: 7,
    });

    const raw = stdoutChunks.join("");
    expect(raw).not.toContain("今晚一起吃饭吗");
    expect(raw).not.toContain("hello there");
    expect(raw).not.toContain("原始消息");
    expect(raw).not.toContain("sk-abcdef123456789");
    expect(raw).not.toContain("super-secret-key-value");
    expect(raw).not.toContain("小雅");

    const fields = stdoutLines()[0].fields as Record<string, unknown>;
    expect(String(fields.content)).toContain("redacted");
    expect(String(fields.token)).toContain("redacted");
    expect(fields.char_count).toBe(7);
  });

  it("普通字段值中的 Key/Bearer 也会被扫描替换", () => {
    const log = createLogger("llm");
    log.warn("llm.retry", {
      error: "auth failed: key=sk-live-abcdef123456 Bearer abcdefghijklmn",
    });

    const raw = stderrChunks.join("");
    expect(raw).not.toContain("sk-live-abcdef123456");
    expect(raw).not.toContain("abcdefghijklmn");
    expect(raw).toContain("[redacted]");
  });

  it("嵌套字段递归脱敏，长字符串截断", () => {
    const log = createLogger("test");
    log.info("nested", {
      nested: { content: "秘密内容", count: 2 },
      long: "a".repeat(500),
    });

    const fields = stdoutLines()[0].fields as Record<string, unknown>;
    const nested = fields.nested as Record<string, unknown>;
    expect(String(nested.content)).toContain("redacted");
    expect(nested.count).toBe(2);
    expect(String(fields.long).length).toBeLessThan(400);
    expect(String(fields.long)).toContain("500 chars");
  });

  it("BigInt / 循环引用 / 函数字段不会让日志抛错", () => {
    const log = createLogger("test");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      log.info("tricky", { big: BigInt(42), circular, fn: () => 1, undef: undefined })
    ).not.toThrow();
    expect(stdoutLines()).toHaveLength(1);
  });

  it("sanitizeLogFields 可直接用于拦截未走 logger 的场景", () => {
    const sanitized = sanitizeLogFields({ content: "秘密", count: 1 });
    expect(String(sanitized?.content)).toContain("redacted");
    expect(sanitized?.count).toBe(1);
  });
});

describe("logger 级别与格式", () => {
  it("级别过滤：warn 模式下 debug/info 不输出", () => {
    configureLogger({ level: "warn" });
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");

    expect(stdoutChunks.join("")).toBe("");
    expect(stderrLines().map((line) => line.event)).toEqual(["w"]);
  });

  it("TTY 文本格式人类可读", () => {
    configureLogger({ format: "text", tty: true });
    const log = createLogger("qq");
    log.info("ws.connected", { active: 2, reconnect: false });

    const raw = stdoutChunks.join("");
    expect(raw).toContain("[qq]");
    expect(raw).toContain("ws.connected");
    expect(raw).toMatch(/INFO\s/);
    expect(raw).toContain("active=2");
    expect(raw).not.toContain('"level"'); // 不是 JSON
  });

  it("logEvent 使用 app scope", () => {
    logEvent("info", "app.started", { version: "0.1.0" });
    const lines = stdoutLines();
    expect(lines[0].scope).toBe("app");
    expect(lines[0].event).toBe("app.started");
  });

  it("配置快照可读（测试/诊断用）", () => {
    configureLogger({ level: "error", format: "json", tty: false });
    const config = getLoggerConfig();
    expect(config.level).toBe("error");
    expect(config.format).toBe("json");
    expect(config.tty).toBe(false);
  });

  it("非法 level/format 回退默认，不抛错", () => {
    expect(() => configureLogger({ level: "verbose", format: "xml" })).not.toThrow();
    expect(["debug", "info", "warn", "error"]).toContain(getLoggerConfig().level);
  });
});

describe("last_error", () => {
  it("error 级日志记录最近错误（供 /health last_error），且不含凭据", () => {
    const log = createLogger("llm");
    log.warn("llm.retry", { error: "某次重试失败" });
    expect(getLastError()).toBeNull();

    log.error("llm.failed", { error: "API 错误 401（API Key 无效）", token: "sk-secret123456789" });
    const lastError = getLastError();
    expect(lastError).toContain("llm.failed");
    expect(lastError).not.toContain("sk-secret123456789");

    clearLastError();
    expect(getLastError()).toBeNull();
  });
});
