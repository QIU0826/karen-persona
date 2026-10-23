/**
 * /health + /cost 健康检查服务测试。
 *
 * 使用 KAREN_DATA_DIR 临时目录 + 随机空闲端口（不占用 18081），
 * 通过真实 HTTP 请求断言字段/状态码，不联网、不触碰仓库 data/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DependencySnapshot, DependencyStatus } from "./dependency-health.js";

let dir: string;
let handles: Array<{ stop(): void; server: http.Server }> = [];
let currentVector: typeof import("../data/vector.js") | null = null;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-health-"));
  process.env.KAREN_DATA_DIR = dir;
  // 静音 logger 输出（测试断言走 HTTP / getLastError，不依赖 stdout）
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  vi.resetModules();
  handles = [];
  currentVector = null;
});

afterEach(async () => {
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
    currentVector?.closeVectorDb();
  } catch {
    // ignore
  }
  currentVector = null;
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function loadModules() {
  const health = await import("./health-server.js");
  const logger = await import("./logger.js");
  const vector = await import("../data/vector.js");
  currentVector = vector;
  return { health, logger, vector };
}

/** 申请一个空闲端口（避免与真实桥接的 18081/18080 冲突）。 */
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

async function getJson(port: number, pathname: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body };
}

describe("/health", () => {
  it("返回 ok/uptime/version/ws_connections/db_ok/pending_replies/cost_today/last_error", async () => {
    const { health, vector } = await loadModules();
    const port = await getFreePort();
    const startedAt = Date.now() - 65_000;
    const handle = health.startHealthServer({
      port,
      getWsConnections: () => 2,
      getPendingReplies: () => 3,
      startedAt,
    });
    expect(handle).not.toBeNull();
    handles.push(handle!);
    await waitListening(handle!.server);

    const actualPort = handle!.port;
    expect(actualPort).toBe(port);
    const { status, body } = await getJson(actualPort!, "/health");

    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(body?.db_ok).toBe(true);
    expect(body?.ws_connections).toBe(2);
    expect(body?.pending_replies).toBe(3);
    expect(typeof body?.uptime).toBe("number");
    expect(Number(body?.uptime)).toBeGreaterThanOrEqual(65);
    expect(typeof body?.version).toBe("string");
    expect(String(body?.version)).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof body?.cost_today).toBe("number");
    expect(body?.last_error).toBeNull();
    expect(body?.status).toBe("ok");
    expect(body?.dependencies).toEqual([]);
    expect(body?.dependencies_checked_at).toBeNull();
    expect(body?.degraded).toEqual([]);

    // 不泄露敏感信息（本次没有任何凭据字段，但兜底断言）
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain("api_key");
    vector.closeVectorDb();
  });

  it("status=degraded 时列出不可达依赖与 qq-bridge", async () => {
    const { health, vector } = await loadModules();
    const port = await getFreePort();
    const down: DependencyStatus = {
      name: "tts-voxcpm2",
      role: "tts",
      label: "VoxCPM2 语音合成",
      url: "http://127.0.0.1:19102",
      checkLoaded: true,
      up: false,
      latencyMs: 800,
      error: "timeout",
    };
    const snapshot: DependencySnapshot = {
      checkedAt: Date.now(),
      statuses: [down],
      degraded: [down],
    };
    const handle = health.startHealthServer({
      port,
      getWsConnections: () => 0,
      startedAt: Date.now() - 180_000,
      getDependencySnapshot: () => snapshot,
    });
    handles.push(handle!);
    await waitListening(handle!.server);

    const { status, body } = await getJson(handle!.port!, "/health");
    expect(status).toBe(200);
    expect(body?.status).toBe("degraded");
    expect(body?.degraded).toContain("tts-voxcpm2");
    expect(body?.degraded).toContain("qq-bridge");
    const deps = body?.dependencies as Array<Record<string, unknown>>;
    expect(deps[0]).toMatchObject({
      name: "tts-voxcpm2",
      up: false,
      latency_ms: 800,
      error: "timeout",
    });
    expect(typeof body?.dependencies_checked_at).toBe("number");
    vector.closeVectorDb();
  });

  it("只绑定 127.0.0.1（不对外网暴露）", async () => {
    const { health } = await loadModules();
    const port = await getFreePort();
    const handle = health.startHealthServer({ port });
    handles.push(handle!);
    await waitListening(handle!.server);

    const address = handle!.server.address();
    expect(typeof address).toBe("object");
    expect((address as net.AddressInfo).address).toBe("127.0.0.1");
  });

  it("last_error 返回最近一条 error 级日志（来自 logger，已脱敏）", async () => {
    const { health, logger } = await loadModules();
    const port = await getFreePort();
    const handle = health.startHealthServer({ port });
    handles.push(handle!);
    await waitListening(handle!.server);

    logger.logEvent("error", "test.failure", {
      error: "模拟失败",
      token: "sk-should-not-leak-123456",
    });
    const { status, body } = await getJson(handle!.port!, "/health");
    expect(status).toBe(200);
    expect(String(body?.last_error)).toContain("test.failure");
    expect(String(body?.last_error)).not.toContain("sk-should-not-leak-123456");
  });
});

describe("/cost", () => {
  it("返回 7 日成本摘要结构", async () => {
    const { health } = await loadModules();
    const port = await getFreePort();
    const handle = health.startHealthServer({ port });
    handles.push(handle!);
    await waitListening(handle!.server);

    const { status, body } = await getJson(handle!.port!, "/cost");
    expect(status).toBe(200);
    expect(body?.window_days).toBe(7);
    expect(Array.isArray(body?.by_day)).toBe(true);
    expect((body?.by_day as unknown[]).length).toBe(7);
    expect(Array.isArray(body?.by_model)).toBe(true);
    expect(typeof (body?.total as Record<string, unknown>)?.calls).toBe("number");
    expect(typeof body?.generated_at).toBe("string");
  });
});

describe("路由与容错", () => {
  it("未知路径 / 非 GET 方法返回 404", async () => {
    const { health } = await loadModules();
    const port = await getFreePort();
    const handle = health.startHealthServer({ port });
    handles.push(handle!);
    await waitListening(handle!.server);

    const notFound = await getJson(handle!.port!, "/nope");
    expect(notFound.status).toBe(404);
    expect(notFound.body?.error).toBe("not_found");

    const wrongMethod = await getJson(handle!.port!, "/health", { method: "POST" });
    expect(wrongMethod.status).toBe(404);
  });

  it("port=0 表示关闭（返回 null）；非法端口不抛错、返回 null", async () => {
    const { health } = await loadModules();
    expect(health.startHealthServer({ port: 0 })).toBeNull();
    expect(() => health.startHealthServer({ port: 99999 })).not.toThrow();
    expect(health.startHealthServer({ port: 99999 })).toBeNull();
    expect(health.startHealthServer({ port: Number.NaN })).toBeNull();
  });

  it("端口冲突只记错误日志，不让主进程崩溃", async () => {
    const { health, logger } = await loadModules();
    const port = await getFreePort();
    const first = health.startHealthServer({ port });
    handles.push(first!);
    await waitListening(first!.server);

    let second: ReturnType<typeof health.startHealthServer> = null;
    expect(() => {
      second = health.startHealthServer({ port });
    }).not.toThrow();
    if (second) handles.push(second);

    // 等 on("error") 异步触发
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(String(logger.getLastError())).toContain("health.server_error");
  });

  it("stop() 幂等关闭，关闭后连接被拒绝", async () => {
    const { health } = await loadModules();
    const port = await getFreePort();
    const handle = health.startHealthServer({ port });
    await waitListening(handle!.server);

    const closed = new Promise<void>((resolve) => handle!.server.once("close", () => resolve()));
    handle!.stop();
    handle!.stop();
    await closed;

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
