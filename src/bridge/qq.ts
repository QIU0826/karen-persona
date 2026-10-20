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
  countPendingReplies,
} from "../data/pending-queue.js";
import {
  initConversation,
  processMessage,
  processMessageStream,
  processProactive,
  persistRuntimeState,
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
import { handleControlCommand } from "../commands/control.js";
import { exportUserData } from "../data/user-export.js";
import { buildFirstContactDisclosure } from "../persona/disclosure.js";
import {
  buildAgeConfirmedText,
  buildAgeDeclinedText,
  buildAgeGatePrompt,
  buildAgeGateReminder,
  evaluateAgeGate,
  shouldEnforceAgeGate,
} from "../persona/age-gate.js";
import { ackDisclosure, confirmAge, hasAgeConfirmation } from "../data/consent.js";
import { ownerForQq } from "../data/owner.js";
import { pickSticker, toStickerCqCode } from "../impulse/stickers.js";
import { buildGroupReplyPlan } from "./group-reply.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createLogger, configureLogger } from "../obs/logger.js";
import { startHealthServer, type HealthServerHandle } from "../obs/health-server.js";
import { startWebServer, type WebServerHandle } from "../web/server.js";

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
/** 贴纸：主动发图概率 / 冷却（同一用户） / 收到表情后的回应概率 */
const STICKER_PROBABILITY = 0.22;
const STICKER_REPLY_TO_STICKER_PROBABILITY = 0.55;
const STICKER_COOLDOWN_MS = 5 * 60 * 1000;

/** 结构化日志 scope=qq（脱敏、TTY 可读；只记录长度/摘要，不落消息正文）。 */
const log = createLogger("qq");

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

/** 去掉 raw_message 中的 CQ 码，只留纯文本（用于图片/表情附带文字） */
function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
}

/** 按 Unicode 码点统计字符数（结构化日志字段用）。 */
function charCount(text: string): number {
  return Array.from(text).length;
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

interface SharedBase {
  /** 根据 QQ 用户 ID 获取对应的人设 */
  getPersona: (userId: number) => Persona;
  config: AppConfig;
}

// ── 运行时状态 ──────────────────────────────────

const userStates = new Map<number, ConversationState>();
const userLastActive = new Map<number, number>();
/** 年龄门提醒节流（同一用户 5 分钟内最多提醒一次，避免刷屏） */
const ageGateReminderAt = new Map<number, number>();
const AGE_GATE_REMINDER_INTERVAL_MS = 5 * 60 * 1000;
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
/** 上次发贴纸的时间（每用户冷却） */
const userLastStickerAt = new Map<number, number>();
/** 群聊贴纸冷却：key = `${groupId}:${userId}`（同一个人在私聊/群里互不影响） */
const groupLastStickerAt = new Map<string, number>();

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
  log.debug("security.ignored_non_whitelisted", {
    total: ignoredNonWhitelistedMessages,
    accounts: ignoredNonWhitelistedUsers.size,
  });
}

function reportIgnoredNonWhitelisted(): void {
  if (ignoredNonWhitelistedMessages <= lastReportedIgnoredMessages) return;
  const delta = ignoredNonWhitelistedMessages - lastReportedIgnoredMessages;
  lastReportedIgnoredMessages = ignoredNonWhitelistedMessages;
  log.warn("security.ignored_non_whitelisted_summary", {
    delta,
    total: ignoredNonWhitelistedMessages,
    accounts: ignoredNonWhitelistedUsers.size,
  });
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
    log.info("gate.deferred_cancelled", { user_id: userId, reason, cancelled });
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
    log.warn("gate.deferred_invalid_delay", { delay_ms: String(delayMs) });
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
  log.info("gate.deferred_scheduled", {
    user_id: ctx.userId,
    delay_s: Math.round(delay / 1000),
    chars: charCount(ctx.text),
    pending_id: pendingId,
  });
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
    log.info("gate.deferred_cancelled", { user_id: ctx.userId, reason: "user_state_changed" });
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
      log.warn("gate.deferred_still_gated", { user_id: ctx.userId });
      if (pendingId) markPendingDone(pendingId);
      return;
    }
    if (pendingId) markPendingDone(pendingId);
    if (outcome.sentCount === 0) {
      log.info("gate.deferred_empty", { user_id: ctx.userId });
    }
  } catch (err) {
    const msg = errMessage(err);
    log.error("gate.deferred_failed", { user_id: ctx.userId, error: msg });
    if (pendingId) {
      const retry = markPendingAttempt(pendingId, msg);
      const retryDelay = Math.max(MIN_DEFERRED_DELAY_MS, retry.dueAt - Date.now());
      log.info("gate.deferred_retry", {
        user_id: ctx.userId,
        attempts: retry.attempts,
        delay_s: Math.round(retryDelay / 1000),
      });
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
    if (purged > 0) log.debug("gate.pending_purged", { purged });

    const rows = listPendingReplies("qq-private");
    if (rows.length === 0) return;

    log.info("gate.pending_restore_start", { count: rows.length });
    for (const row of rows) {
      const userId = Number(row.userId);
      if (!Number.isFinite(userId)) {
        markPendingDone(row.id);
        continue;
      }
      if (!isAllowedUser(sharedBase, userId)) {
        log.warn("gate.pending_cancelled", { reason: "allowed_users_changed", pending_id: row.id });
        markPendingDone(row.id);
        continue;
      }
      if (userDeferredTimers.has(userId)) continue;

      let state = userStates.get(userId);
      if (!state) {
        const persona = sharedBase.getPersona(userId);
        state = await initConversation(persona, sharedBase.config, ownerForQq(userId));
        state.stickerMode = "qqface";
        userStates.set(userId, state);
      }
      const wait = Math.max(2_000, row.dueAt - Date.now());
      log.info("gate.pending_restored", {
        user_id: userId,
        delay_s: Math.round(wait / 1000),
        attempts: row.attempts,
      });
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
    log.error("gate.pending_restore_failed", { error: errMessage(err) });
  } finally {
    pendingRestoring = false;
  }
}

function scheduleDeferredGroupReply(ctx: DeferredGroupContext, delayMs: number): void {
  const delay = clampDeferredDelay(delayMs);
  if (delay === null) {
    log.warn("gate.group_deferred_invalid_delay", { delay_ms: String(delayMs) });
    return;
  }
  cancelDeferredTimer(ctx.userId);
  log.info("gate.group_deferred_scheduled", {
    group_id: ctx.groupId,
    user_id: ctx.userId,
    delay_s: Math.round(delay / 1000),
  });
  const timer = setTimeout(() => {
    userDeferredTimers.delete(ctx.userId);
    void deliverDeferredGroupReply(ctx);
  }, delay);
  // 群聊延迟暂不持久化（pendingId=-1）；与私聊共用「每用户一个 timer」的简化语义
  userDeferredTimers.set(ctx.userId, { timer, pendingId: -1 });
}

async function deliverDeferredGroupReply(ctx: DeferredGroupContext): Promise<void> {
  if (userStates.get(ctx.userId) !== ctx.state) {
    log.info("gate.group_deferred_cancelled", { user_id: ctx.userId });
    return;
  }
  try {
    const result = await processMessage(ctx.state, ctx.text, {
      bypassGate: true,
      skipUserPersist: true,
      skipPhoto: !ctx.state.config.group_photo_enabled,
    });
    for (const line of result.logs) console.log(`  ${line}`);
    if (result.deferred) {
      log.warn("gate.group_deferred_still_gated", { group_id: ctx.groupId });
      return;
    }
    const sent = await sendGroupReplies(ctx.groupId, ctx.userId, ctx.userName, result, {
      photoEnabled: ctx.state.config.group_photo_enabled === true,
    });
    log.info("gate.group_deferred_done", { group_id: ctx.groupId, sent });
  } catch (err) {
    log.error("gate.group_deferred_failed", { group_id: ctx.groupId, error: errMessage(err) });
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
  log.info("memory.evicted_users", { removed: toRemove.length, remaining: userStates.size });
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
        log.error("message.drain_failed", { user_id: userId, error: errMessage(err) });
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
  // TTY 下保留人类可读 banner；非 TTY（PM2/管道）走结构化日志，保持 JSON lines
  if (process.stdout.isTTY) {
    console.log("╔══════════════════════════════════════╗");
    console.log("║   Karen — QQ 桥接 (NapCat/OneBot)   ║");
    console.log("╚══════════════════════════════════════╝\n");
  } else {
    log.info("startup.banner", { service: "karen-qq", bridge: "napcat/onebot11" });
  }

  const config = loadConfig();
  setLogLevel(config.log_level);
  configureLogger({ level: config.log_level });

  // ── 安全启动自检 ──────────────────────────────
  const isLoopback =
    config.one_bot_ws_host === "127.0.0.1" ||
    config.one_bot_ws_host === "localhost" ||
    config.one_bot_ws_host === "::1" ||
    config.one_bot_ws_host === "[::1]";

  if (config.allowed_users.length === 0) {
    log.warn("security.allowed_users_empty", {
      hint: "任何 QQ 号都能和她聊天；个人使用请把 allowed_users 配成自己的 QQ 号，对外提供服务前必须配置",
    });
  } else {
    log.info("security.allowed_users", { count: config.allowed_users.length });
  }

  if (!isLoopback && !config.one_bot_token) {
    log.warn("security.ws_no_token", {
      host: config.one_bot_ws_host,
      hint: "非本机回环监听但未配置 ONE_BOT_TOKEN：局域网内任何人都能伪装 NapCat 发事件",
    });
  }
  if (config.one_bot_token && config.one_bot_token.length < 8) {
    log.warn("security.token_too_short", { length: config.one_bot_token.length });
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
          log.warn("persona.load_failed", { persona_id: personaId, error: errMessage(err) });
        }
      }
    }
  }

  log.info("startup.persona", {
    persona: defaultPersona.name,
    career: defaultPersona.identity.lifeStory.career,
  });
  if (config.user_personas && Object.keys(config.user_personas).length > 0) {
    log.info("startup.user_personas", { count: Object.keys(config.user_personas).length });
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
    log.info("memory.decay", { decayed, archived });
  }

  // P2-a: 记忆代谢
  const metabResult = metabolizeMemories({
    currentEmotion: 0, // 启动时情绪中性
    topicKeywords: [],
  });
  for (const line of metabResult.logs) {
    console.log(`  ${line}`);
  }

  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === "sk-your-key-here") {
    log.error("startup.missing_api_key", { hint: "未设置 DEEPSEEK_API_KEY" });
    return;
  }

  // ── 可观测性：/health + /cost（仅 127.0.0.1；启动失败不影响桥接）──
  const healthServer: HealthServerHandle | null = startHealthServer({
    port: config.health_port,
    getWsConnections: () => getConnectionStatus().count,
    getPendingReplies: () => countPendingReplies(),
  });

  // ── 本地 Web 控制台（只读四视图；仅 127.0.0.1；失败不影响桥接）──
  const webServer: WebServerHandle | null = startWebServer({
    port: config.web_port,
    token: config.web_token,
    personaId: config.persona,
    personaName: defaultPersona.name,
    initialCloseness: defaultPersona.relationship.closeness,
    getWsConnections: () => getConnectionStatus().count,
    getPendingReplies: () => countPendingReplies(),
  });

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
        log.warn("ws.handshake_rejected", {
          reason: decision.reason,
          path: sanitizeLogValue(getRequestPathname(info.req)),
        });
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
    log.info("ws.listening", {
      url: `ws://${display}${PATH}`,
      token_enforced: Boolean(TOKEN),
    });
    log.info("ws.waiting_for_client");
    if (process.stdout.isTTY) console.log("══════════════════════════════════════\n");
  });

  wss.on("error", (err: Error) => {
    log.error("ws.server_error", { error: err.message });
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const clientPath = sanitizeLogValue(getRequestPathname(req));
    const wasReconnect = getConnectionCount() > 0;
    log.info("ws.connected", {
      path: clientPath,
      reconnect: wasReconnect,
      active: getConnectionCount() + 1,
    });
    if (wasReconnect) {
      log.info("ws.reconnected", { note: "会话和记忆保持不变" });
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
      log.warn("ws.disconnected", { remaining });
      if (remaining === 0) {
        const status = getConnectionStatus();
        log.warn("ws.disconnected_waiting", { last_connected_at: status.since });
        // 延迟 30s 确认不是瞬时重连，再弹通知
        setTimeout(() => {
          if (getConnectionCount() === 0) {
            log.error("ws.offline_timeout", { hint: "掉线超过 30s，请重新扫码登录 NapCatQQ" });
            notifyWindows("Karen 掉线了", "NapCatQQ 连接已断开，请重新扫码登录。");
          }
        }, 30000);
      }
    });

    ws.on("error", (err: Error) => {
      clearInterval(pingInterval);
      log.error("ws.connection_error", { error: err.message });
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
        // /pause：暂停主动消息（用户主动发消息仍会正常回）
        if (state.proactivePaused) continue;

        // 频率限制
        const freqLimit = sharedBase.config.message_frequency_limit;
        if (!checkRateLimit(userId, freqLimit)) continue;

        const result = await processProactive(state);
        if (!result || !result.reply) continue;

        for (const line of result.logs) {
          console.log(`  ${line}`);
        }

        const pendingSnapshot = userPending.get(userId) ?? 0;
        const lines = result.reply.split("\n").filter(Boolean);
        for (const line of lines) {
          // 中断检测：主动 burst 中用户回复了就停
          const nowPending = userPending.get(userId) ?? 0;
          if (nowPending > pendingSnapshot) {
            log.info("proactive.interrupted", { user_id: userId });
            state.interrupted = true;
            break;
          }

          sendPrivateMsg(userId, line.trim());
          log.info("proactive.sent", { user_id: userId, chars: charCount(line.trim()) });
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
        log.error("proactive.failed", { user_id: userId, error: errMessage(err) });
      }
    }
  }, HEARTBEAT_MS);

  log.info("proactive.heartbeat_started", { interval_min: HEARTBEAT_MS / 60000 });

  // ── 优雅退出 ──────────────────────────────────

  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown.start");
    clearInterval(statusInterval);
    clearInterval(heartbeatTimer);
    const cancelled = clearAllDeferredTimers();
    if (cancelled > 0) log.info("shutdown.deferred_timers_cleared", { cancelled });
    for (const buf of userBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = null;
    }
    for (const ws of wss.clients) {
      try { ws.close(); } catch { /* 忽略关闭失败 */ }
    }
    healthServer?.stop();
    webServer?.stop();
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
      log.warn("api.call_failed", { retcode: apiResp.retcode });
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
    log.error("ws.event_failed", { error: errMessage(err) });
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
/** 出站图片大小上限（base64 后约 6.7MB，留余量） */
const MAX_OUTBOUND_PHOTO_BYTES = 5 * 1024 * 1024;

interface OutboundPhoto {
  url?: string;
  file?: string;
  caption?: string;
}

/**
 * 发送主动分享的图片：先发配文、再发图片（本地文件读 base64 / URL 下载后 base64）。
 * 失败静默降级，不影响文字回复；日志不落正文。
 */
/** 读取/下载出站图片为 base64（本地文件优先；失败返回 null）。 */
async function readOutboundPhotoBase64(
  photo: { file?: string; url?: string },
): Promise<{ base64: string; source: string } | null> {
  if (photo.file) {
    const buffer = fs.readFileSync(photo.file);
    if (buffer.length > 0 && buffer.length <= MAX_OUTBOUND_PHOTO_BYTES) {
      return { base64: buffer.toString("base64"), source: "local" };
    }
    return null;
  }
  if (photo.url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(photo.url, { signal: controller.signal });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0 && buffer.length <= MAX_OUTBOUND_PHOTO_BYTES) {
          return { base64: buffer.toString("base64"), source: "url" };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function sendPhotoToUser(userId: number, photo: OutboundPhoto): Promise<void> {
  try {
    const resolved = await readOutboundPhotoBase64(photo);
    if (!resolved) {
      log.warn("photo.outbound_failed", { user_id: userId, source: photo.file ? "local" : "url" });
      return;
    }

    if (photo.caption) {
      sendPrivateMsg(userId, photo.caption);
      await sleep(700);
    }
    sendPrivateMsg(userId, asCqCode(`[CQ:image,file=base64://${resolved.base64}]`));
    log.info("photo.sent", {
      user_id: userId,
      source: resolved.source,
      bytes: Math.round((resolved.base64.length * 3) / 4),
      target: "private",
    });
  } catch (err: unknown) {
    log.warn("photo.send_error", { user_id: userId, error: errMessage(err) });
  }
}

/** 群聊发图（仅 group_photo_enabled=true 时调用）：先配文再图片，与私聊一致。 */
async function sendPhotoToGroup(groupId: number, photo: OutboundPhoto): Promise<void> {
  try {
    const resolved = await readOutboundPhotoBase64(photo);
    if (!resolved) {
      log.warn("photo.outbound_failed", { group_id: groupId, source: photo.file ? "local" : "url" });
      return;
    }
    if (photo.caption) {
      sendGroupMsg(groupId, photo.caption);
      await sleep(700);
    }
    sendGroupMsg(groupId, asCqCode(`[CQ:image,file=base64://${resolved.base64}]`));
    log.info("photo.sent", {
      group_id: groupId,
      source: resolved.source,
      bytes: Math.round((resolved.base64.length * 3) / 4),
      target: "group",
    });
  } catch (err: unknown) {
    log.warn("photo.send_error", { group_id: groupId, error: errMessage(err) });
  }
}

async function streamPrivateReply(params: {
  state: ConversationState;
  text: string;
  userId: number;
  userName: string;
  options?: { bypassGate?: boolean; skipUserPersist?: boolean };
  /** 日志前缀，用于区分正常回复与延迟补发 */
  logPrefix?: string;
}): Promise<PrivateStreamOutcome> {
  const { state, text, userId, options } = params;
  const logPrefix = params.logPrefix ?? "回复";
  const pendingSnapshot = userPending.get(userId) ?? 0;
  let sentCount = 0;

  const stream = processMessageStream(state, text, options);
  for await (const frag of stream) {
    // 中断检测：用户发来新消息 → 丢弃剩余 burst
    if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
      state.interrupted = true;
      log.info("reply.interrupted", { user_id: userId, stage: "before_send" });
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
        log.info("reply.interrupted", { user_id: userId, stage: "before_qqface" });
        return { sentCount, interrupted: true };
      }
      sendPrivateMsg(userId, asCqCode(frag.qqFace));
      log.info("reply.sent_qqface", { user_id: userId, deferred: logPrefix !== "回复" });
      sentCount++;
      // 不能 break：qqFace 之后还可能跟主动发图 fragment（本地图库/Unsplash）
      continue;
    }

    if (frag.image) {
      await sendPhotoToUser(userId, frag.image);
      continue;
    }

    if (frag.safetyMessage) {
      // 合规：危机求助资源（程序生成，独立消息）
      sendPrivateMsg(userId, frag.safetyMessage);
      log.info("compliance.crisis_resources_sent", { user_id: userId });
      continue;
    }

    if (!frag.text) continue;

    // 流式 fragment 之间的自然间隔（模拟打字间隙）
    if (sentCount > 0) {
      const typingDelay = 200 + Math.random() * 600;
      await sleep(typingDelay);
      if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
        state.interrupted = true;
        log.info("reply.interrupted", { user_id: userId, stage: "streaming" });
        return { sentCount, interrupted: true };
      }
    }

    sendPrivateMsg(userId, frag.text);
    log.info("reply.sent", {
      user_id: userId,
      chars: charCount(frag.text),
      deferred: logPrefix !== "回复",
    });
    sentCount++;
  }

  return { sentCount, interrupted: false };
}

/** 贴纸发送目标：私聊给某人，或群聊里回应某人（同一套贴纸/情绪逻辑） */
type StickerTarget =
  | { kind: "private"; userId: number }
  | { kind: "group"; groupId: number; userId: number };

/**
 * 文字回复后，按情绪/时段「顺手」发一个本地贴纸。
 * - 私聊/群聊共用选择逻辑；冷却按目标分别计算（私聊 5 分钟，群聊按 群+人 5 分钟）；
 * - 收到对方表情时更愿意回一个；
 * - 冲突未化解时不发；资源/发送失败静默降级。
 */
function maybeSendSticker(
  target: StickerTarget,
  state: ConversationState,
  inboundSticker: boolean,
): void {
  if (process.env.STICKER_ENABLED === "0") return;

  const now = Date.now();
  const groupKey = target.kind === "group" ? `${target.groupId}:${target.userId}` : "";
  const last =
    target.kind === "private"
      ? (userLastStickerAt.get(target.userId) ?? 0)
      : (groupLastStickerAt.get(groupKey) ?? 0);
  if (now - last < STICKER_COOLDOWN_MS) return;

  const conflictAt = state.relationshipState.lastConflictAt;
  const conflictActive = conflictAt !== null && now - conflictAt < 24 * 60 * 60 * 1000;

  const sticker = pickSticker({
    emotion: state.emotionState.vector,
    hour: new Date(now).getHours(),
    conflictActive,
  });
  if (!sticker) return;

  const probability = inboundSticker ? STICKER_REPLY_TO_STICKER_PROBABILITY : STICKER_PROBABILITY;
  if (Math.random() > probability) return;

  const cq = toStickerCqCode(sticker);
  if (!cq) return;

  if (target.kind === "private") {
    userLastStickerAt.set(target.userId, now);
    sendPrivateMsg(target.userId, asCqCode(cq));
    log.info("sticker.sent", {
      user_id: target.userId,
      sticker: sticker.id,
      reply_to_sticker: inboundSticker,
      target: "private",
    });
    return;
  }

  groupLastStickerAt.set(groupKey, now);
  sendGroupMsg(target.groupId, asCqCode(cq));
  log.info("sticker.sent", {
    group_id: target.groupId,
    user_id: target.userId,
    sticker: sticker.id,
    reply_to_sticker: inboundSticker,
    target: "group",
  });
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
  let inboundSticker = false;
  for (const event of events) {
    const media = detectMedia(event);

    // 表情/表情包不再丢弃：转成 [表情：xxx] 合成文本，让她能做出反应
    if (media && (media.type === "face" || media.type === "mface")) {
      inboundSticker = true;
      log.info("sticker.received", { user_id: userId, type: media.type });
    }

    // P2-e: 图片识别
    let syntheticText = media?.syntheticText || null;
    if (media?.type === "image" && media.data?.url) {
      const desc = await describeImage(media.data.url);
      if (desc) {
        syntheticText = `[图片：${desc}]`;
        log.info("vision.described", { chars: charCount(desc), source: "private" });
      }
    }

    // 图片/表情附带文字时保留文字（raw_message 去掉 CQ 码后的残余）
    let rawText = syntheticText || event.raw_message || "";
    if (syntheticText && (media?.type === "image" || media?.type === "face" || media?.type === "mface")) {
      const residual = stripCqCodes(event.raw_message ?? "");
      if (residual) rawText = `${syntheticText} ${residual}`;
    }
    if (media?.type === "reply") {
      let quoted = getReplyContext(media.data);
      // 回退：NapCatQQ 未附带原文时，用 message_id 调 get_msg API 回查
      if (!quoted && media.data?.id) {
        const msgId = parseInt(media.data.id, 10);
        if (!isNaN(msgId)) {
          log.info("quote.refetch_start");
          quoted = await getMsgById(msgId);
          if (quoted) {
            log.info("quote.refetch_ok", { chars: charCount(quoted) });
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
    // 治理命令：/why /stats /pause /resume /export /help
    if (!userStates.has(userId)) {
      evictStaleUsers();
      const persona = sharedBase.getPersona(userId);
      const st = await initConversation(persona, sharedBase.config, ownerForQq(userId));
      st.stickerMode = "qqface";
      userStates.set(userId, st);
      if (sharedBase.config.ai_disclosure && st.session.messages.length === 0) {
        const gatePending =
          shouldEnforceAgeGate(st.owner, sharedBase.config.age_gate_enabled) &&
          !hasAgeConfirmation(st.owner);
        sendPrivateMsg(userId, buildFirstContactDisclosure({ ageGate: gatePending }));
        ackDisclosure(st.owner);
        log.info("compliance.disclosure_sent", { user_id: userId });
      }
    }
    const state = userStates.get(userId)!;
    const handled = await handleControlCommand(text, state, {
      reply: (reply) => sendPrivateMsg(userId, reply),
      persist: () => persistRuntimeState(state),
      exportData: () =>
        exportUserData({
          personaName: state.persona.name,
          storagePersona: state.storagePersona,
          storageKey: state.storageKey,
          session: state.session,
          initialCloseness: state.persona.relationship.closeness,
        }),
    });
    if (!handled) {
      sendPrivateMsg(userId, "看不懂这个指令。/help 看看能做什么。");
    }
    return;
  }

  log.info("message.received", { user_id: userId, chars: charCount(text) });

  if (!userStates.has(userId)) {
    evictStaleUsers();
    const persona = sharedBase.getPersona(userId);
    const st = await initConversation(persona, sharedBase.config, ownerForQq(userId));
    st.stickerMode = "qqface";
    userStates.set(userId, st);
    log.info("session.created", { user_id: userId, persona: persona.name });
    const gatePending =
      shouldEnforceAgeGate(st.owner, sharedBase.config.age_gate_enabled) &&
      !hasAgeConfirmation(st.owner);
    // 合规：首次对话披露（AI 身份 + 数据去向 + 18+），仅新会话发一次
    if (sharedBase.config.ai_disclosure && st.session.messages.length === 0) {
      sendPrivateMsg(userId, buildFirstContactDisclosure({ ageGate: gatePending }));
      ackDisclosure(st.owner);
      log.info("compliance.disclosure_sent", { user_id: userId });
    }
    if (gatePending) {
      sendPrivateMsg(userId, buildAgeGatePrompt());
      ageGateReminderAt.set(userId, Date.now());
      log.info("compliance.age_gate_prompt", { user_id: userId });
      return;
    }
  }

  userLastActive.set(userId, Date.now());
  const state = userStates.get(userId)!;

  // 合规：年龄门（未确认前不进入角色对话；确认消息本身不当作聊天内容）
  const ageGateAction = evaluateAgeGate({
    text,
    owner: state.owner,
    enabled: sharedBase.config.age_gate_enabled,
    confirmed: hasAgeConfirmation(state.owner),
  });
  if (ageGateAction === "declined") {
    sendPrivateMsg(userId, buildAgeDeclinedText());
    log.info("compliance.age_gate_declined", { user_id: userId });
    return;
  }
  if (ageGateAction === "confirmed") {
    confirmAge(state.owner);
    sendPrivateMsg(userId, buildAgeConfirmedText());
    log.info("compliance.age_gate_confirmed", { user_id: userId });
    return;
  }
  if (ageGateAction === "ask") {
    const lastPromptAt = ageGateReminderAt.get(userId) ?? 0;
    if (Date.now() - lastPromptAt >= AGE_GATE_REMINDER_INTERVAL_MS) {
      sendPrivateMsg(userId, buildAgeGateReminder());
      ageGateReminderAt.set(userId, Date.now());
      log.info("compliance.age_gate_remind", { user_id: userId });
    }
    return;
  }

  // 频率限制（放在门控/LLM 之前，省成本）
  const freqLimit = sharedBase.config.message_frequency_limit;
  if (!checkRateLimit(userId, freqLimit)) {
    log.warn("message.rate_limited", { user_id: userId, limit_per_minute: freqLimit });
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
    } else if (outcome.sentCount > 0) {
      maybeSendSticker({ kind: "private", userId }, state, inboundSticker);
    }
  } catch (err: unknown) {
    log.error("reply.failed", { user_id: userId, error: errMessage(err) });
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
 *
 * 出站内容由 `buildGroupReplyPlan` 统一编排：文字气泡 → QQ 表情 → （可选）照片+配文。
 * 照片默认不发群（隐私保守），只有 `group_photo_enabled: true` 才会出现。
 */
async function sendGroupReplies(
  groupId: number,
  userId: number,
  _userName: string,
  result: PipelineResult,
  options: { photoEnabled?: boolean } = {},
): Promise<number> {
  const plan = buildGroupReplyPlan(result, { photoEnabled: options.photoEnabled === true });
  if (plan.textLines.length === 0 && !plan.qqFaceCq && !plan.photo) return 0;

  let sent = 0;
  for (let i = 0; i < plan.textLines.length; i++) {
    const line = plan.textLines[i];
    const delayMs = line.length <= 3 ? 600 + Math.random() * 800 :
                    line.length <= 15 ? 1000 + Math.random() * 1500 :
                    1500 + Math.random() * 2500;
    if (i > 0) await sleep(delayMs);

    sendGroupMsg(groupId, line);
    log.info("group.reply_sent", { group_id: groupId, user_id: userId, chars: charCount(line) });
    sent++;
  }

  // QQ 表情
  if (plan.qqFaceCq) {
    await sleep(500 + Math.random() * 600);
    sendGroupMsg(groupId, asCqCode(plan.qqFaceCq));
    sent++;
  }

  // 主动分享的照片（默认关闭；仅团体发图开启时）
  if (plan.photo) {
    await sleep(800 + Math.random() * 800);
    await sendPhotoToGroup(groupId, plan.photo);
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
    log.info("group.ignored_stranger", { group_id: groupId, user_id: userId });
    return;
  }

  const userName = sanitizeLogValue(event.sender?.card || event.sender?.nickname || String(userId));
  log.info("group.mentioned", { group_id: groupId, user_id: userId });

  // 图片/表情识别（群聊里收到表情时也会更愿意回贴纸）
  const media = detectMedia(event as unknown as PrivateMessageEvent);
  const inboundSticker = media?.type === "face" || media?.type === "mface";
  let finalText = text;
  if (media?.type === "image" && media.data?.url) {
    const desc = await describeImage(media.data.url);
    if (desc) {
      finalText = `[图片：${desc}] ${text}`;
      log.info("vision.described", { chars: charCount(desc), source: "group" });
    }
  }

  const state = userStates.get(userId)!;
  // 合规：未确认 18+ 的用户不在群里回复（避免在多人场合诱导未成年人互动）
  if (
    shouldEnforceAgeGate(state.owner, state.config.age_gate_enabled) &&
    !hasAgeConfirmation(state.owner)
  ) {
    log.info("compliance.age_gate_group_blocked", { group_id: groupId, user_id: userId });
    return;
  }
  userLastActive.set(userId, Date.now());

  try {
    // P0 修复：await + catch，畸形事件/LLM 失败不再产生 unhandled rejection
    // 群聊默认 skipPhoto：多人群里不发她的生活照（config.group_photo_enabled 才开）
    const result = await processMessage(state, finalText, {
      skipPhoto: !state.config.group_photo_enabled,
    });
    for (const line of result.logs) console.log(`  ${line}`);

    // 消息门判定晚点回
    if (result.deferred) {
      scheduleDeferredGroupReply(
        { groupId, userId, userName, text: finalText, state, sharedBase },
        result.deferred.delayMs,
      );
      return;
    }
    if (result.silenced) return;

    // 出站：文字 → QQ 表情 →（可选）照片；之后再按情绪/时段顺手一个贴纸
    const sent = await sendGroupReplies(groupId, userId, userName, result, {
      photoEnabled: state.config.group_photo_enabled === true,
    });
    if (sent > 0) {
      maybeSendSticker({ kind: "group", groupId, userId }, state, inboundSticker);
    }
  } catch (err: unknown) {
    log.error("group.failed", { group_id: groupId, user_id: userId, error: errMessage(err) });
  }
}

// ── 进程级兜底 ──────────────────────────────────

process.on("unhandledRejection", (reason) => {
  log.error("process.unhandled_rejection", { error: errMessage(reason) });
});

process.on("uncaughtException", (err) => {
  // 记录后保持进程存活：一条畸形事件/一次失败调用不该让 QQ 桥接整体掉线
  log.error("process.uncaught_exception", { error: errMessage(err) });
});

main().catch((err) => {
  log.error("process.fatal", { error: errMessage(err) });
  process.exit(1);
});
