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
import {
  messageMergeWindowMs,
  planPacing,
  typingTimeFor,
  type PacingPersona,
  type PacingResult,
} from "./pacing.js";
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
  recordRelationshipMilestone,
  runMemoryJobsIfDue,
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
  detectMediaList,
  getReplyContext,
  sendPrivateMsg,
  sendGroupMsg,
  sendPrivateMsgAsync,
  sendGroupMsgAsync,
  verifySentSegment,
  recallMessage,
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
import { describeImage, fetchImageAsDataUrl, labelStickerImage } from "../ai/vision.js";
import { checkMediaUrl } from "../ai/media-url.js";
import { handleControlCommand } from "../commands/control.js";
import { exportUserData } from "../data/user-export.js";
import { publishQzonePost, isQzoneEnabled } from "../qzone/qzone.js";
import { handleSocialCommand } from "../social/command.js";
import { effectiveSocialConfig, loadSocialRuntime, setSocialModeOverride } from "../social/runtime.js";
import { runSocialTick } from "../social/runner.js";
import { approveAndExecuteAction, postDynamicManual, undoSocialAction } from "../social/executor.js";
import { listPending, rejectAction } from "../social/store.js";
import { maybeAutoPublishQzone, localDateKey, type QzoneAutoState } from "../qzone/qzone-auto.js";
import { dataFile } from "../data/paths.js";
import { buildFirstContactDisclosure, shouldSendDisclosure } from "../persona/disclosure.js";
import {
  buildAgeConfirmedText,
  buildAgeDeclinedText,
  buildAgeGatePrompt,
  buildAgeGateReminder,
  evaluateAgeGate,
  shouldEnforceAgeGate,
  stripAgeConfirmationMarkers,
} from "../persona/age-gate.js";
import { ackDisclosure, confirmAge, getConsent, hasAgeConfirmation } from "../data/consent.js";
import { ownerForQq } from "../data/owner.js";
import { collectedStickerProbability, pickSticker, toStickerCqCode } from "../impulse/stickers.js";
import { buildGroupReplyPlan } from "./group-reply.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createLogger, configureLogger } from "../obs/logger.js";
import { startHealthServer, type HealthServerHandle } from "../obs/health-server.js";
import { notifyDesktop } from "../obs/notify.js";
import { startWebServer, type WebServerHandle } from "../web/server.js";
import { isSpeechAvailable, synthesizeSpeech } from "../ai/tts.js";
import { decideVoiceFirst } from "../impulse/voice.js";
import { decideProactiveMedia } from "../impulse/proactive-media.js";
import { detectMediaRequest } from "../impulse/media-request.js";
import {
  buildStickerContextHint,
  rememberStickerMemory,
  type StickerMemory,
} from "../impulse/sticker-context.js";
import { isAsrEnabled, isSilkBuffer, isWavBuffer, silkToWav, transcribeVoice } from "../ai/asr.js";
import { formatVoiceUnderstanding, isSenseVoiceEnabled, understandVoice } from "../ai/sensevoice.js";
import {
  formatQwenOmniVoice,
  isQwenOmniEnabled,
  understandVoiceWithQwenOmni,
} from "../ai/qwen-omni.js";
import {
  collectSticker,
  downloadStickerBytes,
  labelSticker,
  markStickerUsed,
  pickCollectedSticker,
} from "../data/sticker-library.js";
import { isWithinTurnDuplicate } from "../persona/anti-repetition.js";
import { stripOutboundMediaMarkers } from "../persona/outbound-markers.js";
import { updateUserMessageContent } from "../data/history.js";
import { shouldSendPhotoCaption } from "../impulse/photo-caption.js";
import { isCharacterPhotoRequest, pickFallbackSelfie, pickProactivePhoto } from "../impulse/unsplash-trigger.js";
import { replyRefusesPhoto } from "../impulse/photo-refusal.js";
import { generateSelfie, isSelfieGenerationEnabled, pickSelfieCaption } from "../media/selfie-generator.js";
import { saveGeneratedImage } from "../media/generated-store.js";
import { markPromisesDone, recordPromisesFromMessages } from "../data/promise-ledger.js";
import {
  DEFAULT_TYPO_RECALL_SETTINGS,
  type TypoRecallSettings,
} from "../impulse/typo-recall.js";
import { intentSettingsFromTypo, planMessageIntent } from "../impulse/message-intent.js";
import { findPendingVoicePromise, isVoiceFollowUp } from "../pipeline/self-consistency.js";

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

/** 进程内表情包 note 记忆：她刚发/刚收到的收藏表情，最多 5 条/owner。 */
const stickerMemoryByOwner = new Map<string, StickerMemory[]>();

function rememberStickerNote(owner: string, memory: StickerMemory): void {
  const prev = stickerMemoryByOwner.get(owner) ?? [];
  stickerMemoryByOwner.set(owner, rememberStickerMemory(prev, memory));
}

function stickerHintFor(owner: string, text: string): string | undefined {
  return (
    buildStickerContextHint({
      userText: text,
      memories: stickerMemoryByOwner.get(owner) ?? [],
    }) ?? undefined
  );
}

/** 收藏表 scene_tags 是 JSON 字符串；解析失败返回空数组。 */
function parseSceneTags(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** 单轮最多几条文字气泡（超出合并到最后一条；验证里出现过多达 6-9 条） */
const MAX_TEXT_BUBBLES = 4;

/** 语音：录音补白（真人按下录音到发出之间还有一点时间） / 单条语音最长发送等待 */
const VOICE_RECORD_PADDING_MS = 400;
const VOICE_MAX_SEND_DELAY_MS = 12_000;

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

/** 最近发过的「收集来的」表情包（避免连续重复同一张） */
const userRecentCollectedStickers = new Map<number, number[]>();

/** 情绪 → 表情包标签（与 sticker_library.emotion 对齐） */
function stickerEmotionTag(vector: number): string {
  if (vector > 0.35) return "happy";
  if (vector < -0.35) return "sad";
  return "neutral";
}
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
  /** v0.9.26：本轮图片 data URL；进程内补发时保留，重启后靠文字描述兜底 */
  images?: string[];
  /** v0.9.32：表情包 note 上下文（仅本轮内部提示） */
  stickerHint?: string;
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
  images?: string[];
  stickerHint?: string;
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
      images: ctx.images,
      stickerHint: ctx.stickerHint,
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
    recordTurnPromises(ctx.state, {
      voiceSent: outcome.voiceSent === true,
      photoSent: outcome.photoSent,
    });
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
      images: ctx.images,
      stickerHint: ctx.stickerHint,
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
    // 竞态修复：enqueueMessage 看到 processing=true 时只入队不设 timer；
    // 若它恰好发生在「while 检查 events 为空」之后、本 finally 之前，消息会永远卡住。
    // 收尾时再检查一次，有积压就重新排一个消费窗口。
    if (buf.events.length > 0 && userBuffers.get(userId) === buf) {
      if (buf.timer) clearTimeout(buf.timer);
      const latestText = buf.events.length
        ? stripCqCodes(String(buf.events[buf.events.length - 1]?.raw_message ?? ""))
        : "";
      buf.timer = setTimeout(() => {
        if (userBuffers.get(userId) !== buf) return;
        buf.timer = null;
        void drainUserBuffer(userId, buf, sharedBase);
      }, messageMergeWindowMs(latestText, MERGE_WINDOW_MS));
    }
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

  // 重置合并窗口（400ms 内的连续消息合并处理）；对方没说完时延长到 1500ms，
  // 让「我跟你讲」后面的补充消息并进同一批，而不是让她回半句话。
  if (buf.timer) clearTimeout(buf.timer);
  const latestText =
    typeof event.raw_message === "string" ? stripCqCodes(event.raw_message) : "";
  buf.timer = setTimeout(() => {
    if (!buf) return;
    buf.timer = null;
    void drainUserBuffer(userId, buf, sharedBase);
  }, messageMergeWindowMs(latestText, MERGE_WINDOW_MS));
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
  // P0-2：/health 聚合 TTS/ASR/嵌入/生图依赖；掉线/恢复时弹 macOS 通知。
  const healthServer: HealthServerHandle | null = startHealthServer({
    port: config.health_port,
    getWsConnections: () => getConnectionStatus().count,
    getPendingReplies: () => countPendingReplies(),
    enableDependencyMonitor: true,
    onDependencySnapshot: (snapshot, previous) => {
      if (!previous) return;
      const previousDown = new Set(previous.degraded.map((status) => status.name));
      const newlyDown = snapshot.degraded.filter((status) => !previousDown.has(status.name));
      if (newlyDown.length > 0) {
        notifyDesktop(
          "Karen 依赖掉线",
          `${newlyDown.map((status) => status.label).join("、")} 不可达；她可能在降级运行（旧图库/系统音/听不懂语音）。`,
        );
      } else if (previous.degraded.length > 0 && snapshot.degraded.length === 0) {
        notifyDesktop("Karen 依赖恢复", "语音/图像/识别链路已恢复。");
      }
    },
  });

  // ── 本地 Web 控制台（只读四视图；仅 127.0.0.1；失败不影响桥接）──
  const webServer: WebServerHandle | null = startWebServer({
    port: config.web_port,
    token: config.web_token,
    personaId: config.persona,
    personaName: defaultPersona.name,
    initialCloseness: defaultPersona.relationship.closeness,
    // 多用户只读视图：默认只展示主用户；web_all_owners=true 才允许切换
    primaryOwner:
      config.allowed_users.length > 0 ? ownerForQq(config.allowed_users[0]) : "cli:local",
    allOwners: config.web_all_owners === true,
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

  // ── Qzone 自动动态（默认关）──────────────────
  const qzoneStatePath = dataFile("qzone-state.json");
  let qzoneAutoState: QzoneAutoState = { lastDate: null };
  try {
    const raw = JSON.parse(fs.readFileSync(qzoneStatePath, "utf8")) as QzoneAutoState;
    qzoneAutoState = { lastDate: raw.lastDate ?? null, ...(raw.lastTid ? { lastTid: raw.lastTid } : {}), ...(raw.lastAt ? { lastAt: raw.lastAt } : {}) };
  } catch {
    // 首次/损坏：从空状态开始
  }
  let qzonePosting = false;

  const maybeAutoQzone = async (): Promise<void> => {
    if (process.env.KAREN_QZONE_AUTO !== "on") return;
    if (!isQzoneEnabled() || qzonePosting) return;
    if (getConnectionCount() === 0) return;
    const state = userStates.values().next().value as ConversationState | undefined;
    if (!state) return;
    const now = new Date();
    if (qzoneAutoState.lastDate === localDateKey(now)) return;
    qzonePosting = true;
    try {
      const result = await maybeAutoPublishQzone(state, qzoneAutoState, now);
      if (result.posted) {
        qzoneAutoState = result.state;
        fs.writeFileSync(qzoneStatePath, JSON.stringify(qzoneAutoState, null, 2), "utf8");
      }
    } catch (err: unknown) {
      log.warn("qzone.auto_error", { error: errMessage(err) });
    } finally {
      qzonePosting = false;
    }
  };

  // ── 高权限社会化自主 tick（默认不启用；显式 KAREN_SOCIAL 或 /social on 后）──
  let socialRunning = false;
  const maybeRunSocialAutonomy = async (): Promise<void> => {
    if (socialRunning || getConnectionCount() === 0) return;
    const runtime = loadSocialRuntime();
    // 没有显式 opt-in 时不跑：默认 env 不设置，避免用户没配置就自动草拟/发评论
    if (!process.env.KAREN_SOCIAL && !runtime.modeOverride) return;
    const config = effectiveSocialConfig(process.env, runtime);
    if (config.mode === "off") return;
    const entry = userStates.entries().next().value as [number, ConversationState] | undefined;
    if (!entry) return;
    const [userId, state] = entry;
    socialRunning = true;
    try {
      const result = await runSocialTick(state, { config, runtime });
      const action = result.pending ?? result.sent;
      if (!action) return;
      const label = action.action === "dynamic" ? "动态" : action.action === "comment" ? "评论" : action.action;
      if (result.pending) {
        sendPrivateMsg(
          userId,
          `【想发个${label}，等你点头】#${action.id}\n${action.content.slice(0, 80)}\n/social approve ${action.id}｜/social reject ${action.id}`,
        );
        log.info("social.pending", { user_id: userId, action_id: action.id, action: action.action });
      } else if (result.sent) {
        sendPrivateMsg(userId, `【刚在B站${label}了】#${action.id} ${action.target.title ? `「${action.target.title.slice(0, 30)}」` : ""}`.trim());
        log.info("social.sent", { user_id: userId, action_id: action.id, action: action.action });
      }
    } catch (err: unknown) {
      log.warn("social.tick_failed", { error: errMessage(err) });
    } finally {
      socialRunning = false;
    }
  };

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

        // 记忆 v2：到期的日记忆/周汇总（没有到期任务时几乎零成本）
        await runMemoryJobsIfDue(state);

        // 频率限制
        const freqLimit = sharedBase.config.message_frequency_limit;
        if (!checkRateLimit(userId, freqLimit)) continue;

        const result = await processProactive(state);
        if (!result.sent) {
          // v0.4.0：每次心跳都留下"为什么没主动找你"，/why 可查。
          // 日志走 debug，避免每 15 分钟写一条 info 把日志刷满。
          const reason = result.decision.action === "skip" ? result.decision.reason : "gated";
          log.debug("proactive.skip", { user_id: userId, reason, detail: result.decision.detail });
          if (process.env.KAREN_PROACTIVE_VERBOSE === "1") {
            for (const line of result.logs) console.log(`  ${line}`);
          }
          continue;
        }

        for (const line of result.logs) {
          console.log(`  ${line}`);
        }

        const pendingSnapshot = userPending.get(userId) ?? 0;
        const lines = result.reply
          .split("\n")
          .map((line) => stripOutboundMediaMarkers(line))
          .filter(Boolean);

        // P1-4：低频把主动消息改成语音，或文字后补一张本地图。
        const proactiveMediaEnabled = (process.env.KAREN_PROACTIVE_MEDIA ?? "on") !== "off";
        const mediaDecision = decideProactiveMedia({
          voiceEnabled: proactiveMediaEnabled && (state.config.voice_enabled ?? true) === true,
          photoEnabled: proactiveMediaEnabled,
          closeness: state.persona.relationship.closeness,
          hour: new Date().getHours(),
          quietHours: {
            start: state.config.quiet_hours_start,
            end: state.config.quiet_hours_end,
          },
          lastVoiceAt: userLastVoiceAt.get(userId),
          lastPhotoAt: userLastProactivePhotoAt.get(userId),
          now: Date.now(),
        });

        let mediaVoiceSent = false;
        if (
          mediaDecision.kind === "voice" &&
          (userPending.get(userId) ?? 0) <= pendingSnapshot &&
          (await isSpeechReady())
        ) {
          const voiceSent = await sendVoiceNote(userId, state, result.reply);
          if (voiceSent) {
            mediaVoiceSent = true;
            log.info("proactive.voice", {
              user_id: userId,
              channel: result.channel,
              reason: mediaDecision.reason,
            });
          }
        }

        if (!mediaVoiceSent) {
          for (const line of lines) {
            // 中断检测：主动 burst 中用户回复了就停
            const nowPending = userPending.get(userId) ?? 0;
            if (nowPending > pendingSnapshot) {
              log.info("proactive.interrupted", { user_id: userId });
              state.interrupted = true;
              break;
            }

            sendPrivateMsg(userId, line.trim());
            log.info("proactive.sent", {
              user_id: userId,
              channel: result.channel,
              chars: charCount(line.trim()),
            });
            await sleep(1500 + Math.random() * 2000);
          }
          if (result.qqFace) {
            const nowPending = userPending.get(userId) ?? 0;
            if (nowPending <= pendingSnapshot) {
              await sleep(400 + Math.random() * 600);
              sendPrivateMsg(userId, asCqCode(result.qqFace));
            }
          }

          // 语音没发时才考虑补图；用户中途回复就不再发。
          if (
            mediaDecision.kind === "photo" &&
            (userPending.get(userId) ?? 0) <= pendingSnapshot
          ) {
            const photo = pickProactivePhoto(state);
            if (photo) {
              await sendPhotoToUser(
                userId,
                {
                  ...(photo.imageFile ? { file: photo.imageFile } : {}),
                  ...(photo.imageUrl ? { url: photo.imageUrl } : {}),
                  caption: photo.caption,
                },
                result.reply,
              );
              userLastProactivePhotoAt.set(userId, Date.now());
              if (recordRelationshipMilestone(state, "first-photo", "第一次给他发照片")) {
                persistRuntimeState(state);
              }
              log.info("proactive.photo", {
                user_id: userId,
                channel: result.channel,
                source: photo.source,
                reason: mediaDecision.reason,
              });
            }
          }
        }
      } catch (err: unknown) {
        // 单个用户失败不影响其他（不打印正文）
        log.error("proactive.failed", { user_id: userId, error: errMessage(err) });
      }
    }
    // Qzone 自动动态：心跳里低频尝试，每天最多一条；默认关。
    void maybeAutoQzone();
    // 高权限社会化：默认关；显式开启后一次心跳最多一个动作。
    void maybeRunSocialAutonomy();
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
  /** 本轮实际发出的文字正文（按换行拼接，用于「顺手发一条语音」选句） */
  sentText: string;
  /** 本轮是否发过危机求助资源（危机语境下不发语音） */
  safetySent: boolean;
  /** 本轮是否发过照片（同一轮不再补语音，避免多媒体叠在一起） */
  photoSent: boolean;
  /** P1-1：本轮是否真的发出了一条语音（用于标记承诺已兑现）。 */
  voiceSent?: boolean;
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
 * 发送媒体并回读校验（v0.9.24）：语音/照片/贴纸发完用 get_msg 确认段类型。
 * 只记录类型/结果，不记录 CQ 内容或本机路径。
 */
interface MediaSendResult {
  sent: boolean;
  verified: boolean;
}

async function sendPrivateMediaAndVerify(
  userId: number,
  cq: string,
  expected: "image" | "record",
  label: string,
): Promise<MediaSendResult> {
  const messageId = await sendPrivateMsgAsync(userId, asCqCode(cq));
  if (messageId === null) {
    log.warn("media.send_failed", { user_id: userId, kind: label });
    return { sent: false, verified: false };
  }
  const check = await verifySentSegment(messageId, expected);
  if (check.confirmed) {
    log.info("media.verified", {
      user_id: userId,
      kind: label,
      message_id: messageId,
      duration_s: check.durationSeconds,
    });
  } else {
    log.warn("media.verify_failed", {
      user_id: userId,
      kind: label,
      message_id: messageId,
      reason: check.reason,
    });
  }
  return { sent: true, verified: check.confirmed };
}

async function sendGroupMediaAndVerify(
  groupId: number,
  cq: string,
  expected: "image" | "record",
  label: string,
): Promise<MediaSendResult> {
  const messageId = await sendGroupMsgAsync(groupId, asCqCode(cq));
  if (messageId === null) {
    log.warn("media.send_failed", { group_id: groupId, kind: label });
    return { sent: false, verified: false };
  }
  const check = await verifySentSegment(messageId, expected);
  if (check.confirmed) {
    log.info("media.verified", {
      group_id: groupId,
      kind: label,
      message_id: messageId,
      duration_s: check.durationSeconds,
    });
  } else {
    log.warn("media.verify_failed", {
      group_id: groupId,
      kind: label,
      message_id: messageId,
      reason: check.reason,
    });
  }
  return { sent: true, verified: check.confirmed };
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

async function sendPhotoToUser(
  userId: number,
  photo: OutboundPhoto,
  replyText = "",
): Promise<void> {
  try {
    const resolved = await readOutboundPhotoBase64(photo);
    if (!resolved) {
      log.warn("photo.outbound_failed", { user_id: userId, source: photo.file ? "local" : "url" });
      return;
    }

    // v0.9.19：文字已经在说照片 / 偶尔干发时，不再补一条固定配文
    if (shouldSendPhotoCaption({ replyText, caption: photo.caption })) {
      sendPrivateMsg(userId, photo.caption!);
      await sleep(700);
    }
    const sent = await sendPrivateMediaAndVerify(
      userId,
      `[CQ:image,file=base64://${resolved.base64}]`,
      "image",
      "photo",
    );
    if (!sent.sent) return;
    log.info("photo.sent", {
      user_id: userId,
      source: resolved.source,
      bytes: Math.round((resolved.base64.length * 3) / 4),
      target: "private",
      verified: sent.verified,
    });
  } catch (err: unknown) {
    log.warn("photo.send_error", { user_id: userId, error: errMessage(err) });
  }
}

/** 群聊发图（仅 group_photo_enabled=true 时调用）：先配文再图片，与私聊一致。 */
async function sendPhotoToGroup(
  groupId: number,
  photo: OutboundPhoto,
  replyText = "",
): Promise<void> {
  try {
    const resolved = await readOutboundPhotoBase64(photo);
    if (!resolved) {
      log.warn("photo.outbound_failed", { group_id: groupId, source: photo.file ? "local" : "url" });
      return;
    }
    if (shouldSendPhotoCaption({ replyText, caption: photo.caption })) {
      sendGroupMsg(groupId, photo.caption!);
      await sleep(700);
    }
    const sent = await sendGroupMediaAndVerify(
      groupId,
      `[CQ:image,file=base64://${resolved.base64}]`,
      "image",
      "photo",
    );
    if (!sent.sent) return;
    log.info("photo.sent", {
      group_id: groupId,
      source: resolved.source,
      bytes: Math.round((resolved.base64.length * 3) / 4),
      target: "group",
      verified: sent.verified,
    });
  } catch (err: unknown) {
    log.warn("photo.send_error", { group_id: groupId, error: errMessage(err) });
  }
}

/**
 * 估算「把这条气泡打出来」需要多久（毫秒）。
 * 中文手打约 80–120ms/字；再叠加一点读屏/点发送的固定开销，白天夹在 0.3–3s。
 * v0.4.0 起深夜（23:00–06:00）会慢约 1.35 倍、封顶 4.2s（人困的时候确实打得慢）。
 * 目的：让她不是「char 级流式刷屏」，而是像人一样一条一条地把话打完。
 */
/**
 * 从人设的 typingHabit 文本推断打字速度/条间节奏（v0.6）。
 *
 * 人设里 `speaking.typingHabit` 是自然语言（如「一段一段发，不一次性发大段」），
 * 这里只做保守的关键词映射；没有线索就用默认值。
 */
function pacingPersonaFor(persona: ConversationState["persona"]): PacingPersona {
  const habit = String(
    (persona as unknown as { speaking?: { typingHabit?: string } }).speaking?.typingHabit ?? "",
  );
  const persona2: PacingPersona = {};
  if (/慢|慢吞吞|想很久|斟酌/.test(habit)) persona2.typingWpm = 165;
  if (/快|秒回|刷屏|连发/.test(habit)) persona2.typingWpm = 265;
  if (/一段一段|分段|一句一句|碎/.test(habit)) persona2.burstiness = 1.35;
  if (/一条|一次发一条|整段/.test(habit)) persona2.burstiness = 0.8;
  if (/犹豫|欲言又止|打了又删/.test(habit)) persona2.hesitation = 0.35;
  return persona2;
}

/**
 * 这一轮的打字节奏（人设 × 情绪 × 时段；忙碌度暂取 0）。
 * NODE_ENV=test 时压到最小，避免 E2E/单测因为"真人节奏"变慢或抖动。
 */
function buildPacing(state: ConversationState): PacingResult {
  if (process.env.NODE_ENV === "test") {
    return { readDelayMs: 0, perCharMs: 1, capMs: 10, gapMs: 1, hesitationMs: 0, profile: "fast" };
  }
  return planPacing({
    hour: new Date().getHours(),
    emotionVector: state.emotionState.vector,
    persona: pacingPersonaFor(state.persona),
  });
}

// ── 语音识别（v0.23）──────────────────────────

/** 下载入站语音条的原始字节（QQ 语音是 SILK）；失败返回 null。 */
async function downloadAudioBytes(url: string | undefined): Promise<Buffer | null> {
  if (!url) return null;
  const checked = checkMediaUrl(url);
  if (!checked.ok || !checked.url) return null;
  try {
    const res = await fetch(checked.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > 8 * 1024 * 1024) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * 入站语音 → 文字（失败静默回退 `[语音]` 占位，不阻塞回复）。
 * 隐私：日志只记长度与耗时，不打印识别正文。
 */
async function describeVoiceMessage(url: string | undefined): Promise<string | null> {
  if (!isAsrEnabled() && !isSenseVoiceEnabled()) return null;
  const bytes = await downloadAudioBytes(url);
  if (!bytes) {
    log.info("asr.skipped", { reason: "download_failed" });
    return null;
  }

  // v0.9.32：音频大模型优先，其次 SenseVoice，最后 faster-whisper 纯文字。
  const wav = isWavBuffer(bytes)
    ? bytes
    : isSilkBuffer(bytes)
      ? await silkToWav(bytes)
      : null;

  if (wav && isQwenOmniEnabled()) {
    const omni = await understandVoiceWithQwenOmni(wav);
    const formatted = omni ? formatQwenOmniVoice(omni) : null;
    if (formatted) {
      log.info("asr.qwen_omni_ok", {
        chars: omni?.transcript.length ?? 0,
        singing: omni?.singing ?? null,
        sarcasm: omni?.sarcasm ?? null,
        elapsed_ms: omni?.elapsedMs ?? null,
      });
      return formatted;
    }
  }

  if (wav && isSenseVoiceEnabled()) {
    const understood = await understandVoice(wav);
    const formatted = understood ? formatVoiceUnderstanding(understood) : null;
    if (formatted) {
      log.info("asr.sensevoice_ok", {
        chars: understood?.text.length ?? 0,
        emotion: understood?.emotion ?? null,
        events: understood?.events.length ?? 0,
      });
      return formatted;
    }
  }

  const result = await transcribeVoice(bytes);
  if (!result.ok || !result.text) {
    log.info("asr.skipped", { reason: result.reason ?? "unknown" });
    return null;
  }
  return `[语音：${result.text}]`;
}

/**
 * v0.9.28：图片描述异步补写历史。
 * 当前轮先让模型直接看原图，描述在后台生成；回复结束后把占位 [图片] 替换成
 * [图片：描述]，下一轮追问仍能看到细节。不阻塞回复。
 */
async function applyImageDescriptions(
  state: ConversationState,
  originalText: string,
  pending: Array<Promise<string | null>>,
): Promise<void> {
  if (pending.length === 0) return;
  try {
    const descs = await Promise.all(pending);
    let updated = originalText;
    for (const desc of descs) {
      if (desc) updated = updated.replace("[图片]", `[图片：${desc}]`);
    }
    if (updated !== originalText) {
      const ok = updateUserMessageContent(state.session, originalText, updated);
      log.info("image.described_async", {
        chars: updated.length - originalText.length,
        persisted: ok,
      });
    }
  } catch {
    // 描述失败不影响聊天
  }
}

// ── 表情包持续收集（v0.6）─────────────────────

/**
 * 采集后给表情补一条 AI 语义备注（v0.9.24）：这张表情在聊天里表达什么、
 * 适合什么场景。失败静默（没有备注时选择器退回情绪/画面标签）。
 * 默认开启；`KAREN_STICKER_LABEL=off` 可关。
 */
function labelCollectedStickerAsync(id: number, url: string, owner: string): void {
  if (process.env.KAREN_STICKER_LABEL === "off") return;
  void (async () => {
    try {
      const label = await labelStickerImage(url);
      if (!label) return;
      const ok = labelSticker(id, {
        note: label.note,
        tags: label.tags,
        emotion: label.emotion,
      });
      if (ok) {
        rememberStickerNote(owner, {
          note: label.note,
          tags: label.tags,
          direction: "received",
          at: Date.now(),
        });
        log.info("sticker.labeled", { id, tags: label.tags.length });
      }
    } catch {
      // 打标失败不影响聊天
    }
  })();
}

/**
 * 入站图片/表情包 → 本地库（fire-and-forget）。
 *
 * 只存**用户主动发来的**图片，且只在本机使用；默认关闭，需要 `KAREN_STICKER_COLLECT=on`
 * 才开启（首周建议只入库不发送）。视觉描述里的关键词作为初始标签（后续可让模型重新打标）。
 */
function maybeCollectSticker(url: string | undefined, owner: string, description?: string | null): void {
  if (!url) return;
  if (process.env.KAREN_STICKER_COLLECT !== "on") return;
  void (async () => {
    try {
      const bytes = await downloadStickerBytes(url);
      if (!bytes) return;
      const tags = (description ?? "")
        .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, " ")
        .split(" ")
        .filter((t) => t.length >= 2)
        .slice(0, 5);
      const result = collectSticker({ ownerId: owner, bytes, source: "inbound", tags });
      if (result.reason === "saved") {
        log.info("sticker.collected", { owner, bytes: bytes.length, id: result.id });
        if (result.id && url) labelCollectedStickerAsync(result.id, url, owner);
      }
    } catch {
      // 采集失败完全不影响聊天
    }
  })();
}

// ── 打错字 → 撤回 → 重发修正（v0.3 真实感）──────

/** 上次给某用户演「打错字撤回」的时间（冷却用；进程内即可，重启最多多演一次） */
const userLastTypoRecallAt = new Map<number, number>();

/**
 * 发一条文字气泡；低概率演「先发错字 → 1-2s 后撤回 → 重发正确版」。
 *
 * 只影响 transport 层：`sentText` / 会话 / 记忆里始终是正确原文；
 * 异步发送拿不到 message_id 或撤回失败时静默降级，不阻塞主流程。
 */
/**
 * 发一条文字气泡，偶尔演「发出去又想改」（v0.6 起支持四类意图）：
 * - typo_recall   打错字 → 撤回 → 重发正确版
 * - regret_recall 说重了 → 撤回 → 换一句收着的
 * - rewrite       表述太绕 → 撤回 → 只说短的那半句
 * - hesitate      犹豫（不撤回；表现为回得很慢、话很短，由节奏层处理）
 *
 * 只影响 transport：会话/记忆里始终只落正确原文；异步拿不到 message_id 或撤回失败
 * 时静默降级为「发原文」或「错字+更正」并存，绝不阻塞主流程。
 */
async function sendPrivateBubbleWithTypoRecall(
  userId: number,
  text: string,
  state: ConversationState,
  safetySent: boolean,
): Promise<void> {
  // 单测/E2E（vitest 子进程 NODE_ENV=test）里关闭随机真实感，保证断言确定性；
  // 需要覆盖「打错字链路」时可显式设 KAREN_TYPO_RECALL_ALLOW_TEST=1。
  if (process.env.NODE_ENV === "test" && process.env.KAREN_TYPO_RECALL_ALLOW_TEST !== "1") {
    sendPrivateMsg(userId, text);
    return;
  }

  const config = state.config;
  const defaults = DEFAULT_TYPO_RECALL_SETTINGS;
  const typoSettings: TypoRecallSettings = {
    enabled: config.typo_recall_enabled ?? defaults.enabled,
    probability: config.typo_recall_probability ?? defaults.probability,
    delayMs: config.typo_recall_delay_ms ?? defaults.delayMs,
    cooldownMinutes: config.typo_recall_cooldown_minutes ?? defaults.cooldownMinutes,
  };

  const plan = planMessageIntent(
    {
      text,
      now: Date.now(),
      safetySent,
      emotionVector: state.emotionState.vector,
      isNight: new Date().getHours() >= 23 || new Date().getHours() < 6,
    },
    intentSettingsFromTypo(typoSettings),
    { lastRecallAt: userLastTypoRecallAt.get(userId) },
  );

  // 犹豫 / 不演：正常发原文
  if (plan.intent === "none" || plan.intent === "hesitate" || !plan.sentText) {
    sendPrivateMsg(userId, text);
    return;
  }

  const messageId = await sendPrivateMsgAsync(userId, plan.sentText);
  if (messageId === null) {
    // 异步发送失败：不制造「发出去但撤回不了」的消息，直接发正确原文
    sendPrivateMsg(userId, text);
    return;
  }

  const followUp = plan.followUpText ?? text;
  const delayMs = plan.delayMs ?? defaults.delayMs;
  userLastTypoRecallAt.set(userId, Date.now());
  log.info("message_intent.scheduled", { user_id: userId, intent: plan.intent, delay_ms: delayMs });
  const timer = setTimeout(() => {
    void (async () => {
      const recalled = await recallMessage(messageId);
      sendPrivateMsg(userId, followUp);
      log.info(recalled ? "message_intent.done" : "message_intent.recall_failed", {
        user_id: userId,
        intent: plan.intent,
      });
    })();
  }, delayMs);
  timer.unref();
}

async function streamPrivateReply(params: {
  state: ConversationState;
  text: string;
  userId: number;
  userName: string;
  options?: { bypassGate?: boolean; skipUserPersist?: boolean };
  /** v0.9.26：本轮图片 data URL（最多 2 张），附到当前 user message */
  images?: string[];
  /** v0.9.32：表情包 note 内部提示 */
  stickerHint?: string;
  /** 日志前缀，用于区分正常回复与延迟补发 */
  logPrefix?: string;
  /** P0-3：整条用语音代替文字（点名要语音/收到语音/低概率）。 */
  voiceMode?: boolean;
  /** P0-5：本轮自拍由桥接异步生成，跳过管线里的同步发图。 */
  skipPhoto?: boolean;
}): Promise<PrivateStreamOutcome> {
  const { state, text, userId, options, images, stickerHint } = params;
  const logPrefix = params.logPrefix ?? "回复";
  const pendingSnapshot = userPending.get(userId) ?? 0;
  let sentCount = 0;
  let sentText = "";
  let safetySent = false;
  let photoSent = false;
  /** 已发出的文字气泡数 / 当轮已发内容（去重用）/ 超出上限后待合并的尾巴 */
  let textBubbles = 0;
  const sentFragments: string[] = [];
  let mergedTail = "";
  /** 每轮最多演一次「打错字撤回」，避免多气泡放大触发率 */
  let typoDecided = false;
  /** P0-3：voice-first 时先攒着文字，合成成功就只发语音；失败再回退文字。 */
  const voiceFirst = params.voiceMode === true;
  let bufferedText = "";
  /** 危机轮强制文字（求助资源后不能只跟一条语音）。 */
  let forceText = false;

  // v0.6：这一轮的打字节奏（人设 × 情绪 × 时段），整轮复用
  const pacing = buildPacing(state);
  let pacedFirstTextSent = false;

  const stream = processMessageStream(state, text, {
    ...options,
    images,
    stickerHint,
    ...(params.skipPhoto ? { skipPhoto: true } : {}),
  });
  for await (const frag of stream) {
    // 中断检测：用户发来新消息 → 丢弃剩余 burst
    if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
      state.interrupted = true;
      log.info("reply.interrupted", { user_id: userId, stage: "before_send" });
      return { sentCount, interrupted: true, sentText, safetySent, photoSent };
    }

    // 消息门判定「晚点回」
    if (frag.deferred) {
      return { sentCount, deferredDelayMs: frag.deferred.delayMs, interrupted: false, sentText, safetySent, photoSent };
    }

    if (frag.qqFace) {
      // voice-first 不发 QQ 表情：语音条后面再接表情像机器人补装饰。
      if (voiceFirst) continue;
      // 最后一条：QQ 表情（流结束后追加）
      await sleep(400 + Math.random() * 400);
      if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
        state.interrupted = true;
        log.info("reply.interrupted", { user_id: userId, stage: "before_qqface" });
        return { sentCount, interrupted: true, sentText, safetySent, photoSent };
      }
      sendPrivateMsg(userId, asCqCode(frag.qqFace));
      log.info("reply.sent_qqface", { user_id: userId, deferred: logPrefix !== "回复" });
      sentCount++;
      // 不能 break：qqFace 之后还可能跟主动发图 fragment（本地图库/Unsplash）
      continue;
    }

    if (frag.image) {
      await sendPhotoToUser(userId, frag.image, sentText);
      markPromisesDone(state.owner, state.storagePersona, ["photo"]);
      if (recordRelationshipMilestone(state, "first-photo", "第一次给他发照片")) {
        log.info("relationship.milestone", { user_id: userId, id: "first-photo" });
      }
      photoSent = true;
      continue;
    }

    if (frag.safetyMessage) {
      // 合规：危机求助资源（程序生成，独立消息）
      sendPrivateMsg(userId, frag.safetyMessage);
      safetySent = true;
      forceText = true;
      log.info("compliance.crisis_resources_sent", { user_id: userId });
      continue;
    }

    const outboundText = stripOutboundMediaMarkers(frag.text);
    if (!outboundText) continue;

    // voice-first：先攒文字，等流结束后再决定发语音还是回退文字。
    if (voiceFirst && !forceText) {
      bufferedText += (bufferedText ? "\n" : "") + outboundText;
      sentText = bufferedText;
      continue;
    }

    // 当轮去重：同一轮里几乎相同的话只发一次（流式分条常见）
    if (isWithinTurnDuplicate(outboundText, sentFragments)) {
      log.info("reply.dropped_within_turn_duplicate", { user_id: userId });
      continue;
    }
    // 单轮气泡上限：超出的先攒着，等这轮结束合并成一条发（不丢内容）
    if (textBubbles >= MAX_TEXT_BUBBLES) {
      mergedTail += (mergedTail ? "\n" : "") + outboundText;
      continue;
    }

    // 真人节奏：第一条是「看到消息 → 开始打字」，后续每条按字数模拟打字耗时
    // （中文手打约 80–120ms/字；过短的气泡也不会秒发，读/点发送有固定开销）
    // 第一条：看到消息→开始打字的延迟（含偶发的犹豫）
    if (!pacedFirstTextSent) {
      pacedFirstTextSent = true;
      await sleep(pacing.readDelayMs + pacing.hesitationMs);
    }

    if (sentCount > 0) {
      await sleep(typingTimeFor(outboundText, pacing));
      if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
        state.interrupted = true;
        log.info("reply.interrupted", { user_id: userId, stage: "streaming" });
        return { sentCount, interrupted: true, sentText, safetySent, photoSent };
      }
    } else {
      await sleep(300 + Math.random() * 500);
    }

    // 每轮只在第一条文字气泡上尝试一次「打错字→撤回→重发」；延迟补发不演
    if (!typoDecided && logPrefix === "回复") {
      typoDecided = true;
      await sendPrivateBubbleWithTypoRecall(userId, outboundText, state, safetySent);
    } else {
      sendPrivateMsg(userId, outboundText);
    }
    sentText += (sentText ? "\n" : "") + outboundText;
    log.info("reply.sent", {
      user_id: userId,
      chars: charCount(outboundText),
      deferred: logPrefix !== "回复",
    });
    sentCount++;
  }

  // P0-3：voice-first 的收尾——语音成功只发语音；失败/危机回退文字。
  if (voiceFirst) {
    const flushBufferedAsText = async (): Promise<void> => {
      const lines = bufferedText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await sleep(typingTimeFor(lines[i]!, pacing));
        sendPrivateMsg(userId, lines[i]!);
        log.info("reply.sent", {
          user_id: userId,
          chars: charCount(lines[i]!),
          deferred: logPrefix !== "回复",
        });
        sentCount++;
      }
      sentText = lines.join("\n");
      bufferedText = "";
    };

    if (bufferedText && !forceText && !state.interrupted) {
      const voiceSent = await sendVoiceNote(userId, state, bufferedText);
      if (voiceSent) {
        sentCount++;
        return { sentCount, interrupted: false, sentText, safetySent, photoSent, voiceSent: true };
      }
      log.warn("voice.first_fallback_text", { user_id: userId });
    }
    if (bufferedText) await flushBufferedAsText();
    return { sentCount, interrupted: false, sentText, safetySent, photoSent };
  }

  // 超出气泡上限的内容合并成一条发出（保持在 4 条以内，又不会丢话）
  if (mergedTail.trim()) {
    mergedTail = stripOutboundMediaMarkers(mergedTail);
  }
  if (mergedTail.trim()) {
    await sleep(typingTimeFor(mergedTail, pacing));
    if ((userPending.get(userId) ?? 0) > pendingSnapshot) {
      state.interrupted = true;
      log.info("reply.interrupted", { user_id: userId, stage: "before_merged_tail" });
      return { sentCount, interrupted: true, sentText, safetySent, photoSent };
    }
    sendPrivateMsg(userId, mergedTail);
    sentText += (sentText ? "\n" : "") + mergedTail;
    sentCount++;
    log.info("reply.sent_merged_tail", { user_id: userId, chars: charCount(mergedTail) });
  }

  return { sentCount, interrupted: false, sentText, safetySent, photoSent };
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
function userIdForSticker(target: StickerTarget): number {
  return target.userId;
}

async function maybeSendSticker(
  target: StickerTarget,
  state: ConversationState,
  inboundSticker: boolean,
  opts: { requested?: boolean; contextText?: string } = {},
): Promise<boolean> {
  if (process.env.STICKER_ENABLED === "0") return false;

  const now = Date.now();
  const groupKey = target.kind === "group" ? `${target.groupId}:${target.userId}` : "";
  const last =
    target.kind === "private"
      ? (userLastStickerAt.get(target.userId) ?? 0)
      : (groupLastStickerAt.get(groupKey) ?? 0);
  // 用户点名要表情包时不吃冷却（他就是想现在看一个）
  if (!opts.requested && now - last < STICKER_COOLDOWN_MS) return false;

  const conflictAt = state.relationshipState.lastConflictAt;
  const conflictActive = conflictAt !== null && now - conflictAt < 24 * 60 * 60 * 1000;

  const emotionTag = stickerEmotionTag(state.emotionState.vector);

  // v0.6：优先用"从聊天里收集来的"表情包（开关 KAREN_STICKER_USE=on），没有再回退内置
  if (process.env.KAREN_STICKER_USE === "on" && !conflictActive) {
    const owner =
      target.kind === "private" ? ownerForQq(target.userId) : ownerForQq(target.userId);
    // v0.9.0：用户点名要表情包时不再排除"刚发过的那张"——
    // 真实长跑 E2E 发现：库里有 1 张、之前顺手发过，点名时被 exclude 掉 → 回退内置贴纸，
    // 用户视角就是"我要表情包，她给了个没收藏的"。点名时重复同款是正常的。
    const collected = pickCollectedSticker({
      ownerId: owner,
      emotion: emotionTag,
      contextText: opts.contextText,
      excludeIds: opts.requested
        ? []
        : (userRecentCollectedStickers.get(userIdForSticker(target)) ?? []),
    });
    // v0.8.19：点名要表情包时必定从收集库出（原来这里只有 22% 概率，
    // 与内置贴纸路径"点名必发"不一致；用户明说要还经常给内置的，显得没在听）。
    const collectedProbability = collectedStickerProbability({
      requested: opts.requested === true,
      inboundSticker,
      normalProbability: STICKER_PROBABILITY,
      replyProbability: STICKER_REPLY_TO_STICKER_PROBABILITY,
    });
    if (collected && Math.random() <= collectedProbability) {
      try {
        const base64 = fs.readFileSync(collected.file).toString("base64");
        const cqCollected = `[CQ:image,file=base64://${base64}]`;
        const sent =
          target.kind === "private"
            ? await sendPrivateMediaAndVerify(target.userId, cqCollected, "image", "sticker")
            : await sendGroupMediaAndVerify(target.groupId, cqCollected, "image", "sticker");
        if (!sent.sent) return false;
        if (target.kind === "private") {
          userLastStickerAt.set(target.userId, now);
          userRecentCollectedStickers.set(
            target.userId,
            [...(userRecentCollectedStickers.get(target.userId) ?? []), collected.id].slice(-5),
          );
        } else {
          groupLastStickerAt.set(groupKey, now);
        }
        markStickerUsed(collected.id, now);
        if (collected.note) {
          rememberStickerNote(owner, {
            note: collected.note,
            tags: parseSceneTags(collected.scene_tags),
            direction: "sent",
            at: now,
          });
        }
        log.info("sticker.collected_sent", {
          id: collected.id,
          kind: target.kind,
          verified: sent.verified,
        });
        return true;
      } catch {
        // 读文件失败 → 回退内置贴纸
      }
    }
  }

  const sticker = pickSticker({
    emotion: state.emotionState.vector,
    hour: new Date(now).getHours(),
    conflictActive,
    recentIds: userRecentStickers.get(userIdForSticker(target)) ?? [],
  });
  if (!sticker) return false;

  const probability = inboundSticker ? STICKER_REPLY_TO_STICKER_PROBABILITY : STICKER_PROBABILITY;
  if (!opts.requested && Math.random() > probability) return false;

  const cq = toStickerCqCode(sticker);
  if (!cq) return false;

  const sent =
    target.kind === "private"
      ? await sendPrivateMediaAndVerify(target.userId, cq, "image", "sticker")
      : await sendGroupMediaAndVerify(target.groupId, cq, "image", "sticker");
  if (!sent.sent) return false;

  if (target.kind === "private") {
    userLastStickerAt.set(target.userId, now);
    userRecentStickers.set(
      target.userId,
      [...(userRecentStickers.get(target.userId) ?? []), sticker.id].slice(-3),
    );
    log.info("sticker.sent", {
      user_id: target.userId,
      sticker: sticker.id,
      reply_to_sticker: inboundSticker,
      target: "private",
      verified: sent.verified,
    });
    return true;
  }

  groupLastStickerAt.set(groupKey, now);
  log.info("sticker.sent", {
    group_id: target.groupId,
    user_id: target.userId,
    sticker: sticker.id,
    reply_to_sticker: inboundSticker,
    target: "group",
    verified: sent.verified,
  });
  return true;
}

// ── 语音消息 ────────────────────────────────────

/** 每个用户最近发过的贴纸 id（避免同一张图连着复用） */
const userRecentStickers = new Map<number, string[]>();

/** 上次给某用户发语音的时间（冷却用；进程内即可，重启后最多多发一条） */
const userLastVoiceAt = new Map<number, number>();
/** P0-5：运行时自拍防重入 / 冷却 / 配文去重 */
const selfieInFlight = new Set<number>();
const userLastSelfieAt = new Map<number, number>();
const userRecentSelfieCaptions = new Map<number, string[]>();
const SELFIE_COOLDOWN_MS = 90_000;
/** P1-4：主动消息附带照片的上次发送时间（24h 冷却）。 */
const userLastProactivePhotoAt = new Map<number, number>();
/** 语音能力懒探测：null=未探测；false=本机不可用（之后不再尝试，静默降级为文字） */
let speechAvailable: boolean | null = null;

async function isSpeechReady(): Promise<boolean> {
  if (speechAvailable === null) {
    try {
      speechAvailable = await isSpeechAvailable();
    } catch {
      speechAvailable = false;
    }
    log.info(speechAvailable ? "voice.available" : "voice.unavailable", {
      platform: process.platform,
    });
  }
  return speechAvailable;
}

/**
 * 文字回复后，偶尔「顺手」补一条语音（真人懒得打字时会直接说话）。
 * - 决策在 impulse/voice.ts（纯函数），合成在 ai/tts.ts（失败静默降级为文字）
 * - 亲密度/免打扰/冷却/概率/危机语境都会拦截
 * - 发送前按语音时长等待（像真人先录完再发）；调用方用 void 调用，不阻塞主流程
 */
/**
 * 合成并发送一条语音（P0-3）——决策在 `decideVoiceFirst`，这里只做 TTS + 发送。
 * 失败返回 false，由调用方回退成文字（绝不静默吞掉回复）。
 */
async function sendVoiceNote(
  userId: number,
  state: ConversationState,
  text: string,
): Promise<boolean> {
  const config = state.config;
  const speech = await synthesizeSpeech(text, {
    maxChars: config.voice_max_chars ?? 40,
    voice: config.voice_tts_voice,
    rate: config.voice_tts_rate,
    styleEnabled: config.voice_style_enabled !== false,
    style: {
      emotionVector: state.emotionState.vector,
      hour: new Date().getHours(),
      closeness: state.persona.relationship.closeness,
      fillerProbability: config.voice_filler_probability,
    },
  });
  if (!speech) {
    log.warn("voice.synth_failed", { user_id: userId, mode: "voice_first" });
    return false;
  }

  // 真人会先录完再发：等待 ≈ 语音时长 + 一点操作时间。
  const recordDelay = Math.min(
    speech.durationMs + VOICE_RECORD_PADDING_MS + Math.random() * 400,
    VOICE_MAX_SEND_DELAY_MS,
  );
  await sleep(recordDelay);
  const sent = await sendPrivateMediaAndVerify(
    userId,
    `[CQ:record,file=base64://${speech.silkBase64}]`,
    "record",
    "voice",
  );
  if (!sent.sent) return false;
  userLastVoiceAt.set(userId, Date.now());
  const done = markPromisesDone(state.owner, state.storagePersona, ["voice"]);
  log.info("voice.sent", {
    user_id: userId,
    mode: "voice_first",
    duration_ms: speech.durationMs,
    bytes: speech.byteLength,
    verified: sent.verified,
    promises_done: done,
  });
  if (recordRelationshipMilestone(state, "first-voice", "第一次给他发语音")) {
    persistRuntimeState(state);
    log.info("relationship.milestone", { user_id: userId, id: "first-voice" });
  }
  return true;
}

/** 这一轮要不要整条用语音（P0-3）。点名/收到语音优先，普通轮低概率。 */
async function resolveVoiceFirst(
  userId: number,
  state: ConversationState,
  text: string,
  inboundVoice: boolean,
): Promise<{ voice: boolean; reason: string }> {
  // 单测/E2E（vitest 子进程）里关闭随机语音，保证断言确定性；
  // 需要覆盖语音链路时显式设 KAREN_VOICE_ALLOW_TEST=1。
  if (process.env.NODE_ENV === "test" && process.env.KAREN_VOICE_ALLOW_TEST !== "1") {
    return { voice: false, reason: "test_disabled" };
  }
  if ((state.config.voice_enabled ?? true) !== true) {
    return { voice: false, reason: "disabled" };
  }
  const speechAvailable = await isSpeechReady();
  // P0-6：跨轮承诺兜底——她之前答应过语音还没兑现，用户来催（好了吗/语音呢…）
  // 时也走 voice-first，而不是让模型继续嘴上「等会儿」。
  const pendingVoicePromise = findPendingVoicePromise(
    state.session.messages,
    Date.now(),
    userLastVoiceAt.get(userId),
  );
  const promiseFollowUp =
    pendingVoicePromise !== null && isVoiceFollowUp(text);
  if (promiseFollowUp) {
    log.info("voice.promise_followup", {
      user_id: userId,
      age_min: Math.max(1, Math.round((Date.now() - pendingVoicePromise!.at) / 60_000)),
    });
  }
  const decision = decideVoiceFirst(
    {
      requested: detectMediaRequest(text).voice || promiseFollowUp,
      inboundVoice,
      closeness: state.persona.relationship.closeness,
      hour: new Date().getHours(),
      quietHours: {
        start: state.config.quiet_hours_start,
        end: state.config.quiet_hours_end,
      },
      lastSentAt: userLastVoiceAt.get(userId),
    },
    {
      enabled: true,
      probability: state.config.voice_probability ?? 0.12,
      minCloseness: state.config.voice_min_closeness ?? 2.5,
      cooldownMinutes: state.config.voice_cooldown_minutes ?? 8,
      maxChars: state.config.voice_max_chars ?? 40,
      allowedInGroup: state.config.voice_group_enabled === true,
    },
    { speechAvailable },
  );
  return { voice: decision.speak, reason: decision.reason };
}


/**
 * P0-5：用户点名要自拍 → 后台生成 + 质检 + 发送（约 25–45s）。
 * - 先回一句「等我拍一张」，不阻塞当轮文字；
 * - 失败/质检不过 → 回退回本地自拍，不承诺落空；
 * - 同一用户同时只跑一张，90s 冷却。
 */
async function sendRequestedSelfie(
  userId: number,
  state: ConversationState,
  userText: string,
  lastReply: string,
): Promise<void> {
  if (replyRefusesPhoto(lastReply)) {
    log.info("selfie.skipped_refusal", { user_id: userId });
    return;
  }
  if (selfieInFlight.has(userId)) {
    sendPrivateMsg(userId, "还在拍呢，马上");
    return;
  }
  const now = Date.now();
  if (now - (userLastSelfieAt.get(userId) ?? 0) < SELFIE_COOLDOWN_MS) {
    sendPrivateMsg(userId, "刚拍过一张，等我缓缓");
    return;
  }

  selfieInFlight.add(userId);
  try {
    if (!/拍|自拍|照/.test(lastReply)) {
      sendPrivateMsg(userId, "等我拍一张");
    }
    const weatherRaw = state.weatherPerception?.raw;
    const result = await generateSelfie({
      userText,
      lastReply,
      hour: new Date().getHours(),
      emotionVector: state.emotionState.vector,
      weather: weatherRaw
        ? { condition: weatherRaw.condition, temperature: weatherRaw.temp }
        : null,
    });

    if (result.ok && result.bytes) {
      const file = saveGeneratedImage(result.bytes);
      if (file) {
        const caption = pickSelfieCaption(
          Math.random,
          userRecentSelfieCaptions.get(userId) ?? [],
        );
        await sendPhotoToUser(userId, { file, caption }, lastReply);
        markPromisesDone(state.owner, state.storagePersona, ["photo"]);
        if (recordRelationshipMilestone(state, "first-photo", "第一次给他发照片")) {
          persistRuntimeState(state);
          log.info("relationship.milestone", { user_id: userId, id: "first-photo" });
        }
        userLastSelfieAt.set(userId, now);
        userRecentSelfieCaptions.set(
          userId,
          [...(userRecentSelfieCaptions.get(userId) ?? []), caption].slice(-3),
        );
        log.info("selfie.sent", {
          user_id: userId,
          attempts: result.attempts,
          elapsed_ms: result.elapsedMs,
          bytes: result.bytes.length,
          scene: result.scene,
        });
        return;
      }
    }

    log.warn("selfie.failed", {
      user_id: userId,
      reason: result.reason ?? "unknown",
      attempts: result.attempts,
      elapsed_ms: result.elapsedMs,
    });
    const fallback = pickFallbackSelfie(state);
    if (fallback) {
      await sendPhotoToUser(
        userId,
        {
          ...(fallback.imageFile ? { file: fallback.imageFile } : {}),
          ...(fallback.imageUrl ? { url: fallback.imageUrl } : {}),
          caption: fallback.caption,
        },
        lastReply,
      );
      userLastSelfieAt.set(userId, now);
      log.info("selfie.fallback_local", { user_id: userId, source: fallback.source });
    } else {
      sendPrivateMsg(userId, "等我下次再拍给你吧");
    }
  } catch (err: unknown) {
    log.warn("selfie.error", { user_id: userId, error: errMessage(err) });
  } finally {
    selfieInFlight.delete(userId);
  }
}

/** P1-1：每轮结束后从最近消息抽承诺/日程；本轮真发过语音/照片则顺手标记兑现。 */
function recordTurnPromises(
  state: ConversationState,
  opts: { voiceSent?: boolean; photoSent?: boolean } = {},
): void {
  try {
    recordPromisesFromMessages(
      state.owner,
      state.storagePersona,
      state.session.messages,
      Date.now(),
    );
    const kinds: Array<"voice" | "photo"> = [];
    if (opts.voiceSent) kinds.push("voice");
    if (opts.photoSent) kinds.push("photo");
    if (kinds.length > 0) {
      markPromisesDone(state.owner, state.storagePersona, kinds);
    }
  } catch {
    // 承诺记账失败不影响回复
  }
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
  const attachedImages: string[] = [];
  const pendingImageDescriptions: Array<Promise<string | null>> = [];
  let inboundSticker = false;
  let inboundVoice = false;
  for (const event of events) {
    // v0.9.24：处理消息里的**所有**媒体段。旧逻辑只看第一个非文本段，
    // 图+图、引用+图、图+表情时会静默丢掉后面的图。
    const mediaList = detectMediaList(event);
    const replyMedia = mediaList.find((m) => m.type === "reply") ?? null;
    const visualMedia = mediaList.filter((m) => m.type !== "reply");
    const fragments: string[] = [];
    let imageCount = 0;

    for (const media of visualMedia) {
      // 表情/表情包不再丢弃：转成 [表情：xxx] 合成文本，让她能做出反应
      if (media.type === "face" || media.type === "mface") {
        inboundSticker = true;
        log.info("sticker.received", { user_id: userId, type: media.type });
      }

      let syntheticText = media.syntheticText;
      // P2-e: 图片识别（单条消息最多识别 5 张，防止一条消息打 10 次视觉）
      if (media.type === "image") {
        imageCount++;
        if (imageCount > 5) {
          syntheticText = "[图片]（超过单条 5 张，已跳过识别）";
        } else if (media.data?.url) {
          // v0.9.26：下载一次 data URL，原图直接附给当前轮模型；
          // v0.9.28：描述改为后台生成，回复不再等 vision（历史在回复后补写）。
          const dataUrl = await fetchImageAsDataUrl(media.data.url);
          const descPromise = (dataUrl
            ? describeImage(dataUrl)
            : describeImage(media.data.url)
          ).catch(() => null);
          pendingImageDescriptions.push(descPromise);
          if (dataUrl && attachedImages.length < 2) attachedImages.push(dataUrl);
          maybeCollectSticker(media.data.url, ownerForQq(userId));
        }
      }

      // v0.23：语音识别（QQ 语音条 SILK → 本地 whisper → 文本）
      if (media.type === "record") {
        inboundVoice = true;
        const transcribed = await describeVoiceMessage(media.data?.url);
        if (transcribed) syntheticText = transcribed;
      }

      if (syntheticText) fragments.push(syntheticText);
    }

    // 图片/表情附带文字时保留文字（raw_message 去掉 CQ 码后的残余）
    let rawText = fragments.join(" ");
    const residual = stripCqCodes(event.raw_message ?? "");
    if (residual) rawText = rawText ? `${rawText} ${residual}` : residual;

    if (replyMedia) {
      let quoted = getReplyContext(replyMedia.data);
      // 回退：NapCatQQ 未附带原文时，用 message_id 调 get_msg API 回查
      if (!quoted && replyMedia.data?.id) {
        const msgId = parseInt(replyMedia.data.id, 10);
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
  let text = texts.join("\n");
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
      // 披露按 owner 只发一次：老版本升级上来的用户 session 非空但从未确认过披露，也要补发
      if (
        shouldSendDisclosure({
          enabled: sharedBase.config.ai_disclosure,
          acknowledgedAt: getConsent(st.owner)?.disclosureAckedAt,
        })
      ) {
        const gatePending =
          shouldEnforceAgeGate(st.owner, sharedBase.config.age_gate_enabled) &&
          !hasAgeConfirmation(st.owner);
        sendPrivateMsg(
          userId,
          buildFirstContactDisclosure({ ageGate: gatePending, herName: st.persona.name }),
        );
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
      publishQzone: (content) => publishQzonePost({ content }),
      social: async (commandText) => {
        const runtime = loadSocialRuntime();
        const config = effectiveSocialConfig(process.env, runtime);
        return handleSocialCommand(commandText, {
          config,
          runtime,
          setMode: (mode) => setSocialModeOverride(mode),
          approve: (id) => approveAndExecuteAction(id, effectiveSocialConfig()),
          reject: (id) => {
            try {
              rejectAction(id, { actor: "owner" });
              return { ok: true, reason: `已拒绝 #${id}` };
            } catch (err) {
              return { ok: false, reason: err instanceof Error ? err.message : "拒绝失败" };
            }
          },
          undo: (id) => undoSocialAction(id, effectiveSocialConfig()),
          postDynamic: (content) => postDynamicManual(content, effectiveSocialConfig(), { owner: state.owner }),
          pending: (limit) => listPending({ limit: limit ?? 20 }),
          runTick: () => runSocialTick(state, { config: effectiveSocialConfig() }),
        });
      },
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
    // 合规：披露按 owner 只发一次（AI 身份 + 数据去向 + 18+）。
    // 不能只看「会话是否为空」：老版本升级用户 session 已有上百条，但从未确认过披露。
    if (
      shouldSendDisclosure({
        enabled: sharedBase.config.ai_disclosure,
        acknowledgedAt: getConsent(st.owner)?.disclosureAckedAt,
      })
    ) {
      sendPrivateMsg(
        userId,
        buildFirstContactDisclosure({ ageGate: gatePending, herName: st.persona.name }),
      );
      ackDisclosure(st.owner);
      log.info("compliance.disclosure_sent", { user_id: userId });
    }
    if (gatePending) {
      sendPrivateMsg(userId, buildAgeGatePrompt());
      ageGateReminderAt.set(userId, Date.now());
      log.info("compliance.age_gate_prompt", { user_id: userId });
      // 如果用户的第一条消息本身就是「我成年了」，不要吞掉这条：继续往下走由 evaluateAgeGate 确认
      const earlyAction = evaluateAgeGate({
        text,
        owner: st.owner,
        enabled: sharedBase.config.age_gate_enabled,
        confirmed: hasAgeConfirmation(st.owner),
      });
      if (earlyAction !== "confirmed") return;
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
    // 合并窗口里「确认 + 紧接着的聊天」会被拼成一段：不能把后半句吞掉
    const remainder = stripAgeConfirmationMarkers(text);
    if (!remainder) return;
    log.info("compliance.age_gate_confirmed_with_chat", {
      user_id: userId,
      chars: charCount(remainder),
    });
    text = remainder;
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
    const stickerHint = stickerHintFor(ownerForQq(userId), text);
    // P0-5：点名「自拍/拍张你」时由桥接异步生成，跳过同步发图避免双发。
    const selfiePlan =
      isSelfieGenerationEnabled() &&
      detectMediaRequest(text).photo &&
      isCharacterPhotoRequest(text);
    // P0-3：先决定这一轮是语音还是文字；voice-first 时流式文字只会被攒起来。
    const voiceMode = await resolveVoiceFirst(userId, state, text, inboundVoice);
    log.info("voice.mode", {
      user_id: userId,
      mode: voiceMode.voice ? "voice" : "text",
      reason: voiceMode.reason,
    });
    const outcome = await streamPrivateReply({
      state,
      text,
      userId,
      userName,
      images: attachedImages,
      ...(stickerHint ? { stickerHint } : {}),
      voiceMode: voiceMode.voice,
      ...(selfiePlan ? { skipPhoto: true } : {}),
    });
    void applyImageDescriptions(state, text, pendingImageDescriptions);

    // 消息门判定晚点回：调度定时补发（用户消息此时已落库）
    if (outcome.deferredDelayMs !== undefined) {
      scheduleDeferredPrivateReply(
        { userId, userName, text, state, sharedBase, images: attachedImages, ...(stickerHint ? { stickerHint } : {}) },
        outcome.deferredDelayMs,
      );
    } else if (outcome.sentCount > 0 && !voiceMode.voice) {
      // 用户点名要表情包时，别装没听见：提高对应动作的概率
      const mediaRequest = detectMediaRequest(text);
      await maybeSendSticker(
        { kind: "private", userId },
        state,
        inboundSticker,
        { requested: mediaRequest.sticker && !mediaRequest.voice, contextText: text },
      );
    }

    // P0-5：自拍异步生成（文字/语音已发出，约 25–45s 后补图；失败回退本地自拍）
    if (
      selfiePlan &&
      outcome.deferredDelayMs === undefined &&
      !outcome.interrupted &&
      outcome.sentCount > 0
    ) {
      void sendRequestedSelfie(userId, state, text, outcome.sentText).catch((err: unknown) => {
        log.warn("selfie.spawn_failed", { user_id: userId, error: errMessage(err) });
      });
    }
    recordTurnPromises(state, {
      voiceSent: outcome.voiceSent === true,
      photoSent: outcome.photoSent,
    });
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
  const textLines = plan.textLines.map((line) => stripOutboundMediaMarkers(line)).filter(Boolean);
  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i]!;
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
    await sendPhotoToGroup(groupId, plan.photo, textLines.join("\n"));
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
  const mediaList = detectMediaList(event as unknown as PrivateMessageEvent);
  const inboundSticker = mediaList.some((m) => m.type === "face" || m.type === "mface");
  let finalText = text;
  const attachedImages: string[] = [];
  const pendingImageDescriptions: Array<Promise<string | null>> = [];
  for (const media of mediaList) {
    if (media.type !== "image" || !media.data?.url) continue;
    // 群聊同样把原图附给当前轮（最多 2 张）；描述后台生成，回复不再等 vision。
    const dataUrl = await fetchImageAsDataUrl(media.data.url);
    pendingImageDescriptions.push(
      (dataUrl ? describeImage(dataUrl) : describeImage(media.data.url)).catch(() => null),
    );
    finalText = `[图片] ${finalText}`;
    if (dataUrl && attachedImages.length < 2) attachedImages.push(dataUrl);
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
    const stickerHint = stickerHintFor(ownerForQq(userId), finalText);
    const result = await processMessage(state, finalText, {
      skipPhoto: !state.config.group_photo_enabled,
      images: attachedImages,
      ...(stickerHint ? { stickerHint } : {}),
    });
    void applyImageDescriptions(state, finalText, pendingImageDescriptions);
    for (const line of result.logs) console.log(`  ${line}`);

    // 消息门判定晚点回
    if (result.deferred) {
      scheduleDeferredGroupReply(
        { groupId, userId, userName, text: finalText, state, sharedBase, images: attachedImages, ...(stickerHint ? { stickerHint } : {}) },
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
      void maybeSendSticker({ kind: "group", groupId, userId }, state, inboundSticker, {
        contextText: finalText,
      }).catch(
        (err: unknown) => log.warn("sticker.error", { group_id: groupId, error: errMessage(err) }),
      );
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
