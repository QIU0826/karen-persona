/**
 * QQ 桥接 — 通过 NapCatQQ (OneBot 11) 连接 QQ。
 * NapCatQQ 反向 WebSocket 连接到本服务，本服务作为 WS 服务端。
 *
 * 启动方式: npm run qq
 * 前置条件: 先启动 NapCatQQ（配置好反向 WS 地址 ws://127.0.0.1:8080/onebot/v11/ws）
 */
import "dotenv/config";
import { WebSocketServer, type WebSocket } from "ws";
import { loadPersona } from "../persona/loader.js";
import type { Persona } from "../persona/loader.js";
import { loadConfig, setLogLevel } from "../data/store.js";
import type { AppConfig } from "../data/store.js";
import { applyGlobalDecay, archiveDecayedEpisodes, closeVectorDb } from "../data/vector.js";
import {
  initConversation,
  processMessage,
  processMessageStream,
  processProactive,
  getStateSummary,
  type ConversationState,
} from "../pipeline/orchestrator.js";
import { metabolizeMemories } from "../evolution/memory-decay.js";
import {
  addConnection,
  getConnectionCount,
  getConnectionStatus,
  parseEvent,
  parseApiResponse,
  isPrivateMessage,
  isGroupMessage,
  detectMedia,
  getReplyContext,
  sendPrivateMsg,
  sendGroupMsg,
  tryResolveApiResponse,
  getMsgById,
  extractAtText,
  type PrivateMessageEvent,
  type GroupMessageEvent,
  type OneBotApiResponse,
  type MessageMedia,
} from "./onebot.js";
import { describeImage } from "../ai/vision.js";
import { execSync } from "node:child_process";

/** Windows 桌面通知（掉线提醒等） */
function notifyWindows(title: string, body: string): void {
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title}', '${body}', 'Info'); Start-Sleep -Seconds 6; $n.Visible = $false`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, stdio: "ignore" });
  } catch {
    // 通知失败不影响主流程
  }
}

/** 下载图片并转为 base64 data URI，供 CQ 码使用 */
async function downloadImageAsBase64(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get("content-type") ?? "image/jpeg";
    return `base64://${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

interface SharedBase {
  /** 根据 QQ 用户 ID 获取对应的人设 */
  getPersona: (userId: number) => Persona;
  config: AppConfig;
}

const PORT = Number(process.env.ONE_BOT_WS_PORT) || 8080;
const PATH = process.env.ONE_BOT_WS_PATH || "/onebot/v11/ws";

const userStates = new Map<number, ConversationState>();
const userLastActive = new Map<number, number>();
const MAX_USER_STATES = 500;

/** 淘汰最久未活跃的用户状态 */
function evictStaleUsers(): void {
  if (userStates.size <= MAX_USER_STATES) return;

  const entries = Array.from(userLastActive.entries())
    .sort((a, b) => a[1] - b[1]);

  const toRemove = entries.slice(0, entries.length - MAX_USER_STATES);
  for (const [userId] of toRemove) {
    userStates.delete(userId);
    userLastActive.delete(userId);
    userPending.delete(userId);
    userBuffers.delete(userId);
  }
  console.log(`[内存] 淘汰 ${toRemove.length} 个不活跃用户 (剩余: ${userStates.size})`);
}

/** 缓存已加载的人设（personaId → Persona） */
const personaCache = new Map<string, Persona>();

// P1-a: 每用户中断计数
const userPending: Map<number, number> = new Map();

// 频率限制：记录每个用户每分钟的消息数
const userMessageTimestamps = new Map<number, number[]>();

function checkRateLimit(userId: number, limit: number): boolean {
  const now = Date.now();
  const timestamps = userMessageTimestamps.get(userId) ?? [];
  // 清除 1 分钟前的记录
  const recent = timestamps.filter(t => now - t < 60000);
  if (recent.length >= limit) return false;
  recent.push(now);
  userMessageTimestamps.set(userId, recent);
  return true;
}

// 消息合并缓冲：收集 400ms 内的连续消息，一次处理（模拟"看到两条一起回"）
interface MessageBuffer {
  events: PrivateMessageEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}
const userBuffers = new Map<number, MessageBuffer>();

function enqueueMessage(event: PrivateMessageEvent, sharedBase: SharedBase) {
  const userId = event.user_id;

  // 标记中断（打断当前正在发送的 burst）
  userPending.set(userId, (userPending.get(userId) ?? 0) + 1);

  let buf = userBuffers.get(userId);
  if (!buf) {
    buf = { events: [], timer: null, processing: false };
    userBuffers.set(userId, buf);
  }
  buf.events.push(event);

  // 正在处理中 → 新消息已入缓冲，处理完当前批次后会检查
  if (buf.processing) return;

  // 重置合并窗口（400ms 内的连续消息合并处理）
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buf!.timer = null;
    buf!.processing = true;
    const batch = buf!.events.splice(0);
    handlePrivateBatch(batch, sharedBase).finally(() => {
      buf!.processing = false;
      // 若在处理期间又有新消息到达，立即处理
      if (buf!.events.length > 0) {
        enqueueMessage(buf!.events.splice(0)[0], sharedBase);
      }
    });
  }, 400);
}

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Karen — QQ 桥接 (NapCat/OneBot)   ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  setLogLevel(config.log_level);

  // 预加载默认人设
  const defaultPersona = await loadPersona(config.persona);
  personaCache.set(config.persona, defaultPersona);

  // 预加载 user_personas 中配置的所有人设
  if (config.user_personas) {
    for (const personaId of Object.values(config.user_personas)) {
      if (!personaCache.has(personaId)) {
        try {
          personaCache.set(personaId, await loadPersona(personaId));
        } catch (err) {
          console.log(`[警告] 用户配置的人设 "${personaId}" 加载失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  console.log(`[启动] 默认人设: ${defaultPersona.name} (${defaultPersona.identity.lifeStory.career})`);
  if (config.user_personas && Object.keys(config.user_personas).length > 0) {
    console.log(`[启动] 用户映射: ${Object.entries(config.user_personas).map(([uid, pid]) => `${uid}→${pid}`).join(", ")}`);
  }

  const sharedBase: SharedBase = {
    config,
    getPersona: (userId: number) => {
      const personaId = config.user_personas?.[String(userId)] ?? config.persona;
      return personaCache.get(personaId) ?? defaultPersona;
    },
  };

  const decayed = applyGlobalDecay();
  const archived = archiveDecayedEpisodes();
  if (decayed > 0 || archived > 0) {
    console.log(`[记忆] 衰减: ${decayed} | 归档: ${archived}`);
  }

  // P2-a: 记忆代谢
  const metabResult = metabolizeMemories({
    currentEmotion: 0, // 启动时情绪中性
    topicKeywords: [],
  });
  for (const log of metabResult.logs) {
    console.log(`  ${log}`);
  }

  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === "sk-your-key-here") {
    console.log("[错误] 未设置 DEEPSEEK_API_KEY");
    return;
  }

  // ── WebSocket 服务端 ─────────────────────────

  const wss = new WebSocketServer({
    port: PORT,
    // 接受任意路径的 WebSocket 连接
    verifyClient: (info, cb) => {
      console.log(`[WS] 握手请求: ${info.req.url}`);
      cb(true);
    },
  });

  wss.on("listening", () => {
    console.log(`[WS] 监听 ws://127.0.0.1:${PORT}${PATH}`);
    console.log("[WS] 等待 NapCatQQ 连接...");
    console.log("══════════════════════════════════════\n");
  });

  wss.on("error", (err: Error) => {
    console.error(`[WS] 服务端错误: ${err.message}`);
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const clientPath = req.url || "/";
    const wasReconnect = getConnectionCount() > 0;
    console.log(`[WS] ${wasReconnect ? "重连" : "连接"}: ${clientPath} (活跃: ${getConnectionCount() + 1})`);
    if (wasReconnect) {
      console.log("[WS] NapCat 已重连，会话和记忆保持不变");
    }
    addConnection(ws);

    // 心跳：每 30s ping 一次，检测连接是否存活
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on("pong", () => {
      // 连接存活，不需要额外处理
    });

    ws.on("message", (data: Buffer) => {
      const raw = data.toString();
      // 诊断：打印每条消息的类型
      if (raw.length < 500) {
        const preview = raw.slice(0, 80);
        const tag = raw.includes('"post_type"') ? "event" : raw.includes('"retcode"') ? "api_resp" : "other";
        console.log(`[WS] <<< ${tag}: ${preview}...`);
      }
      handleMessage(ws, raw, sharedBase);
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      const remaining = getConnectionCount();
      console.log(`[WS] 连接断开 (剩余活跃: ${remaining})`);
      if (remaining === 0) {
        const status = getConnectionStatus();
        console.log(`[WS] NapCat 已断开。等待重连... (上次连接: ${status.since ?? "未知"})`);
        // 延迟 30s 确认不是瞬时重连，再弹通知
        setTimeout(() => {
          if (getConnectionCount() === 0) {
            console.log("[WS] 掉线超过 30s，请重新扫码登录 NapCatQQ");
            notifyWindows("Karen 掉线了", "NapCatQQ 连接已断开，请重新扫码登录。");
          }
        }, 30000);
      }
    });

    ws.on("error", (err: Error) => {
      clearInterval(pingInterval);
      console.error(`[WS] 连接错误: ${err.message}`);
    });
  });

  // 连接状态定时上报
  const statusInterval = setInterval(() => {
    const status = getConnectionStatus();
    if (!status.connected && getConnectionCount() === 0) {
      // 不重复打印，只在 close 时打印一次
    }
  }, 60000);

  // ── P1: 生活流心跳 ──────────────────────────

  // 每 15 分钟检查一次她的生活状态（天气/因果链/情绪/时间节点），
  // 产生分享冲动时经由消息门决定是否发送。
  // 深夜不禁止——消息门自会处理延迟或发送。
  const HEARTBEAT_MS = 15 * 60 * 1000;
  const heartbeatTimer = setInterval(async () => {
    if (getConnectionCount() === 0) return;

    for (const [userId, state] of userStates) {
      try {
        // 频率限制
        const freqLimit = sharedBase.config.message_frequency_limit ?? 10;
        if (!checkRateLimit(userId, freqLimit)) continue;

        const result = await processProactive(state);
        if (!result || !result.reply) continue;

        const userName = String(userId);
        for (const log of result.logs) {
          console.log(`  ${log}`);
        }

        const pendingSnapshot = userPending.get(userId) ?? 0;
        const lines = result.reply.split("\n").filter(Boolean);
        for (const line of lines) {
          // 中断检测：主动 burst 中用户回复了就停
          const nowPending = userPending.get(userId) ?? 0;
          if (nowPending > pendingSnapshot) {
            console.log(`[主动] 用户 ${userName} 发来新消息，丢弃剩余`);
            state.interrupted = true;
            break;
          }

          sendPrivateMsg(userId, line.trim());
          console.log(`[主动] -> ${userName}: ${line.trim()}`);
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
        }
        if (result.qqFace) {
          const nowPending = userPending.get(userId) ?? 0;
          if (nowPending <= pendingSnapshot) {
            await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
            sendPrivateMsg(userId, result.qqFace);
          }
        }
      } catch (err: unknown) {
        // 单个用户失败不影响其他
      }
    }
  }, HEARTBEAT_MS);

  console.log(`[主动] 生活流心跳已启动 (每 ${HEARTBEAT_MS / 60000} 分钟)`);

  // ── 优雅退出 ──────────────────────────────────

  const cleanup = () => {
    console.log("\n[退出] 正在清理...");
    clearInterval(statusInterval);
    clearInterval(heartbeatTimer);
    closeVectorDb();
    wss.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// ── 消息分发 ────────────────────────────────────

async function handleMessage(
  _ws: WebSocket,
  raw: string,
  sharedBase: SharedBase,
) {
  // 路由异步 API 响应（get_msg 等带 echo 的请求）
  if (tryResolveApiResponse(raw)) return;

  const apiResp = parseApiResponse(raw);
  if (apiResp && apiResp.retcode !== 0) {
    console.log(`[API] 调用失败: retcode=${apiResp.retcode}`);
    return;
  }

  const event = parseEvent(raw);
  if (!event) return;

  if (isPrivateMessage(event)) {
    enqueueMessage(event, sharedBase);
  } else if (isGroupMessage(event)) {
    handleGroupMessage(event, sharedBase);
  } else {
    console.log(`[WS] 未处理的事件: post_type=${event.post_type} sub_type=${(event as any).sub_type ?? "none"}`);
  }
}

async function handlePrivateBatch(
  events: PrivateMessageEvent[],
  sharedBase: SharedBase,
) {
  if (events.length === 0) return;

  // 取第一个事件的 userId（批次内同一用户）
  const userId = events[0].user_id;

  // 处理每个事件的媒体，合并文本
  const texts: string[] = [];
  for (const event of events) {
    const media = detectMedia(event);

    // 表情包 → 跳过
    if (media && (media.type === "face" || media.type === "mface")) {
      continue;
    }

    // P2-e: 图片识别
    let syntheticText = media?.syntheticText || null;
    if (media?.type === "image" && media.data?.url) {
      const desc = await describeImage(media.data.url);
      if (desc) {
        syntheticText = `[图片：${desc}]`;
        console.log(`[Vision] 识别: ${desc}`);
      }
    }

    // 引用消息：拼接引用原文
    let rawText = syntheticText || event.raw_message;
    if (media?.type === "reply") {
      let quoted = getReplyContext(media.data);
      // 回退：NapCatQQ 未附带原文时，用 message_id 调 get_msg API 回查
      if (!quoted && media.data?.id) {
        const msgId = parseInt(media.data.id, 10);
        if (!isNaN(msgId)) {
          console.log(`[引用] NapCat 未附带原文，回查消息 ${msgId}...`);
          quoted = await getMsgById(msgId);
          if (quoted) {
            console.log(`[引用] 回查成功: ${quoted.slice(0, 50)}...`);
          }
        }
      }
      if (quoted) {
        rawText = `[引用：他说"${quoted}"] ${rawText}`;
      }
    }
    const t = rawText?.trim();
    if (t) texts.push(t);
  }

  if (texts.length === 0) return;
  const text = texts.join("\n");
  if (!text) return;

  const userName = events[0].sender?.nickname || String(userId);

  if (text.startsWith("/")) {
    const state = userStates.get(userId);
    if (text === "/stats" && state) {
      const summary = getStateSummary(state);
      sendPrivateMsg(userId, summary.join("\n"));
    }
    return;
  }

  console.log(`[收到] ${userName} (${userId}): ${text}`);

  if (!userStates.has(userId)) {
    evictStaleUsers();
    const persona = sharedBase.getPersona(userId);
    const st = await initConversation(persona, sharedBase.config);
    st.stickerMode = "qqface";
    userStates.set(userId, st);
    console.log(`[会话] 新会话: ${userName} → ${persona.name}`);
  }

  userLastActive.set(userId, Date.now());
  const state = userStates.get(userId)!;

  try {
    // P1: 流式响应 — 逐 fragment 发送，模拟边想边打
    const stream = processMessageStream(state, text);

    const freqLimit = sharedBase.config.message_frequency_limit ?? 10;
    if (!checkRateLimit(userId, freqLimit)) {
      console.log(`[限速] 用户 ${userName} 超过频率限制 (${freqLimit}/分钟)`);
      return;
    }

    const pendingSnapshot = userPending.get(userId) ?? 0;
    let sentCount = 0;

    for await (const frag of stream) {
      // 中断检测
      const nowPending = userPending.get(userId) ?? 0;
      if (nowPending > pendingSnapshot) {
        console.log(`[中断] 用户 ${userName} 发来新消息，丢弃剩余`);
        state.interrupted = true;
        break;
      }

      if (frag.qqFace) {
        // 最后一条：QQ 表情（流结束后追加）
        await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
        const afterWait = userPending.get(userId) ?? 0;
        if (afterWait <= pendingSnapshot) {
          sendPrivateMsg(userId, frag.qqFace);
          console.log(`[回复] -> ${userName}: ${frag.qqFace}`);
        }
        break;
      }

      if (!frag.text) continue;

      // 流式 fragment 之间的自然间隔（模拟打字间隙，不是固定延迟）
      if (sentCount > 0) {
        const typingDelay = 200 + Math.random() * 600; // 0.2-0.8s，比之前的 1.5-4s 快很多
        await new Promise(r => setTimeout(r, typingDelay));
        const afterWait = userPending.get(userId) ?? 0;
        if (afterWait > pendingSnapshot) {
          console.log(`[中断] 用户 ${userName} 在流中发来新消息`);
          state.interrupted = true;
          break;
        }
      }

      sendPrivateMsg(userId, frag.text);
      console.log(`[回复] -> ${userName}: ${frag.text}`);
      sentCount++;
    }

    // 流式结束后，不处理 Unsplash（非流式 processMessage 中处理）
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.log(`[错误] ${msg}`);
    try { sendPrivateMsg(userId, "[系统] 消息发送失败，请稍后重试"); } catch { /* 放弃 */ }
  }
}

// ── P3: 群聊一对一陪伴 ───────────────────────────

/**
 * 处理群聊消息。
 * 仅在以下条件全部满足时才回复：
 * 1. 消息中 @了她
 * 2. @她的那个人是她"认识"的（有过私聊记录）
 *
 * 回复风格和一对一完全一致——碎片化、不括号、有毒舌的权力。
 * 她不是群助手，她是来看她认识的人的。
 */
async function handleGroupMessage(
  event: GroupMessageEvent,
  sharedBase: SharedBase,
): Promise<void> {
  const selfId = event.self_id;
  const userId = event.user_id;
  const groupId = event.group_id;

  // 检查是否 @了她
  const text = extractAtText(event, selfId);
  if (!text) return;

  // 检查 @她的那个人是否是她"认识"的
  if (!userStates.has(userId)) {
    console.log(`[群聊] 忽略群 ${groupId} 中陌生人 ${userId} 的 @`);
    return;
  }

  const userName = event.sender?.card || event.sender?.nickname || String(userId);
  console.log(`[群聊] ${userName}(${userId}) 在群 ${groupId} 中 @: ${text}`);

  // 图片识别
  const media = detectMedia(event as unknown as PrivateMessageEvent);
  let finalText = text;
  if (media?.type === "image" && media.data?.url) {
    const desc = await describeImage(media.data.url);
    if (desc) {
      finalText = `[图片：${desc}] ${text}`;
    }
  }

  const state = userStates.get(userId)!;
  userLastActive.set(userId, Date.now());

  try {
    const result = await processMessage(state, finalText);
    for (const log of result.logs) console.log(`  ${log}`);

    if (!result.reply && !result.qqFace) return;

    // 群聊回复：每条消息随机间隔，模拟打字
    const lines = result.reply.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const delayMs = line.length <= 3 ? 600 + Math.random() * 800 :
                      line.length <= 15 ? 1000 + Math.random() * 1500 :
                      1500 + Math.random() * 2500;
      if (i > 0) await new Promise(r => setTimeout(r, delayMs));

      sendGroupMsg(groupId, line);
      console.log(`[群聊回复] -> ${userName}: ${line}`);
    }

    // QQ 表情
    if (result.qqFace) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 600));
      sendGroupMsg(groupId, result.qqFace);
    }

    // 不发 Unsplash 照片到群里——那是私聊专属
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.log(`[群聊错误] ${msg}`);
  }
}

main().catch((err) => {
  console.error("[致命错误]", err instanceof Error ? err.message : err);
  process.exit(1);
});
