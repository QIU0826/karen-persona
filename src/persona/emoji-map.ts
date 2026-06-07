/**
 * QQ 内置表情 ID 映射表（P1-d）。
 * 按情绪分类，与 kaomoji 的情绪体系对齐。
 * 标准 QQ face ID 0-300+，仅收录常用且有明确情绪指向的。
 */

// ── 情绪分类 → QQ face IDs ──────────────────────

export const QQ_FACE_MAP: Record<string, number[]> = {
  /** 撒娇、害羞、不好意思 */
  coy: [109, 104, 111, 55, 79],
  /** 傲娇、不屑、嘴硬 */
  tsundere: [178, 175, 20, 101, 105],
  /** 怼人、无语、翻白眼 */
  sassy: [212, 123, 2, 107, 18],
  /** 开心、得意、偷笑 */
  happy: [176, 14, 74, 21, 27],
  /** 难过、委屈、要哭 */
  sad: [116, 5, 96, 106, 9],
  /** 敷衍、无所谓、随便 */
  dismissive: [178, 212, 123, 28, 182],
  /** 晚安、拜拜、困了 */
  sleepy: [74, 60, 76, 24, 3],
  /** 惊讶、震惊 */
  surprised: [0, 96, 10, 97, 15],
};

/** 将 kaomoji 风格映射到 QQ 表情分类 */
export function kaomojiStyleToQQ(style: string): string {
  switch (style) {
    case "动物系": return "coy";
    case "日系": return "happy";
    case "抽象系": return "sassy";
    default: return "happy";
  }
}

/** 从分类中随机选一个 face ID */
export function pickQQFace(category: string): number {
  const ids = QQ_FACE_MAP[category] ?? QQ_FACE_MAP["happy"];
  return ids[Math.floor(Math.random() * ids.length)];
}

/** 生成 CQ 码 */
export function toCqFace(id: number): string {
  return `[CQ:face,id=${id}]`;
}
