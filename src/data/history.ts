import fs from "node:fs";
import path from "node:path";

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

const DATA_DIR = path.resolve("data");

function getSessionPath(personaId: string): string {
  return path.join(DATA_DIR, `${personaId}-session.json`);
}

function getArchivePath(personaId: string, date: string): string {
  return path.join(DATA_DIR, `${personaId}-archive-${date}.json`);
}

/** 加载或创建会话 */
export function loadSession(personaId: string): ConversationSession {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const p = getSessionPath(personaId);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ConversationSession;
  }

  return {
    personaId,
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    messages: [],
    t3: {
      currentTopic: "",
      emotionVector: 0,
      activeThreads: [],
    },
  };
}

/** 保存会话（异步，避免阻塞消息处理） */
export async function saveSession(session: ConversationSession): Promise<void> {
  session.lastActiveAt = Date.now();
  const p = getSessionPath(session.personaId);
  await fs.promises.writeFile(p, JSON.stringify(session, null, 2), "utf-8");
}

/** 添加消息到会话 */
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

  // 保持最近 200 条消息（滑动窗口）
  if (session.messages.length > 200) {
    const toArchive = session.messages.slice(0, session.messages.length - 200);
    session.messages = session.messages.slice(session.messages.length - 200);

    // 异步归档旧消息
    const date = new Date().toISOString().split("T")[0];
    const archivePath = getArchivePath(session.personaId, date);
    fs.promises.readFile(archivePath, "utf-8")
      .then(raw => JSON.parse(raw) as ChatMessage[])
      .catch(() => [] as ChatMessage[])
      .then(existing => {
        return fs.promises.writeFile(archivePath, JSON.stringify([...existing, ...toArchive], null, 2), "utf-8");
      })
      .catch(() => { /* 归档失败不阻塞 */ });
  }

  // fire-and-forget 保存
  saveSession(session).catch(() => {});
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
