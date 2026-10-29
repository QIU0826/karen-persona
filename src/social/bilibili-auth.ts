/**
 * B 站登录态写客户端（Social P1）。
 *
 * 边界（与 types.ts/config.ts 的设计一致，但本文件不修改它们）：
 * - 所有写动作必须经过上层社交引擎（policy/runner/审批），本客户端只负责「带 Cookie+CSRF 发请求」；
 * - 永不抛异常：任何失败都返回 `SocialActionResult{ok:false,errorCode,reason}`；
 * - `dryRun` 默认开启：只做参数校验并返回预览，不发网络请求；生产 runner 必须显式传 `dryRun:false`；
 * - Cookie 只在请求构造时出现（header），不进日志/不进结果/meta；CSRF 从 `bili_jct`；
 * - 不做风控对抗：412/-352/-412/509 不重试；只有网络错误/超时/5xx/429 最多重试 1 次；
 * - 端点以 bilibili-API-collect 文档为准；不确定的标 SPIKE（见 docs/SOCIAL_BILIBILI_API.md）。
 *
 * 端点状态（SPIKE = 文档/实际行为待真实 Cookie 验证）：
 * - comment / deleteComment / like / unlike / coin / follow / unfollow：文档明确，SPIKE 程度低；
 * - favorite / unfavorite（/x/v3/fav/resource/deal）：SPIKE（本仓文档未直接覆盖该 URL）；
 * - postDynamic / deleteDynamic（api.vc）：SPIKE；
 * - share（/x/web-interface/share/add）：SPIKE（文档鉴权写的是 buvid3，实际 Cookie 也可用，待验证）；
 * - 动态点赞（/x/dynamic/feed/dyn/thumb，JSON body + csrf query）：SPIKE。
 */
import { createLogger } from "../obs/logger.js";
import {
  bilibiliCookieFingerprint,
  loadBilibiliCredentials,
  toBilibiliCookieHeader,
  verifyBilibiliLogin,
  type BilibiliCookie,
  type BilibiliCredentialError,
  type BilibiliLoginInfo,
} from "./credentials.js";
import type { SocialActionType, SocialActionResult, SocialTarget } from "./types.js";

const log = createLogger("social.bilibili");

const API = "https://api.bilibili.com";
const VC_API = "https://api.vc.bilibili.com";

/** 写端点（集中定义，便于审计/文档/测试；不要在这些字符串里拼 Cookie）。 */
export const BILIBILI_WRITE_ENDPOINTS = {
  comment: `${API}/x/v2/reply/add`,
  deleteComment: `${API}/x/v2/reply/del`,
  videoLike: `${API}/x/web-interface/archive/like`,
  dynamicLike: `${API}/x/dynamic/feed/dyn/thumb`,
  coin: `${API}/x/web-interface/coin/add`,
  favoriteDeal: `${API}/x/v3/fav/resource/deal`,
  relationModify: `${API}/x/relation/modify`,
  share: `${API}/x/web-interface/share/add`,
  postDynamic: `${VC_API}/dynamic_svr/v1/dynamic_svr/create`,
  deleteDynamic: `${VC_API}/dynamic_svr/v1/dynamic_svr/rm_dynamic`,
  nav: `${API}/x/web-interface/nav`,
} as const;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 400;
const MAX_COMMENT_CHARS = 1000;
const MAX_DYNAMIC_CHARS = 2000;

export interface BilibiliAuthOptions {
  /** 显式 Cookie（测试/上层注入；优先于文件/env） */
  cookie?: BilibiliCookie;
  /** 覆盖 cookie 文件路径（相对 process.cwd()） */
  cookieFile?: string;
  /** 测试用 env（默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** 默认 true：不真正写；生产必须显式传 false */
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface BilibiliAuthLoginStatus extends BilibiliLoginInfo {
  credentialSource?: "env" | "file" | "explicit";
  secure?: boolean;
  warnings?: string[];
}

export interface BilibiliAuthClient {
  readonly dryRun: boolean;
  verifyLogin(): Promise<BilibiliAuthLoginStatus>;
  comment(target: SocialTarget, content: string, opts?: CommentOptions): Promise<SocialActionResult>;
  reply(target: SocialTarget, content: string, root: string | number, parent?: string | number): Promise<SocialActionResult>;
  deleteComment(target: SocialTarget, rpid: string | number): Promise<SocialActionResult>;
  postDynamic(content: string): Promise<SocialActionResult>;
  deleteDynamic(dynamicId: string | number): Promise<SocialActionResult>;
  like(target: SocialTarget): Promise<SocialActionResult>;
  unlike(target: SocialTarget): Promise<SocialActionResult>;
  favorite(target: SocialTarget, folderId: string | number): Promise<SocialActionResult>;
  unfavorite(target: SocialTarget, folderId: string | number): Promise<SocialActionResult>;
  coin(target: SocialTarget, multiply?: 1 | 2): Promise<SocialActionResult>;
  follow(targetOrUid: SocialTarget | string | number): Promise<SocialActionResult>;
  unfollow(targetOrUid: SocialTarget | string | number): Promise<SocialActionResult>;
  share(target: SocialTarget): Promise<SocialActionResult>;
}

export interface CommentOptions {
  /** 根评论 rpid（二级评论/回复时必填） */
  root?: string | number;
  /** 父评论 rpid（不传时默认等于 root） */
  parent?: string | number;
}

// ── 错误码映射 ────────────────────────────────────

const BILI_ERROR_MAP: Record<string, string> = {
  "-101": "not_logged_in",
  "-102": "account_banned",
  "-104": "insufficient_coins",
  "-111": "csrf_failed",
  "-352": "risk_control",
  "-400": "invalid_request",
  "-403": "forbidden",
  "-404": "not_found",
  "-412": "risk_control",
  "-509": "rate_limited",
  "65004": "unlike_failed",
  "65006": "already_liked",
  "71000": "duplicate_share",
  "10003": "video_not_found",
  "11010": "content_not_exist",
  "12002": "comments_closed",
  "12003": "reply_forbidden",
  "12006": "comment_not_found",
  "12009": "invalid_target_type",
  "12015": "captcha_required",
  "12016": "sensitive_content",
  "12022": "comment_deleted",
  "12025": "content_too_long",
  "12035": "blocked_by_up",
  "12045": "purchase_required",
  "12051": "duplicate_comment",
  "12052": "comments_closed",
  "34002": "cannot_coin_self",
  "34003": "invalid_coin_amount",
  "34004": "coin_interval_too_short",
  "34005": "coin_limit_exceeded",
  "4100001": "invalid_params",
};

/** bilibili 业务码 → 稳定的错误码（未知码返回 `bili_code_<code>`）。 */
export function mapBilibiliErrorCode(code: number): string {
  return BILI_ERROR_MAP[String(code)] ?? `bili_code_${code}`;
}

/** 风控/限流错误码（一律不自动重试）。 */
export function isRiskControlError(code: string): boolean {
  return code === "risk_control" || code === "rate_limited" || code === "account_banned";
}

// ── 内部工具 ──────────────────────────────────────

function endpointPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname;
  } catch {
    return endpoint;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimContent(value: string): string {
  return (value ?? "").trim();
}

function targetIsBilibili(target: SocialTarget): boolean {
  return !!target && target.platform === "bilibili";
}

function targetTypeOf(target: SocialTarget): string | null {
  return target && typeof target.targetType === "string" ? target.targetType : null;
}

/** 视频引用：aid 或 bvid（至少一个）。 */
function videoRefOf(target: SocialTarget): { aid?: number; bvid?: string } | null {
  const aid = Number(target.aid);
  if (Number.isFinite(aid) && aid > 0) return { aid: Math.floor(aid) };
  const raw = String(target.targetId ?? "").trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(raw)) return { bvid: raw };
  if (/^\d{1,15}$/.test(raw)) return { aid: Number(raw) };
  return null;
}

/** 评论 oid 必须是 aid（B 站评论区 oid=aid）；只有 BV 时需先解析，当前返回 null。 */
function aidOf(target: SocialTarget): number | null {
  const aid = Number(target.aid);
  if (Number.isFinite(aid) && aid > 0) return Math.floor(aid);
  const raw = String(target.targetId ?? "").trim();
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  return null;
}

function uidOf(targetOrUid: SocialTarget | string | number): string | null {
  if (typeof targetOrUid === "number" || typeof targetOrUid === "string") {
    const raw = String(targetOrUid).trim();
    return /^\d{1,20}$/.test(raw) ? raw : null;
  }
  const fromAuthor = stringOf(targetOrUid.authorUid);
  if (fromAuthor && /^\d{1,20}$/.test(fromAuthor)) return fromAuthor;
  const fromTarget = stringOf(targetOrUid.targetId);
  return fromTarget && /^\d{1,20}$/.test(fromTarget) ? fromTarget : null;
}

/** 构造表单 body（undefined 值不发送）。 */
export function buildFormBody(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.append(key, String(value));
  }
  return search.toString();
}

interface RequestSpec {
  action: SocialActionType;
  endpoint: string;
  /** 表单/JSON 二选一 */
  form?: Record<string, string | number | undefined>;
  json?: unknown;
  /** URL query（动态点赞的 csrf 必须放 query；不要写进日志） */
  query?: Record<string, string>;
  /** 是否在结果里标 undoable */
  undoable: boolean;
  targetType: string | null;
  contentLength?: number;
  /** 从 data 中提取外部 id */
  externalId?: (data: unknown) => string | undefined;
}

interface CredentialState {
  cookie: BilibiliCookie;
  fingerprint: string;
  source: "env" | "file" | "explicit";
  secure: boolean;
  warnings: string[];
}

interface HttpOutcome {
  ok: boolean;
  status?: number;
  code?: number;
  message?: string;
  data?: unknown;
  errorCode?: string;
  reason?: string;
  attempts: number;
}

type ExecuteResult = SocialActionResult;

function failure(
  action: SocialActionType,
  errorCode: string,
  reason: string,
  extra?: Partial<SocialActionResult>,
): SocialActionResult {
  return {
    ok: false,
    platform: "bilibili",
    action,
    errorCode,
    reason,
    ...extra,
  };
}

function success(
  action: SocialActionType,
  request: RequestSpec,
  outcome: HttpOutcome,
  extraMeta: Record<string, unknown>,
): SocialActionResult {
  let externalId: string | undefined;
  if (request.externalId && outcome.data !== undefined) {
    try {
      externalId = request.externalId(outcome.data);
    } catch {
      externalId = undefined;
    }
  }
  return {
    ok: true,
    platform: "bilibili",
    action,
    ...(externalId ? { externalId } : {}),
    undoable: request.undoable,
    meta: {
      endpoint: endpointPath(request.endpoint),
      httpStatus: outcome.status ?? null,
      biliCode: outcome.code ?? null,
      attempts: outcome.attempts,
      targetType: request.targetType,
      ...(request.contentLength !== undefined ? { contentLength: request.contentLength } : {}),
      ...extraMeta,
    },
  };
}

export function createBilibiliAuthClient(options: BilibiliAuthOptions = {}): BilibiliAuthClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.min(60_000, Math.max(2_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const retryDelayMs = Math.min(5_000, Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const sleepFn = options.sleepFn ?? sleepReal;
  const dryRun = options.dryRun ?? true;

  let cached: CredentialState | null = null;
  let lastError: BilibiliCredentialError | null = null;

  function resolveCredentials(): { ok: true; state: CredentialState } | { ok: false; error: BilibiliCredentialError } {
    if (cached) return { ok: true, state: cached };
    if (options.cookie) {
      const state: CredentialState = {
        cookie: options.cookie,
        fingerprint: bilibiliCookieFingerprint(options.cookie),
        source: "explicit",
        secure: true,
        warnings: [],
      };
      cached = state;
      return { ok: true, state };
    }
    if (lastError && lastError.code === "invalid_format") return { ok: false, error: lastError };
    const loaded = loadBilibiliCredentials({ env: options.env, cookieFile: options.cookieFile });
    if (!loaded.ok) {
      lastError = loaded.error;
      return { ok: false, error: loaded.error };
    }
    const state: CredentialState = {
      cookie: loaded.credentials.cookie,
      fingerprint: loaded.credentials.fingerprint,
      source: loaded.credentials.source,
      secure: loaded.credentials.secure,
      warnings: loaded.credentials.warnings,
    };
    cached = state;
    lastError = null;
    return { ok: true, state };
  }

  function credentialMeta(state: CredentialState): Record<string, unknown> {
    return { credentialSource: state.source, credentialSecure: state.secure, credentialWarnings: state.warnings.length };
  }

  function riskErrorFromStatus(status: number): string | null {
    if (status === 412) return "risk_control";
    if (status === 429) return "rate_limited";
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    return null;
  }

  async function send(request: RequestSpec, state: CredentialState): Promise<HttpOutcome> {
    const csrf = state.cookie.biliJct;
    const form = request.form
      ? {
          ...request.form,
          csrf,
          // 少数旧接口要求同时带 csrf_token（两者都是 bili_jct）；用占位符在唯一入口替换
          ...(Object.values(request.form).includes("__csrf__") ? { csrf_token: csrf } : {}),
        }
      : undefined;
    const query = new URLSearchParams(request.query ?? {});
    // 写接口的 csrf 放 query 的端点（动态点赞）只在这一处拼接；日志只记录 path
    if (request.query) query.set("csrf", csrf);
    const url = query.toString() ? `${request.endpoint}?${query.toString()}` : request.endpoint;
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Referer: "https://www.bilibili.com/",
      Accept: "application/json, text/plain, */*",
      Cookie: toBilibiliCookieHeader(state.cookie),
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (request.json !== undefined) headers["Content-Type"] = "application/json";

    let attempts = 0;
    let last: HttpOutcome = { ok: false, attempts: 0, errorCode: "network_error", reason: "not sent" };
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts = attempt;
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers,
          ...(form ? { body: buildFormBody(form) } : {}),
          ...(request.json !== undefined ? { body: JSON.stringify(request.json) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const status = response.status;
        const riskCode = riskErrorFromStatus(status);
        const text = await response.text();
        if (riskCode) {
          last = {
            ok: false,
            status,
            attempts,
            errorCode: riskCode,
            reason: `HTTP ${status}（风控/限流/权限；不绕过）`,
          };
          // 429 最多重试 1 次；412/401/403 一律不重试（避免加剧风控）
          if (status === 429 && attempt < 2) {
            await sleepFn(retryDelayMs);
            continue;
          }
          break;
        }
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          last = { ok: false, status, attempts, errorCode: "invalid_response", reason: "响应不是 JSON" };
          if (status >= 500 && attempt < 2) {
            await sleepFn(retryDelayMs);
            continue;
          }
          break;
        }
        const code = Number(body.code);
        if (Number.isFinite(code) && code === 0) {
          last = { ok: true, status, attempts, code, message: stringOf(body.message), data: body.data };
          break;
        }
        const mapped = Number.isFinite(code) ? mapBilibiliErrorCode(code) : "invalid_response";
        last = {
          ok: false,
          status,
          attempts,
          code: Number.isFinite(code) ? code : undefined,
          message: stringOf(body.message),
          errorCode: mapped,
          reason: mapped,
        };
        // 风控/登录/csrf/参数错误：重试没有意义，直接失败
        if (isRiskControlError(mapped) || mapped === "not_logged_in" || mapped === "csrf_failed") break;
        if (attempt < 2 && (status >= 500 || status === 429)) {
          await sleepFn(retryDelayMs);
          continue;
        }
        break;
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        last = {
          ok: false,
          attempts,
          errorCode: "network_error",
          reason: name === "AbortError" || name === "TimeoutError" ? "请求超时" : "网络错误",
        };
        if (attempt < 2) {
          await sleepFn(retryDelayMs);
          continue;
        }
      }
    }
    return last;
  }

  async function execute(request: RequestSpec): Promise<ExecuteResult> {
    const action = request.action;
    try {
      // dryRun：不读 Cookie、不联网；只返回可审计的预览
      if (dryRun) {
        log.info("write.dry_run", {
          action,
          endpoint: endpointPath(request.endpoint),
          targetType: request.targetType,
          contentLength: request.contentLength ?? 0,
        });
        return {
          ok: true,
          platform: "bilibili",
          action,
          undoable: request.undoable,
          meta: {
            dryRun: true,
            endpoint: endpointPath(request.endpoint),
            targetType: request.targetType,
            ...(request.contentLength !== undefined ? { contentLength: request.contentLength } : {}),
            attempts: 0,
          },
        };
      }

      const resolved = resolveCredentials();
      if (!resolved.ok) {
        log.warn("write.no_credentials", { action, code: resolved.error.code });
        return failure(action, resolved.error.code, resolved.error.message, {
          meta: { endpoint: endpointPath(request.endpoint), attempts: 0 },
        });
      }
      const outcome = await send(request, resolved.state);
      if (outcome.ok) {
        log.info("write.sent", {
          action,
          endpoint: endpointPath(request.endpoint),
          attempts: outcome.attempts,
          fingerprint: resolved.state.fingerprint,
        });
        return success(action, request, outcome, credentialMeta(resolved.state));
      }
      log.warn("write.failed", {
        action,
        endpoint: endpointPath(request.endpoint),
        errorCode: outcome.errorCode ?? "unknown",
        httpStatus: outcome.status ?? null,
        biliCode: outcome.code ?? null,
        attempts: outcome.attempts,
        fingerprint: resolved.state.fingerprint,
      });
      return failure(action, outcome.errorCode ?? "unknown_error", outcome.reason ?? outcome.errorCode ?? "未知错误", {
        meta: {
          endpoint: endpointPath(request.endpoint),
          httpStatus: outcome.status ?? null,
          biliCode: outcome.code ?? null,
          attempts: outcome.attempts,
          ...credentialMeta(resolved.state),
        },
      });
    } catch (error) {
      // 最后一道闸：任何意外都不能把异常抛给上层（更不允许带 Cookie 的 error 冒泡）
      const name = error instanceof Error ? error.name : "unknown";
      log.error("write.internal_error", { action, reason: name });
      return failure(action, "internal_error", "内部错误（已捕获）", {
        meta: { endpoint: endpointPath(request.endpoint), attempts: 0 },
      });
    }
  }

  function commonTargetFailure(action: SocialActionType, target: SocialTarget, reason: string): SocialActionResult {
    const meta: Record<string, unknown> = { targetType: targetTypeOf(target) };
    return failure(action, "invalid_target", reason, { meta });
  }

  return {
    dryRun,
    async verifyLogin(): Promise<BilibiliAuthLoginStatus> {
      try {
        const resolved = resolveCredentials();
        if (!resolved.ok) {
          return {
            ok: false,
            loggedIn: false,
            fingerprint: "",
            errorCode: "no_credentials",
            message: resolved.error.message,
          };
        }
        const login = await verifyBilibiliLogin(resolved.state.cookie, { fetchFn, timeoutMs });
        return {
          ...login,
          credentialSource: resolved.state.source,
          secure: resolved.state.secure,
          warnings: resolved.state.warnings,
        };
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        log.error("login.internal_error", { reason: name });
        return { ok: false, loggedIn: false, fingerprint: "", errorCode: "invalid_response", message: "内部错误（已捕获）" };
      }
    },

    async comment(target, content, opts = {}): Promise<SocialActionResult> {
      return executeSafe("comment", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("comment", target, "target.platform 不是 bilibili");
        const aid = aidOf(target);
        if (!aid) return commonTargetFailure("comment", target, "评论需要 video aid（BV 号需先解析为 aid）");
        const text = trimContent(content);
        if (!text) return failure("comment", "invalid_content", "评论内容为空");
        if (Array.from(text).length > MAX_COMMENT_CHARS) {
          return failure("comment", "invalid_content", `评论内容超过 ${MAX_COMMENT_CHARS} 字`);
        }
        const root = opts.root !== undefined ? stringOf(opts.root) : undefined;
        const parent = opts.parent !== undefined ? stringOf(opts.parent) : root;
        return execute({
          action: "comment",
          endpoint: BILIBILI_WRITE_ENDPOINTS.comment,
          form: { oid: aid, type: 1, message: text, root, parent },
          undoable: true,
          targetType: "video",
          contentLength: Array.from(text).length,
          externalId: (data) => {
            const record = asRecord(data);
            return stringOf(record?.rpid_str) ?? stringOf(record?.rpid);
          },
        });
      });
    },

    async reply(target, content, root, parent): Promise<SocialActionResult> {
      return executeSafe("reply", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("reply", target, "target.platform 不是 bilibili");
        const aid = aidOf(target);
        if (!aid) return commonTargetFailure("reply", target, "回复需要 video aid（BV 号需先解析为 aid）");
        const rootRpid = stringOf(root);
        if (!rootRpid) return failure("reply", "invalid_target", "回复需要 root 评论 rpid");
        const text = trimContent(content);
        if (!text) return failure("reply", "invalid_content", "回复内容为空");
        if (Array.from(text).length > MAX_COMMENT_CHARS) {
          return failure("reply", "invalid_content", `回复内容超过 ${MAX_COMMENT_CHARS} 字`);
        }
        return execute({
          action: "reply",
          endpoint: BILIBILI_WRITE_ENDPOINTS.comment,
          form: { oid: aid, type: 1, message: text, root: rootRpid, parent: stringOf(parent) ?? rootRpid },
          undoable: true,
          targetType: "comment",
          contentLength: Array.from(text).length,
          externalId: (data) => {
            const record = asRecord(data);
            return stringOf(record?.rpid_str) ?? stringOf(record?.rpid);
          },
        });
      });
    },

    async deleteComment(target, rpid): Promise<SocialActionResult> {
      return executeSafe("delete_comment", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("delete_comment", target, "target.platform 不是 bilibili");
        const aid = aidOf(target);
        if (!aid) return commonTargetFailure("delete_comment", target, "删除评论需要 video aid");
        const rpidStr = stringOf(rpid);
        if (!rpidStr) return failure("delete_comment", "invalid_target", "缺少评论 rpid");
        return execute({
          action: "delete_comment",
          endpoint: BILIBILI_WRITE_ENDPOINTS.deleteComment,
          form: { type: 1, oid: aid, rpid: rpidStr },
          undoable: false,
          targetType: "comment",
        });
      });
    },

    async postDynamic(content): Promise<SocialActionResult> {
      return executeSafe("dynamic", () => {
        const text = trimContent(content);
        if (!text) return failure("dynamic", "invalid_content", "动态内容为空");
        if (Array.from(text).length > MAX_DYNAMIC_CHARS) {
          return failure("dynamic", "invalid_content", `动态内容超过 ${MAX_DYNAMIC_CHARS} 字`);
        }
        return execute({
          action: "dynamic",
          endpoint: BILIBILI_WRITE_ENDPOINTS.postDynamic,
          // SPIKE：api.vc 动态创建接口（dynamic_id/type/rid 为文档固定传参）
          form: { dynamic_id: 0, type: 4, rid: 0, content: text, csrf_token: "__csrf__" },
          undoable: true,
          targetType: "none",
          contentLength: Array.from(text).length,
          externalId: (data) => {
            const record = asRecord(data);
            return stringOf(record?.dynamic_id_str) ?? stringOf(record?.dynamic_id);
          },
        });
      });
    },

    async deleteDynamic(dynamicId): Promise<SocialActionResult> {
      return executeSafe("delete_dynamic", () => {
        const id = stringOf(dynamicId);
        if (!id || !/^\d{1,25}$/.test(id)) return failure("delete_dynamic", "invalid_target", "缺少合法的 dynamic_id");
        return execute({
          action: "delete_dynamic",
          endpoint: BILIBILI_WRITE_ENDPOINTS.deleteDynamic,
          // SPIKE：文档同时要求 csrf_token 与 csrf（两种后端校验）
          form: { dynamic_id: id, csrf_token: "__csrf__" },
          undoable: false,
          targetType: "dynamic",
        });
      });
    },

    async like(target): Promise<SocialActionResult> {
      return executeSafe("like", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("like", target, "target.platform 不是 bilibili");
        if (target.targetType === "dynamic") {
          const dynId = stringOf(target.targetId);
          if (!dynId || !/^\d{1,25}$/.test(dynId)) return commonTargetFailure("like", target, "动态点赞需要 dynamic_id");
          return execute({
            action: "like",
            endpoint: BILIBILI_WRITE_ENDPOINTS.dynamicLike,
            // SPIKE：JSON body + csrf 放 query（文档明确）
            query: { csrf: "" },
            json: { dyn_id_str: dynId, up: 1 },
            undoable: true,
            targetType: "dynamic",
          });
        }
        const ref = videoRefOf(target);
        if (!ref) return commonTargetFailure("like", target, "点赞需要 video aid 或 BV 号");
        return execute({
          action: "like",
          endpoint: BILIBILI_WRITE_ENDPOINTS.videoLike,
          form: { ...ref, like: 1 },
          undoable: true,
          targetType: "video",
        });
      });
    },

    async unlike(target): Promise<SocialActionResult> {
      return executeSafe("unlike", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("unlike", target, "target.platform 不是 bilibili");
        if (target.targetType === "dynamic") {
          const dynId = stringOf(target.targetId);
          if (!dynId || !/^\d{1,25}$/.test(dynId)) return commonTargetFailure("unlike", target, "取消动态点赞需要 dynamic_id");
          return execute({
            action: "unlike",
            endpoint: BILIBILI_WRITE_ENDPOINTS.dynamicLike,
            query: { csrf: "" },
            json: { dyn_id_str: dynId, up: 2 },
            undoable: false,
            targetType: "dynamic",
          });
        }
        const ref = videoRefOf(target);
        if (!ref) return commonTargetFailure("unlike", target, "取消点赞需要 video aid 或 BV 号");
        return execute({
          action: "unlike",
          endpoint: BILIBILI_WRITE_ENDPOINTS.videoLike,
          form: { ...ref, like: 0 },
          undoable: false,
          targetType: "video",
        });
      });
    },

    async favorite(target, folderId): Promise<SocialActionResult> {
      return executeSafe("favorite", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("favorite", target, "target.platform 不是 bilibili");
        const aid = aidOf(target);
        if (!aid) return commonTargetFailure("favorite", target, "收藏需要 video aid");
        const folder = stringOf(folderId);
        if (!folder || !/^\d{1,20}$/.test(folder)) return failure("favorite", "invalid_target", "收藏需要合法的收藏夹 id");
        return execute({
          action: "favorite",
          endpoint: BILIBILI_WRITE_ENDPOINTS.favoriteDeal,
          // SPIKE：/x/v3/fav/resource/deal 的参数与返回待真实 Cookie 验证
          form: { rid: aid, type: 2, add_media_ids: folder },
          undoable: true,
          targetType: "video",
        });
      });
    },

    async unfavorite(target, folderId): Promise<SocialActionResult> {
      return executeSafe("unfavorite", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("unfavorite", target, "target.platform 不是 bilibili");
        const aid = aidOf(target);
        if (!aid) return commonTargetFailure("unfavorite", target, "取消收藏需要 video aid");
        const folder = stringOf(folderId);
        if (!folder || !/^\d{1,20}$/.test(folder)) return failure("unfavorite", "invalid_target", "取消收藏需要合法的收藏夹 id");
        return execute({
          action: "unfavorite",
          endpoint: BILIBILI_WRITE_ENDPOINTS.favoriteDeal,
          form: { rid: aid, type: 2, del_media_ids: folder },
          undoable: false,
          targetType: "video",
        });
      });
    },

    async coin(target, multiply = 1): Promise<SocialActionResult> {
      return executeSafe("coin", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("coin", target, "target.platform 不是 bilibili");
        const ref = videoRefOf(target);
        if (!ref) return commonTargetFailure("coin", target, "投币需要 video aid 或 BV 号");
        const amount = multiply === 2 ? 2 : 1;
        return execute({
          action: "coin",
          endpoint: BILIBILI_WRITE_ENDPOINTS.coin,
          form: { ...ref, multiply: amount, select_like: 0 },
          undoable: false,
          targetType: "video",
        });
      });
    },

    async follow(targetOrUid): Promise<SocialActionResult> {
      return executeSafe("follow", () => {
        const fid = uidOf(targetOrUid);
        if (!fid) return failure("follow", "invalid_target", "关注需要目标用户 uid");
        return execute({
          action: "follow",
          endpoint: BILIBILI_WRITE_ENDPOINTS.relationModify,
          form: { fid, act: 1, re_src: 11 },
          undoable: true,
          targetType: "user",
        });
      });
    },

    async unfollow(targetOrUid): Promise<SocialActionResult> {
      return executeSafe("unfollow", () => {
        const fid = uidOf(targetOrUid);
        if (!fid) return failure("unfollow", "invalid_target", "取关需要目标用户 uid");
        return execute({
          action: "unfollow",
          endpoint: BILIBILI_WRITE_ENDPOINTS.relationModify,
          form: { fid, act: 2, re_src: 11 },
          undoable: false,
          targetType: "user",
        });
      });
    },

    async share(target): Promise<SocialActionResult> {
      return executeSafe("share", () => {
        if (!targetIsBilibili(target)) return commonTargetFailure("share", target, "target.platform 不是 bilibili");
        const ref = videoRefOf(target);
        if (!ref) return commonTargetFailure("share", target, "分享需要 video aid 或 BV 号");
        return execute({
          action: "share",
          endpoint: BILIBILI_WRITE_ENDPOINTS.share,
          // SPIKE：文档鉴权写 buvid3；实际 Cookie 也可能可用，待验证
          form: { ...ref, source: "web_normal" },
          undoable: false,
          targetType: "video",
        });
      });
    },
  };

  async function executeSafe(
    action: SocialActionType,
    fn: () => Promise<SocialActionResult> | SocialActionResult,
  ): Promise<SocialActionResult> {
    try {
      return await fn();
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      log.error("write.internal_error", { action, reason: name });
      return failure(action, "internal_error", "内部错误（已捕获）");
    }
  }
}
