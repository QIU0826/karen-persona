/**
 * 本地 Web 控制台 HTTP 服务（步骤 5，只读，零新依赖）。
 *
 * - node:http，**只绑定 127.0.0.1**（不对外网开放）；
 * - 默认端口 18082（config `web_port`，0 = 关闭），由 bridge/qq.ts 启动；启动失败只
 *   记 `web.server_error` / `web.start_failed` 日志，绝不让桥接进程崩溃；
 * - `web_token` 可选：设置后所有请求必须带 `?token=` 或 `X-Web-Token`，否则 401；
 *   未设置时仅本机可访问，启动打 warn；
 * - 所有响应统一带 CSP（禁止外域脚本）、no-store、nosniff、Referrer-Policy 等安全头；
 * - 路由（GET only）：
 *   `/`                 单页控制台（服务端首屏渲染）
 *   `/api/overview`     总览（人设/会话/记忆/关系/健康/今日成本）
 *   `/api/session`      最近会话消息（?limit=，默认 30，上限 100）
 *   `/api/memory`       最近 T2（无 query）或混合检索（?query=&limit=，默认 10，上限 20）
 *   `/api/timeline`     关系时间线 / 里程碑 / herView / 情绪 / 漂移 / 叙事阶段
 *   `/api/health`       复用 obs/health-server 的探活数据（DB/WS/待补发/最近错误）
 *   `/api/cost`         今日 + 最近 7 天成本（复用 cost-tracker）
 *   其他路径 → 404 JSON；错误统一 `{ ok:false, error }`。
 *
 * 手动验证：
 *   curl -s http://127.0.0.1:18082/ | head
 *   curl -s http://127.0.0.1:18082/api/overview
 *   curl -s -H "X-Web-Token: $WEB_TOKEN" http://127.0.0.1:18082/api/timeline
 */
import http from "node:http";
import crypto from "node:crypto";
import { createLogger } from "../obs/logger.js";
import { renderDashboard, type DashboardData } from "./dashboard.js";
import {
  composeOverview,
  getCostData,
  getHealthData,
  getOverview,
  getRecentMemories,
  getSessionData,
  getTimeline,
  normalizeLimit,
  resolvePersonaContext,
  searchMemories,
  type HealthDataSourceOptions,
  type WebPersonaContext,
  type WebPersonaOverride,
} from "./data.js";

const log = createLogger("web");

/** 固定只监听本机回环地址（安全基线，不提供配置项避免误暴露）。 */
export const WEB_HOST = "127.0.0.1";

/**
 * 统一 CSP：禁止外域脚本/样式/连接（页面只用内联 CSS/JS 与同源 API）。
 * `'unsafe-inline'` 仅用于本项目内联样式与脚本，页面不含任何外域资源。
 */
export const WEB_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

export interface WebServerOptions {
  /** 监听端口；0 表示关闭（返回 null），测试可传随机端口。 */
  port: number;
  /** 可选访问 token；设置后所有请求必须携带 `?token=` 或 `X-Web-Token`。 */
  token?: string;
  /** T2 记忆的 persona_id（通常 config.persona）。 */
  personaId?: string;
  /** state/session 文件用的人设名（通常 persona.name）。 */
  personaName?: string;
  /** 人设初始亲密度（状态文件不存在时的兜底展示）。 */
  initialCloseness?: number;
  /** 活跃 WS 连接数（由桥接注入；不注入则 0）。 */
  getWsConnections?: () => number;
  /** pending 回复数（默认从 pending_replies 表统计）。 */
  getPendingReplies?: () => number;
  /** 服务启动时间（uptime 基准），默认 startWebServer 调用时刻。 */
  startedAt?: number;
}

export interface WebServerHandle {
  /** 实际监听端口（异步 listen 之后才有值；未监听为 null）。 */
  readonly port: number | null;
  readonly server: http.Server;
  /** 幂等关闭（进程退出/测试用），不会抛错。 */
  stop(): void;
}

function getListeningPort(server: http.Server): number | null {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : null;
}

// ── 安全工具 ────────────────────────────────────

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** 等长 constant-time 比较（避免 token 逐字符比较的时序侧信道）。 */
function tokenEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function extractToken(req: http.IncomingMessage, url: URL): string | null {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const header = req.headers["x-web-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (Array.isArray(header) && header.length > 0 && header[0].trim()) return header[0].trim();
  return null;
}

function isAuthorized(req: http.IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return true;
  const provided = extractToken(req, url);
  return provided !== null && tokenEquals(token, provided);
}

// ── 响应工具 ────────────────────────────────────

function send(
  res: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  try {
    if (res.writableEnded) return;
    res.writeHead(statusCode, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": WEB_CSP,
    });
    res.end(body);
  } catch {
    // 客户端提前断开等场景：忽略
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch {
    payload = JSON.stringify({ ok: false, error: "internal_error" });
  }
  send(res, statusCode, "application/json; charset=utf-8", payload);
}

function sendHtml(res: http.ServerResponse, statusCode: number, body: string): void {
  send(res, statusCode, "text/html; charset=utf-8", body);
}

// ── 数据组装 ────────────────────────────────────

function personaOverride(options: WebServerOptions): WebPersonaOverride {
  return { id: options.personaId, name: options.personaName };
}

function healthOptions(options: WebServerOptions): HealthDataSourceOptions {
  return {
    startedAt: options.startedAt,
    getWsConnections: options.getWsConnections,
    getPendingReplies: options.getPendingReplies,
  };
}

function buildDashboardData(
  options: WebServerOptions,
  persona: WebPersonaContext,
): DashboardData {
  const override = personaOverride(options);
  const session = getSessionData(30, override);
  const memory = getRecentMemories(30, override);
  const timeline = getTimeline(override, options.initialCloseness ?? 3);
  const health = getHealthData(healthOptions(options));
  const cost = getCostData(7);
  const overview = composeOverview(persona, { session, memory, timeline, health, cost });
  return { overview, session, memory, timeline, health, cost };
}

// ── 路由 ────────────────────────────────────────

type RequestOptions = WebServerOptions & { token: string | undefined; startedAt: number };

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RequestOptions,
): Promise<void> {
  try {
    // 防御纵深：即使将来误改监听地址，也拒绝非回环来源
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${WEB_HOST}`);
    } catch {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    if (!isAuthorized(req, url, options.token)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const rawPath = url.pathname;
    const pathname = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    const override = personaOverride(options);

    if (pathname === "/" || pathname === "/index.html") {
      try {
        const persona = resolvePersonaContext(override);
        const data = buildDashboardData(options, persona);
        sendHtml(res, 200, renderDashboard(data));
      } catch (err) {
        log.error("web.dashboard_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { ok: false, error: "internal_error" });
      }
      return;
    }

    if (pathname === "/api/overview") {
      sendJson(res, 200, getOverview(override, {
        initialCloseness: options.initialCloseness ?? 3,
        health: healthOptions(options),
      }));
      return;
    }

    if (pathname === "/api/session") {
      const limit = normalizeLimit(url.searchParams.get("limit"), 30);
      sendJson(res, 200, getSessionData(limit, override));
      return;
    }

    if (pathname === "/api/memory") {
      const query = (url.searchParams.get("query") ?? "").trim();
      if (query) {
        const limit = normalizeLimit(url.searchParams.get("limit"), 10, 20);
        sendJson(res, 200, await searchMemories(query, limit, override));
      } else {
        const limit = normalizeLimit(url.searchParams.get("limit"), 30);
        sendJson(res, 200, getRecentMemories(limit, override));
      }
      return;
    }

    if (pathname === "/api/timeline") {
      sendJson(res, 200, getTimeline(override, options.initialCloseness ?? 3));
      return;
    }

    if (pathname === "/api/health") {
      sendJson(res, 200, getHealthData(healthOptions(options)));
      return;
    }

    if (pathname === "/api/cost") {
      sendJson(res, 200, getCostData(7));
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    log.error("web.request_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
}

/**
 * 启动 Web 控制台服务。任何启动错误都只记日志并返回 null（桥接进程不能因此退出）。
 * 端口 0/负数 → 视为关闭，返回 null。
 */
export function startWebServer(options: WebServerOptions): WebServerHandle | null {
  const port = Math.round(options.port);
  if (!Number.isFinite(port) || port <= 0) {
    if (port === 0) log.info("web.disabled", { reason: "web_port=0" });
    return null;
  }

  const token =
    typeof options.token === "string" && options.token.trim() !== ""
      ? options.token.trim()
      : undefined;
  const startedAt = options.startedAt ?? Date.now();
  const requestOptions: RequestOptions = { ...options, port, token, startedAt };

  let server: http.Server;
  try {
    server = http.createServer((req, res) => {
      void handleRequest(req, res, requestOptions);
    });
  } catch (err) {
    log.warn("web.start_failed", {
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  server.on("error", (err: Error) => {
    // EADDRINUSE / EACCES 等：记日志，不退出、不影响桥接
    log.error("web.server_error", { port, error: err.message });
  });

  try {
    server.listen(port, WEB_HOST, () => {
      log.info("web.started", {
        host: WEB_HOST,
        port: getListeningPort(server) ?? port,
        token_enabled: token !== undefined,
      });
    });
  } catch (err) {
    log.warn("web.start_failed", {
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (token === undefined) {
    log.warn("web.no_token", {
      hint: "未设置 web_token：控制台仅本机可访问（已绑定 127.0.0.1）；如需额外保护请设置 web_token",
    });
  } else if (token.length < 8) {
    log.warn("web.token_too_short", { length: token.length });
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

  return {
    get port(): number | null {
      return getListeningPort(server);
    },
    server,
    stop: () => {
      process.removeListener("exit", onExit);
      stop();
    },
  };
}
