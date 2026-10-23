/**
 * 跨轮时间差提示（v0.9.32）。
 *
 * 真实巡检发现：23:49 用户说“准备睡觉”，第二天 09:11 她才回“这个点睡？”，
 * 把昨晚当成现在。最近消息历史里没有时间戳，模型只能看到内容，因此必须显式补时间差。
 */
import type { ConversationSession } from "../data/history.js";

const MIN_GAP_MS = 2 * 60 * 60 * 1000;

function formatGap(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  const days = hours / 24;
  return `${Math.round(days)} 天前`;
}

/**
 * 若上一轮对话超过 2 小时，生成“先接时间差”的内部提示；否则返回空。
 * 当前用户消息若已落库（延迟补发），不会把它当作上一轮。
 */
export function buildTimeGapNote(
  session: ConversationSession,
  currentInput: string,
  now = Date.now(),
): string {
  const previous = [...session.messages]
    .reverse()
    .find((m) => !(m.role === "user" && m.content === currentInput));
  if (!previous) return "";
  const gap = now - previous.timestamp;
  if (!Number.isFinite(gap) || gap < MIN_GAP_MS) return "";

  const nowLabel = new Date(now).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const prevLabel = new Date(previous.timestamp).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `\n[时间上下文，仅内部可见] 现在是 ${nowLabel}；上一轮对话在 ${prevLabel}（${formatGap(gap)}）。这是新的一天/新时段。除非他明确接着昨晚的事说，否则先自然接住时间差（问候、问今天安排、接当下），不要继续昨晚的话题，也不要把旧时间点当成现在反问。`;
}

/**
 * 把时间提示直接贴到最后一条 user message 前面（prompt-only，不落库）。
 * 放在 system 末尾容易被大 prompt 淹没；贴在当前输入旁更有效。
 */
export function applyTimeGapToMessages(
  messages: Array<{ role: string; content: string }>,
  session: ConversationSession,
  currentInput: string,
  now = Date.now(),
): void {
  const note = buildTimeGapNote(session, currentInput, now);
  if (!note) return;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      messages[i]!.content = `${note.trim()}\n\n${messages[i]!.content}`;
      return;
    }
  }
}
