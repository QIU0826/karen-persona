/**
 * 跨轮时间差提示（v0.9.32）。
 *
 * 真实巡检发现：23:49 用户说“准备睡觉”，第二天 09:11 她才回“这个点睡？”，
 * 把昨晚当成现在。最近消息历史里没有时间戳，模型只能看到内容，因此必须显式补时间差。
 */
import type { ConversationSession } from "../data/history.js";

const MIN_GAP_MS = 2 * 60 * 60 * 1000;

/** 日常收尾：这类上一轮不适合强行“昨晚你说…” */
const ROUTINE_END_RE = /^(准备睡|睡了|去睡|睡觉|先睡|晚安|好梦|拜拜|明天见|不聊了|先这样)/;
/** 值得跨天回扣的情绪/约定/重要事 */
const IMPORTANT_TOPIC_RE = /(吵架|生气|难过|委屈|对不起|道歉|答应|约好|明天|面试|考试|医院|工作|辞职|喜欢|想你|分手|冷战|担心|害怕|哭|重要|记得)/;
/** 用户当前话里可能在接旧话题 */
const CONTINUATION_RE = /(昨晚|昨天|上次|那个|后来|你说|刚说|然后呢|继续|还没)/;
/** 用户当前话像是在开启新一天 */
const NEW_DAY_RE = /^(早|早安|早上好|在吗|醒了|我醒了|起床|起了)/;

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
  const lastUser = [...session.messages]
    .reverse()
    .find((m) => m.role === "user" && m.content !== currentInput);
  const lastText = lastUser?.content ?? "";
  const routineEnd = ROUTINE_END_RE.test(lastText);
  const important = IMPORTANT_TOPIC_RE.test(lastText);
  const continuation = CONTINUATION_RE.test(currentInput);
  const newDay = NEW_DAY_RE.test(currentInput.trim());

  const cues: string[] = [];
  if (routineEnd) cues.push("上一轮最后一句是日常收尾（睡觉/晚安类），不适合强行回扣");
  if (important) cues.push("上一轮有情绪/约定/重要事，值得轻轻提一句");
  if (continuation) cues.push("他现在的话像是在接旧话题，先接他的话，必要时呼应昨晚");
  if (newDay) cues.push("他像是在开启新一天（打招呼/刚醒），可以自然问候今天");
  if (cues.length === 0) cues.push("他没有明显接旧话题，也没有明显开启新话题，按你此刻的感觉选一种");

  return `\n[时间上下文，仅内部可见] 现在是 ${nowLabel}；上一轮对话在 ${prevLabel}（${formatGap(gap)}）。这是新的一天/新时段。你可以自己选择：
- 如果上一段有未完成的情绪/约定/重要事，就轻轻提一句，再接今天；
- 如果只是睡觉/晚安/日常收尾，就直接开启新一天，不必硬提，最多轻描淡写一句；
- 如果他现在的消息明确在接旧话题，就先接他的话，必要时呼应昨晚。
判断线索：${cues.join("；")}。
不要机械地说“昨晚你说要睡”，也不要假装即时回复或把旧时间点当成现在反问。`;
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
