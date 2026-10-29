/**
 * B 站写接口 SPIKE（仅测试小号；默认 dry-run，不写）。
 *
 * 用法：
 *   npm run social:spike -- --read
 *   KAREN_SOCIAL_SPIKE=1 npm run social:spike -- --action comment --bvid BV1... --text "测试评论" --confirm
 *   KAREN_SOCIAL_SPIKE=1 npm run social:spike -- --action dynamic --text "测试动态" --confirm
 *   KAREN_SOCIAL_SPIKE=1 npm run social:spike -- --action like --bvid BV1... --confirm
 *   npm run social:spike -- --action delete-comment --bvid BV1... --rpid 123
 *
 * 安全：没有 --confirm 只走 dry-run；没有 KAREN_SOCIAL_SPIKE=1 不允许真写；
 * 不打印 Cookie；不做风控对抗。
 */
import "dotenv/config";
import { parseBilibiliVideoRef, fetchBilibiliVideoDetail } from "../src/world/bilibili.js";
import { createBilibiliAuthClient } from "../src/social/bilibili-auth.js";
import { loadBilibiliCredentials, verifyBilibiliLogin } from "../src/social/credentials.js";
import { loadSocialConfig } from "../src/social/config.js";
import type { SocialTarget } from "../src/social/types.js";

interface Args {
  action?: string;
  bvid?: string;
  rpid?: string;
  text?: string;
  confirm: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { confirm: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm") out.confirm = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--action") out.action = argv[++i];
    else if (a === "--bvid") out.bvid = argv[++i];
    else if (a === "--rpid") out.rpid = argv[++i];
    else if (a === "--text") out.text = argv[++i];
  }
  return out;
}

const HELP = `social:spike（默认 dry-run）
  --read
  --action comment --bvid BV... --text 正文 [--confirm]
  --action dynamic --text 正文 [--confirm]
  --action like --bvid BV... [--confirm]
  --action delete-comment --bvid BV... --rpid 123 [--confirm]
真写需要 KAREN_SOCIAL_SPIKE=1 且 --confirm；只在小号上测试。`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.action && process.argv.length <= 2)) {
    console.log(HELP);
    return;
  }
  const config = loadSocialConfig();
  const loaded = loadBilibiliCredentials({ cookieFile: config.cookieFile });
  if (!loaded.ok) {
    console.error(`❌ 无 Cookie：${loaded.error.code}；请放到 ${config.cookieFile}`);
    process.exitCode = 1;
    return;
  }
  const login = await verifyBilibiliLogin(loaded.credentials.cookie);
  console.log(`login=${login.loggedIn} uid=${login.uid ?? "-"} uname=${login.uname ?? "-"} fingerprint=${login.fingerprint}`);
  if (!login.loggedIn) {
    console.error(`❌ 未登录：${login.errorCode ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  const enabled = process.env.KAREN_SOCIAL_SPIKE === "1";
  const dryRun = !args.confirm || !enabled;
  console.log(`action=${args.action ?? "read"} dryRun=${dryRun}${dryRun ? "（未真实写）" : "（真实写）"}`);
  const auth = createBilibiliAuthClient({ dryRun, cookieFile: config.cookieFile });

  const targetFor = async (): Promise<SocialTarget | null> => {
    if (!args.bvid) return null;
    const ref = parseBilibiliVideoRef(args.bvid);
    if (!ref) return null;
    const detail = await fetchBilibiliVideoDetail(args.bvid);
    if (!detail) return null;
    return { platform: "bilibili", targetType: "video", targetId: detail.bvid, title: detail.title, url: detail.url, aid: detail.aid };
  };

  if (!args.action || args.action === "read") {
    console.log("✅ 登录/读态 OK；未指定 --action，未执行写操作。");
    return;
  }
  if (args.action === "dynamic") {
    if (!args.text) throw new Error("dynamic 需要 --text");
    const result = await auth.postDynamic(args.text);
    console.log(JSON.stringify(result));
    return;
  }
  const target = await targetFor();
  if (!target) throw new Error(`无法解析/读取视频：${args.bvid ?? "（缺 --bvid）"}`);
  if (args.action === "comment") {
    if (!args.text) throw new Error("comment 需要 --text");
    console.log(JSON.stringify(await auth.comment(target, args.text)));
  } else if (args.action === "like") {
    console.log(JSON.stringify(await auth.like(target)));
  } else if (args.action === "delete-comment") {
    if (!args.rpid) throw new Error("delete-comment 需要 --rpid");
    console.log(JSON.stringify(await auth.deleteComment(target, args.rpid)));
  } else {
    throw new Error(`未知 action：${args.action}`);
  }
}

main().catch((err) => {
  console.error(`social spike failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
