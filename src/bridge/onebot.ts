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

/** 唯一允许绕过 CQ 转义的受控 CQ 码：QQ 内置表情 */
const ALLOWED_CQ_PATTERN = /^\[CQ:face,id=\d{1,4}\]$/;

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

interface ApiResponse {
  status: "ok" | "failed";
  retcode: number;
  data: unknown;
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

/** OneBot CQ 码匹配 */
function extractCqType(segments: MessageSegment[]): string | null {
  for (const seg of segments) {
    if (seg.type && seg.type !== "text") return seg.type;
  }
  return null;
}

/** 提取图片/语音的 URL（给 Level 2 预留） */
function extractCqData(segments: MessageSegment[], cqType: string): Record<string, string> | null {
  for (const seg of segments) {
    if (seg.type === cqType && isRecord(seg.data)) return seg.data as Record<string, string>;
  }
  return null;
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
export function detectMedia(event: PrivateMessageEvent): MessageMedia | null {
  if (!event) return null;
  const segments = getSegments(event.message);
  if (!segments || segments.length === 0) return null;
  const cqType = extractCqType(segments);
  if (!cqType) return null;

  switch (cqType) {
    case "image":
      return {
        type: "image",
        syntheticText: "[图片]",
        data: extractCqData(segments, "image"),
      };
    case "record":
      return {
        type: "record",
        syntheticText: "[语音]",
        data: extractCqData(segments, "record"),
      };
    case "reply":
      // 引用消息：返回原始 text + reply 数据，由 qq.ts 拼接 [引用：...]
      return {
        type: "reply",
        syntheticText: typeof event.raw_message === "string" ? event.raw_message : "",
        data: extractCqData(segments, "reply"),
      };
    case "face":
    case "mface":
      return {
        type: cqType,
        syntheticText: "",
        data: null,
      };
    default:
      return {
        type: cqType as MediaType,
        syntheticText: `[不支持的消息: ${cqType}]`,
        data: extractCqData(segments, cqType),
      };
  }
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
