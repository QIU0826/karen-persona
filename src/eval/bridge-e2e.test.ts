/**
 * QQ 桥接端到端集成测试（不需要 QQ / NapCat / 真实模型）。
 *
 * 结构：
 * - fake DeepSeek：本地 HTTP 服务，模拟 OpenAI 兼容接口（非流式 / SSE 流式 / 视觉）；
 * - 临时工作区：写一份只用于测试的 config.yaml，`KAREN_DATA_DIR` 指向临时目录；
 * - 真实 bridge 子进程：`tsx src/bridge/qq.ts`，随机端口启动反向 WS 服务；
 * - 测试进程扮演 NapCat：连接 WS、发 OneBot 事件、收集 `send_*` action。
 *
 * 覆盖主链路：
 * 1. 新用户第一条私聊 → AI 披露 + 18+ 年龄门确认请求；
 * 2. 回复「我成年了」→ 确认并放行；
 * 3. 普通私聊 → 流式回复（SSE）；
 * 4. 图片消息 → 视觉描述请求（fake 服务断言 image_url）；
 * 5. 群聊 @ → 群回复。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_QQ = 100000001;
const TEST_QQ2 = 100000002;
const BOT_QQ = 100000000;
const GROUP_ID = 999001;
const WS_PATH = "/onebot/v11/ws";
const WS_TOKEN = "e2e-token";

/** 1x1 透明 PNG（足够通过文件头识别/vision 请求）。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let bridgeOutputTail = "";
let currentBridge: ChildProcess | null = null;
let wsClosed = "";

interface FakeOpenAi {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function pickNonStreamReply(body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body.messages ?? []);
  if (serialized.includes("image_url")) return "这是一张测试图片，画面里有一只橘猫。";
  if (serialized.includes("信息抽取器")) return JSON.stringify({ facts: [] });
  if (serialized.includes("候选") || serialized.includes("编号")) return "[]";
  return "嗯我在听";
}

function sseChunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/img.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
      res.end(PNG_BYTES);
      return;
    }
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push(body);
      const model = String(body.model ?? "deepseek-flash");

      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // 两段 delta，最后带 usage + finish；bridge 会拼成「嗯我在听」
        res.write(sseChunk(model, { content: "嗯我" }, null));
        res.write(sseChunk(model, { content: "在听" }, null));
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: pickNonStreamReply(body) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("fake OpenAI 端口获取失败");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || !address) {
        server.close();
        reject(new Error("空闲端口获取失败"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge 提前退出（code=${child.exitCode}）\n--- bridge 输出 ---\n${bridgeOutputTail}`);
    }
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await wait(150);
  }
  throw new Error(`bridge 在 ${timeoutMs}ms 内未监听端口 ${port}`);
}

interface OneBotClient {
  actions: Array<Record<string, unknown>>;
  send: (event: Record<string, unknown>) => void;
  waitFor: (
    predicate: (action: Record<string, unknown>, index: number) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function connectOneBot(port: number): Promise<OneBotClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    headers: { Authorization: `Bearer ${WS_TOKEN}` },
  });
  const actions: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("close", (code: number, reason: Buffer) => {
    wsClosed = `code=${code} reason=${reason.toString()}`;
  });
  ws.on("message", (data: Buffer) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    actions.push(parsed);
    // 桥接可能发带 echo 的 API 请求（如 get_msg），回 ok 即可
    if (typeof parsed.echo !== "undefined") {
      ws.send(
        JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: parsed.echo }),
      );
    }
  });
  return {
    actions,
    send: (event) => {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error(`OneBot WS 未连接（readyState=${ws.readyState}），事件未发送`);
      }
      ws.send(JSON.stringify(event));
    },
    waitFor: async (predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let index = 0; index < actions.length; index++) {
          if (predicate(actions[index], index)) return actions[index];
        }
        await wait(100);
      }
      const summary = actions
        .map((action) => `${String(action.action)}:${messageText(action).slice(0, 60)}`)
        .join(" | ");
      throw new Error(
        `等待 OneBot action 超时（已收到 ${actions.length} 条）: ${summary}` +
          `\nbridge.exitCode=${String(currentBridge?.exitCode)} signal=${String(currentBridge?.signalCode)} wsClosed=${wsClosed}` +
          `\n--- bridge 输出 ---\n${bridgeOutputTail.slice(-2500)}`,
      );
    },
    close: () => ws.close(),
  };
}

function paramsUserId(action: Record<string, unknown>): number | undefined {
  const params = action.params as Record<string, unknown> | undefined;
  const value = params?.user_id;
  return typeof value === "number" ? value : undefined;
}

function messageText(action: Record<string, unknown>): string {
  const params = action.params as Record<string, unknown> | undefined;
  const message = params?.message;
  return typeof message === "string" ? message : "";
}

function privateEvent(text: string, messageId: number, userId: number = TEST_QQ): Record<string, unknown> {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: BOT_QQ,
    user_id: userId,
    message_id: messageId,
    raw_message: text,
    message: [{ type: "text", data: { text } }],
    sender: { user_id: userId, nickname: `E2E 测试${userId}` },
    time: Math.floor(Date.now() / 1000),
  };
}

function imageEvent(imageUrl: string, messageId: number): Record<string, unknown> {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: BOT_QQ,
    user_id: TEST_QQ,
    message_id: messageId,
    raw_message: `[CQ:image,file=e2e.png,url=${imageUrl}]`,
    message: [{ type: "image", data: { file: "e2e.png", url: imageUrl } }],
    sender: { user_id: TEST_QQ, nickname: "E2E 测试" },
    time: Math.floor(Date.now() / 1000),
  };
}

function groupEvent(text: string, messageId: number, userId: number = TEST_QQ): Record<string, unknown> {
  return {
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    self_id: BOT_QQ,
    user_id: userId,
    group_id: GROUP_ID,
    message_id: messageId,
    raw_message: `[CQ:at,qq=${BOT_QQ}] ${text}`,
    message: [
      { type: "at", data: { qq: String(BOT_QQ) } },
      { type: "text", data: { text: ` ${text}` } },
    ],
    sender: { user_id: userId, nickname: `E2E 测试${userId}`, card: "" },
    time: Math.floor(Date.now() / 1000),
  };
}

describe("QQ 桥接端到端（fake OneBot + fake DeepSeek）", () => {
  let fake: FakeOpenAi;
  let workDir: string;
  let dataDir: string;
  let bridge: ChildProcess | null = null;
  let onebot: OneBotClient | null = null;

  beforeAll(async () => {
    fake = await startFakeOpenAi();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-e2e-"));
    dataDir = path.join(workDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    // 人设目录按 cwd 读取：复制一份到临时工作区，避免测试依赖仓库外的状态
    fs.cpSync(path.join(REPO_ROOT, "personas"), path.join(workDir, "personas"), {
      recursive: true,
    });
    const port = await freePort();
    fs.writeFileSync(
      path.join(workDir, "config.yaml"),
      [
        'persona: "xiaoya"',
        'her_name: "小雅"',
        'your_name: "你"',
        'location: "上海"',
        "tags: []",
        `allowed_users: [${TEST_QQ}, ${TEST_QQ2}]`,
        'one_bot_ws_host: "127.0.0.1"',
        `one_bot_ws_port: ${port}`,
        `one_bot_ws_path: "${WS_PATH}"`,
        `one_bot_token: "${WS_TOKEN}"`,
        // 关闭免打扰/发图，避免测试时序与随机性
        'quiet_hours_start: "00:00"',
        'quiet_hours_end: "00:00"',
        "photo_share_min_closeness: 10",
        "photo_share_probability: 0",
        "age_gate_enabled: true",
        "ai_disclosure: true",
        "health_port: 0",
        "web_port: 0",
      ].join("\n"),
      "utf8",
    );

    const env = { ...process.env };
    // 隔离真实 Key / 外部服务；只指向 fake DeepSeek
    delete env.QWEN_VL_API_KEY;
    delete env.UNSPLASH_ACCESS_KEY;
    delete env.OPENWEATHER_API_KEY;
    delete env.KAREN_DATA_DIR;
    Object.assign(env, {
      DEEPSEEK_API_KEY: "sk-e2e-test",
      DEEPSEEK_BASE_URL: fake.baseUrl,
      KAREN_DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
      LOG_FORMAT: "text",
      NO_COLOR: "1",
    });

    bridge = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
        path.join(REPO_ROOT, "src/bridge/qq.ts"),
      ],
      { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const appendOutput = (chunk: Buffer): void => {
      bridgeOutputTail = (bridgeOutputTail + chunk.toString()).slice(-4000);
    };
    currentBridge = bridge;
    bridge.stdout?.on("data", appendOutput);
    bridge.stderr?.on("data", appendOutput);

    await waitForPort(port, 30000, bridge);
    onebot = await connectOneBot(port);
  }, 60000);

  afterAll(async () => {
    try {
      onebot?.close();
    } catch {
      // ignore
    }
    if (bridge && bridge.exitCode === null) {
      bridge.kill("SIGTERM");
      await wait(800);
      if (bridge.exitCode === null) bridge.kill("SIGKILL");
    }
    await fake?.close();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 30000);

  it(
    "新用户披露→年龄门→确认→私聊→图片→群聊",
    async () => {
      const client = onebot!;
      const actions = client.actions;

      // 1) 新用户第一条消息：披露 + 年龄确认请求（两条，且不进入角色对话）
      client.send(privateEvent("你好呀", 1));
      await client.waitFor(
        (action) =>
          action.action === "send_private_msg" &&
          messageText(action).includes("AI") &&
          messageText(action).includes("18"),
      );
      await client.waitFor(
        (action) =>
          action.action === "send_private_msg" && messageText(action).includes("我成年了"),
      );

      // 2) 确认年龄 + 紧接着一条聊天（400ms 合并窗口内）。
      //    回归：确认和聊天被拼成一批时，确认分支不能把后半句吞掉。
      client.send(privateEvent("我成年了", 2));
      client.send(privateEvent("今天好累啊", 3));
      await client.waitFor(
        (action) => action.action === "send_private_msg" && messageText(action).includes("继续聊"),
      );
      await client.waitFor(
        (action) => action.action === "send_private_msg" && messageText(action).includes("嗯我在听"),
      );

      // 4) 图片消息 → 视觉接口被调用 + 仍收到回复
      const imageUrl = `${fake.baseUrl}/img.png`;
      const beforeImage = actions.length;
      client.send(imageEvent(imageUrl, 4));
      await client.waitFor(
        (action, index) =>
          index >= beforeImage &&
          action.action === "send_private_msg" &&
          messageText(action).includes("嗯我在听"),
      );
      expect(fake.requests.some((request) => JSON.stringify(request).includes("image_url"))).toBe(
        true,
      );

      // 5) 群聊 @ → 群回复
      client.send(groupEvent("在吗", 5));
      await client.waitFor(
        (action) => action.action === "send_group_msg" && messageText(action).includes("嗯我在听"),
      );

      // 副作用校验不是重点，但至少确认 bridge 没有崩溃且收到过 3 类 action
      expect(actions.some((action) => action.action === "send_private_msg")).toBe(true);
    },
    120000,
  );

  it("治理命令：/about 展示 AI 披露与数据去向、/age 显示已确认", async () => {
    const client = onebot!;
    const actions = client.actions;

    let before = actions.length;
    client.send(privateEvent("/about", 21));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        messageText(action).includes("AI 虚拟人角色") &&
        messageText(action).includes("DeepSeek"),
      30000,
    );

    before = actions.length;
    client.send(privateEvent("/age", 22));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        messageText(action).includes("已确认"),
      30000,
    );
  }, 60000);

  it("危机兜底：强制回复并附专业求助资源（12356）", async () => {
    const client = onebot!;
    const actions = client.actions;
    const before = actions.length;
    client.send(privateEvent("我不想活了，感觉撑不下去了", 23));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        messageText(action).includes("12356"),
      40000,
    );
  }, 60000);

  it("多用户隔离 + 未确认年龄的群聊拦截", async () => {
    const client = onebot!;
    const actions = client.actions;

    // 用户 2 第一条私聊：披露 + 年龄门（独立 owner）
    let before = actions.length;
    client.send(privateEvent("你好呀", 31, TEST_QQ2));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        paramsUserId(action) === TEST_QQ2 &&
        messageText(action).includes("AI") &&
        messageText(action).includes("18"),
      30000,
    );
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        paramsUserId(action) === TEST_QQ2 &&
        messageText(action).includes("我成年了"),
      30000,
    );

    // 用户 2 在群聊 @ 她：未确认 18+ → 合规要求不回复（负向断言）
    before = actions.length;
    client.send(groupEvent("在吗", 32, TEST_QQ2));
    await wait(1500);
    expect(actions.slice(before).filter((action) => action.action === "send_group_msg")).toHaveLength(
      0,
    );

    // 确认年龄后，第二用户私聊正常回复
    client.send(privateEvent("我成年了", 33, TEST_QQ2));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        paramsUserId(action) === TEST_QQ2 &&
        messageText(action).includes("继续聊"),
      30000,
    );
    client.send(privateEvent("今天也好累", 34, TEST_QQ2));
    await client.waitFor(
      (action, index) =>
        index >= before &&
        action.action === "send_private_msg" &&
        paramsUserId(action) === TEST_QQ2 &&
        messageText(action).includes("嗯我在听"),
      30000,
    );

    // 数据库侧隔离：两个 owner 的同意记录 + 两份记忆 persona
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(dataDir, "memory.sqlite"), { readonly: true });
    try {
      const owners = (
        db.prepare("SELECT owner_id FROM user_consent ORDER BY owner_id").all() as Array<{
          owner_id: string;
        }>
      ).map((row) => row.owner_id);
      expect(owners).toContain(`qq:${TEST_QQ}`);
      expect(owners).toContain(`qq:${TEST_QQ2}`);

      const personas = (
        db
          .prepare("SELECT DISTINCT persona_id FROM t2_episodes WHERE source = 'chat'")
          .all() as Array<{ persona_id: string }>
      ).map((row) => row.persona_id);
      expect(personas.length).toBeGreaterThanOrEqual(2);
      expect(personas.some((id) => id.includes("qq-100000002"))).toBe(true);
    } finally {
      db.close();
    }
  }, 90000);
});
