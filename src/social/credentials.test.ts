import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureLogger } from "../obs/logger.js";
import {
  bilibiliCookieFingerprint,
  describeBilibiliCredentials,
  inspectBilibiliCookieFile,
  loadAndVerifyBilibiliLogin,
  loadBilibiliCredentials,
  parseBilibiliCookie,
  parseBilibiliCookieJson,
  parseBilibiliCookieString,
  toBilibiliCookieHeader,
  verifyBilibiliLogin,
  type BilibiliCookie,
} from "./credentials.js";

beforeAll(() => configureLogger({ level: "error" }));

const SESSDATA = "sess-secret-abc%2C1750000000%2Cxyz";
const BILI_JCT = "csrf-token-def";
const COOKIE: BilibiliCookie = { sessData: SESSDATA, biliJct: BILI_JCT, dedeUserId: "12345" };

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-cred-"));
  tempDirs.push(dir);
  return dir;
}

function writeCookieFile(content: string, mode = 0o600): string {
  const dir = tempDir();
  const file = path.join(dir, "bilibili-cookie.json");
  fs.writeFileSync(file, content, "utf-8");
  try {
    fs.chmodSync(file, mode);
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  } catch {
    // Windows 上 chmod 可能无效；权限断言用 skipIf 跳过
  }
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  calls: Array<{ url: string; init?: RequestInit }> = [],
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SESSDATA);
  expect(serialized).not.toContain(BILI_JCT);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("credentials 解析", () => {
  it("解析 cookie 字符串（SESSDATA 里的 %2C 保持原样）", () => {
    const parsed = parseBilibiliCookieString(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}; DedeUserID=12345`);
    expect(parsed).toEqual({ sessData: SESSDATA, biliJct: BILI_JCT, dedeUserId: "12345" });
  });

  it("解析 JSON（大小写不敏感 + numeric uid）", () => {
    expect(parseBilibiliCookieJson({ SESSDATA, bili_jct: BILI_JCT, DedeUserID: 12345 })).toEqual({
      sessData: SESSDATA,
      biliJct: BILI_JCT,
      dedeUserId: "12345",
    });
  });

  it("解析 JSON 里的嵌套 cookie 字符串", () => {
    expect(parseBilibiliCookieJson({ cookie: `SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}` })).toMatchObject({
      sessData: SESSDATA,
      biliJct: BILI_JCT,
    });
  });

  it("缺少必要字段/非法格式返回 null", () => {
    expect(parseBilibiliCookieString("SESSDATA=x")).toBeNull();
    expect(parseBilibiliCookieString("bili_jct=x")).toBeNull();
    expect(parseBilibiliCookie("{bad json")).toBeNull();
    expect(parseBilibiliCookieJson({ SESSDATA })).toBeNull();
    expect(parseBilibiliCookieJson(null)).toBeNull();
    expect(parseBilibiliCookie("")).toBeNull();
  });

  it("cookie header 包含三个字段但可安全用于请求", () => {
    const header = toBilibiliCookieHeader(COOKIE);
    expect(header).toContain(`SESSDATA=${SESSDATA}`);
    expect(header).toContain(`bili_jct=${BILI_JCT}`);
    expect(header).toContain("DedeUserID=12345");
    expect(header).not.toContain("\n");
  });

  it("fingerprint 稳定、12 位 hex、不同 SESSDATA 不同", () => {
    const fp = bilibiliCookieFingerprint(COOKIE);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(bilibiliCookieFingerprint(COOKIE)).toBe(fp);
    expect(bilibiliCookieFingerprint({ sessData: `${SESSDATA}-other` })).not.toBe(fp);
    expect(fp).not.toContain(SESSDATA.slice(0, 8));
  });
});

describe("credentials 读取", () => {
  it("env BILIBILI_COOKIE（字符串）优先，不读文件", () => {
    const file = writeCookieFile(JSON.stringify({ SESSDATA: "file-sess", bili_jct: "file-csrf" }));
    const result = loadBilibiliCredentials({
      env: { BILIBILI_COOKIE: `SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`, KAREN_BILIBILI_COOKIE_FILE: file },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.source).toBe("env");
    expect(result.credentials.cookie.sessData).toBe(SESSDATA);
  });

  it("env BILIBILI_COOKIE（JSON）", () => {
    const result = loadBilibiliCredentials({
      env: { BILIBILI_COOKIE: JSON.stringify({ SESSDATA, bili_jct: BILI_JCT }) },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.source).toBe("env");
  });

  it("从 JSON 文件读取（0600 且目录 0700 时 secure=true）", () => {
    const file = writeCookieFile(JSON.stringify({ SESSDATA, bili_jct: BILI_JCT, DedeUserID: "12345" }));
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.source).toBe("file");
    expect(result.credentials.path).toBe(file);
    expect(result.credentials.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    if (process.platform !== "win32") expect(result.credentials.secure).toBe(true);
  });

  it("从 cookie 字符串文件读取", () => {
    const file = writeCookieFile(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`);
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.cookie.biliJct).toBe(BILI_JCT);
  });

  it("文件不存在 → no_credentials（message 不含 Cookie）", () => {
    const result = loadBilibiliCredentials({ env: {}, cookieFile: "/nonexistent/karen-cookie.json" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("no_credentials");
      expect(result.error.message).not.toContain(SESSDATA);
    }
  });

  it("文件格式非法 → invalid_format", () => {
    const file = writeCookieFile("not a cookie at all");
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_format");
  });

  it("文件权限过宽 → warning + secure=false（Windows 跳过）", () => {
    if (process.platform === "win32") return;
    const file = writeCookieFile(JSON.stringify({ SESSDATA, bili_jct: BILI_JCT }), 0o644);
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.secure).toBe(false);
    expect(result.credentials.warnings.join("；")).toContain("chmod 600");
  });

  it("requireSecure=true 时权限过宽直接拒绝", () => {
    if (process.platform === "win32") return;
    const file = writeCookieFile(JSON.stringify({ SESSDATA, bili_jct: BILI_JCT }), 0o644);
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file, requireSecure: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("insecure_permissions");
  });

  it("inspectBilibiliCookieFile：0600/0700 → secure；不存在 → exists=false", () => {
    const file = writeCookieFile(JSON.stringify({ SESSDATA, bili_jct: BILI_JCT }));
    const status = inspectBilibiliCookieFile(file);
    expect(status.exists).toBe(true);
    if (process.platform !== "win32") {
      expect(status.fileMode).toBe(0o600);
      expect(status.dirMode).toBe(0o700);
      expect(status.secure).toBe(true);
    }
    const missing = inspectBilibiliCookieFile("/nonexistent/dir/x.json");
    expect(missing.exists).toBe(false);
  });

  it("describeBilibiliCredentials 只含安全摘要", () => {
    const file = writeCookieFile(JSON.stringify({ SESSDATA, bili_jct: BILI_JCT, DedeUserID: "12345" }));
    const result = loadBilibiliCredentials({ env: {}, cookieFile: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const described = describeBilibiliCredentials(result.credentials);
    expect(described).toMatchObject({ source: "file", uid: "12345", secure: true });
    expectNoSecrets(described);
  });
});

describe("verifyBilibiliLogin（只读 nav）", () => {
  it("isLogin=true → loggedIn + uid/uname/level；结果不含 Cookie", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = mockFetch(
      () =>
        jsonResponse({
          code: 0,
          data: { isLogin: true, mid: 42, uname: "小雅", level_info: { current_level: 5 } },
        }),
      calls,
    );
    const info = await verifyBilibiliLogin(COOKIE, { fetchFn });
    expect(info).toMatchObject({ ok: true, loggedIn: true, uid: 42, uname: "小雅", level: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/x/web-interface/nav");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cookie")).toContain(`SESSDATA=${SESSDATA}`);
    expectNoSecrets(info);
  });

  it("code=-101 / isLogin=false → not_logged_in，不抛异常", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ code: -101, message: "账号未登录", data: { isLogin: false } }));
    const info = await verifyBilibiliLogin(COOKIE, { fetchFn });
    expect(info.ok).toBe(true);
    expect(info.loggedIn).toBe(false);
    expect(info.errorCode).toBe("not_logged_in");
    expectNoSecrets(info);
  });

  it("HTTP 412 → risk_control（失败但不抛）", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = mockFetch(() => new Response("blocked", { status: 412 }), calls);
    const info = await verifyBilibiliLogin(COOKIE, { fetchFn });
    expect(info).toMatchObject({ ok: false, loggedIn: false, errorCode: "risk_control" });
    expect(calls).toHaveLength(1);
  });

  it("网络错误/超时 → network_error，错误信息不含 Cookie", async () => {
    const fetchFn = mockFetch(() => {
      throw new DOMException(`aborted with SESSDATA=${SESSDATA}`, "AbortError");
    });
    const info = await verifyBilibiliLogin(COOKIE, { fetchFn, timeoutMs: 2000 });
    expect(info.errorCode).toBe("network_error");
    expect(info.message).toBe("请求超时");
    expectNoSecrets(info);
  });

  it("非 JSON 响应 → invalid_response", async () => {
    const fetchFn = mockFetch(() => new Response("<html>risk</html>", { status: 200 }));
    const info = await verifyBilibiliLogin(COOKIE, { fetchFn });
    expect(info.errorCode).toBe("invalid_response");
  });

  it("loadAndVerifyBilibiliLogin：无凭据返回 error，不抛", async () => {
    const result = await loadAndVerifyBilibiliLogin({ env: {}, cookieFile: "/nonexistent/x.json" });
    expect(result.error?.code).toBe("no_credentials");
    expect(result.credentials).toBeUndefined();
  });
});
