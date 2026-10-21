/**
 * 「自述提及频率」控制（v0.9.7）。
 *
 * 背景：v0.9.6 让她的每日生活流可用之后，真实长跑评审反馈
 * 「生活细节（老周、账本、擦杯子）出现得略密集，有背设定感」——
 * 素材变多 ≠ 每轮都该讲自己的事。真人聊天里，自己的日常是偶尔顺手提一句，
 * 不是每轮都播报。
 *
 * 做法（两层）：
 * 1. **检测**：回复里是否真的提了自己的生活（用当天生活流文本 + 人设实体做重叠判断）；
 * 2. **预算**：最近 6 轮里最多 2 轮自述；超了就注入一句「这轮别讲自己」的内部提示，
 *    并跳过 talk-moves 的 self-disclose 动作。
 *
 * 纯函数 + 可注入状态，便于单测；进程内计数（重启清零，和其它短期节奏一致）。
 */

/** 最近多少轮参与预算 */
export const MENTION_WINDOW_TURNS = 6;
/** 窗口内允许自述的轮数 */
export const MENTION_MAX_IN_WINDOW = 2;

/** 人设/生活流里的「专名」——用于判断回复是不是在说自己的事 */
const ENTITY_PATTERN = /(老周|阿杰|小雨|五花|拉花|瑜伽|咖啡店|吧台|拿铁|嘉兴|日本|团子)/g;

/**
 * 判断一条回复是否在讲她自己的生活。
 *
 * @param reply 她的回复全文
 * @param lifeTexts 当天生活流的句子（她可能改写，所以用字面重叠兜底）
 * @param extraKeywords 额外实体词（如人设里的朋友名/目标词）
 */
export function detectSelfMention(
  reply: string,
  lifeTexts: string[] = [],
  extraKeywords: string[] = [],
): boolean {
  const text = (reply ?? "").replace(/\s+/g, " ");
  if (!text) return false;

  // 1) 实体词命中（最可靠）
  const entities = new Set<string>();
  for (const word of extraKeywords) {
    if (word && word.length >= 2) entities.add(word);
  }
  for (const life of lifeTexts) {
    for (const word of life.match(/[\u4e00-\u9fff]{2,4}/g) ?? []) entities.add(word);
  }
  let entityHits = 0;
  for (const entity of entities) {
    if (text.includes(entity)) entityHits += 1;
  }
  // 匹配 ENTITY_PATTERN 的兜底（不依赖当天生活流是否取到）
  const patternHits = (text.match(ENTITY_PATTERN) ?? []).length;
  if (entityHits + patternHits >= 1) return true;

  // 2) 与当天生活流的字符 2-gram 重叠（模型会改写句子）
  for (const life of lifeTexts) {
    const clean = life.replace(/[^\u4e00-\u9fff]/g, "");
    if (clean.length < 6) continue;
    let overlap = 0;
    for (let i = 0; i + 2 <= clean.length; i += 1) {
      const gram = clean.slice(i, i + 2);
      if (text.includes(gram)) overlap += 1;
    }
    if (overlap >= 4) return true;
  }
  return false;
}

/** 最近几轮的自述标记（true=提了自己的事），新的在后 */
export type MentionHistory = boolean[];

/** 是否已超预算（超了就该这轮先不说自己） */
export function isOverMentionBudget(history: MentionHistory): boolean {
  const window = history.slice(-MENTION_WINDOW_TURNS);
  return window.filter(Boolean).length >= MENTION_MAX_IN_WINDOW;
}

/** 追加一轮记录并截断窗口（只保留最近窗口+1，避免无限增长） */
export function recordMention(history: MentionHistory, mentioned: boolean): MentionHistory {
  return [...history, mentioned].slice(-MENTION_WINDOW_TURNS);
}

/** 超预算时注入的内部提示；未超预算返回空串 */
export function buildMentionPacingNote(history: MentionHistory): string {
  if (!isOverMentionBudget(history)) return "";
  return (
    "\n[内部提示] 最近几轮你已经讲过自己的事了。**这一轮先别再主动提你自己/你的店/你的猫**，" +
    "专心接他的话、问一句具体的；自己的事偶尔提一句就够了，说多了像在背设定。"
  );
}

/** 评测/调试用：统计窗口内自述轮数 */
export function countMentions(history: MentionHistory): number {
  return history.filter(Boolean).length;
}
