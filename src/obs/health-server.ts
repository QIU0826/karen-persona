/**
 * 最小健康检查 HTTP 服务（可观测最小闭环，M1-9）。
 *
 * 零依赖：node:http。**只绑定 127.0.0.1**（不对外网开放，避免泄露运行状态）。
 * 由 qq.ts 按 config.health_port（默认 18081，0=关闭）启动；启动失败只记日志，
 * 绝不让桥接进程崩溃。
 *
 * 路由：
 *   GET /health  → { ok, uptime, version, ws_connections, db_ok, pending_replies,
 *                    cost_today, last_error }
 *   GET /cost    → 最近 7 天成本摘要（by_day / by_model / total）
 *   其他路径/方法 → 404 JSON
 *
 * 返回内容不含任何消息正文、token 或 Key（last_error 也经过 logger 脱敏）。
 *
 * 手动验证：
 *   curl -s http://127.0.0.1:18081/health
 *   curl -s http://127.0.0.1:18081/cost
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createLogger, getLastError } from "./logger.js";
import { getCostReport, getTodayCostSummary } from "./cost-tracker.js";
import { getVectorDb } from "../data/vector.js";
import { countPendingReplies } from "../data/pending-queue.js";

const log = createLogger("health");

/** 固定只监听本机回环地址（安全基线，不提供配置项避免误暴露）。 */
export const HEALTH_HOST = "127.0.0.1";

export interface HealthServerOptions {
  /** 监听端口；0 表示关闭（返回 null），测试可传 0 以外的随机端口。 */
  port: number;
  /** 活跃 WS 连接数（由桥接注入；不注入则固定 0）。 */
  getWsConnections?: () => number;
  /** pending 回复数（默认从 pending_replies 表统计）。 */
  getPendingReplies?: () => number;
  /** 业务启动时间（uptime 基准），默认 startHealthServer 调用时刻。 */
  startedAt?: number;
}

export interface HealthServerHandle {
  /** 实际监听端口（异步 listen 之后才有值；未监听为 null）。 */
  readonly port: number | null;
  readonly server: http.Server;
  /** 幂等关闭（进程退出/测试用），不会抛错。 */
  stop(): void;
}

interface HealthPayload {
  ok: boolean;
  uptime: number;
  version: string;
  ws_connections: number;
  db_ok: boolean;
  pending_replies: number;
  cost_today: number;
  last_error: string | null;
}

let cachedVersion: string | null = null;

/** 读取应用版本号（package.json；读不到时回退 unknown，绝不影响健康检查）。 */
export function getAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedVersion = process.env.npm_package_version ?? "unknown";
  }
  return cachedVersion;
}

function safeNumber(fn: (() => number) | undefined, fallback = 0): number {
  if (!fn) return fallback;
  try {
    const value = fn();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function checkDbOk(): boolean {
  try {
    const row = getVectorDb().prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

/** 组装 /health 响应（导出便于测试）。不含敏感信息。 */
export function buildHealthPayload(
  options: Pick<HealthServerOptions, "getWsConnections" | "getPendingReplies" | "startedAt">
): HealthPayload {
  const startedAt = options.startedAt ?? Date.now();
  const wsConnections = safeNumber(options.getWsConnections, 0);
  const pendingReplies = options.getPendingReplies
    ? safeNumber(options.getPendingReplies, 0)
    : safeNumber(countPendingReplies, 0);

  let costToday = 0;
  try {
    costToday = getTodayCostSummary().cost_cny;
  } catch {
    costToday = 0;
  }

  const dbOk = checkDbOk();
  return {
    ok: dbOk,
    uptime: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    version: getAppVersion(),
    ws_connections: wsConnections,
    db_ok: dbOk,
    pending_replies: pendingReplies,
    cost_today: costToday,
    last_error: getLastError(),
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  try {
    if (res.writableEnded) return;
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    // 客户端提前断开等场景：忽略
  }
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: HealthServerOptions
): void {
  try {
    // 只接受 GET（/health /cost 只读）；其他方法/路径统一 404
    if (req.method !== "GET") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", `http://${HEALTH_HOST}`).pathname;
    } catch {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    if (pathname === "/health") {
      const payload = buildHealthPayload(options);
      sendJson(res, payload.ok ? 200 : 503, payload);
      return;
    }

    if (pathname === "/cost") {
      try {
        sendJson(res, 200, getCostReport(7));
      } catch (err) {
        log.warn("health.cost_report_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { ok: false, error: "cost_unavailable" });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    log.error("health.request_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
}

/**
 * 启动 health server。任何错误都只记日志并返回 null（桥接进程不能因探活服务没起来而退出）。
 * 端口 0/负数 → 视为关闭，返回 null。
 */
export function startHealthServer(options: HealthServerOptions): HealthServerHandle | null {
  const port = Math.round(options.port);
  if (!Number.isFinite(port) || port <= 0) {
    if (port === 0) log.info("health.disabled", { reason: "health_port=0" });
    return null;
  }

  const startedAt = options.startedAt ?? Date.now();
  const requestOptions: HealthServerOptions = { ...options, port, startedAt };

  let server: http.Server;
  try {
    server = http.createServer((req, res) => handleRequest(req, res, requestOptions));
  } catch (err) {
    log.warn("health.start_failed", {
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  server.on("error", (err: Error) => {
    // EADDRINUSE / EACCES 等：记日志，不退出、不影响桥接
    log.error("health.server_error", { port, error: err.message });
  });

  try {
    server.listen(port, HEALTH_HOST, () => {
      log.info("health.started", { host: HEALTH_HOST, port: getListeningPort(server) ?? port });
    });
  } catch (err) {
    // 非法端口（RangeError）等同步异常
    log.warn("health.start_failed", {
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  // 进程退出兜底关闭（正常路径由调用方 stop；这里只是保险，不阻止退出）
  const onExit = (): void => stop();
  process.once("exit", onExit);

  const handle: HealthServerHandle = {
    get port(): number | null {
      return getListeningPort(server);
    },
    server,
    stop: () => {
      process.removeListener("exit", onExit);
      stop();
    },
  };
  return handle;
}

function getListeningPort(server: http.Server): number | null {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : null;
}
