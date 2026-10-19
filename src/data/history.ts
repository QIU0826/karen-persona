/**
 * 会话历史（T0）持久化。
 *
 * 设计要点（M0 地基修复）：
 * - 路径统一走 data/paths.ts，支持 KAREN_DATA_DIR
 * - 原子写：先写 *.tmp 再 rename，避免进程被杀时留下半个 JSON
 * - 同步写：会话文件很小（≤200 条消息），每条消息同步落盘换取可靠性
 * - 容错：损坏的会话文件自动备份为 *.corrupt-<ts>，不阻塞启动
 */
import fs from "node:fs";
import { dataFile, ensureDataDir, safeFileStem } from "./paths.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationSession {
  personaId: string;
  startedAt: number;
  lastActiveAt: number;
  messages: ChatMessage[];
  // T3 会话级状态
  t3: {
    currentTopic: string;
    emotionVector: number; // -1 到 1，当前情绪偏移
    activeThreads: string[]; // 当前活跃的话题线索
  };
}

/** 单会话最多保留的消息条数（滚动窗口，旧消息归档） */
const MAX_MESSAGES = 200;

function getSessionPath(personaId: string): string {
  return dataFile(`${safeFileStem(personaId)}-session.json`);
}

function getArchivePath(personaId: string, date: string): string {
  return dataFile(`${safeFileStem(personaId)}-archive-${date}.json`);
}

function freshSession(personaId: string): ConversationSession {
  const now = Date.now();
  return {
    personaId,
    startedAt: now,
    lastActiveAt: now,
    messages: [],
    t3: {
      currentTopic: "",
      emotionVector: 0,
      activeThreads: [],
    },
  };
}

/** 兼容旧版会话文件：补齐缺失字段，过滤非法消息 */
function normalizeSession(raw: unknown, personaId: string): ConversationSession {
  const base = freshSession(personaId);
  if (!raw || typeof raw !== "object") return base;

  const obj = raw as Partial<ConversationSession>;
  const messages = Array.isArray(obj.messages)
    ? obj.messages.filter(
        (m): m is ChatMessage =>
          !!m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          typeof m.timestamp === "number",
      )
    : [];

  return {
    personaId,
    startedAt: typeof obj.startedAt === "number" ? obj.startedAt : base.startedAt,
    lastActiveAt: typeof obj.lastActiveAt === "number" ? obj.lastActiveAt : base.lastActiveAt,
    messages,
    t3: {
      currentTopic: obj.t3?.currentTopic ?? "",
      emotionVector: typeof obj.t3?.emotionVector === "number" ? obj.t3.emotionVector : 0,
      activeThreads: Array.isArray(obj.t3?.activeThreads) ? obj.t3.activeThreads : [],
    },
  };
}

/** 加载或创建会话（不存在则创建；损坏则备份后重建） */
export function loadSession(personaId: string): ConversationSession {
  ensureDataDir();

  const p = getSessionPath(personaId);
  if (!fs.existsSync(p)) return freshSession(personaId);

  try {
    const raw = fs.readFileSync(p, "utf-8");
    return normalizeSession(JSON.parse(raw), personaId);
  } catch (err) {
    const backup = `${p}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(p, backup);
      console.warn(`[会话] 文件损坏，已备份到 ${backup}，将创建新会话`);
    } catch {
      // 备份失败也不能阻塞启动
    }
    console.warn(`[会话] 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    return freshSession(personaId);
  }
}

/** 原子写入会话（同步，确保进程退出/崩溃时不丢最后一条消息） */
export function saveSessionSync(session: ConversationSession): void {
  session.lastActiveAt = Date.now();
  const p = getSessionPath(session.personaId);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

/** 异步兼容包装（保留旧调用方式） */
export async function saveSession(session: ConversationSession): Promise<void> {
  saveSessionSync(session);
}

/** 添加消息到会话并立即持久化 */
export function addMessage(
  session: ConversationSession,
  role: "user" | "assistant",
  content: string
): void {
  session.messages.push({
    role,
    content,
    timestamp: Date.now(),
  });

  // 保持最近 MAX_MESSAGES 条消息（滑动窗口）
  if (session.messages.length > MAX_MESSAGES) {
    const toArchive = session.messages.slice(0, session.messages.length - MAX_MESSAGES);
    session.messages = session.messages.slice(session.messages.length - MAX_MESSAGES);
    archiveMessages(session.personaId, toArchive);
  }

  saveSessionSync(session);
}

/** 归档旧消息（尽力而为，失败不影响主流程） */
function archiveMessages(personaId: string, messages: ChatMessage[]): void {
  const date = new Date().toISOString().split("T")[0];
  const archivePath = getArchivePath(personaId, date);
  try {
    const existing: ChatMessage[] = fs.existsSync(archivePath)
      ? (JSON.parse(fs.readFileSync(archivePath, "utf-8")) as ChatMessage[])
      : [];
    const tmp = `${archivePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify([...existing, ...messages], null, 2), "utf-8");
    fs.renameSync(tmp, archivePath);
  } catch {
    // 归档失败不阻塞对话
  }
}

/** 构建发送给 AI 的消息列表（最近 N 条 + 较早消息的摘要 + System Prompt） */
export function buildChatMessages(
  session: ConversationSession,
  systemPrompt: string,
  maxRecent: number = 15
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = session.messages.slice(-maxRecent);

  // 如果有被截断的较早消息，生成一个简短摘要
  const older = session.messages.slice(0, -maxRecent);
  let olderSummary = "";
  if (older.length > 5) {
    const topics = older
      .filter(m => m.content.length > 3)
      .slice(-10)
      .map(m => m.content.slice(0, 40))
      .join("；");
    olderSummary = `\n\n你们之前聊过的大概内容：${topics}`;
  }

  const systemWithHistory = systemPrompt + olderSummary;
  return [{ role: "system", content: systemWithHistory }, ...recent];
}

/** 提取 T3 摘要（会话结束后下沉到 T2） */
export function extractT3Summary(session: ConversationSession): string {
  const recentMessages = session.messages.slice(-10);
  const topics = recentMessages.map((m) => m.content.slice(0, 50)).join(" | ");
  return `[${new Date().toISOString()}] 话题: ${session.t3.currentTopic || "闲聊"}, 情绪偏移: ${session.t3.emotionVector}, 最近: ${topics}`;
}
