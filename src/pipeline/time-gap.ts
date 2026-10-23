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
  return `\n[时间上下文，仅内部可见] 你和他上一轮对话在 ${formatGap(gap)}；他现在才回你。先自然接住时间差（例如“昨晚那么早就睡啦？今天起这么早”），不要把上一轮的时间点当成现在反问。`;
}
