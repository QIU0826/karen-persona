/**
 * QQ 桥接 — 通过 NapCatQQ (OneBot 11) 连接 QQ。
 * NapCatQQ 反向 WebSocket 连接到本服务，本服务作为 WS 服务端。
 *
 * 启动方式: npm run qq
 * 前置条件: 先启动 NapCatQQ（反向 WS 地址需与 one_bot_ws_path 一致，默认 /onebot/v11/ws）
 *
 * M0 安全与可靠性（task-2）：
 * - WS 默认只监听 127.0.0.1（one_bot_ws_host / ONE_BOT_HOST 可配），握手校验 path + 可选 token；
 * - ALLOWED_USERS / allowed_users 白名单；空白名单启动时打印显著警告；
 * - 出站消息 CQ 转义 + 仅放行受控 qqFace + 按 QQ 长度上限切分（见 onebot.ts）；
 * - message_id LRU 去重；合并窗口处理期间的新消息全部重投不丢失；
 * - 群聊 handler await + catch；unhandledRejection / uncaughtException 兜底；
 * - 消费消息门的延迟回复（deferred）：**排期持久化**到 SQLite（pending_replies），
 *   进程重启/NapCat 重连后自动恢复并补发；失败按 60s×attempts 退避重试；
 *   新消息到达取消该用户待发回复；退出时只清 timer，保留持久化记录；
 * - 日志只打印长度/摘要，不打印消息全文、token 或不必要的外部内容。
 */
import "dotenv/config";
import { WebSocketServer, type WebSocket } from "ws";
import { loadPersona } from "../persona/loader.js";
import type { Persona } from "../persona/loader.js";
import { loadConfig, setLogLevel, debugLog } from "../data/store.js";
import type { AppConfig } from "../data/store.js";
import { applyGlobalDecay, archiveDecayedEpisodes, closeVectorDb } from "../data/vector.js";
import {
  cancelPendingReplies,
  enqueuePendingReply,
  listPendingReplies,
  markPendingAttempt,
  markPendingDone,
  purgeFinishedReplies,
} from "../data/pending-queue.js";
import {
  initConversation,
  processMessage,
  processMessageStream,
  processProactive,
  getStateSummary,
  type ConversationState,
  type PipelineResult,
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
  isUserAllowed,
  MessageIdDedup,
  verifyHandshake,
  getRequestPathname,
  type PrivateMessageEvent,
  type GroupMessageEvent,
  type CqCode,
} from "./onebot.js";
import { describeImage } from "../ai/vision.js";
import { execSync } from "node:child_process";

// ── 常量 ────────────────────────────────────────

/** 消息合并窗口：400ms 内的连续消息合并处理 */
const MERGE_WINDOW_MS = 400;
/** 每个用户缓存的会话状态上限（超出淘汰最久未活跃的） */
const MAX_USER_STATES = 500;
/** message_id 去重 LRU 容量（断线重连场景足够） */
const DEDUP_CAPACITY = 1000;
/** 延迟补回复的上下限（防止异常值/0 值让 timer 失效） */
const MIN_DEFERRED_DELAY_MS = 500;
const MAX_DEFERRED_DELAY_MS = 24 * 60 * 60 * 1000;
/** 非法连接/握手失败的日志里最多展示多少字符 */
const MAX_LOG_VALUE_LENGTH = 120;

// ── 通用工具 ────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 orchestrator 产出的 qqFace CQ 码包装为受控 CQ 消息（避免被当作普通文本转义） */
function asCqCode(cq: string): CqCode {
  return { type: "cqcode", cq };
}

/** 只保留长度信息：日志中不落任何消息正文 */
function textSummary(text: string): string {
  return `${text.length} 字`;
}

/** 转义/截断外部可控字符串，避免日志注入 */
function sanitizeLogValue(value: string, maxLength = MAX_LOG_VALUE_LENGTH): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, maxLength);
}

/** Windows 桌面通知（掉线提醒等） */
function notifyWindows(title: string, body: string): void {
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title}', '${body}', 'Info'); Start-Sleep -Seconds 6; $n.Visible = $false`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, stdio: "ignore" });
  } catch {
    // 通知失败不影响主流程，也不在日志里输出异常（可能包含命令行参数）
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

// ── 运行时状态 ──────────────────────────────────

const userStates = new Map<number, ConversationState>();
const userLastActive = new Map<number, number>();
/** 缓存已加载的人设（personaId → Persona） */
const personaCache = new Map<string, Persona>();
/** 每用户中断计数：新消息到达 +1，用于打断正在发送的 burst */
const userPending: Map<number, number> = new Map();
/** 频率限制：记录每个用户每分钟的消息数 */
const userMessageTimestamps = new Map<number, number[]>();
/** message_id 去重（LRU） */
const messageDedup = new MessageIdDedup(DEDUP_CAPACITY);
/** 每个用户最多一个待补发的延迟回复（timer + 持久化记录 id） */
const userDeferredTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; pendingId: number }>();

// 静默忽略的非白名单账号（只统计数量，日志不落 QQ 号）
let ignoredNonWhitelistedMessages = 0;
const ignoredNonWhitelistedUsers = new Set<number>();
let lastReportedIgnoredMessages = 0;

function isAllowedUser(sharedBase: SharedBase, userId: number): boolean {
  return isUserAllowed(userId, sharedBase.config.allowed_users);
}

function noteIgnoredNonWhitelisted(userId: number): void {
  ignoredNonWhitelistedMessages++;
  ignoredNonWhitelistedUsers.add(userId);
  debugLog(`[安全] 忽略非白名单账号的消息（累计 ${ignoredNonWhitelistedMessages} 条）`);
}

function reportIgnoredNonWhitelisted(): void {
  if (ignoredNonWhitelistedMessages <= lastReportedIgnoredMessages) return;
  const delta = ignoredNonWhitelistedMessages - lastReportedIgnoredMessages;
  lastReportedIgnoredMessages = ignoredNonWhitelistedMessages;
  console.log(
    `[安全] 已忽略 ${delta} 条非白名单账号消息（累计 ${ignoredNonWhitelistedMessages} 条，涉及 ${ignoredNonWhitelistedUsers.size} 个账号）`,
  );
}

// ── 延迟回复（消息门 deferred）──────────────────

function cancelDeferredTimer(userId: number, reason?: string): void {
  const entry = userDeferredTimers.get(userId);
  if (entry) {
    clearTimeout(entry.timer);
    userDeferredTimers.delete(userId);
  }
  // 即使内存里没有 timer（例如刚重启还没恢复），也要取消持久化记录
  const cancelled = cancelPendingReplies("qq-private", String(userId), reason ?? "");
  if (reason && (entry || cancelled > 0)) {
    console.log(`[消息门] 用户 ${userId} 的待补发回复已取消（${reason}）`);
  }
}

/** 退出时只清理内存 timer；持久化记录保留，下次启动恢复 */
function clearAllDeferredTimers(): number {
  const count = userDeferredTimers.size;
  for (const entry of userDeferredTimers.values()) clearTimeout(entry.timer);
  userDeferredTimers.clear();
  return count;
}

/** 校验/夹取延迟时长；非法值返回 null（调用方跳过补发） */
function clampDeferredDelay(delayMs: number): number | null {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
  return Math.min(Math.max(Math.round(delayMs), MIN_DEFERRED_DELAY_MS), MAX_DEFERRED_DELAY_MS);
}

interface DeferredPrivateContext {
  userId: number;
  userName: string;
  text: string;
  state: ConversationState;
  sharedBase: SharedBase;
  /** 持久化队列中的记录 id（恢复/重试时必需） */
  pendingId?: number;
}

interface DeferredGroupContext {
  groupId: number;
  userId: number;
  userName: string;
  text: string;
  state: ConversationState;
  sharedBase: SharedBase;
}

function scheduleDeferredPrivateReply(ctx: DeferredPrivateContext, delayMs: number): void {
  const delay = clampDeferredDelay(delayMs);
  if (delay === null) {
    console.warn(`[消息门] 收到无效延迟 ${String(delayMs)}ms，跳过补回复`);
    return;
  }
  // 同一用户只保留最新一条（与旧的内存 timer 语义一致），先取消旧记录
  cancelDeferredTimer(ctx.userId, "重新排期");
  const pendingId = enqueuePendingReply({
    platform: "qq-private",
    userId: String(ctx.userId),
    userName: ctx.userName,
    personaId: ctx.state.persona.name,
    text: ctx.text,
    dueAt: Date.now() + delay,
  });
  console.log(
    `[消息门] 用户 ${ctx.userName} 的消息晚点回：${Math.round(delay / 1000)}s 后补发` +
      `（${textSummary(ctx.text)}，已持久化 #${pendingId}）`,
  );
  scheduleDeferredDelivery({ ...ctx, pendingId }, delay);
}

/** 安排一次投递（内存 timer）；timer 触发后从 map 移除并调用 deliver */
function scheduleDeferredDelivery(ctx: DeferredPrivateContext, delayMs: number): void {
  const wait = Math.max(MIN_DEFERRED_DELAY_MS, Math.round(delayMs));
  const timer = setTimeout(() => {
    userDeferredTimers.delete(ctx.userId);
    void deliverDeferredPrivateReply(ctx);
  }, wait);
  userDeferredTimers.set(ctx.userId, { timer, pendingId: ctx.pendingId ?? -1 });
}

async function deliverDeferredPrivateReply(ctx: DeferredPrivateContext): Promise<void> {
  const pendingId = ctx.pendingId;
  // 用户状态被淘汰/重建时放弃，避免把回复写到旧状态上
  if (userStates.get(ctx.userId) !== ctx.state) {
    console.log(`[消息门] 用户 ${ctx.userName} 状态已变化，取消延迟补发`);
    if (pendingId) markPendingDone(pendingId);
    return;
  }
  try {
    const outcome = await streamPrivateReply({
      state: ctx.state,
      text: ctx.text,
      userId: ctx.userId,
      userName: ctx.userName,
      options: { bypassGate: true, skipUserPersist: true },
      logPrefix: "延迟补发",
    });
    if (outcome.deferredDelayMs !== undefined) {
      // bypassGate 下不应再被门控；不再排期，避免无限循环
      console.warn("[消息门] 延迟补发时仍被门控，已跳过");
      if (pendingId) markPendingDone(pendingId);
      return;
    }
    if (pendingId) markPendingDone(pendingId);
    if (outcome.sentCount === 0) {
      console.log(`[消息门] 延迟补发未产生回复（${ctx.userName}）`);
    }
  } catch (err) {
    const msg = errMessage(err);
    console.error(`[消息门] 延迟补发失败（${ctx.userName}）: ${msg}`);
    if (pendingId) {
      const retry = markPendingAttempt(pendingId, msg);
      const retryDelay = Math.max(MIN_DEFERRED_DELAY_MS, retry.dueAt - Date.now());
      console.log(
        `[消息门] 已重新排期：第 ${retry.attempts} 次重试，${Math.round(retryDelay / 1000)}s 后`,
      );
      scheduleDeferredDelivery(ctx, retryDelay);
    }
  }
}

// ── 待补发队列恢复（进程重启 / NapCat 重连）────────

let pendingRestoring = false;

/**
 * 从持久化队列恢复待补发回复。
 * 在 NapCat 反向 WS 连上后调用（send 需要活跃连接）。
 */
async function restorePendingReplies(sharedBase: SharedBase): Promise<void> {
  if (pendingRestoring) return;
  pendingRestoring = true;
  try {
    const purged = purgeFinishedReplies();
    if (purged > 0) debugLog(`[消息门] 清理已完成/已取消的延迟记录 ${purged} 条`);

    const rows = listPendingReplies("qq-private");
    if (rows.length === 0) return;

    console.log(`[消息门] 发现 ${rows.length} 条待补发回复，开始恢复`);
    for (const row of rows) {
      const userId = Number(row.userId);
      if (!Number.isFinite(userId)) {
        markPendingDone(row.id);
        continue;
      }
      if (!isAllowedUser(sharedBase, userId)) {
        console.log("[消息门] 白名单已变化，取消一条待补发回复");
        markPendingDone(row.id);
        continue;
      }
      if (userDeferredTimers.has(userId)) continue;

      let state = userStates.get(userId);
      if (!state) {
        const persona = sharedBase.getPersona(userId);
        state = await initConversation(persona, sharedBase.config);
        state.stickerMode = "qqface";
        userStates.set(userId, state);
      }
      const wait = Math.max(2_000, row.dueAt - Date.now());
      console.log(
        `[消息门] 恢复待补发：用户 ${userId}，${Math.round(wait / 1000)}s 后补发（尝试 ${row.attempts} 次）`,
      );
      scheduleDeferredDelivery(
        {
          userId,
          userName: row.userName || String(userId),
          text: row.text,
          state,
          sharedBase,
          pendingId: row.id,
        },
        wait,
      );
    }
  } catch (err) {
    console.error(`[消息门] 恢复待补发失败: ${errMessage(err)}`);
  } finally {
    pendingRestoring = false;
  }
}

function scheduleDeferredGroupReply(ctx: DeferredGroupContext, delayMs: number): void {
  const delay = clampDeferredDelay(delayMs);
  if (delay === null) {
    console.warn(`[消息门] 收到无效延迟 ${String(delayMs)}ms，跳过群聊补回复`);
    return;
  }
  cancelDeferredTimer(ctx.userId);
  console.log(
    `[消息门] 群 ${ctx.groupId} 中 ${ctx.userName} 的消息晚点回：${Math.round(delay / 1000)}s 后补发`,
  );
  const timer = setTimeout(() => {
    userDeferredTimers.delete(ctx.userId);
    void deliverDeferredGroupReply(ctx);
  }, delay);
  // 群聊延迟暂不持久化（pendingId=-1）；与私聊共用「每用户一个 timer」的简化语义
  userDeferredTimers.set(ctx.userId, { timer, pendingId: -1 });
}

async function deliverDeferredGroupReply(ctx: DeferredGroupContext): Promise<void> {
  if (userStates.get(ctx.userId) !== ctx.state) {
    console.log("[消息门] 用户状态已变化，取消群聊延迟补发");
    return;
  }
  try {
    const result = await processMessage(ctx.state, ctx.text, {
      bypassGate: true,
      skipUserPersist: true,
    });
    for (const log of result.logs) console.log(`  ${log}`);
    if (result.deferred) {
      console.warn("[消息门] 群聊延迟补发时仍被门控，已跳过");
      return;
    }
    const sent = await sendGroupReplies(ctx.groupId, ctx.userId, ctx.userName, result);
    console.log(`[消息门] 群聊延迟补发完成: ${sent} 条`);
  } catch (err) {
    console.error(`[消息门] 群聊延迟补发失败: ${errMessage(err)}`);
  }
}

// ── 频率限制 ────────────────────────────────────

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

// ── 消息合并缓冲 + 重投 ─────────────────────────

interface MessageBuffer {
  events: PrivateMessageEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}
const userBuffers = new Map<number, MessageBuffer>();

/** 淘汰最久未活跃的用户状态（含其待补发 timer） */
function evictStaleUsers(): void {
  if (userStates.size <= MAX_USER_STATES) return;

  const entries = Array.from(userLastActive.entries())
    .sort((a, b) => a[1] - b[1]);

  const toRemove = entries.slice(0, entries.length - MAX_USER_STATES);
  for (const [userId] of toRemove) {
    userStates.delete(userId);
    userLastActive.delete(userId);
    userPending.delete(userId);
    cancelDeferredTimer(userId);
    userMessageTimestamps.delete(userId);
    const buf = userBuffers.get(userId);
    if (buf) {
      if (buf.timer) clearTimeout(buf.timer);
      userBuffers.delete(userId);
    }
  }
  console.log(`[内存] 淘汰 ${toRemove.length} 个不活跃用户 (剩余: ${userStates.size})`);
}

/** 消费缓冲：处理期间到达的新消息会被继续消费，不丢失 */
async function drainUserBuffer(
  userId: number,
  buf: MessageBuffer,
  sharedBase: SharedBase,
): Promise<void> {
  if (userBuffers.get(userId) !== buf) return; // 已被淘汰/重建
  buf.processing = true;
  try {
    while (buf.events.length > 0) {
      const batch = buf.events.splice(0);
      try {
        await handlePrivateBatch(batch, sharedBase);
      } catch (err) {
        console.error(`[错误] 用户 ${userId} 消息处理失败: ${errMessage(err)}`);
      }
    }
  } finally {
    buf.processing = false;
  }
}

function enqueueMessage(event: PrivateMessageEvent, sharedBase: SharedBase): void {
  const userId = event.user_id;

  // 新消息到达：取消该用户待定的延迟补回复（以最新消息为准）
  cancelDeferredTimer(userId, "用户发来新消息");
  // 标记中断（打断当前正在发送的 burst）
  userPending.set(userId, (userPending.get(userId) ?? 0) + 1);

  let buf = userBuffers.get(userId);
  if (!buf) {
    buf = { events: [], timer: null, processing: false };
    userBuffers.set(userId, buf);
  }
  buf.events.push(event);

  // 正在处理中 → 新消息已入缓冲，drainUserBuffer 会在当前批次后继续消费
  if (buf.processing) return;

  // 重置合并窗口（400ms 内的连续消息合并处理）
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    if (!buf) return;
    buf.timer = null;
    void drainUserBuffer(userId, buf, sharedBase);
  }, MERGE_WINDOW_MS);
}

// ── 启动主流程 ──────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Karen — QQ 桥接 (NapCat/OneBot)   ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  setLogLevel(config.log_level);

  // ── 安全启动自检 ──────────────────────────────
  const isLoopback =
    config.one_bot_ws_host === "127.0.0.1" ||
    config.one_bot_ws_host === "localhost" ||
    config.one_bot_ws_host === "::1" ||
    config.one_bot_ws_host === "[::1]";

  if (config.allowed_users.length === 0) {
    console.warn("⚠️  [安全] allowed_users 白名单为空：任何 QQ 号都能和她聊天。");
    console.warn("⚠️  [安全] 个人使用请把 allowed_users 配成你自己的 QQ 号；对外提供服务前必须配置。");
  } else {
    console.log(`[安全] 白名单已启用：${config.allowed_users.length} 个 QQ 号`);
  }

  if (!isLoopback && !config.one_bot_token) {
    console.warn(
      `⚠️  [安全] WS 监听 ${config.one_bot_ws_host}（非本机回环）但未配置 ONE_BOT_TOKEN：局域网内任何人都能伪装 NapCat 发事件。`,
    );
  }
  if (config.one_bot_token && config.one_bot_token.length < 8) {
    console.warn("[安全] ONE_BOT_TOKEN 过短（<8 字符），容易被暴力猜测。");
  }

  // 预加载默认人设
  const defaultPersona = await loadPersona(config.persona);
  personaCache.set(config.persona, defaultPersona);

  // 预加载 user_personas 中配置的所有人设（日志不打印 QQ 号）
  if (config.user_personas) {
    for (const personaId of Object.values(config.user_personas)) {
      if (!personaCache.has(personaId)) {
        try {
          personaCache.set(personaId, await loadPersona(personaId));
        } catch (err) {
          console.log(`[警告] 用户配置的人设 "${personaId}" 加载失败: ${errMessage(err)}`);
        }
      }
    }
  }

  console.log(`[启动] 默认人设: ${defaultPersona.name} (${defaultPersona.identity.lifeStory.career})`);
  if (config.user_personas && Object.keys(config.user_personas).length > 0) {
    console.log(`[启动] 已启用 ${Object.keys(config.user_personas).length} 条用户专属人设映射`);
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

  // ── WebSocket 服务端（安全加固）────────────────
  const PORT = config.one_bot_ws_port;
  const PATH = config.one_bot_ws_path;
  const HOST = config.one_bot_ws_host;
  const TOKEN = config.one_bot_token;

  const wss = new WebSocketServer({
    host: HOST,
    port: PORT,
    verifyClient: (info, cb) => {
      const decision = verifyHandshake(info.req, PATH, TOKEN);
      if (!decision.ok) {
        console.warn(
          `[WS] 拒绝握手：${decision.reason} (path=${sanitizeLogValue(getRequestPathname(info.req))})`,
        );
        cb(false, decision.statusCode, decision.reason);
        return;
      }
      cb(true);
    },
  });

  wss.on("listening", () => {
    const address = wss.address();
    const display =
      typeof address === "string"
        ? address
        : address
          ? `${address.address}:${address.port}`
          : `${HOST}:${PORT}`;
    console.log(`[WS] 监听 ws://${display}${PATH}`);
    console.log(`[WS] 等待 NapCatQQ 连接...${TOKEN ? "（已启用 token 校验）" : ""}`);
    console.log("══════════════════════════════════════\n");
  });

  wss.on("error", (err: Error) => {
    console.error(`[WS] 服务端错误: ${err.message}`);
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const clientPath = sanitizeLogValue(getRequestPathname(req));
    const wasReconnect = getConnectionCount() > 0;
    console.log(`[WS] ${wasReconnect ? "重连" : "连接"}: ${clientPath} (活跃: ${getConnectionCount() + 1})`);
    if (wasReconnect) {
      console.log("[WS] NapCat 已重连，会话和记忆保持不变");
    }
    addConnection(ws);

    // 恢复持久化的待补发回复（重启/重连后仍能兑现「晚点回」）
    void restorePendingReplies(sharedBase);

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
      // 只记录事件类型与字节数，不打印消息内容
      debugLog(`[WS] 收到数据 ${raw.length}B`);
      void handleMessage(ws, raw, sharedBase);
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

  // 连接状态/安全计数定时上报
  const statusInterval = setInterval(() => {
    reportIgnoredNonWhitelisted();
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
        const freqLimit = sharedBase.config.message_frequency_limit;
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
          console.log(`[主动] -> ${userName}: ${textSummary(line.trim())}`);
          await sleep(1500 + Math.random() * 2000);
        }
        if (result.qqFace) {
          const nowPending = userPending.get(userId) ?? 0;
          if (nowPending <= pendingSnapshot) {
            await sleep(400 + Math.random() * 600);
            sendPrivateMsg(userId, asCqCode(result.qqFace));
          }
        }
      } catch (err: unknown) {
        // 单个用户失败不影响其他（不打印正文）
        console.error(`[主动] 用户 ${userId} 处理失败: ${errMessage(err)}`);
      }
    }
  }, HEARTBEAT_MS);

  console.log(`[主动] 生活流心跳已启动 (每 ${HEARTBEAT_MS / 60000} 分钟)`);

  // ── 优雅退出 ──────────────────────────────────

  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[退出] 正在清理...");
    clearInterval(statusInterval);
    clearInterval(heartbeatTimer);
    const cancelled = clearAllDeferredTimers();
    if (cancelled > 0) console.log(`[退出] 已清理 ${cancelled} 个待补发回复 timer`);
    for (const buf of userBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = null;
    }
    for (const ws of wss.clients) {
      try { ws.close(); } catch { /* 忽略关闭失败 */ }
    }
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
): Promise<void> {
  try {
    // 路由异步 API 响应（get_msg 等带 echo 的请求）
    if (tryResolveApiResponse(raw)) return;

    const apiResp = parseApiResponse(raw);
    if (apiResp && apiResp.retcode !== 0) {
      console.log(`[API] 调用失败: retcode=${apiResp.retcode}`);
      return;
    }

    const event = parseEvent(raw);
    if (!event) {
      debugLog("[WS] 忽略畸形事件（无法解析或缺少关键字段）");
      return;
    }
    if (event.post_type !== "message") {
      debugLog(`[WS] 忽略非消息事件: post_type=${event.post_type}`);
      return;
    }

    const messageEvent = event as PrivateMessageEvent | GroupMessageEvent;

    // message_id 去重：NapCat 断线重连/重复投递时避免重复回复
    if (messageDedup.hasSeen(messageEvent.message_id)) {
      debugLog(`[去重] 忽略重复消息 message_id=${messageEvent.message_id}`);
      return;
    }

    // 白名单：非白名单账号静默忽略并计数（不回复、不落日志正文）
    if (!isAllowedUser(sharedBase, messageEvent.user_id)) {
      noteIgnoredNonWhitelisted(messageEvent.user_id);
      return;
    }

    if (isPrivateMessage(event)) {
      enqueueMessage(event, sharedBase);
    } else if (isGroupMessage(event)) {
      await handleGroupMessage(event, sharedBase);
    } else {
      debugLog(`[WS] 忽略未处理的消息类型: ${event.post_type}`);
    }
  } catch (err) {
    // 单条畸形事件/处理失败绝不拖垮进程
    console.error(`[WS] 事件处理失败: ${errMessage(err)}`);
  }
}

// ── 私聊处理 ────────────────────────────────────

interface PrivateStreamOutcome {
  sentCount: number;
  deferredDelayMs?: number;
  interrupted: boolean;
}

/**
 * 把流式回复逐条发给用户；返回是否被门控延迟/被新消息打断。
 * deferred 时不发送任何内容，由调用方排期补发。
 */
async function streamPrivateReply(params: {
  state: ConversationState;
  text: string;
  userId: number;
  userName: string;
  options?: { bypassGate?: boolean; skipUserPersist?: boolean };
  /** 日志前缀，用于区分正常回复与延迟补发 */
  logPrefix?: string;
}): Promise<PrivateStreamOutcome> {
  const { state, text, userId, userName, options } = params;
  const logPrefix = params.logPrefix ?? "回复";
  const pendingSnapshot = userPending.get(userId) ?? 0;
  let sentCount = 0;

  const stream = processMessageStream(state, text, options);
  for await (const frag of stream) {
    // 中断检测：用户发来新消息 → 丢弃剩余 burst
    if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
      state.interrupted = true;
      console.log(`[中断] 用户 ${userName} 发来新消息，丢弃剩余`);
      return { sentCount, interrupted: true };
    }

    // 消息门判定「晚点回」
    if (frag.deferred) {
      return { sentCount, deferredDelayMs: frag.deferred.delayMs, interrupted: false };
    }

    if (frag.qqFace) {
      // 最后一条：QQ 表情（流结束后追加）
      await sleep(400 + Math.random() * 400);
      if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
        state.interrupted = true;
        console.log(`[中断] 用户 ${userName} 在表情发送前发来新消息`);
        return { sentCount, interrupted: true };
      }
      sendPrivateMsg(userId, asCqCode(frag.qqFace));
      console.log(`[${logPrefix}] -> ${userName}: QQ 表情`);
      sentCount++;
      break;
    }

    if (!frag.text) continue;

    // 流式 fragment 之间的自然间隔（模拟打字间隙）
    if (sentCount > 0) {
      const typingDelay = 200 + Math.random() * 600;
      await sleep(typingDelay);
      if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
        state.interrupted = true;
        console.log(`[中断] 用户 ${userName} 在流中发来新消息`);
        return { sentCount, interrupted: true };
      }
    }

    sendPrivateMsg(userId, frag.text);
    console.log(`[${logPrefix}] -> ${userName}: ${textSummary(frag.text)}`);
    sentCount++;
  }

  return { sentCount, interrupted: false };
}

async function handlePrivateBatch(
  events: PrivateMessageEvent[],
  sharedBase: SharedBase,
): Promise<void> {
  if (events.length === 0) return;

  // 批次内同一用户
  const userId = events[0].user_id;
  if (!isAllowedUser(sharedBase, userId)) return; // 防御性二次校验

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
        console.log(`[Vision] 图片识别完成: ${textSummary(desc)}`);
      }
    }

    // 引用消息：拼接引用原文
    let rawText = syntheticText || event.raw_message || "";
    if (media?.type === "reply") {
      let quoted = getReplyContext(media.data);
      // 回退：NapCatQQ 未附带原文时，用 message_id 调 get_msg API 回查
      if (!quoted && media.data?.id) {
        const msgId = parseInt(media.data.id, 10);
        if (!isNaN(msgId)) {
          console.log("[引用] NapCat 未附带原文，回查原消息...");
          quoted = await getMsgById(msgId);
          if (quoted) {
            console.log(`[引用] 回查成功: ${textSummary(quoted)}`);
          }
        }
      }
      if (quoted) {
        rawText = `[引用：他说"${quoted}"] ${rawText}`;
      }
    }
    const t = rawText.trim();
    if (t) texts.push(t);
  }

  if (texts.length === 0) return;
  const text = texts.join("\n");
  if (!text) return;

  const userName = sanitizeLogValue(
    events[0].sender?.nickname || String(userId),
  );

  if (text.startsWith("/")) {
    const state = userStates.get(userId);
    if (text === "/stats" && state) {
      const summary = getStateSummary(state);
      sendPrivateMsg(userId, summary.join("\n"));
    }
    return;
  }

  console.log(`[收到] ${userName} (${userId}): ${textSummary(text)}`);

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

  // 频率限制（放在门控/LLM 之前，省成本）
  const freqLimit = sharedBase.config.message_frequency_limit;
  if (!checkRateLimit(userId, freqLimit)) {
    console.log(`[限速] 用户 ${userName} 超过频率限制 (${freqLimit}/分钟)，本轮不回复`);
    return;
  }

  try {
    const outcome = await streamPrivateReply({
      state,
      text,
      userId,
      userName,
    });

    // 消息门判定晚点回：调度定时补发（用户消息此时已落库）
    if (outcome.deferredDelayMs !== undefined) {
      scheduleDeferredPrivateReply(
        { userId, userName, text, state, sharedBase },
        outcome.deferredDelayMs,
      );
    }
  } catch (err: unknown) {
    console.error(`[错误] 用户 ${userName} 回复失败: ${errMessage(err)}`);
    // 不发送「[系统] 消息发送失败」这类破坏人设的消息，只用一句人设内兜底
    try {
      sendPrivateMsg(userId, "……等我一下，马上回来。");
    } catch {
      // 放弃
    }
  }
}

// ── P3: 群聊一对一陪伴 ───────────────────────────

/**
 * 发送群聊回复（多条随机间隔，模拟打字）。
 */
async function sendGroupReplies(
  groupId: number,
  userId: number,
  userName: string,
  result: PipelineResult,
): Promise<number> {
  if (!result.reply && !result.qqFace) return 0;

  let sent = 0;
  const lines = result.reply.split("\n").map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delayMs = line.length <= 3 ? 600 + Math.random() * 800 :
                    line.length <= 15 ? 1000 + Math.random() * 1500 :
                    1500 + Math.random() * 2500;
    if (i > 0) await sleep(delayMs);

    sendGroupMsg(groupId, line);
    console.log(`[群聊回复] -> ${userName}(${userId}): ${textSummary(line)}`);
    sent++;
  }

  // QQ 表情
  if (result.qqFace) {
    await sleep(500 + Math.random() * 600);
    sendGroupMsg(groupId, asCqCode(result.qqFace));
    sent++;
  }

  return sent;
}

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

  // 新消息到达：取消该用户待定的延迟补回复
  cancelDeferredTimer(userId, "用户在群里发来新消息");

  // 检查 @她的那个人是否是她"认识"的
  if (!userStates.has(userId)) {
    console.log(`[群聊] 忽略群 ${groupId} 中陌生人的 @（无单聊记录）`);
    return;
  }

  const userName = sanitizeLogValue(event.sender?.card || event.sender?.nickname || String(userId));
  console.log(`[群聊] ${userName}(${userId}) 在群 ${groupId} 中 @了她`);

  // 图片识别
  const media = detectMedia(event as unknown as PrivateMessageEvent);
  let finalText = text;
  if (media?.type === "image" && media.data?.url) {
    const desc = await describeImage(media.data.url);
    if (desc) {
      finalText = `[图片：${desc}] ${text}`;
      console.log(`[Vision] 群聊图片识别完成: ${textSummary(desc)}`);
    }
  }

  const state = userStates.get(userId)!;
  userLastActive.set(userId, Date.now());

  try {
    // P0 修复：await + catch，畸形事件/LLM 失败不再产生 unhandled rejection
    const result = await processMessage(state, finalText);
    for (const log of result.logs) console.log(`  ${log}`);

    // 消息门判定晚点回
    if (result.deferred) {
      scheduleDeferredGroupReply(
        { groupId, userId, userName, text: finalText, state, sharedBase },
        result.deferred.delayMs,
      );
      return;
    }
    if (result.silenced) return;

    // 不发 Unsplash 照片到群里——那是私聊专属
    await sendGroupReplies(groupId, userId, userName, result);
  } catch (err: unknown) {
    console.log(`[群聊错误] ${errMessage(err)}`);
  }
}

// ── 进程级兜底 ──────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error(`[兜底] 未处理的 Promise 拒绝: ${errMessage(reason)}`);
});

process.on("uncaughtException", (err) => {
  // 记录后保持进程存活：一条畸形事件/一次失败调用不该让 QQ 桥接整体掉线
  console.error(`[兜底] 未捕获异常: ${errMessage(err)}`);
});

main().catch((err) => {
  console.error("[致命错误]", errMessage(err));
  process.exit(1);
});
