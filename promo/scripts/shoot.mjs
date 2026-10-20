#!/usr/bin/env node
/**
 * shoot.mjs — 用 Chrome DevTools Protocol 给 promo 页截图（零依赖，复用仓库 ws）。
 *
 * 为什么不用 `chrome --screenshot`：
 *   macOS 的 Chrome 无头模式有**最小窗口宽度 500px**，`--window-size=390,844` 实际按 500 布局，
 *   截出来的 390 宽图片会把右侧内容裁掉（看起来像移动端溢出，其实是截图方式的问题）。
 *   这里用 Emulation.setDeviceMetricsOverride 真正把视口设成 390，移动端布局才准。
 *
 * 用法：
 *   node promo/scripts/shoot.mjs --url "file:///.../promo/index.html?shot=privacy" \
 *        --width 1440 --height 1000 --out promo/screenshots/privacy.png
 *   node promo/scripts/shoot.mjs --url "...?longshot=1" --width 390 --full --out x.png
 *
 * 参数：--url（必填） --width 1440 --height 900 --out（必填） --full（截整页） --wait 1200（毫秒）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const url = arg("url");
const width = Number(arg("width", 1440));
const height = Number(arg("height", 900));
const out = arg("out");
const full = arg("full", false) === true;
const waitMs = Number(arg("wait", 1200));

if (!url || !out) {
  console.error("usage: node shoot.mjs --url <url> --out <png> [--width 1440] [--height 900] [--full]");
  process.exit(2);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-shot-"));
const port = 9300 + Math.floor(Math.random() * 200);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1000, () => req.destroy(new Error("timeout")));
  });
}

async function waitForChrome() {
  for (let i = 0; i < 100; i++) {
    try {
      return await getJson("/json/version");
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("chrome did not start");
}

let nextId = 1;
function makeClient(ws) {
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

try {
  const version = await waitForChrome();
  const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const send = makeClient(ws);

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  }, sessionId);

  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, waitMs));

  // 整页截图前先滚一遍：触发 loading="lazy" 的图片和滚动入场动画，
  // 否则长图里会留下空图片框（真实浏览时没这个问题）
  if (full) {
    await send("Runtime.enable", {}, sessionId);
    await send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        expression: `(async () => {
          const step = Math.max(240, Math.round(window.innerHeight * 0.8));
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 220));
          }
          window.scrollTo(0, 0);
          await new Promise((r) => setTimeout(r, 500));
          return document.body.scrollHeight;
        })()`,
      },
      sessionId,
    );
  }

  const shot = await send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: full },
    sessionId,
  );
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`saved ${out} (${width}x${height}${full ? ", full page" : ""})`);

  ws.close();
  chrome.kill("SIGKILL");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  chrome.kill("SIGKILL");
  process.exitCode = 1;
} finally {
  // Chrome 退出瞬间可能还在写 profile，清理失败不算错误
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    /* ignore */
  }
}
