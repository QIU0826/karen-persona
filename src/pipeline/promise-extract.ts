/**
 * 承诺/待办抽取（P1-1）：从最近对话里找出「答应了但还没做」的事和「他的重要日程」。
 *
 * 纯函数、不碰 DB；确定性正则优先，宁缺毋滥。不抽泛泛的“等会儿聊”，
 * 必须同时有承诺/时间语义 + 具体交付物（语音/照片/见面/吃/看…）或明确的生活事件。
 */
export type PromiseKind = "voice" | "photo" | "event" | "other";

export interface PromiseExtractMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export interface PromiseCandidate {
  kind: PromiseKind;
  content: string;
  dueAt?: number;
  sourceRole: "assistant" | "user";
}

const PROMISE_RE =
  /(答应|说好|约好|等会|等一会儿|等一下|待会|马上|忙完|晚点|回头|改天|明天|后天|周末|下周|下次)/;
const DELIVER_RE =
  /(给你|带你|发你|给你录|给你拍|拍张|照片|自拍|语音|看看|见|去|吃|聊|回你|找你|买|请|录)/;
const NEG_RE = /(不答应|没答应|不想|别|不用|没法|不能|算了|再说吧)/;
const EVENT_RE = /(面试|考试|去医院|做手术|出差|搬家|过生日|生日|开会|见客户|签合同|体检|答辩|复试)/;
/** 用户在问/质疑「你怎么知道」，不是他的日程；这类句子不能当 event。 */
const EVENT_QUESTION_RE = /(怎么知道|你.{0,4}知道|知道我有|听谁|谁说的|是不是|有没有|吗[？?]?|？|\?)/;
const EVENT_TRIGGER_RE = /(我|明天|后天|周末|下周)/;

const MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_SENTENCE_CHARS = 60;
const MAX_CANDIDATES = 6;

function localAt(baseMs: number, dayOffset: number, hour = 20): number {
  const date = new Date(baseMs);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/** 从一句话推断大致到期时间；「改天/下次」这种没有具体时间的返回 undefined。 */
export function inferDueAt(sentence: string, baseMs: number): number | undefined {
  if (/(等会|等一会儿|等一下|待会|马上|一会儿)/.test(sentence)) {
    return baseMs + 30 * 60 * 1000;
  }
  if (/后天/.test(sentence)) return localAt(baseMs, 2);
  if (/明天/.test(sentence)) return localAt(baseMs, 1);
  if (/周末/.test(sentence)) {
    const day = new Date(baseMs).getDay();
    const delta = (6 - day + 7) % 7 || 7;
    return localAt(baseMs, delta);
  }
  return undefined;
}

function splitSentences(text: string): string[] {
  return (text ?? "")
    .split(/[。！？!?\n；;]/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 4 && part.length <= MAX_SENTENCE_CHARS);
}

function inferKind(text: string): PromiseKind {
  if (/(语音|录音|说句话|出声|录一段|给你录|录给|录个|录条)/.test(text)) return "voice";
  if (/(照片|拍照|拍张|自拍|图)/.test(text)) return "photo";
  return "other";
}

/**
 * 从最近消息里抽取承诺/日程候选。扫描 48 小时内、最多 20 条消息，
 * 相同的 kind+content 只保留一条。
 */
export function extractPromises(
  messages: PromiseExtractMessage[],
  now = Date.now(),
): PromiseCandidate[] {
  const seen = new Set<string>();
  const out: PromiseCandidate[] = [];
  const recent = messages
    .filter((m) => typeof m.timestamp === "number" && now - (m.timestamp as number) <= MAX_LOOKBACK_MS)
    .slice(-20);

  for (const message of recent) {
    const base = message.timestamp ?? now;
    for (const sentence of splitSentences(message.content ?? "")) {
      if (NEG_RE.test(sentence)) continue;
      if (message.role === "assistant") {
        if (!PROMISE_RE.test(sentence) || !DELIVER_RE.test(sentence)) continue;
        const kind = inferKind(sentence);
        const key = `${kind}|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, content: sentence, dueAt: inferDueAt(sentence, base), sourceRole: "assistant" });
      } else if (message.role === "user") {
        // 问句/质疑句不是日程：「你怎么知道我有开会」这类不能记成他的事。
        if (EVENT_QUESTION_RE.test(sentence)) continue;
        if (!EVENT_TRIGGER_RE.test(sentence) || !EVENT_RE.test(sentence)) continue;
        const key = `event|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: "event",
          content: sentence,
          dueAt: inferDueAt(sentence, base),
          sourceRole: "user",
        });
      }
    }
  }

  return out
    .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MAX_CANDIDATES);
}
