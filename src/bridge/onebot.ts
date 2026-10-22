/**
 * OneBot 11 协议编解码
 * 处理来自 NapCatQQ 的事件解析和 API 调用构造。
 *
 * 安全约定（M0-4）：
 * - 入站事件必须经 parseEvent() 校验/归一化，畸形事件返回 null，不抛异常；
 * - 出站文本一律做 CQ 码转义，模型输出里的 [CQ:...] 不会被当成 CQ 码执行；
 * - 仅允许受控的 QQ 表情 CQ 码（[CQ:face,id=N]），其余 CQ 码直接丢弃；
 * - 超长消息按 QQ 单条上限切分后逐条发送。
 */
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

// ── 常量 ────────────────────────────────────────

/** QQ 单条文本消息的保守长度上限（字符数）。可用 ONE_BOT_MAX_MESSAGE_LENGTH 覆盖。 */
export const QQ_MAX_MESSAGE_LENGTH = 1000;

/**
 * 允许出站的 CQ 码白名单（唯一能绕过 CQ 转义的内容，全部由内部代码构造，
 * 模型输出永远走不到这里——模型文本会先经过 escapeCqText）：
 * - face：QQ 内置表情（qqFace，由 renderer 生成）
 * - image：本地贴纸 / 主动分享的照片（base64，由 stickers.ts / photo-library 生成）
 * - record：她的语音消息（SILK base64，由 ai/tts.ts 现场合成）
 */
const ALLOWED_CQ_PATTERN =
  /^\[CQ:(face,id=\d{1,4}|(?:image|record),file=base64:\/\/[A-Za-z0-9+/=]{50,})\]$/;

const VALID_POST_TYPES = new Set(["message", "notice", "request", "meta_event"]);

// ── OneBot 11 入站事件 ──────────────────────────

export interface OneBotEvent {
  time: number;
  self_id: number;
  post_type: "message" | "notice" | "request" | "meta_event";
}

export interface PrivateMessageEvent extends OneBotEvent {
  post_type: "message";
  message_type: "private";
  sub_type: "friend" | "group" | "other";
  message_id: number;
  user_id: number;
  message: string | MessageSegment[];
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    sex: string;
    age: number;
  };
}

export interface GroupMessageEvent extends OneBotEvent {
  post_type: "message";
  message_type: "group";
  sub_type: "normal" | "anonymous" | "notice";
  message_id: number;
  group_id: number;
  user_id: number;
  message: string | MessageSegment[];
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    card: string;
    sex: string;
    age: number;
    role: string;
  };
}

interface MessageSegment {
  type: string;
  data: Record<string, string>;
}

// ── 事件字段容错 ────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 从结构化消息段中尽量还原纯文本（仅 text 段） */
function textFromSegments(segments: unknown[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (!isRecord(seg) || seg.type !== "text") continue;
    const data = isRecord(seg.data) ? seg.data : null;
    if (data && typeof data.text === "string") parts.push(data.text);
  }
  return parts.join("");
}

/**
 * 解析并归一化一条入站事件。
 * 畸形/缺关键字段的事件返回 null（绝不抛异常），可选字段给出安全默认值。
 */
export function parseEvent(data: string): OneBotEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const postType = parsed.post_type;
  if (typeof postType !== "string" || !VALID_POST_TYPES.has(postType)) return null;

  // 非消息事件：只保证顶层是对象即可，交给调用方按需处理
  if (postType !== "message") {
    return { ...parsed, post_type: postType } as unknown as OneBotEvent;
  }

  const messageType = parsed.message_type;
  if (messageType !== "private" && messageType !== "group") return null;

  // 路由所必需的字段：缺了就没法处理，直接丢弃
  if (!isFiniteNumber(parsed.user_id)) return null;
  if (!isFiniteNumber(parsed.message_id)) return null;
  if (messageType === "group" && !isFiniteNumber(parsed.group_id)) return null;

  const rawMessageSegments = Array.isArray(parsed.message) ? parsed.message : null;
  const message: string | MessageSegment[] =
    typeof parsed.message === "string"
      ? parsed.message
      : rawMessageSegments
        ? (rawMessageSegments as MessageSegment[])
        : "";

  const rawMessage =
    typeof parsed.raw_message === "string"
      ? parsed.raw_message
      : typeof message === "string"
        ? message
        : textFromSegments(rawMessageSegments ?? []);

  const rawSender = isRecord(parsed.sender) ? parsed.sender : {};
  const sender = {
    user_id: isFiniteNumber(rawSender.user_id) ? rawSender.user_id : parsed.user_id,
    nickname: typeof rawSender.nickname === "string" ? rawSender.nickname : "",
    card: typeof rawSender.card === "string" ? rawSender.card : "",
    sex: typeof rawSender.sex === "string" ? rawSender.sex : "unknown",
    age: isFiniteNumber(rawSender.age) ? rawSender.age : 0,
    role: typeof rawSender.role === "string" ? rawSender.role : "member",
  };

  const subType =
    typeof parsed.sub_type === "string"
      ? parsed.sub_type
      : messageType === "private"
        ? "friend"
        : "normal";

  return {
    ...parsed,
    post_type: "message",
    message_type: messageType,
    sub_type: subType,
    message,
    raw_message: rawMessage,
    sender,
  } as unknown as OneBotEvent;
}

export function isPrivateMessage(
  event: OneBotEvent | null | undefined,
): event is PrivateMessageEvent {
  return (
    !!event &&
    typeof event === "object" &&
    event.post_type === "message" &&
    (event as { message_type?: unknown }).message_type === "private"
  );
}

export function isGroupMessage(
  event: OneBotEvent | null | undefined,
): event is GroupMessageEvent {
  return (
    !!event &&
    typeof event === "object" &&
    event.post_type === "message" &&
    (event as { message_type?: unknown }).message_type === "group"
  );
}

// ── 出站消息安全编码 ────────────────────────────

/**
 * 转义文本中的 CQ 码元字符。
 * OneBot 规定 & [ ] 需要转义；转义后 NapCat/QQ 会还原成普通文本，
 * 因此模型输出里的 `[CQ:at,qq=all]` 只会被当成一句普通的话。
 */
export function escapeCqText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

/** 是否为受控的 qqFace CQ 码（仅允许 [CQ:face,id=数字]） */
export function isAllowedCqCode(cq: string): boolean {
  return ALLOWED_CQ_PATTERN.test(cq.trim());
}

/** 读取单条消息长度上限（环境变量可覆盖，非法值回退默认并警告一次） */
let warnedBadMaxLength = false;
function getMaxMessageLength(): number {
  const raw = process.env.ONE_BOT_MAX_MESSAGE_LENGTH;
  if (!raw || raw.trim() === "") return QQ_MAX_MESSAGE_LENGTH;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 50 || value > 5000) {
    if (!warnedBadMaxLength) {
      warnedBadMaxLength = true;
      console.warn(
        `[配置] ONE_BOT_MAX_MESSAGE_LENGTH 无效（当前: ${raw}），应为 50-5000 的整数，已回退默认 ${QQ_MAX_MESSAGE_LENGTH}`,
      );
    }
    return QQ_MAX_MESSAGE_LENGTH;
  }
  return value;
}

/** 在尽量自然的位置（换行/句末标点）切一刀；找不到合适位置则硬切 */
function findSplitIndex(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);
  let cut = -1;
  const pattern = /\n|[。！？!?…；;]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    cut = match.index + 1;
  }
  // 切点太靠前会造成过多碎片：至少保留 40%
  if (cut >= Math.floor(maxChars * 0.4) && cut < maxChars) return cut;
  // 不要把代理对（emoji）切成两半
  let hard = maxChars;
  const code = text.charCodeAt(hard - 1);
  if (code >= 0xd800 && code <= 0xdbff && hard > 1) hard -= 1;
  return hard;
}

/** 找一个切点，使切出部分的「转义后长度」不超过上限（CQ 转义会膨胀字符数） */
function findEncodedSplitIndex(text: string, limit: number): number {
  // 二分：最大的 cut 使 escapeCqText(text.slice(0, cut)).length <= limit
  let lo = 1;
  let hi = Math.min(text.length, limit);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeCqText(text.slice(0, mid)).length <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let hard = Math.max(1, lo);
  // 不切坏代理对
  const code = text.charCodeAt(hard - 1);
  if (code >= 0xd800 && code <= 0xdbff && hard > 1) hard -= 1;

  // 在可接受范围内优先找自然断点
  const window = text.slice(0, hard);
  let cut = -1;
  const pattern = /\n|[。！？!?…；;]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    cut = match.index + 1;
  }
  if (cut >= Math.floor(limit * 0.4) && cut < hard) return cut;
  return hard;
}

/**
 * 按 QQ 单条长度上限切分文本。
 * 优先在换行/句末标点处断开；每段都非空。
 */
export function splitMessage(text: string, maxChars: number = QQ_MAX_MESSAGE_LENGTH): string[] {
  const limit = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : QQ_MAX_MESSAGE_LENGTH;
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return [];
  if (normalized.length <= limit) return [normalized];

  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const cut = findSplitIndex(remaining, limit);
    const chunk = remaining.slice(0, cut);
    if (chunk.trim().length > 0) parts.push(chunk);
    remaining = remaining.slice(cut);
  }
  if (remaining.trim().length > 0) parts.push(remaining);
  return parts;
}

/**
 * 切分并转义：保证每段「在协议线上」的长度也不超过上限
 * （CQ 转义会把 [ ] & 各膨胀成 5 个字符）。
 */
function splitAndEscape(text: string, limit: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return [];
  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    const escapedAll = escapeCqText(remaining);
    if (escapedAll.length <= limit) {
      if (remaining.trim().length > 0) parts.push(escapedAll);
      break;
    }
    const cut = findEncodedSplitIndex(remaining, limit);
    const chunk = remaining.slice(0, cut);
    if (chunk.trim().length > 0) parts.push(escapeCqText(chunk));
    remaining = remaining.slice(cut);
  }
  return parts;
}

export interface EncodedOutbound {
  /** 待发送的 CQ 字符串（文本已转义 / 已切分） */
  parts: string[];
  /** 是否有未受控 CQ 码被丢弃 */
  droppedCq: boolean;
}

/**
 * 将 SendableMessage 编码为可安全发送的 CQ 字符串数组。
 * - 纯文本：转义 CQ 元字符后按长度切分；
 * - CqCode：仅放行受控 qqFace，其余一律丢弃（droppedCq=true）。
 */
export function encodeOutbound(message: SendableMessage, maxChars?: number): EncodedOutbound {
  if (isCqCode(message)) {
    if (!isAllowedCqCode(message.cq)) return { parts: [], droppedCq: true };
    return { parts: [message.cq.trim()], droppedCq: false };
  }
  const limit = maxChars ?? getMaxMessageLength();
  return { parts: splitAndEscape(message, limit), droppedCq: false };
}

// ── OneBot 11 出站 API ──────────────────────────

type ApiParams = Record<string, unknown>;

interface ApiCall {
  action: string;
  params: ApiParams;
  echo?: string;
}

// ── WS 连接管理 ──────────────────────────────────

let connections: WebSocket[] = [];
let lastConnectedAt: number | null = null;

export function addConnection(ws: WebSocket) {
  connections.push(ws);
  lastConnectedAt = Date.now();
  ws.on("close", () => {
    connections = connections.filter(c => c !== ws);
  });
}

export function getConnectionCount(): number {
  return connections.length;
}

export function getLastConnectedAt(): number | null {
  return lastConnectedAt;
}

/** 连接状态摘要（用于健康检查） */
export function getConnectionStatus(): { connected: boolean; since: string | null; count: number } {
  const alive = connections.filter(c => c.readyState === c.OPEN).length;
  return {
    connected: alive > 0,
    since: lastConnectedAt ? new Date(lastConnectedAt).toISOString() : null,
    count: alive,
  };
}

// ── 消息发送 ────────────────────────────────────

/** QQ CQ 码类型（扩展 kaomoji 渲染器用） */
export interface CqCode {
  type: "cqcode";
  cq: string; // e.g. "[CQ:face,id=178]"
}

export type SendableMessage = string | CqCode;

export function isCqCode(msg: SendableMessage): msg is CqCode {
  return typeof msg !== "string" && (msg as CqCode).type === "cqcode";
}

/**
 * 白名单判断。
 * 空白名单 = 允许全部（当前单用户阶段；qq.ts 会在启动时打印显著警告）。
 */
export function isUserAllowed(
  userId: number | null | undefined,
  allowedUsers: readonly number[],
): boolean {
  if (!Array.isArray(allowedUsers) || allowedUsers.length === 0) return true;
  if (typeof userId !== "number" || !Number.isFinite(userId)) return false;
  return allowedUsers.includes(userId);
}

/**
 * message_id 去重（LRU）。
 * 断线重连/重复投递时 NapCat 可能重发同一条事件，靠它避免重复回复。
 */
export class MessageIdDedup {
  private readonly capacity: number;
  private readonly seen = new Map<number, true>();

  constructor(capacity = 1000) {
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1000;
  }

  get size(): number {
    return this.seen.size;
  }

  /** 是否已见过（true = 重复投递）。非法 id 不参与去重，返回 false。 */
  hasSeen(messageId: number | null | undefined): boolean {
    if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) {
      return false;
    }
    if (this.seen.has(messageId)) {
      // 刷新 LRU 顺序
      this.seen.delete(messageId);
      this.seen.set(messageId, true);
      return true;
    }
    this.seen.set(messageId, true);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return false;
  }

  clear(): void {
    this.seen.clear();
  }
}

function sendMessage(action: string, targetParams: ApiParams, message: SendableMessage): boolean {
  const encoded = encodeOutbound(message);
  if (encoded.droppedCq) {
    console.warn(`[安全] 出站消息包含未受控的 CQ 码，已丢弃（action=${action}）`);
    return false;
  }
  if (encoded.parts.length === 0) return false;

  let sent = false;
  for (const part of encoded.parts) {
    const ok = callApi(action, {
      ...targetParams,
      message: part,
      // 文本已由我们自己转义，避免 NapCat 再解释一遍 CQ 码
      auto_escape: false,
    });
    sent = sent || ok;
    if (!ok) break; // 连接已断，后续分段不再尝试
  }
  return sent;
}

export function sendPrivateMsg(userId: number, message: SendableMessage): boolean {
  return sendMessage("send_private_msg", { user_id: userId }, message);
}

export function sendGroupMsg(groupId: number, message: SendableMessage): boolean {
  return sendMessage("send_group_msg", { group_id: groupId }, message);
}

// ── 受控撤回（delete_msg，v0.3 打错字真实感） ─────

/**
 * 撤回安全边界：
 * - 只允许撤回**本进程最近发出**的消息（message_id 必须在 recentlySentMessages 里）；
 * - 只允许撤回 15s 内的消息（刚发错字才撤回，旧消息不碰）；
 * - 全局至少间隔 5s（避免异常时疯狂撤回刷屏/触发风控）。
 */
const RECALL_MAX_AGE_MS = 15_000;
const RECALL_MIN_INTERVAL_MS = 5_000;
/** 本进程最近发出的消息（message_id → 发出时刻） */
const recentlySentMessages = new Map<number, number>();
/** 最近一次成功撤回的时间（全局限频） */
let lastRecallAt = 0;

function rememberSentMessage(messageId: number | null): void {
  const now = Date.now();
  if (messageId === null) return;
  recentlySentMessages.set(messageId, now);
  // 顺手清理过期记录，避免 Map 无限增长
  for (const [id, sentAt] of recentlySentMessages) {
    if (now - sentAt > RECALL_MAX_AGE_MS) recentlySentMessages.delete(id);
  }
}

function extractMessageId(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as { message_id?: unknown }).message_id;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export interface RecallCheck {
  ok: boolean;
  reason: "ok" | "invalid_id" | "not_recently_sent" | "too_old" | "rate_limited";
}

/** 纯函数守卫（便于单测）：是否允许撤回某个 message_id。 */
export function evaluateRecallAllowed(input: {
  messageId: number;
  sentAt: number | undefined;
  lastRecallAt: number;
  now: number;
}): RecallCheck {
  if (!Number.isInteger(input.messageId) || input.messageId <= 0) {
    return { ok: false, reason: "invalid_id" };
  }
  if (input.sentAt === undefined) return { ok: false, reason: "not_recently_sent" };
  if (input.now - input.sentAt > RECALL_MAX_AGE_MS) return { ok: false, reason: "too_old" };
  if (input.lastRecallAt > 0 && input.now - input.lastRecallAt < RECALL_MIN_INTERVAL_MS) {
    return { ok: false, reason: "rate_limited" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * 异步发送私聊消息并返回 message_id（撤回需要）。
 * 失败（无连接/超时/出站 CQ 被拒）返回 null，绝不抛异常——调用方降级为普通发送。
 */
export async function sendPrivateMsgAsync(
  userId: number,
  message: SendableMessage
): Promise<number | null> {
  const encoded = encodeOutbound(message);
  if (encoded.droppedCq) {
    console.warn("[安全] 异步出站消息包含未受控的 CQ 码，已丢弃");
    return null;
  }
  if (encoded.parts.length === 0) return null;

  let lastMessageId: number | null = null;
  try {
    for (const part of encoded.parts) {
      const data = await callApiAsync("send_private_msg", {
        user_id: userId,
        message: part,
        auto_escape: false,
      });
      const messageId = extractMessageId(data);
      if (messageId !== null) lastMessageId = messageId;
    }
  } catch (err) {
    console.log(`[API] 异步发送失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  rememberSentMessage(lastMessageId);
  return lastMessageId;
}

/** 异步发送群消息并返回 message_id（媒体落地校验用）。失败返回 null。 */
export async function sendGroupMsgAsync(
  groupId: number,
  message: SendableMessage
): Promise<number | null> {
  const encoded = encodeOutbound(message);
  if (encoded.droppedCq) {
    console.warn("[安全] 异步出站群消息包含未受控的 CQ 码，已丢弃");
    return null;
  }
  if (encoded.parts.length === 0) return null;

  let lastMessageId: number | null = null;
  try {
    for (const part of encoded.parts) {
      const data = await callApiAsync("send_group_msg", {
        group_id: groupId,
        message: part,
        auto_escape: false,
      });
      const messageId = extractMessageId(data);
      if (messageId !== null) lastMessageId = messageId;
    }
  } catch (err) {
    console.log(`[API] 异步群发送失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  rememberSentMessage(lastMessageId);
  return lastMessageId;
}

/**
 * 受控撤回自己刚发出的消息（OneBot `delete_msg`）。
 * 只允许撤回 `sendPrivateMsgAsync` 刚发出、且满足时间/频率限制的消息；失败返回 false。
 */
export async function recallMessage(messageId: number): Promise<boolean> {
  const now = Date.now();
  const check = evaluateRecallAllowed({
    messageId,
    sentAt: recentlySentMessages.get(messageId),
    lastRecallAt,
    now,
  });
  if (!check.ok) return false;

  try {
    await callApiAsync("delete_msg", { message_id: messageId }, 3000);
    recentlySentMessages.delete(messageId);
    lastRecallAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

// ── 反向 WS 握手鉴权 ────────────────────────────

/** 从请求 URL 中取 pathname（日志/校验时绝不包含 query 里的 token） */
export function getRequestPathname(req: Pick<IncomingMessage, "url">): string {
  try {
    return new URL(req.url ?? "/", "ws://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

/**
 * 从请求中取 token：优先 query 的 access_token，其次 Authorization: Bearer。
 * NapCat 反向 WS 两种方式都可能用到。
 */
export function getProvidedToken(req: Pick<IncomingMessage, "url" | "headers">): string | null {
  try {
    const url = new URL(req.url ?? "/", "ws://127.0.0.1");
    const queryToken = url.searchParams.get("access_token");
    if (queryToken) return queryToken;
  } catch {
    // URL 解析失败时继续尝试 Header
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return null;
}

/** 定长比较，避免 token 逐字符比较的时间侧信道 */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface HandshakeDecision {
  ok: boolean;
  /** 拒绝时回给客户端的 HTTP 状态码（404 路径不符 / 401 token 不符） */
  statusCode: number;
  /** 人类可读的拒绝原因（不含 token 等敏感值） */
  reason: string;
}

/**
 * 反向 WS 握手校验：path 必须匹配配置，配置了 token 时必须校验通过。
 * 纯函数，方便单测；qq.ts 的 verifyClient 直接调用它。
 */
export function verifyHandshake(
  req: Pick<IncomingMessage, "url" | "headers">,
  expectedPath: string,
  expectedToken?: string | null,
): HandshakeDecision {
  const pathname = getRequestPathname(req);
  if (pathname !== expectedPath) {
    return { ok: false, statusCode: 404, reason: "路径不匹配" };
  }
  if (expectedToken) {
    const provided = getProvidedToken(req);
    if (!provided || !safeEquals(provided, expectedToken)) {
      return { ok: false, statusCode: 401, reason: "token 校验失败" };
    }
  }
  return { ok: true, statusCode: 101, reason: "ok" };
}

// ── 通用 API 调用 ───────────────────────────────

function callApi(action: string, params: ApiParams): boolean {
  const request: ApiCall = { action, params };
  const data = JSON.stringify(request);
  let sent = false;
  for (const ws of connections) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      sent = true;
    }
  }
  if (!sent) {
    console.log(`[API] 无法发送 ${action}: 无活跃连接`);
  }
  return sent;
}

// ── 异步 API 调用（带 echo 匹配，等待响应） ─────

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCalls = new Map<string, PendingCall>();
let echoCounter = 0;

export function callApiAsync(action: string, params: ApiParams, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const echo = `karen_${++echoCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(echo);
      reject(new Error(`[API] ${action} 超时`));
    }, timeoutMs);
    pendingCalls.set(echo, { resolve, reject, timer });

    const request: ApiCall = { action, params, echo };
    const data = JSON.stringify(request);
    let sent = false;
    for (const ws of connections) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        sent = true;
      }
    }
    if (!sent) {
      clearTimeout(timer);
      pendingCalls.delete(echo);
      reject(new Error(`[API] 无法发送 ${action}: 无活跃连接`));
    }
  });
}

/** 尝试用收到的消息匹配并解析一个待处理的异步 API 响应 */
export function tryResolveApiResponse(raw: string): boolean {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.echo !== "string") return false;
    if (typeof obj.retcode !== "number") return false;
    const pending = pendingCalls.get(obj.echo);
    if (!pending) return false;

    clearTimeout(pending.timer);
    pendingCalls.delete(obj.echo);

    if (obj.retcode === 0) {
      pending.resolve(obj.data);
    } else {
      pending.reject(new Error(`[API] 调用失败: retcode=${obj.retcode}`));
    }
    return true;
  } catch {
    return false;
  }
}

// ── 出站媒体落地校验（v0.9.24） ─────────────────
//
// 为什么需要：`sendPrivateMsg` 是 fire-and-forget，WS 半断连 / 网关返回成功但消息
// 没真正落地时，调用方仍以为"发了"。语音/照片/贴纸属于"说了就要有"的动作，
// 发完用 get_msg 回读段类型，作为"真的发出去了"的硬证据。
//
// 只回读段类型，不回传 file/url：私聊 get_msg 的 url 字段可能带本机路径，
// 不应进入日志/模型上下文。

/** get_msg 回读到的消息段（只保留类型与少量安全字段）。 */
export interface MsgSegmentInfo {
  type: string;
  /** record 段的时长（秒）；其他段为 null */
  durationSeconds: number | null;
}

/**
 * 从 get_msg 的响应里提取消息段。纯函数，便于单测。
 * 兼容：
 * - `message` 为 OneBot 11 段数组；
 * - `message` 为 CQ 码字符串（部分实现会这样返回）；
 * - 缺失/畸形 → null。
 */
export function extractMsgSegments(data: unknown): MsgSegmentInfo[] | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as { message?: unknown }).message;
  if (Array.isArray(raw)) {
    const out: MsgSegmentInfo[] = [];
    for (const seg of raw) {
      if (!seg || typeof seg !== "object") continue;
      const type = (seg as { type?: unknown }).type;
      if (typeof type !== "string" || !type) continue;
      const segData = (seg as { data?: unknown }).data;
      const durationRaw =
        segData && typeof segData === "object"
          ? (segData as { duration?: unknown }).duration
          : undefined;
      const duration =
        typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw >= 0
          ? durationRaw
          : null;
      out.push({ type, durationSeconds: duration });
    }
    return out.length > 0 ? out : [];
  }
  if (typeof raw === "string") {
    const out: MsgSegmentInfo[] = [];
    // 只解析 CQ 类型，不解析参数；用于"这条消息里有没有 record/image"。
    for (const match of raw.matchAll(/\[CQ:([a-z_]+)(?:,|\])/gi)) {
      out.push({ type: match[1].toLowerCase(), durationSeconds: null });
    }
    return out.length > 0 ? out : [];
  }
  return null;
}

/**
 * 回读一条消息，返回段类型列表；失败/无连接返回 null。
 * 超时默认 2s：落地校验不该把正常回复拖慢；get_msg 本地网关通常 <100ms。
 */
export async function getMsgSegments(
  messageId: number,
  timeoutMs = 2000,
): Promise<MsgSegmentInfo[] | null> {
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  try {
    const data = await callApiAsync("get_msg", { message_id: messageId }, timeoutMs);
    return extractMsgSegments(data);
  } catch (err) {
    console.log(`[get_msg] 获取消息 ${messageId} 失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 发送后校验：回读消息里确实有期望的段类型。 */
export async function verifySentSegment(
  messageId: number | null,
  expected: "image" | "record",
): Promise<{ confirmed: boolean; durationSeconds: number | null; reason: string }> {
  if (messageId === null) {
    return { confirmed: false, durationSeconds: null, reason: "no_message_id" };
  }
  const segments = await getMsgSegments(messageId);
  if (segments === null) {
    return { confirmed: false, durationSeconds: null, reason: "get_msg_failed" };
  }
  const hit = segments.find((s) => s.type === expected);
  if (!hit) {
    return { confirmed: false, durationSeconds: null, reason: "segment_missing" };
  }
  return { confirmed: true, durationSeconds: hit.durationSeconds, reason: "ok" };
}

/** 通过 get_msg API 获取消息原文 */
export async function getMsgById(messageId: number): Promise<string | null> {
  try {
    const data = await callApiAsync("get_msg", { message_id: messageId }, 5000) as Record<string, unknown>;
    if (typeof data?.raw_message === "string") return data.raw_message;
    if (typeof data?.message === "string") return data.message;
    if (Array.isArray(data?.message)) {
      const parts: string[] = [];
      for (const seg of data.message as Array<{ type: string; data?: { text?: string } }>) {
        if (seg.type === "text" && seg.data?.text) {
          parts.push(seg.data.text);
        }
      }
      return parts.join("") || null;
    }
    return null;
  } catch (err) {
    console.log(`[get_msg] 获取消息 ${messageId} 失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── API 响应解析 ─────────────────────────────────

export interface OneBotApiResponse {
  status: "ok" | "failed";
  retcode: number;
}

export function parseApiResponse(raw: string): OneBotApiResponse | null {
  try {
    const data = JSON.parse(raw);
    if (isRecord(data) && typeof data.status === "string" && typeof data.retcode === "number") {
      return { status: data.status as OneBotApiResponse["status"], retcode: data.retcode };
    }
    return null;
  } catch {
    return null;
  }
}

// ── P1-3: 消息类型检测 ─────────────────────────

/** 取消息段数组（字符串/缺失时返回 null） */
function getSegments(segments: unknown): MessageSegment[] | null {
  if (!Array.isArray(segments)) return null;
  return segments.filter(
    (seg): seg is MessageSegment => isRecord(seg) && typeof seg.type === "string",
  );
}

export type MediaType = "image" | "record" | "face" | "mface" | "video" | "file" | "location" | "reply" | null;

export interface MessageMedia {
  type: MediaType;
  /** 合成标记文本（给 pipeline 用） */
  syntheticText: string;
  /** Level 2 预留：媒体 URL/数据 */
  data: Record<string, string> | null;
}

/**
 * 检测消息中的媒体类型并返回合成标记。
 * 对畸形/缺失的 message 字段容错：无法识别时返回 null。
 */
// ── QQ 内置表情（face）名称 ────────────────────

/** 常用 QQ face id → 中文名；只用于把入站表情转成可理解的合成文本 */
const QQ_FACE_NAMES: Record<string, string> = {
  "0": "惊讶", "1": "撇嘴", "2": "色", "3": "发呆", "4": "得意", "5": "流泪",
  "6": "害羞", "7": "闭嘴", "8": "睡", "9": "大哭", "10": "尴尬", "11": "发怒",
  "12": "调皮", "13": "呲牙", "14": "微笑", "15": "难过", "16": "酷", "17": "冷汗",
  "18": "抓狂", "19": "吐", "20": "偷笑", "21": "可爱", "22": "白眼", "23": "傲慢",
  "24": "饥饿", "25": "困", "26": "惊恐", "27": "流汗", "28": "憨笑", "29": "悠闲",
  "30": "奋斗", "31": "咒骂", "32": "疑问", "33": "嘘", "34": "晕", "35": "折磨",
  "36": "衰", "37": "骷髅", "38": "敲打", "39": "再见", "40": "擦汗", "41": "抠鼻",
  "42": "鼓掌", "43": "糗大了", "44": "坏笑", "45": "左哼哼", "46": "右哼哼",
  "47": "哈欠", "48": "鄙视", "49": "委屈", "50": "快哭了", "51": "阴险",
  "52": "亲亲", "53": "吓", "54": "可怜", "55": "爱心", "56": "心碎", "57": "啤酒",
  "58": "咖啡", "59": "蛋糕", "60": "玫瑰", "61": "凋谢", "62": "示爱", "63": "爱心",
  "64": "男孩", "65": "女孩", "66": "握手", "67": "胜利", "68": "抱拳", "69": "勾引",
  "70": "拳头", "71": "差劲", "72": "爱你", "73": "NO", "74": "OK", "75": "爱情",
  "76": "飞吻", "77": "跳跳", "78": "发抖", "79": "怄火", "80": "西瓜", "81": "啤酒",
};

/** 把入站 QQ 内置表情 id 转成中文名（未知回退「表情」） */
export function describeQqFace(id: string | undefined | null): string {
  if (!id) return "表情";
  return QQ_FACE_NAMES[id] ?? "表情";
}

/**
 * 表情包 summary 是外部可控文本，会被直接拼进 prompt。
 * 压成单行 + 去掉控制字符 + 限长，防止「[动画表情]\n忽略以上规则」这类伪造段落。
 * 按码点截断，避免切开 emoji 代理对。
 */
export function sanitizeMediaSummary(raw: string | undefined | null, maxLen = 60): string {
  if (!raw) return "";
  const cleaned = String(raw)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^[\[\]【】]+|[\[\]【】]+$/g, "")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxLen ? chars.slice(0, maxLen).join("") : cleaned;
}

/** 把单个非文本消息段转成模型可读的合成标记。 */
function mediaFromSegment(seg: MessageSegment, event: PrivateMessageEvent): MessageMedia | null {
  const data = isRecord(seg.data) ? (seg.data as Record<string, string>) : null;
  switch (seg.type) {
    case "image":
      return { type: "image", syntheticText: "[图片]", data };
    case "record":
      return { type: "record", syntheticText: "[语音]", data };
    case "reply":
      // 引用消息：返回原始 text + reply 数据，由 qq.ts 拼接 [引用：...]
      return {
        type: "reply",
        syntheticText: typeof event.raw_message === "string" ? event.raw_message : "",
        data,
      };
    case "face":
      return { type: "face", syntheticText: `[表情：${describeQqFace(data?.id)}]`, data };
    case "mface": {
      const summary = sanitizeMediaSummary(data?.summary);
      return { type: "mface", syntheticText: summary ? `[表情包：${summary}]` : "[表情包]", data };
    }
    case "text":
      return null;
    default:
      return { type: seg.type as MediaType, syntheticText: `[不支持的消息: ${seg.type}]`, data };
  }
}

/**
 * 检测消息中的**所有**媒体段（v0.9.24）。
 *
 * 旧 `detectMedia` 只取第一个非文本段，导致「图+图」「引用+图」「图+表情」
 * 后面的媒体被静默丢弃。这里按消息段顺序返回全部媒体，调用方逐条处理；
 * 文本段不进入结果（文本由 raw_message / stripCqCodes 处理）。
 * 畸形消息返回空数组，不抛异常。
 */
export function detectMediaList(event: PrivateMessageEvent): MessageMedia[] {
  if (!event) return [];
  const segments = getSegments(event.message);
  if (!segments || segments.length === 0) return [];
  const out: MessageMedia[] = [];
  for (const seg of segments) {
    const media = mediaFromSegment(seg, event);
    if (media) out.push(media);
  }
  return out;
}

/**
 * 兼容旧调用：返回第一个媒体段（与 v0.9.23 行为一致）。
 * 新代码应使用 detectMediaList，避免多图/引用+图丢媒体。
 */
export function detectMedia(event: PrivateMessageEvent): MessageMedia | null {
  return detectMediaList(event)[0] ?? null;
}

/**
 * 检测群消息中是否 @了指定 QQ 号。
 * 返回被 @ 时提取的纯文本（去掉了 @CQ 码）；畸形消息返回 null。
 */
export function extractAtText(event: GroupMessageEvent, selfId: number): string | null {
  if (!event) return null;
  const segments = event.message;
  const rawMessage = typeof event.raw_message === "string" ? event.raw_message : "";

  if (typeof segments === "string") {
    // 字符串形式：检查 raw_message 中是否包含 [CQ:at,qq=<selfId>]
    const atPattern = new RegExp(`\\[CQ:at,qq=${selfId}\\]`);
    if (atPattern.test(rawMessage)) {
      return rawMessage.replace(atPattern, "").trim();
    }
    return null;
  }

  const safeSegments = getSegments(segments);
  if (!safeSegments) return null;

  // 结构化消息：检查 segments 中是否有 at 类型的 segment
  let atFound = false;
  for (const seg of safeSegments) {
    if (seg.type === "at" && isRecord(seg.data) && seg.data.qq === String(selfId)) {
      atFound = true;
      break;
    }
  }
  if (!atFound) return null;

  // 提取文本部分（去掉 at segment）
  const textParts: string[] = [];
  for (const seg of safeSegments) {
    if (seg.type === "text" && isRecord(seg.data) && typeof seg.data.text === "string") {
      textParts.push(seg.data.text);
    } else if (seg.type === "at" && isRecord(seg.data)) {
      // 跳过 at，但如果它是 @别人（不是自己），可以保留为文本标记
      if (seg.data.qq !== String(selfId)) {
        textParts.push(`@${seg.data.qq ?? "某人"}`);
      }
    }
  }
  const text = textParts.join("").trim();
  return text || rawMessage.replace(/\[CQ:at,[^\]]+\]/, "").trim();
}

/** 从 reply 段的 data 中提取引用原文（NapCatQQ 可能在 data 中附带原文） */
export function getReplyContext(replyData: Record<string, string> | null): string | null {
  if (!replyData || !isRecord(replyData)) return null;
  // 有些实现直接在 data 中包含被引用消息的 text
  if (typeof replyData.text === "string") return replyData.text;
  // 有些用 message 字段
  if (typeof replyData.message === "string") return replyData.message;
  return null;
}
