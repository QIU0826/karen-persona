/**
 * 表情包 note 上下文（v0.9.32）。
 *
 * 收藏表情在 `sticker_library` 里有 AI 生成的 note/scene_tags，但此前没有进入聊天 prompt。
 * 这里把“她刚发/刚收到”的 note 做成仅内部可见的提示，让被问“这个表情什么意思”时能对上，
 * 而不是临场编一个“看着傻”。
 *
 * 约束：纯函数、无 IO；note 只用于 system prompt，不写 session、不发给用户。
 */

export type StickerDirection = "sent" | "received";

export interface StickerMemory {
  note: string;
  tags: string[];
  direction: StickerDirection;
  at: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_MEMORIES = 5;
const MAX_IN_HINT = 3;

function compact(text: string, max = 40): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 用户是否在问/指代一张表情包。 */
export function isStickerQuestion(userText: string): boolean {
  const t = String(userText ?? "").trim();
  if (!t) return false;
  if (/(表情包|表情|贴纸)/.test(t)) return true;
  return /(这个|那张|这张|图).{0,8}(什么意思|啥意思|含义|是什么|啥)/.test(t);
}

/**
 * 根据用户问句和最近表情记录生成内部提示；没有匹配时返回 null。
 * 只保留 30 分钟内的记录，最多展示最近 3 条。
 */
export function buildStickerContextHint(input: {
  userText: string;
  memories: StickerMemory[];
  now?: number;
}): string | null {
  if (!isStickerQuestion(input.userText)) return null;
  const now = input.now ?? Date.now();
  const fresh = (input.memories ?? [])
    .filter((m) => m && m.note && now - m.at >= 0 && now - m.at <= TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_IN_HINT);
  if (fresh.length === 0) return null;

  const lines = fresh.map((m) => {
    const tags = m.tags.map((t) => compact(t, 12)).filter(Boolean).join("/");
    const suffix = tags ? `（${tags}）` : "";
    return `${m.direction === "sent" ? "你最近发过" : "他最近发来"}的表情备注：${compact(m.note)}${suffix}`;
  });
  return `[表情包上下文，仅内部可见] ${lines.join("；")}。`;
}

/** 去重、截断并保留最近记录；bridge 进程内使用。 */
export function rememberStickerMemory(
  list: StickerMemory[],
  memory: StickerMemory,
  now = Date.now(),
): StickerMemory[] {
  const note = compact(memory.note);
  if (!note) return list;
  const next = [
    ...list.filter((m) => !(m.direction === memory.direction && m.note === note)),
    { ...memory, note, at: memory.at || now },
  ];
  return next.slice(-MAX_MEMORIES);
}
