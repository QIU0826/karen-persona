/**
 * B 站登录态凭据读取（Social P1）。
 *
 * 安全边界（必须遵守）：
 * - Cookie 只从「文件」或「进程 env」读取，不写数据库、不写日志、不进返回值之外的持久层；
 * - 任何日志/错误/结果摘要只允许出现 `fingerprint`（SESSDATA 的 sha256 前 12 位）与 uid/来源，
 *   绝不允许出现 SESSDATA / bili_jct / DedeUserID 的原文；
 * - 文件权限：建议 cookie 文件 0600、目录 0700；权限过宽只产生 warning（不阻塞，方便用户修），
 *   但会在凭据结果里标记 `secure:false`，调用方可据此拒绝高权限动作。
 *
 * 支持格式：
 * 1) env `BILIBILI_COOKIE`：cookie 字符串（`SESSDATA=...; bili_jct=...; DedeUserID=...`）
 *    或 JSON（`{"SESSDATA":"...","bili_jct":"...","DedeUserID":"..."}`）；
 * 2) 文件（路径优先级：参数 cookieFile > env KAREN_BILIBILI_COOKIE_FILE > 默认
 *    `data/secrets/bilibili-cookie.json`），内容同上两种格式。
 *
 * 本模块不发起写请求；`verifyBilibiliLogin` 只调用只读的 `/x/web-interface/nav`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../obs/logger.js";

const log = createLogger("social.credentials");

const DEFAULT_COOKIE_FILE = "data/secrets/bilibili-cookie.json";
const DEFAULT_TIMEOUT_MS = 8_000;
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export type BilibiliCookieSource = "env" | "file";

export interface BilibiliCookie {
  /** 原始 SESSDATA（绝不外泄；只在 Cookie header 里出现） */
  sessData: string;
  /** CSRF token（bili_jct）；写接口的 csrf 字段/参数 */
  biliJct: string;
  /** 登录用户 uid（可选，部分写接口需要） */
  dedeUserId?: string;
}

export interface BilibiliCookieFileStatus {
  path: string;
  exists: boolean;
  /** 仅 POSIX；Windows 上为 null（不做权限判断） */
  fileMode: number | null;
  dirMode: number | null;
  secure: boolean;
  warnings: string[];
}

export interface BilibiliCredentials {
  cookie: BilibiliCookie;
  source: BilibiliCookieSource;
  /** 文件来源时的绝对路径（env 来源为 null） */
  path: string | null;
  fingerprint: string;
  secure: boolean;
  warnings: string[];
}

export type BilibiliCredentialErrorCode =
  | "no_credentials"
  | "unreadable"
  | "invalid_format"
  | "missing_fields"
  | "insecure_permissions";

export interface BilibiliCredentialError {
  code: BilibiliCredentialErrorCode;
  /** 面向用户/日志的可读信息；不含任何 Cookie 内容 */
  message: string;
}

export type BilibiliCredentialResult =
  | { ok: true; credentials: BilibiliCredentials }
  | { ok: false; error: BilibiliCredentialError };

export interface LoadCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  /** 覆盖文件路径（相对路径基于 process.cwd()） */
  cookieFile?: string;
  /** 为 true 时，文件权限过宽直接返回 insecure_permissions（默认 false：只 warning） */
  requireSecure?: boolean;
}

export interface VerifyBilibiliLoginOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface BilibiliLoginInfo {
  ok: boolean;
  loggedIn: boolean;
  uid?: number;
  uname?: string;
  level?: number;
  fingerprint: string;
  errorCode?: "not_logged_in" | "no_credentials" | "risk_control" | "network_error" | "invalid_response" | "http_error";
  message?: string;
}

// ── 解析 ─────────────────────────────────────────

function normalKey(key: string): string {
  return key.trim().toLowerCase();
}

function pick(obj: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/**
 * 解析 cookie 字符串（`SESSDATA=...; bili_jct=...; DedeUserID=...`）。
 * 值保持原样（SESSDATA 可能带 URL 编码的逗号）；find 到第一个 `=` 后全部作为值。
 */
export function parseBilibiliCookieString(raw: string): BilibiliCookie | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const values: Record<string, string> = {};
  for (const part of text.split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const key = normalKey(piece.slice(0, eq));
    const value = piece.slice(eq + 1).trim();
    if (value) values[key] = value;
  }
  const sessData = values["sessdata"] ?? "";
  const biliJct = values["bili_jct"] ?? "";
  if (!sessData || !biliJct) return null;
  const dede = values["dedeuserid"] ?? "";
  return {
    sessData,
    biliJct,
    ...(dede ? { dedeUserId: dede } : {}),
  };
}

/** 解析 JSON 对象（也接受 `{cookie: "SESSDATA=..."}` 嵌套）。 */
export function parseBilibiliCookieJson(raw: unknown): BilibiliCookie | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // 允许 {"cookie":"SESSDATA=...; bili_jct=..."} 这种简化格式
  const nested = obj.cookie;
  if (typeof nested === "string") {
    const parsed = parseBilibiliCookieString(nested);
    if (parsed) return parsed;
  }
  const sessData = pick(obj, ["SESSDATA", "sessdata", "sessData"]);
  const biliJct = pick(obj, ["bili_jct", "biliJct", "biliJctToken", "csrf"]);
  if (!sessData || !biliJct) return null;
  const dede = pick(obj, ["DedeUserID", "dedeUserId", "dede_user_id", "uid"]);
  return {
    sessData,
    biliJct,
    ...(dede ? { dedeUserId: dede } : {}),
  };
}

/** 解析「JSON 或 cookie 字符串」两种格式。 */
export function parseBilibiliCookie(raw: string): BilibiliCookie | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      return parseBilibiliCookieJson(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return parseBilibiliCookieString(text);
}

/** 生成 Cookie header（内部/测试用；只允许在请求构造时调用，不要写日志）。 */
export function toBilibiliCookieHeader(cookie: BilibiliCookie): string {
  const parts = [`SESSDATA=${cookie.sessData}`, `bili_jct=${cookie.biliJct}`];
  if (cookie.dedeUserId) parts.push(`DedeUserID=${cookie.dedeUserId}`);
  return parts.join("; ");
}

/** 凭据指纹：SESSDATA sha256 前 12 位；可用于日志关联，无法反推出原值。 */
export function bilibiliCookieFingerprint(cookie: Pick<BilibiliCookie, "sessData">): string {
  return crypto.createHash("sha256").update(cookie.sessData).digest("hex").slice(0, 12);
}

/** 不带 Cookie 的安全摘要（日志/审计唯一允许的形状）。 */
export function describeBilibiliCredentials(
  credentials: BilibiliCredentials,
): { source: BilibiliCookieSource; fingerprint: string; uid: string | null; secure: boolean } {
  return {
    source: credentials.source,
    fingerprint: credentials.fingerprint,
    uid: credentials.cookie.dedeUserId ?? null,
    secure: credentials.secure,
  };
}

// ── 文件权限 ─────────────────────────────────────

function modeOf(file: string): number | null {
  if (process.platform === "win32") return null;
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/** 权限过宽判断：group/other 有任何权限即算宽（0600/0700 为推荐）。 */
function permissionWarnings(paths: { file: string; dir: string }): {
  fileMode: number | null;
  dirMode: number | null;
  secure: boolean;
  warnings: string[];
} {
  const fileMode = modeOf(paths.file);
  const dirMode = modeOf(paths.dir);
  const warnings: string[] = [];
  let secure = true;
  if (fileMode !== null && (fileMode & 0o077) !== 0) {
    secure = false;
    warnings.push(`Cookie 文件权限过宽（${fileMode.toString(8)}），建议 chmod 600 ${paths.file}`);
  }
  if (dirMode !== null && (dirMode & 0o077) !== 0) {
    secure = false;
    warnings.push(`Cookie 目录权限过宽（${dirMode.toString(8)}），建议 chmod 700 ${paths.dir}`);
  }
  return { fileMode, dirMode, secure, warnings };
}

/** 检查 cookie 文件/目录权限（不存在时 exists:false，不产生 warning）。 */
export function inspectBilibiliCookieFile(cookieFile: string): BilibiliCookieFileStatus {
  const resolved = path.resolve(cookieFile);
  const exists = fs.existsSync(resolved);
  const permissions = permissionWarnings({ file: resolved, dir: path.dirname(resolved) });
  return {
    path: resolved,
    exists,
    fileMode: permissions.fileMode,
    dirMode: permissions.dirMode,
    secure: exists ? permissions.secure : true,
    warnings: exists ? permissions.warnings : [],
  };
}

// ── 主入口 ───────────────────────────────────────

function fail(code: BilibiliCredentialErrorCode, message: string): BilibiliCredentialResult {
  return { ok: false, error: { code, message } };
}

/**
 * 读取凭据：env `BILIBILI_COOKIE` 优先于文件。
 * 永不抛异常；失败返回带安全 message 的 error。
 */
export function loadBilibiliCredentials(options: LoadCredentialsOptions = {}): BilibiliCredentialResult {
  const env = options.env ?? process.env;
  const envCookie = (env.BILIBILI_COOKIE ?? "").trim();
  if (envCookie) {
    const parsed = parseBilibiliCookie(envCookie);
    if (!parsed) {
      log.warn("credentials.invalid_env");
      return fail("invalid_format", "BILIBILI_COOKIE 不是合法的 Cookie 字符串或 JSON（需要 SESSDATA 与 bili_jct）");
    }
    const credentials: BilibiliCredentials = {
      cookie: parsed,
      source: "env",
      path: null,
      fingerprint: bilibiliCookieFingerprint(parsed),
      secure: true,
      warnings: [],
    };
    log.info("credentials.loaded", { source: "env", fingerprint: credentials.fingerprint, uid: parsed.dedeUserId ?? null });
    return { ok: true, credentials };
  }

  const configured = (options.cookieFile ?? env.KAREN_BILIBILI_COOKIE_FILE ?? DEFAULT_COOKIE_FILE).trim();
  if (!configured) return fail("no_credentials", "未配置 BILIBILI_COOKIE 或 KAREN_BILIBILI_COOKIE_FILE");
  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved)) {
    return fail(
      "no_credentials",
      `未找到 B 站 Cookie：${resolved}（或设置 BILIBILI_COOKIE）`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    log.warn("credentials.unreadable", { path: resolved });
    return fail("unreadable", `无法读取 Cookie 文件：${resolved}`);
  }
  const parsed = parseBilibiliCookie(raw);
  if (!parsed) {
    log.warn("credentials.invalid_file", { path: resolved });
    return fail(
      "invalid_format",
      `Cookie 文件内容格式不正确（需要 JSON 或 "SESSDATA=...; bili_jct=..."）：${resolved}`,
    );
  }

  const perms = inspectBilibiliCookieFile(resolved);
  const credentials: BilibiliCredentials = {
    cookie: parsed,
    source: "file",
    path: resolved,
    fingerprint: bilibiliCookieFingerprint(parsed),
    secure: perms.secure,
    warnings: perms.warnings,
  };
  for (const warning of perms.warnings) log.warn("credentials.insecure_permissions", { path: resolved, warning });
  if (!credentials.secure && options.requireSecure) {
    return fail("insecure_permissions", perms.warnings.join("；"));
  }
  log.info("credentials.loaded", {
    source: "file",
    path: resolved,
    fingerprint: credentials.fingerprint,
    uid: parsed.dedeUserId ?? null,
    secure: credentials.secure,
  });
  return { ok: true, credentials };
}

// ── 登录态校验（只读 nav）──────────────────────────

interface NavResponse {
  code?: number;
  message?: string;
  data?: {
    isLogin?: boolean;
    mid?: number;
    uname?: string;
    level_info?: { current_level?: number };
    /** 未登录时 nav 仍会返回 wbi_img，这里不关心 */
    wbi_img?: unknown;
  };
}

/**
 * 调 `/x/web-interface/nav` 判断 Cookie 是否仍有登录态。
 * 永不抛异常；失败返回 ok:false + errorCode（不含 Cookie）。
 */
export async function verifyBilibiliLogin(
  cookie: BilibiliCookie,
  options: VerifyBilibiliLoginOptions = {},
): Promise<BilibiliLoginInfo> {
  const fingerprint = bilibiliCookieFingerprint(cookie);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.min(30_000, Math.max(2_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchFn(NAV_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://www.bilibili.com/",
        Accept: "application/json, text/plain, */*",
        Cookie: toBilibiliCookieHeader(cookie),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.warn("login.verify_http", { status: response.status, fingerprint });
      return {
        ok: false,
        loggedIn: false,
        fingerprint,
        errorCode: response.status === 412 || response.status === 429 ? "risk_control" : "http_error",
        message: `HTTP ${response.status}`,
      };
    }
    const text = await response.text();
    let body: NavResponse;
    try {
      body = JSON.parse(text) as NavResponse;
    } catch {
      return { ok: false, loggedIn: false, fingerprint, errorCode: "invalid_response", message: "响应不是 JSON" };
    }
    const data = body.data ?? {};
    if (body.code === 0 && data.isLogin === true) {
      log.info("login.verified", { fingerprint, uid: data.mid ?? null });
      return {
        ok: true,
        loggedIn: true,
        fingerprint,
        ...(typeof data.mid === "number" ? { uid: data.mid } : {}),
        ...(typeof data.uname === "string" ? { uname: data.uname } : {}),
        ...(typeof data.level_info?.current_level === "number" ? { level: data.level_info.current_level } : {}),
      };
    }
    if (body.code === -101 || data.isLogin === false) {
      log.info("login.not_logged_in", { fingerprint });
      return { ok: true, loggedIn: false, fingerprint, errorCode: "not_logged_in", message: "账号未登录或 Cookie 已失效" };
    }
    log.warn("login.verify_business", { code: body.code ?? null, fingerprint });
    return {
      ok: false,
      loggedIn: false,
      fingerprint,
      errorCode: "invalid_response",
      message: `nav 返回 code=${body.code ?? "?"}`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    log.warn("login.verify_failed", { fingerprint, reason: name });
    return {
      ok: false,
      loggedIn: false,
      fingerprint,
      errorCode: "network_error",
      message: name === "AbortError" || name === "TimeoutError" ? "请求超时" : "网络错误",
    };
  }
}

/** 读取凭据 + 校验登录态（便利函数；永不抛异常）。 */
export async function loadAndVerifyBilibiliLogin(
  options: LoadCredentialsOptions & VerifyBilibiliLoginOptions = {},
): Promise<{ credentials?: BilibiliCredentials; login?: BilibiliLoginInfo; error?: BilibiliCredentialError }> {
  const loaded = loadBilibiliCredentials(options);
  if (!loaded.ok) return { error: loaded.error };
  const login = await verifyBilibiliLogin(loaded.credentials.cookie, options);
  return { credentials: loaded.credentials, login };
}
