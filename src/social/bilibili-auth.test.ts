import { beforeAll, describe, expect, it, vi } from "vitest";
import { configureLogger } from "../obs/logger.js";
import {
  BILIBILI_WRITE_ENDPOINTS,
  createBilibiliAuthClient,
  mapBilibiliErrorCode,
  type BilibiliAuthOptions,
} from "./bilibili-auth.js";
import type { SocialTarget } from "./types.js";

beforeAll(() => configureLogger({ level: "error" }));

const SESSDATA = "sess-secret-abc";
const BILI_JCT = "csrf-token-def";
const UID = "12345";

const COOKIE = { sessData: SESSDATA, biliJct: BILI_JCT, dedeUserId: UID };

const VIDEO: SocialTarget = {
  platform: "bilibili",
  targetType: "video",
  targetId: "BV1aaaaaaaaa",
  aid: 956789,
  title: "测试视频",
  authorUid: "777",
};

const DYNAMIC: SocialTarget = {
  platform: "bilibili",
  targetType: "dynamic",
  targetId: "1057955152016703512",
};

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: Partial<BilibiliAuthOptions> = {},
  calls: CapturedCall[] = [],
): { client: ReturnType<typeof createBilibiliAuthClient>; calls: CapturedCall[] } {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const client = createBilibiliAuthClient({ cookie: COOKIE, fetchFn, dryRun: false, ...options });
  return { client, calls };
}

function bodyOf(call: CapturedCall | undefined): URLSearchParams {
  expect(call?.init?.body).toBeTruthy();
  return new URLSearchParams(String(call?.init?.body ?? ""));
}

function headerOf(call: CapturedCall | undefined, name: string): string {
  return new Headers(call?.init?.headers).get(name) ?? "";
}

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SESSDATA);
  expect(serialized).not.toContain(BILI_JCT);
}

describe("错误码映射", () => {
  it("常见业务码映射为稳定错误码", () => {
    expect(mapBilibiliErrorCode(-101)).toBe("not_logged_in");
    expect(mapBilibiliErrorCode(-111)).toBe("csrf_failed");
    expect(mapBilibiliErrorCode(-352)).toBe("risk_control");
    expect(mapBilibiliErrorCode(-412)).toBe("risk_control");
    expect(mapBilibiliErrorCode(12002)).toBe("comments_closed");
    expect(mapBilibiliErrorCode(34002)).toBe("cannot_coin_self");
    expect(mapBilibiliErrorCode(999999)).toBe("bili_code_999999");
  });
});

describe("dryRun 与凭据", () => {
  it("dryRun 只做预览，不发请求、不需要 Cookie", async () => {
    const calls: CapturedCall[] = [];
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const client = createBilibiliAuthClient({ dryRun: true, fetchFn: fetchFn as unknown as typeof fetch, env: {} });
    const result = await client.comment(VIDEO, "她看到这个视频觉得很有意思");
    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({ dryRun: true, contentLength: 13 });
    expect(String(result.meta?.endpoint)).toContain("/x/v2/reply/add");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expectNoSecrets(result);
  });

  it("非 dryRun 且无凭据 → no_credentials，不联网", async () => {
    const { client, calls } = makeClient(
      () => jsonResponse({ code: 0 }),
      { cookie: undefined, env: {}, cookieFile: "/nonexistent/cookie.json" },
    );
    const result = await client.comment(VIDEO, "hello");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("no_credentials");
    expect(calls).toHaveLength(0);
    expectNoSecrets(result);
  });

  it("verifyLogin 成功返回 uid/uname，且结果不含 Cookie", async () => {
    const { client } = makeClient(() =>
      jsonResponse({ code: 0, data: { isLogin: true, mid: 42, uname: "小雅", level_info: { current_level: 6 } } }),
    );
    const status = await client.verifyLogin();
    expect(status).toMatchObject({ ok: true, loggedIn: true, uid: 42, uname: "小雅" });
    expectNoSecrets(status);
  });

  it("verifyLogin 无凭据 → no_credentials", async () => {
    const client = createBilibiliAuthClient({ dryRun: false, env: {}, cookieFile: "/nonexistent/x.json" });
    const status = await client.verifyLogin();
    expect(status.errorCode).toBe("no_credentials");
    expect(status.loggedIn).toBe(false);
  });
});

describe("评论 / 回复 / 删除", () => {
  it("comment 成功：端点/表单/Cookie/CSRF 正确，返回 rpid 且不含敏感信息", async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ code: 0, message: "0", data: { rpid: 123456789, rpid_str: "123456789" } }),
    );
    const result = await client.comment(VIDEO, "这个视频拍得挺舒服的");
    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("123456789");
    expect(result.undoable).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.comment);
    expect(calls[0]?.init?.method).toBe("POST");
    const body = bodyOf(calls[0]);
    expect(body.get("oid")).toBe("956789");
    expect(body.get("type")).toBe("1");
    expect(body.get("message")).toBe("这个视频拍得挺舒服的");
    expect(body.get("csrf")).toBe(BILI_JCT);
    expect(headerOf(calls[0], "cookie")).toContain(`SESSDATA=${SESSDATA}`);
    expect(headerOf(calls[0], "content-type")).toContain("application/x-www-form-urlencoded");
    expect(result.meta).toMatchObject({ endpoint: "/x/v2/reply/add", contentLength: 10, attempts: 1 });
    expectNoSecrets(result);
    expect(String(result.meta?.contentLength)).not.toContain("这个视频");
  });

  it("comment -111 → csrf_failed，不重试", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: -111, message: "csrf校验失败" }));
    const result = await client.comment(VIDEO, "hello");
    expect(result).toMatchObject({ ok: false, errorCode: "csrf_failed" });
    expect(calls).toHaveLength(1);
    expectNoSecrets(result);
  });

  it("comment -101 → not_logged_in", async () => {
    const { client } = makeClient(() => jsonResponse({ code: -101, message: "账号未登录" }));
    const result = await client.comment(VIDEO, "hello");
    expect(result.errorCode).toBe("not_logged_in");
  });

  it("reply 带 root/parent，端点与 comment 相同", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: { rpid_str: "222" } }));
    const result = await client.reply(VIDEO, "回复一下", "111");
    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("222");
    const body = bodyOf(calls[0]);
    expect(body.get("root")).toBe("111");
    expect(body.get("parent")).toBe("111");
    expect(body.get("oid")).toBe("956789");
  });

  it("deleteComment：type/oid/rpid/csrf 正确", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    const result = await client.deleteComment(VIDEO, "333");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.deleteComment);
    const body = bodyOf(calls[0]);
    expect(body.get("oid")).toBe("956789");
    expect(body.get("rpid")).toBe("333");
    expect(body.get("type")).toBe("1");
  });
});

describe("风控 / 重试 / 超时", () => {
  it("HTTP 412 → risk_control，不重试", async () => {
    const { client, calls } = makeClient(() => new Response("blocked", { status: 412 }));
    const result = await client.comment(VIDEO, "hello");
    expect(result).toMatchObject({ ok: false, errorCode: "risk_control" });
    expect(calls).toHaveLength(1);
  });

  it("HTTP 500 + 非 JSON：最多重试 1 次，最终 invalid_response", async () => {
    const sleeps: number[] = [];
    const { client, calls } = makeClient(() => new Response("<html>server error</html>", { status: 500 }), {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await client.like(VIDEO);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("网络超时重试 1 次后失败为 network_error；错误信息不含 Cookie", async () => {
    const sleeps: number[] = [];
    const { client, calls } = makeClient(
      () => {
        throw new DOMException(`aborted SESSDATA=${SESSDATA}`, "AbortError");
      },
      {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const result = await client.like(VIDEO);
    expect(result).toMatchObject({ ok: false, errorCode: "network_error", reason: "请求超时" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expectNoSecrets(result);
  });

  it("同步抛错也不冒泡（永不抛异常）", async () => {
    const { client } = makeClient(() => {
      throw new Error(`sync boom SESSDATA=${SESSDATA}`);
    });
    await expect(client.like(VIDEO)).resolves.toMatchObject({ ok: false, errorCode: "network_error" });
  });
});

describe("视频互动 / 动态 / 关系", () => {
  it("like/unlike 视频：like=1/0 + aid", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    await client.like(VIDEO);
    await client.unlike(VIDEO);
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.videoLike);
    expect(bodyOf(calls[0]).get("like")).toBe("1");
    expect(bodyOf(calls[0]).get("aid")).toBe("956789");
    expect(bodyOf(calls[1]).get("like")).toBe("0");
  });

  it("like/unlike 动态：JSON body + csrf 在 query", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    await client.like(DYNAMIC);
    await client.unlike(DYNAMIC);
    expect(calls[0]?.url).toContain(BILIBILI_WRITE_ENDPOINTS.dynamicLike);
    expect(calls[0]?.url).toContain(`csrf=${BILI_JCT}`);
    expect(headerOf(calls[0], "content-type")).toContain("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ dyn_id_str: DYNAMIC.targetId, up: 1 });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ dyn_id_str: DYNAMIC.targetId, up: 2 });
  });

  it("coin：multiply 只允许 1/2", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    await client.coin(VIDEO, 2);
    expect(bodyOf(calls[0]).get("multiply")).toBe("2");
    expect(bodyOf(calls[0]).get("select_like")).toBe("0");
    await client.coin(VIDEO, 5 as unknown as 1 | 2);
    expect(bodyOf(calls[1]).get("multiply")).toBe("1");
  });

  it("follow/unfollow：fid + act=1/2 + re_src", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    await client.follow(VIDEO);
    await client.unfollow("777");
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.relationModify);
    expect(bodyOf(calls[0]).get("fid")).toBe("777");
    expect(bodyOf(calls[0]).get("act")).toBe("1");
    expect(bodyOf(calls[0]).get("re_src")).toBe("11");
    expect(bodyOf(calls[1]).get("act")).toBe("2");
  });

  it("favorite 缺少收藏夹 id → invalid_target，不联网；成功后 add_media_ids", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    const invalid = await client.favorite(VIDEO, "");
    expect(invalid).toMatchObject({ ok: false, errorCode: "invalid_target" });
    expect(calls).toHaveLength(0);
    const ok = await client.favorite(VIDEO, "11823061");
    expect(ok.ok).toBe(true);
    expect(bodyOf(calls[0]).get("add_media_ids")).toBe("11823061");
    expect(bodyOf(calls[0]).get("rid")).toBe("956789");
  });

  it("unfavorite 使用 del_media_ids", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    await client.unfavorite(VIDEO, "11823061");
    expect(bodyOf(calls[0]).get("del_media_ids")).toBe("11823061");
  });

  it("share：bvid 或 aid + source", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: 3 }));
    const target: SocialTarget = { platform: "bilibili", targetType: "video", targetId: "BV1aaaaaaaaa" };
    await client.share(target);
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.share);
    expect(bodyOf(calls[0]).get("bvid")).toBe("BV1aaaaaaaaa");
    expect(bodyOf(calls[0]).get("source")).toBe("web_normal");
  });
});

describe("动态发布 / 删除 / 参数校验", () => {
  it("postDynamic：api.vc 端点 + 固定字段 + csrf_token/csrf", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: { dynamic_id_str: "999", dynamic_id: 999 } }));
    const result = await client.postDynamic("今天在店里遇到一只猫");
    expect(result.ok).toBe(true);
    expect(result.externalId).toBe("999");
    expect(calls[0]?.url).toBe(BILIBILI_WRITE_ENDPOINTS.postDynamic);
    const body = bodyOf(calls[0]);
    expect(body.get("type")).toBe("4");
    expect(body.get("dynamic_id")).toBe("0");
    expect(body.get("content")).toBe("今天在店里遇到一只猫");
    expect(body.get("csrf")).toBe(BILI_JCT);
    expect(body.get("csrf_token")).toBe(BILI_JCT);
  });

  it("deleteDynamic：dynamic_id + csrf_token/csrf", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0, data: {} }));
    const result = await client.deleteDynamic(999);
    expect(result.ok).toBe(true);
    const body = bodyOf(calls[0]);
    expect(body.get("dynamic_id")).toBe("999");
    expect(body.get("csrf_token")).toBe(BILI_JCT);
  });

  it("评论区只有 BV（无 aid）→ invalid_target，不发请求", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0 }));
    const result = await client.comment({ platform: "bilibili", targetType: "video", targetId: "BV1aaaaaaaaa" }, "hello");
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_target" });
    expect(calls).toHaveLength(0);
  });

  it("空内容 / 超长内容在本地拦截", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0 }));
    expect((await client.comment(VIDEO, "   ")).errorCode).toBe("invalid_content");
    expect((await client.postDynamic("x".repeat(2001))).errorCode).toBe("invalid_content");
    expect(calls).toHaveLength(0);
  });

  it("平台不匹配 → invalid_target，不联网", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ code: 0 }));
    const result = await client.like({ platform: "qzone", targetType: "video", targetId: "x", aid: 1 });
    expect(result.errorCode).toBe("invalid_target");
    expect(calls).toHaveLength(0);
  });
});
