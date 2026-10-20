/**
 * 「她主动了解你」（v0.5）。
 *
 * 为什么需要：真实会话实测发现事实层长期为空——**用户从不主动说自己的事**，
 * 他一直在问"她"（你是干什么的/发张照片）。真人对刚认识的人会主动问，
 * 所以她也要问：做什么工作、在哪个城市、养不养宠物、最近在忙什么。
 *
 * 设计：
 * - 只在「还不算熟」（亲密度 < 5）且该主题还没问过时触发；
 * - 每 4 轮对话最多问一次（别像查户口）；
 * - 只给模型一句"你可以顺口问一句 X"的提示，**不强制**，也不指定措辞；
 * - 问过的主题落库（getting_to_know 表），同一个问题不会问第二次。
 */

export type AskTopic = "name" | "city" | "job" | "pet" | "plan";

export interface AskTopicSpec {
  topic: AskTopic;
  /** 判断"是否已经知道"时检查这些 fact key */
  factKeys: string[];
  /** 给模型的一句话提示（不指定具体措辞） */
  hint: string;
}

export const ASK_TOPICS: AskTopicSpec[] = [
  { topic: "job", factKeys: ["job", "company", "work"], hint: "他平时做什么工作" },
  { topic: "city", factKeys: ["city", "location"], hint: "他在哪个城市" },
  { topic: "pet", factKeys: ["pet"], hint: "他有没有养宠物" },
  { topic: "name", factKeys: ["name", "nickname"], hint: "他叫什么（怎么称呼他）" },
  { topic: "plan", factKeys: ["plan"], hint: "他最近在忙什么/有什么计划" },
];

/** 亲密度门槛：再熟一点就不用"查户口"了 */
export const GET_TO_KNOW_MAX_CLOSENESS = 5;
/** 两次主动提问的最小轮次间隔 */
export const ASK_COOLDOWN_TURNS = 4;

export interface PickAskInput {
  /** 已记住的事实 key（小写） */
  knownFactKeys: string[];
  /** 已经问过的主题 */
  askedTopics: string[];
  closeness: number;
  /** 这一轮是第几轮对话（用来做冷却） */
  turnIndex: number;
  /** 上次提问发生在第几轮（没有则 null） */
  lastAskedTurn: number | null;
}

export interface PickAskResult {
  topic: AskTopic;
  hint: string;
}

/**
 * 决定这一轮要不要"顺口问一个还不了解的问题"。
 * 返回 null 表示这轮不主动问（大多数轮次都是 null）。
 */
export function pickGetToKnowAsk(input: PickAskInput): PickAskResult | null {
  if (input.closeness >= GET_TO_KNOW_MAX_CLOSENESS) return null;
  if (input.lastAskedTurn !== null && input.turnIndex - input.lastAskedTurn < ASK_COOLDOWN_TURNS) {
    return null;
  }
  const known = new Set(input.knownFactKeys.map((k) => k.toLowerCase()));
  const asked = new Set(input.askedTopics);
  for (const spec of ASK_TOPICS) {
    if (asked.has(spec.topic)) continue;
    if (spec.factKeys.some((key) => known.has(key))) continue;
    return { topic: spec.topic, hint: spec.hint };
  }
  return null;
}

/**
 * 注入 prompt 的提示句。
 * 刻意写得"可选项"而不是硬指令——她可以这轮不问，也可以在合适的地方问。
 */
export function buildGetToKnowNote(result: PickAskResult): string {
  return `\n## 你还不太了解他\n- 如果聊到合适的地方，可以顺口问一句：${result.hint}（别像查户口，一次只问一件，也不用每轮都问）\n`;
}
