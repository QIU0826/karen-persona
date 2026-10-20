/**
 * 「相识场景」编造守卫（确定性，不依赖模型听话）。
 *
 * 背景：15 轮真实验证里，用户从未说过线下见过面，她却编出了
 * 「你每周来三四次，坐吧台 / 有次下雨没带伞 / 我借你的 / 后来就熟了呗」。
 * prompt 里已有「记忆没有就别编」的规则，但模型仍会偶尔违反 —— 这一层做兜底：
 *
 * - 只在**用户这轮确实在问相识**、且**没有任何可靠依据**（人设的 howWeMet、
 *   用户事实、T2 记忆里都没有相关记录）时才启用；
 * - 启用时把「具体场景断言」的分句删掉；如果全被删光，就换成一句含糊的真人式回应；
 * - 有依据时完全不干预（正常回忆不受影响）。
 *
 * 纯函数、无 IO，便于单测。
 */

/** 用户在问「我们怎么认识的 / 第一次见面 / 认识多久」 */
const ASK_PATTERNS: readonly RegExp[] = [
  /(我们|咱俩|你和我|你跟我)[^。！？\n]{0,8}(怎么|咋|如何)[^。！？\n]{0,6}(认识|相识|碰见|遇到|熟起来|熟识)/,
  /(怎么|咋|如何)[^。！？\n]{0,6}(认识|相遇|碰见|遇到)的/,
  /第一次(见面|见你|见你的|认识)/,
  /(在哪|哪里|哪儿)(见|认识)的/,
  /(认识|见面|相处)多久/,
  /(还记得|想起来|想想)(我们|咱俩|你和我)?[^。！？\n]{0,6}(怎么|第一次|初识|相识|认识)/,
  /(我们|咱俩)[^。！？\n]{0,6}(初识|相识)/,
];

/** 可靠依据：人设里的相识背景，或事实/记忆里出现过相识场景的关键词 */
const GROUNDING_PATTERN =
  /(介绍|相亲|同学|同事|网友|网上认识|软件上认识|店里认识|店里见过|吧台认识|聚会|饭局|婚礼|生日会|培训班|公司认识|从小认识|发小|邻居)/;

/** 具体场景断言（被认定为「编造」的分句特征） */
const SCENE_CLAIM_PATTERN =
  /(吧台|柜台|收银台|门口|地铁口|公司楼下|下雨|雨天|淋雨|撑伞|借.{0,2}伞|伞|递给你|请你喝|点了[^。！？\n]{0,6}杯|每周|每天都来|天天来|老来|常来|老是来|老是坐|坐.{0,2}吧台|第一次见你|第一次来店里|那次你|那天你|后来就熟了)/;

/**
 * 具体场所名词：即使加了「好像/大概」这类模糊词，仍然是**断言了一个具体场景**。
 * v0.9（真机回归发现）：她说「好像是咖啡店吧 具体记不太清」——模糊词掩盖了编造，
 * 上一版词表只覆盖「吧台/店里」，漏了咖啡店/酒吧/书店这类场所名。
 */
const VENUE_CLAIM_PATTERN =
  /(咖啡店|咖啡馆|咖啡厅|奶茶店|酒吧|书店|餐厅|饭店|食堂|小馆|夜宵摊|大排档|便利店|超市|商场|电影院|剧院|健身房|图书馆|自习室|公园|操场|球场|体育馆|展览|展会|演唱会|音乐节|车站|机场|地铁站|写字楼|学校门口|校门口|宿舍楼下|公司附近|公司旁边)/;

/** 没有依据时的兜底回应（真人也会说「记不清了，你提醒我」） */
const MEETING_FALLBACKS: readonly string[] = [
  "嗯……这事儿我还真说不上来。你提醒我一下？",
  "说来话长……你先说说，你记得的是怎么认识的。",
  "记不清了。反正认识你之后，日子没那么无聊了。",
];

/** 用户这轮是否在问相识（空/非字符串安全返回 false）。 */
export function isAskingHowWeMet(text: string | null | undefined): boolean {
  const raw = typeof text === "string" ? text : "";
  const normalized = raw.replace(/\[CQ:[^\]]+\]/g, " ").trim();
  if (!normalized) return false;
  return ASK_PATTERNS.some((re) => re.test(normalized));
}

/**
 * 是否有可靠依据可以聊相识。
 *
 * 只认**用户侧证据**：用户明确写过/说过的相识背景（config.relationship_background）、
 * 抽取到的用户事实、检索到的 T2 记忆。
 * 人设包里自带的 howWeMet 不算——那是她的背景设定，不是「用户确认过的事实」，
 * 照着背会变成编造（15 轮验证就是这么翻车的）。
 */
export function hasMeetingGrounding(sources: {
  /** 用户自己提供/确认过的相识背景（config.relationship_background） */
  userBackground?: string | null;
  factsText?: string | null;
  memoryText?: string | null;
}): boolean {
  const user = (sources.userBackground ?? "").trim();
  if (user && !/^(你们认识|认识|你们|未知|不详)$/.test(user)) return true;
  const combined = `${sources.factsText ?? ""}\n${sources.memoryText ?? ""}`;
  return GROUNDING_PATTERN.test(combined);
}

export interface MeetingGuardResult {
  text: string;
  changed: boolean;
  /** 整条都被删空（调用方应改用兜底回应） */
  removedAll: boolean;
}

/**
 * 删掉「具体相识场景」的分句。
 * active=false（有依据 / 用户没问）时原样返回。
 */
export function stripFabricatedMeeting(
  text: string,
  active: boolean,
): MeetingGuardResult {
  const source = typeof text === "string" ? text : "";
  if (!active || !source.trim()) {
    return { text: source, changed: false, removedAll: false };
  }

  const keptLines: string[] = [];
  for (const line of source.split("\n")) {
    const clauses = line.split(/(?<=[，,。！？!?；;…])/);
    const kept = clauses.filter((clause) => !(SCENE_CLAIM_PATTERN.test(clause) || VENUE_CLAIM_PATTERN.test(clause)));
    const joined = kept
      .join("")
      .replace(/^[，,。！？!?；;…\s]+/, "")
      .replace(/[，,、；;…\s]+$/, "")
      .trim();
    if (joined) keptLines.push(joined);
  }

  const out = keptLines.join("\n").trim();
  return {
    text: out,
    changed: out !== source.trim(),
    removedAll: out.length === 0,
  };
}

/** 按用户输入稳定挑一句兜底（同一句话总得到同一句，避免反复追问时来回变）。 */
export function pickMeetingFallback(seed: string): string {
  let hash = 0;
  for (const ch of seed ?? "") {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return MEETING_FALLBACKS[hash % MEETING_FALLBACKS.length]!;
}
