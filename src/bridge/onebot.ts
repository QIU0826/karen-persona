/**
 * OneBot 11 协议编解码
 * 处理来自 NapCatQQ 的事件解析和 API 调用构造
 */
import type { WebSocket } from "ws";

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

export function sendPrivateMsg(userId: number, message: SendableMessage): boolean {
  return callApi("send_private_msg", {
    user_id: userId,
    message: isCqCode(message) ? message.cq : message,
    auto_escape: false,
  });
}

export function sendGroupMsg(groupId: number, message: SendableMessage): boolean {
  return callApi("send_group_msg", {
    group_id: groupId,
    message: isCqCode(message) ? message.cq : message,
    auto_escape: false,
  });
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
    if (typeof data.status === "string" && typeof data.retcode === "number") {
      return { status: data.status, retcode: data.retcode };
    }
    return null;
  } catch {
    return null;
  }
}

// ── 事件解析 ────────────────────────────────────

export function parseEvent(data: string): OneBotEvent | null {
  try {
    return JSON.parse(data) as OneBotEvent;
  } catch {
    return null;
  }
}

export function isPrivateMessage(event: OneBotEvent): event is PrivateMessageEvent {
  return event.post_type === "message" && (event as PrivateMessageEvent).message_type === "private";
}

export function isGroupMessage(event: OneBotEvent): event is GroupMessageEvent {
  return event.post_type === "message" && (event as GroupMessageEvent).message_type === "group";
}

// ── P1-3: 消息类型检测 ─────────────────────────

/** OneBot CQ 码匹配 */
function extractCqType(segments: MessageSegment[] | string): string | null {
  if (typeof segments === "string") return null;
  for (const seg of segments) {
    if (seg.type && seg.type !== "text") return seg.type;
  }
  return null;
}

/** 提取图片/语音的 URL（给 Level 2 预留） */
function extractCqData(segments: MessageSegment[] | string, cqType: string): Record<string, string> | null {
  if (typeof segments === "string") return null;
  for (const seg of segments) {
    if (seg.type === cqType && seg.data) return seg.data;
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
 * 检测消息中的媒体类型并返回合成标记
 */
export function detectMedia(event: PrivateMessageEvent): MessageMedia | null {
  const segments = event.message;
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
        syntheticText: event.raw_message,
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
 * 返回被 @ 时提取的纯文本（去掉了 @CQ 码）。
 */
export function extractAtText(event: GroupMessageEvent, selfId: number): string | null {
  const segments = event.message;
  if (typeof segments === "string") {
    // 字符串形式：检查 raw_message 中是否包含 [CQ:at,qq=<selfId>]
    const atPattern = new RegExp(`\\[CQ:at,qq=${selfId}\\]`);
    if (atPattern.test(event.raw_message)) {
      return event.raw_message.replace(atPattern, "").trim();
    }
    return null;
  }

  // 结构化消息：检查 segments 中是否有 at 类型的 segment
  let atFound = false;
  for (const seg of segments) {
    if (seg.type === "at" && seg.data?.qq === String(selfId)) {
      atFound = true;
      break;
    }
  }
  if (!atFound) return null;

  // 提取文本部分（去掉 at segment）
  const textParts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text" && seg.data?.text) {
      textParts.push(seg.data.text);
    } else if (seg.type === "at") {
      // 跳过 at，但如果它是 @别人（不是自己），可以保留为文本标记
      if (seg.data?.qq !== String(selfId)) {
        textParts.push(`@${seg.data?.qq ?? "某人"}`);
      }
    }
  }
  const text = textParts.join("").trim();
  return text || event.raw_message.replace(/\[CQ:at,[^\]]+\]/, "").trim();
}

/** 从 reply 段的 data 中提取引用原文（NapCatQQ 可能在 data 中附带原文） */
export function getReplyContext(replyData: Record<string, string> | null): string | null {
  if (!replyData) return null;
  // 有些实现直接在 data 中包含被引用消息的 text
  if (replyData.text) return replyData.text;
  // 有些用 message 字段
  if (replyData.message) return replyData.message;
  return null;
}

