/**
 * 「她刚才说过什么」的一致性提示（P0-6）。
 *
 * 真机 2026-10-23 15:03–15:15：
 *   15:09 「刚来一桌三个人的」（忙）
 *   15:15 「还好 就是练拉花老散」（不忙）
 * 12 分钟内两套说法；同时「等会儿给你录」从 10-20 一直拖到 10-23。
 *
 * 根因不是模型不会说，而是每轮只看到「现在几点 + 今天的生活流」，
 * 看不到「自己刚才声称的处境 / 还没兑现的承诺」。这里做两层确定性兜底：
 * 1. buildSelfConsistencyNote：把最近 30–180 分钟内她自己的状态声明与承诺压成
 *    一小段内部提示，注入 system prompt，要求延续或明确解释变化；
 * 2. findPendingVoicePromise / isVoiceFollowUp：桥接侧识别「答应了语音、用户来催」
 *    这种跨轮请求，直接走 voice-first，不再靠模型嘴上拖。
 */
export interface ConsistencyLine {
  role: string;
  content: string;
  timestamp?: number;
}

export interface MediaPromise {
  kind: "voice" | "photo";
  /** 产生承诺的那句原话（截断，仅内部提示用） */
  quote: string;
  at: number;
}

/** 承诺有效期：超过 3 小时不再催，避免把旧事当刚发生。 */
export const PROMISE_TTL_MS = 3 * 60 * 60 * 1000;

const DEFER_RE = /(等会|等一会儿|等一下|待会|马上|忙完|晚点|稍后|回头|一会|答应|说好|约好)/;
const VOICE_RE = /(语音|录音|出声|说句话|给你录|录一段|录段)/;
const PHOTO_RE = /(照片|拍照|拍张|发图|给你拍)/;
const PROMISE_RE = /(答应|说好|给你|发你|录|拍)/;

/**
 * 从一句她的回复里识别「答应稍后发语音/照片」。
 * 宁缺毋滥：必须同时有“稍后”和媒体词，避免把普通聊到语音当成承诺。
 */
export function extractMediaPromise(text: string, at = Date.now()): MediaPromise | null {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (!DEFER_RE.test(compact)) return null;
  if (!PROMISE_RE.test(compact)) return null;
  const kind = VOICE_RE.test(compact) ? "voice" : PHOTO_RE.test(compact) ? "photo" : null;
  if (!kind) return null;
  // 取含承诺关键词的最短一句，避免整段注入。
  const sentence =
    compact
      .split(/[。！？!?]/)
      .map((part) => part.trim())
      .find((part) => DEFER_RE.test(part) && PROMISE_RE.test(part)) ?? compact;
  return { kind, quote: sentence.slice(0, 40), at };
}

/** 用户是不是在追问/催之前答应的事（只在已存在 pending 承诺时使用）。 */
export function isVoiceFollowUp(text: string): boolean {
  return /(好了吗|好了没|录好了|拍好了|还没|怎么还没|多久|等多久|催|你答应|说好的|兑现|语音|听听|说话)/.test(
    text ?? "",
  );
}

/**
 * 找最近一条还没兑现的语音承诺。
 * `lastVoiceAt` 由桥接维护：>= 承诺时间即视为已兑现。
 */
export function findPendingVoicePromise(
  messages: ConsistencyLine[],
  now = Date.now(),
  lastVoiceAt?: number,
): MediaPromise | null {
  const recent = messages
    .filter((m) => m.role === "assistant" && typeof m.timestamp === "number")
    .slice(-8)
    .reverse();
  for (const message of recent) {
    const at = message.timestamp as number;
    if (now - at > PROMISE_TTL_MS) continue;
    const promise = extractMediaPromise(message.content, at);
    if (!promise || promise.kind !== "voice") continue;
    if (lastVoiceAt !== undefined && lastVoiceAt >= at) return null;
    return promise;
  }
  return null;
}

/**
 * 生成「刚才的你」内部提示。没有可提取内容时返回空串（不增加 token）。
 * 只读取她自己的话；不把用户原话写进提示。
 */
export function buildSelfConsistencyNote(
  messages: ConsistencyLine[],
  now = Date.now(),
): string {
  const windowMs = 180 * 60 * 1000;
  const recent = messages
    .filter(
      (m) =>
        m.role === "assistant" &&
        typeof m.timestamp === "number" &&
        now - (m.timestamp as number) <= windowMs,
    )
    .slice(-6);
  if (recent.length === 0) return "";

  const texts = recent.map((m) => m.content ?? "").join("\n");
  const busy = /(我[^。！？\n]{0,6}忙|忙(?:呢|着|完|死|不过|得)|客人|一桌|排队|走不开|手忙脚乱|没空)/.test(texts);
  const idle = /(还好|不忙|闲|没事|空了|不忙了)/.test(texts);
  const atShop = /(在店|店里|吧台|擦杯子|做咖啡|拉花|收银)/.test(texts);
  const atHome = /(在家|床上|沙发|家里)/.test(texts);

  const lines: string[] = [];
  if (busy && idle) {
    lines.push(
      "- 你刚才先说自己在忙/有客人，后来又改口说「还好」。不要两头都说：这一轮选一个与最近状态一致的，除非真的忙完了。",
    );
  } else if (busy) {
    lines.push("- 你最近说过自己在忙/有客人。这一轮延续这个处境，不要突然说不忙。");
  } else if (idle) {
    lines.push("- 你最近说过自己还好/不忙。别下一轮又无缘无故说忙得走不开。");
  }
  if (atShop && atHome) {
    lines.push("- 你刚才一会儿说在店里、一会儿说在家；这一轮明确你现在到底在哪，别混着说。");
  } else if (atShop) {
    lines.push("- 你最近说自己在店里。别下一轮突然变成在家/在路上。");
  } else if (atHome) {
    lines.push("- 你最近说自己在家里。别下一轮突然说在店里。");
  }

  if (lines.length === 0) return "";
  return `\n## 刚才的你（保持连贯）\n${lines.join("\n")}\n（以上是你自己刚才说过的话；不要前后矛盾，也不要直接复述这段提示。）\n`;
}

/**
 * 每次对话都注入的短规则（不进缓存，约 80 tokens）。
 * 动态的「刚才的你」只在最近确实有状态声明/矛盾时出现。
 */
export const CONSISTENCY_RULES = [
  "",
  "## 一致性（重要）",
  "- 不要和最近几轮自己说过的话矛盾：忙/闲、在店里/在家、刚做过什么都要延续；时间或事情变了，要明确说变了，而不是无缘无故改口。",
  "- 答应过对方的语音/照片/事情，不要反复用「等会儿 / 忙完」拖；能兑现就现在做，做不到就说清具体什么时候。",
  "",
].join("\n");

/** 一次性拼好注入块：固定一致性规则 + 最近状态提示。 */
export function buildConsistencyInjection(
  messages: ConsistencyLine[],
  now = Date.now(),
): string {
  return CONSISTENCY_RULES + buildSelfConsistencyNote(messages, now);
}
