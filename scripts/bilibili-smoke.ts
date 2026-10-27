#!/usr/bin/env node
/**
 * B 站只读真实链路冒烟（P1，2026-10-27）。
 *
 * 验证内容：
 * 1. 热门 digest 真实取到 ≥3 条内容（标题/UP/播放量/链接）；
 * 2. 视频详情 + 评论摘要真实可取，且 30–60 分钟缓存生效（同一视频只请求一次 view）；
 * 3. 搜索（WBI 签名）与排行端点按实际可用性报告，不假装全部可用；
 * 4. 只读约束：所有出站请求都是 GET、无 cookie / authorization、credentials=omit；
 * 5. 注入 prompt 的文本长度在预算内（≤460 字/块）。
 *
 * 不写入任何文件、不提交 token/cookie；只读公开接口。
 * 用法：
 *   PATH=$PWD/.runtime/node22/bin:$PATH npx tsx scripts/bilibili-smoke.ts
 */
import {
  BILIBILI_PROMPT_MAX_CHARS,
  fetchBilibiliRanking,
  formatBilibiliDigestContext,
  formatBilibiliShareContext,
  getBilibiliDigest,
  loadBilibiliConfig,
  lookupBilibiliShare,
  resetBilibiliCache,
  searchBilibiliVideos,
  type BilibiliConfig,
} from "../src/world/bilibili.js";

interface CapturedRequest {
  url: string;
  method: string;
  credentials?: RequestCredentials;
  headers: Headers;
}

const captured: CapturedRequest[] = [];
const realFetch = globalThis.fetch.bind(globalThis);

// 包装 fetch 只为审计请求头/方法；不改变任何请求。
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  captured.push({
    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    method: init?.method ?? "GET",
    credentials: init?.credentials,
    headers: new Headers(init?.headers),
  });
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

function ok(condition: boolean, message: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) process.exitCode = 1;
}

function printVideo(index: number, video: { title: string; owner: string; views: number; url: string }): void {
  const views = video.views >= 10_000 ? `${(video.views / 10_000).toFixed(1)}万` : String(video.views);
  console.log(`  ${index}. 「${video.title}」 — ${video.owner || "（无UP）"} / ${views}播放`);
  console.log(`     ${video.url}`);
}

async function main(): Promise<number> {
  const base = loadBilibiliConfig();
  // 冒烟不受 NODE_ENV=test 默认关闭影响，显式启用；也不改任何真实环境变量。
  const config: BilibiliConfig = { ...base, enabled: true, minGapMs: Math.min(base.minGapMs, 300) };
  resetBilibiliCache();

  console.log("— B 站只读真实链路冒烟 —");
  console.log(`  TTL=${Math.round(config.cacheTtlMs / 60_000)}min / 日上限=${config.dailyMax} / 超时=${config.timeoutMs}ms`);

  // 1) 热门 digest
  const startedAt = Date.now();
  const digest = await getBilibiliDigest(undefined, config);
  const digestMs = Date.now() - startedAt;
  if (!digest) {
    console.error("  ✗ 热门 digest 取不到（网络/风控？）");
    return 1;
  }
  console.log(`  digest: ${digest.items.length} 条（source=${digest.source}, ${digestMs}ms）`);
  const top3 = digest.items.slice(0, 3);
  ok(top3.length >= 3, `真实取到 ${top3.length}/3 条热门内容`);
  top3.forEach((video, index) => printVideo(index + 1, video));
  const digestBlock = formatBilibiliDigestContext(top3);
  console.log(`  prompt 注入块：${digestBlock.length} 字（预算 ≤${BILIBILI_PROMPT_MAX_CHARS}）`);
  ok(digestBlock.length <= BILIBILI_PROMPT_MAX_CHARS + 1, "digest 注入块在预算内");

  // 2) 视频详情 + 评论摘要（同一 BV 调两次，验证缓存）
  const target = top3[0];
  const beforeViewCalls = captured.filter((request) => request.url.includes("/x/web-interface/view")).length;
  const detail = target ? await lookupBilibiliShare(`https://www.bilibili.com/video/${target.bvid}`, undefined, config) : null;
  const detail2 = target ? await lookupBilibiliShare(`BV 号 ${target.bvid}`, undefined, config) : null;
  const afterViewCalls = captured.filter((request) => request.url.includes("/x/web-interface/view")).length;
  if (!detail) {
    console.error("  ✗ 视频详情取不到");
    process.exitCode = 1;
  } else {
    console.log(`  详情: 「${detail.title}」 / ${detail.owner || "（无UP）"} / 评论 ${detail.comments.length} 条摘要（共 ${detail.commentsTotal}）`);
    if (detail.comments[0]) console.log(`     热评 @${detail.comments[0].author}：${detail.comments[0].text}`);
    const shareBlock = formatBilibiliShareContext(detail);
    console.log(`  分享注入块：${shareBlock.length} 字（预算 ≤${BILIBILI_PROMPT_MAX_CHARS}）`);
    ok(shareBlock.length <= BILIBILI_PROMPT_MAX_CHARS + 1, "share 注入块在预算内");
    ok(Boolean(detail2), "BV 号也能直接解析（第二次调用）");
    ok(afterViewCalls - beforeViewCalls <= 1, `缓存生效：view 只请求 ${afterViewCalls - beforeViewCalls} 次`);
  }

  // 3) 搜索（WBI）；按实际可用性报告
  const searchStarted = Date.now();
  const searchResults = await searchBilibiliVideos("猫", 3, undefined, config);
  const searchMs = Date.now() - searchStarted;
  if (searchResults.length > 0) {
    console.log(`  搜索: ${searchResults.length} 条（${searchMs}ms）`);
    searchResults.forEach((video, index) => printVideo(index + 1, video));
  } else {
    console.log(`  搜索: ⚠️ 当前不可用/受限（${searchMs}ms）— WBI 签名或风控；已按降级处理，不影响主链路`);
  }

  // 4) 排行；按实际可用性报告（本机多次请求后常见 -352）
  const rankingStarted = Date.now();
  const ranking = await fetchBilibiliRanking(3, undefined, config);
  const rankingMs = Date.now() - rankingStarted;
  if (ranking.length > 0) {
    console.log(`  排行: ${ranking.length} 条（${rankingMs}ms）`);
    ranking.forEach((video, index) => printVideo(index + 1, video));
  } else {
    console.log(`  排行: ⚠️ 当前被风控（${rankingMs}ms，常见 -352）；保留实现但默认降级到热门`);
  }

  // 5) 只读审计
  const writes = captured.filter((request) => request.method !== "GET");
  const cookies = captured.filter((request) => request.headers.get("cookie") !== null);
  const auth = captured.filter((request) => request.headers.get("authorization") !== null);
  const notOmit = captured.filter((request) => request.credentials !== undefined && request.credentials !== "omit");
  ok(writes.length === 0, `只读：${captured.length} 个请求全部 GET`);
  ok(cookies.length === 0, "只读：无任何 cookie 请求头");
  ok(auth.length === 0, "只读：无 authorization 请求头");
  ok(notOmit.length === 0, "只读：credentials=omit");
  const hosts = [...new Set(captured.map((request) => new URL(request.url).host))];
  console.log(`  请求主机：${hosts.join(", ")}（共 ${captured.length} 次）`);

  const totalMs = Date.now() - startedAt;
  console.log(`— 完成：${process.exitCode ? "有失败项" : "全部通过"} / ${totalMs}ms —`);
  if (!process.exitCode) {
    console.log("  注意：本工具不登录、不带 cookie、不评论/弹幕/点赞；仅使用公开只读接口。");
  }
  return process.exitCode ?? 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("冒烟异常：", error instanceof Error ? error.message : error);
    process.exit(1);
  });
