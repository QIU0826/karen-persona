/**
 * 社会化只读冒烟：验证 B 站 Cookie/登录态 + 读流 + 草稿安全，不执行任何写操作。
 *
 * 用法：npm run social:smoke
 * 有 Cookie 时输出 uid/uname/fingerprint、热门候选、生成一条评论草稿；
 * 没有 Cookie 时打印放置路径，退出码 1（不抛异常）。
 */
import "dotenv/config";
import { loadSocialConfig } from "../src/social/config.js";
import { loadBilibiliCredentials, verifyBilibiliLogin } from "../src/social/credentials.js";
import { getBilibiliDigest, rankBilibiliForPersona } from "../src/world/bilibili.js";
import { generateCommentDraft } from "../src/social/drafts.js";
import { isCommentRelevant, validateSocialContent } from "../src/social/safety.js";

async function main(): Promise<void> {
  const config = loadSocialConfig();
  console.log(`mode=${config.mode} dryRun=${config.dryRun} cookieFile=${config.cookieFile}`);
  const loaded = loadBilibiliCredentials({ cookieFile: config.cookieFile });
  if (!loaded.ok) {
    console.error(`❌ 未找到可用 Cookie：${loaded.error.code}（${loaded.error.message}）`);
    console.error(`把 B 站小号 Cookie 放到 ${config.cookieFile}（0600），格式 {"SESSDATA":"...","bili_jct":"...","DedeUserID":"..."}。`);
    process.exitCode = 1;
    return;
  }
  const login = await verifyBilibiliLogin(loaded.credentials.cookie);
  console.log(`login=${login.loggedIn} uid=${login.uid ?? "-"} uname=${login.uname ?? "-"} fingerprint=${login.fingerprint}`);
  if (!login.loggedIn) {
    console.error(`❌ Cookie 未登录/已失效：${login.errorCode ?? "unknown"}（${login.message ?? ""}）`);
    process.exitCode = 1;
    return;
  }
  const digest = await getBilibiliDigest();
  if (!digest || digest.items.length === 0) {
    console.error("❌ 读流为空（网络/风控）");
    process.exitCode = 1;
    return;
  }
  const ranked = rankBilibiliForPersona(digest.items, ["咖啡", "生活", "猫", "音乐", "电影"], 5);
  console.log(`digest source=${digest.source} items=${ranked.length}`);
  for (const item of ranked.slice(0, 5)) {
    console.log(`- ${item.bvid} ${item.title.slice(0, 60)}（aid=${item.aid}）`);
  }
  const first = ranked.find((item) => validateSocialContent(item.title, { maxChars: 120 }).ok);
  if (!first) {
    console.error("❌ 没有通过安全过滤的候选");
    process.exitCode = 1;
    return;
  }
  const draft = await generateCommentDraft(
    {
      name: "小雅",
      identity: { lifeStory: { career: "咖啡店店员", currentStatus: "上海" } },
    } as never,
    { title: first.title, desc: first.desc, owner: first.owner, keywords: ["咖啡", "生活"] },
    "social smoke",
  );
  if (!draft) {
    console.error("❌ 草稿生成/安全校验未通过（这是正常兜底，不是崩溃）");
    process.exitCode = 1;
    return;
  }
  const check = validateSocialContent(draft.content, { maxChars: 120 });
  console.log(`draft=${JSON.stringify(draft.content)} safe=${check.ok} relevant=${isCommentRelevant(draft.content, { title: first.title, description: first.desc })}`);
  console.log("✅ 只读链路 OK；未执行任何写操作。");
}

main().catch((err) => {
  console.error(`social smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
