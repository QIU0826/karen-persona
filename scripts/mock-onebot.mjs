#!/usr/bin/env node
/**
 * mock-onebot.mjs — 模拟 NapCatQQ 的「反向 WebSocket 客户端」，用于没有 QQ 账号时
 * 对 `npm run qq`（src/bridge/qq.ts）做端到端联调。
 *
 * 它做的事：
 *   1. 连接 Karen 的 OneBot 11 反向 WS 服务端（默认 ws://127.0.0.1:18080/onebot/v11/ws）；
 *   2. 通过 Authorization: Bearer 或 ?access_token= 传 token（两种 Karen 都支持）；
 *   3. 发一条私聊消息事件（post_type=message / message_type=private）；
 *   4. 打印 Karen 发回的 API 调用（重点是 send_private_msg 的回复内容）；
 *   5. 对带 echo 的 API 请求回一个成功响应（如 Karen 回查引用消息的 get_msg）；
 *   6. 收到回复后短暂等待流式片段，然后退出；超时退出。
 *
 * 零新依赖：只用项目已有的 ws（node_modules/ws），不安装任何东西。
 *
 * 用法：
 *   node scripts/mock-onebot.mjs
 *   node scripts/mock-onebot.mjs --token "$ONE_BOT_TOKEN" --text "你好呀" --seconds 60
 *   node scripts/mock-onebot.mjs --port 18099 --path /onebot/v11/ws --user-id 100000001
 *   node scripts/mock-onebot.mjs --token xxx --token-in query   # 走 ?access_token= 校验
 *
 * 退出码：
 *   0  联调通过：收到至少一条 send_private_msg（她回复了）
 *   1  已连接并发出事件，但 --seconds 内没等到回复（可加大 --seconds 或检查白名单/LLM Key）
 *   2  连接失败（Karen 未启动 / 端口不对）
 *   3  握手被拒（HTTP 401 token 不匹配 / 404 path 不匹配）
 *   4  参数错误
 */

import { WebSocket } from "ws";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "18080";
const DEFAULT_PATH = "/onebot/v11/ws";
const DEFAULT_USER_ID = "100000001";
const DEFAULT_SELF_ID = "100000000";
const DEFAULT_SECONDS = "40";
const DEFAULT_IDLE_EXIT_MS = "2000";

const HELP = `
mock-onebot.mjs — 模拟 NapCat 反向 WS 客户端，联调 Karen QQ 桥接

用法: node scripts/mock-onebot.mjs [选项]

连接：
  --url <url>           完整 WS 地址（优先于 host/port/path），默认 ws://127.0.0.1:18080/onebot/v11/ws
  --host <host>         主机，默认 127.0.0.1
  --port <port>         端口，默认 18080
  --path <path>         路径，默认 /onebot/v11/ws
  --token <token>       握手 token，默认取环境变量 ONE_BOT_TOKEN
  --token-in <mode>     header（默认）| query | both —— token 的传递方式

消息：
  --user-id <qq>        发消息的 QQ 号，默认 ${DEFAULT_USER_ID}（需在 allowed_users 白名单中）
  --self-id <qq>        机器人（小号）QQ 号，默认 ${DEFAULT_SELF_ID}
  --nickname <name>     发送者昵称，默认「联调测试」
  --text <text>         消息内容，默认「你好呀，今天过得怎么样？」

超时：
  --seconds <n>         最长等待秒数（从连接成功算起），默认 ${DEFAULT_SECONDS}
  --idle-exit <ms>      收到第一条回复后再等多久以收齐流式片段，默认 ${DEFAULT_IDLE_EXIT_MS}ms
  -h, --help            显示本帮助

退出码: 0=收到回复  1=超时无回复  2=连接失败  3=握手被拒  4=参数错误
`;

function parseArgs(argv) {
  const opts = {
    url: "",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    path: DEFAULT_PATH,
    token: process.env.ONE_BOT_TOKEN ?? "",
    tokenIn: "header",
    userId: Number(DEFAULT_USER_ID),
    selfId: Number(DEFAULT_SELF_ID),
    nickname: "联调测试",
    text: "你好呀，今天过得怎么样？",
    seconds: Number(DEFAULT_SECONDS),
    idleExitMs: Number(DEFAULT_IDLE_EXIT_MS),
  };

  const needValue = (name, i) => {
    if (i + 1 >= argv.length) {
      console.error(`[错误] ${name} 需要一个值`);
      process.exit(4);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        console.log(HELP.trim());
        process.exit(0);
        break;
      case "--url":
        opts.url = needValue(arg, i);
        i++;
        break;
      case "--host":
        opts.host = needValue(arg, i);
        i++;
        break;
      case "--port":
        opts.port = needValue(arg, i);
        i++;
        break;
      case "--path":
        opts.path = needValue(arg, i);
        i++;
        break;
      case "--token":
        opts.token = needValue(arg, i);
        i++;
        break;
      case "--token-in":
        opts.tokenIn = needValue(arg, i).toLowerCase();
        i++;
        break;
      case "--user-id":
        opts.userId = Number(needValue(arg, i));
        i++;
        break;
      case "--self-id":
        opts.selfId = Number(needValue(arg, i));
        i++;
        break;
      case "--nickname":
        opts.nickname = needValue(arg, i);
        i++;
        break;
      case "--text":
        opts.text = needValue(arg, i);
        i++;
        break;
      case "--seconds":
        opts.seconds = Number(needValue(arg, i));
        i++;
        break;
      case "--idle-exit":
        opts.idleExitMs = Number(needValue(arg, i));
        i++;
        break;
      default:
        console.error(`[错误] 未知参数: ${arg}（用 --help 查看用法）`);
        process.exit(4);
    }
  }

  if (!["header", "query", "both"].includes(opts.tokenIn)) {
    console.error(`[错误] --token-in 只能是 header / query / both（当前: ${opts.tokenIn}）`);
    process.exit(4);
  }
  if (!Number.isInteger(opts.userId) || opts.userId <= 0) {
    console.error("[错误] --user-id 必须是正整数 QQ 号");
    process.exit(4);
  }
  if (!Number.isInteger(opts.selfId) || opts.selfId <= 0) {
    console.error("[错误] --self-id 必须是正整数 QQ 号");
    process.exit(4);
  }
  if (!Number.isFinite(opts.seconds) || opts.seconds <= 0) {
    console.error("[错误] --seconds 必须是正数");
    process.exit(4);
  }
  if (!Number.isFinite(opts.idleExitMs) || opts.idleExitMs < 0) {
    console.error("[错误] --idle-exit 必须是非负数（毫秒）");
    process.exit(4);
  }
  return opts;
}

function buildUrl(opts) {
  const base = opts.url || `ws://${opts.host}:${opts.port}${opts.path}`;
  let url;
  try {
    url = new URL(base);
  } catch {
    console.error(`[错误] 无效的 WS 地址: ${base}`);
    process.exit(4);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    console.error(`[错误] 地址必须是 ws:// 或 wss://（当前: ${url.protocol}）`);
    process.exit(4);
  }
  if (opts.token && (opts.tokenIn === "query" || opts.tokenIn === "both")) {
    url.searchParams.set("access_token", opts.token);
  }
  return url.toString();
}

function maskToken(token) {
  if (!token) return "(未设置)";
  return token.length <= 6 ? "***" : `${token.slice(0, 2)}***${token.slice(-2)}`;
}

function truncate(text, max = 160) {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** 私聊消息事件（字段与 OneBot 11 / NapCat 实际上报一致，兼容 Karen 的 parseEvent） */
function buildPrivateMessageEvent(opts) {
  const messageId = Date.now() % 1_000_000_000;
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: opts.selfId,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: messageId,
    user_id: opts.userId,
    message: opts.text,
    raw_message: opts.text,
    font: 14,
    sender: {
      user_id: opts.userId,
      nickname: opts.nickname,
      sex: "unknown",
      age: 0,
    },
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = buildUrl(opts);

  const headers = {};
  if (opts.token && (opts.tokenIn === "header" || opts.tokenIn === "both")) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   mock-onebot — 模拟 NapCat 反向 WS 客户端   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`[连接] ${url}`);
  console.log(`[token] ${maskToken(opts.token)}（传递方式: ${opts.tokenIn}）`);
  console.log(`[事件] 私聊 from ${opts.userId}（${opts.nickname}）: ${truncate(opts.text)}`);
  console.log(`[超时] 最长 ${opts.seconds}s；收到回复后 ${opts.idleExitMs}ms 无新片段即退出\n`);

  let connected = false;
  let eventSent = false;
  let finished = false;
  const apiCalls = [];
  const sendPrivateCalls = [];
  const timers = new Set();

  const ws = new WebSocket(url, { headers });

  const addTimer = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  let idleTimer = null;
  const armIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = addTimer(() => finish(0, "已收到回复（空闲退出）"), opts.idleExitMs);
  };

  function finish(code, reason, extra = "") {
    if (finished) return;
    finished = true;
    clearTimers();
    if (idleTimer) clearTimeout(idleTimer);

    console.log(`\n──── 结果 ────`);
    console.log(`握手连接: ${connected ? "✅" : "❌"} | 事件已发送: ${eventSent ? "✅" : "❌"}`);
    console.log(`API 调用: ${apiCalls.length} 条 | send_private_msg: ${sendPrivateCalls.length} 条`);
    if (sendPrivateCalls.length > 0) {
      console.log("她的回复：");
      for (const msg of sendPrivateCalls) console.log(`  ↳ ${truncate(msg, 300)}`);
    }
    if (extra) console.log(extra);
    console.log(`退出码: ${code}（${reason}）`);

    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "mock done");
      }
    } catch {
      // 忽略关闭异常
    }
    setTimeout(() => process.exit(code), 150);
  }

  // 握手被服务端拒绝（401 token / 404 path）时触发
  ws.on("unexpected-response", (_req, res) => {
    const bodyHint =
      res.statusCode === 401
        ? "token 不匹配（检查 --token 与 Karen 的 ONE_BOT_TOKEN）"
        : res.statusCode === 404
          ? "path 不匹配（检查 --path 与 Karen 的 ONE_BOT_WS_PATH）"
          : "检查 Karen 的握手校验配置";
    finish(3, `握手被拒 HTTP ${res.statusCode} ${res.statusMessage || ""}；${bodyHint}`);
  });

  ws.on("open", () => {
    connected = true;
    console.log("✅ WS 握手成功，连接已建立");
    addTimer(() => {
      if (finished) return;
      const event = buildPrivateMessageEvent(opts);
      ws.send(JSON.stringify(event));
      eventSent = true;
      console.log(`→ 已发送私聊事件（message_id=${event.message_id}, user_id=${event.user_id}）`);
    }, 250);

    addTimer(() => {
      finish(
        sendPrivateCalls.length > 0 ? 0 : 1,
        sendPrivateCalls.length > 0 ? "超时前已收到回复" : "超时，未收到 send_private_msg",
      );
    }, opts.seconds * 1000);
  });

  ws.on("message", (data) => {
    const raw = data.toString();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.log(`[WS] 收到非 JSON 数据 ${raw.length}B`);
      return;
    }

    // Karen 的入站事件一般不会发给客户端，这里只做提示（比如 future 的 meta_event）
    if (payload && typeof payload.post_type === "string") {
      console.log(`[事件] post_type=${payload.post_type}（忽略）`);
      return;
    }

    // Karen 的 API 请求：{ action, params, echo? }
    if (payload && typeof payload.action === "string") {
      apiCalls.push(payload.action);
      if (payload.action === "send_private_msg") {
        const target = payload.params?.user_id;
        const message = typeof payload.params?.message === "string" ? payload.params.message : JSON.stringify(payload.params?.message);
        sendPrivateCalls.push(message);
        console.log(`[API] send_private_msg -> user_id=${target} message="${truncate(message, 200)}"`);
        armIdleExit();
      } else {
        console.log(`[API] ${payload.action} params=${truncate(JSON.stringify(payload.params ?? {}), 200)}`);
      }

      // 带 echo 的请求需要响应（Karen 的 callApiAsync 依赖 echo 匹配）
      if (typeof payload.echo === "string") {
        ws.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: {},
            echo: payload.echo,
          }),
        );
      }
      return;
    }

    // 非事件、非 action 的普通 API 响应（echo 已由 Karen 处理，这里仅打印）
    if (payload && typeof payload.retcode === "number") {
      console.log(`[WS] 收到 API 响应 retcode=${payload.retcode}`);
    }
  });

  ws.on("ping", () => {
    // ws 库自动回 pong；这里只提示心跳，避免刷屏不打印
  });

  ws.on("error", (err) => {
    if (finished) return;
    console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    if (!connected) {
      finish(
        2,
        "连接失败：确认 Karen 已 `npm run qq` 常驻、端口/路径正确、没有防火墙拦截",
      );
    }
  });

  ws.on("close", (code, reasonBuf) => {
    if (finished) return;
    const reason = reasonBuf?.toString() || "";
    console.log(`[WS] 连接关闭 code=${code}${reason ? ` reason=${reason}` : ""}`);
    if (sendPrivateCalls.length > 0) {
      finish(0, "连接关闭前已收到回复");
    } else if (eventSent) {
      finish(1, "连接关闭且未收到回复");
    } else {
      finish(2, "连接关闭且事件未发出");
    }
  });
}

// 兜底：不让一个未捕获异常留下悬挂进程
process.on("unhandledRejection", (reason) => {
  console.error(`[兜底] 未处理的 Promise 拒绝: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

main();
