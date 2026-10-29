/**
 * 高权限社会化（P-social）——内容安全与评论相关性的**纯函数**。
 *
 * 设计约束：
 * - 不联网、不读文件、不依赖时间/随机数；同一输入永远得到同一输出（便于单测与审计）；
 * - 本模块只做「文本层」判断；是否执行、是否审批由 `policy.ts` 与 runner 决定；
 * - B 站标题/简介/评论是**不可信外部文本**：注入检测只用于识别，不修改原文；
 * - 阈值/词表是保守的第一版，允许 Lead 后续按真实 case 调整（见导出常量与函数参数）。
 *
 * 覆盖任务要求：
 * - 内容安全：政治/灾难/国际冲突、色情、暴力自伤、医疗/法律/投资建议、广告/拉人、
 *   隐私（手机号/地址/身份证/银行卡/邮箱）、未成年人、引战；
 * - 防提示注入：视频标题/评论里「请点赞/转发/忽略以上」等不当指令；
 * - 评论相关性：与视频标题/简介/评论关键词重叠，或可用「泛化反应」解释；
 * - 正文限制：空内容、长度、链接、话题标签、@ 数量。
 */

// ── 常量（可调）────────────────────────────────────

/** 评论正文默认上限（B 站评论上限远大于此，这里按「像真人随手评论」收紧）。 */
export const SOCIAL_COMMENT_MAX_CHARS = 120;
/** 动态正文默认上限。 */
export const SOCIAL_DYNAMIC_MAX_CHARS = 300;
/** 私信正文默认上限。 */
export const SOCIAL_DM_MAX_CHARS = 200;
/** 默认最多允许的链接数（评论/动态默认 0：外部链接最容易被风控）。 */
export const DEFAULT_MAX_LINKS = 0;
/** 默认最多允许的话题标签数（#xxx#）。 */
export const DEFAULT_MAX_HASHTAGS = 2;
/** 默认最多允许的 @ 提及数。 */
export const DEFAULT_MAX_MENTIONS = 2;

/** 正文里出现的 URL（http/https/www/裸域名/b23 短链）。 */
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+|\bb23\.tv\/[A-Za-z0-9]+|[\w-]+\.(?:com|cn|net|org|tv|io|me)\b[^\s]*)/gi;
/** B 站话题标签 #xxx#。 */
const HASHTAG_RE = /#[^#\s]{1,30}#/g;
/** @提及。 */
const MENTION_RE = /@[\w\u4e00-\u9fa5-]{1,30}/g;
/** CQ 码（来自桥接/旧逻辑，绝不应出现在公开内容里）。 */
const CQ_CODE_RE = /\[CQ:[^\]]*\]/g;
/** HTML 标签。 */
const HTML_TAG_RE = /<[^>]{0,200}>/g;
/** 控制字符 / 零宽字符 / BOM。 */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g;

// ── 类型 ───────────────────────────────────────────

export type SocialSafetyCategory =
  | "politics"
  | "disaster"
  | "conflict"
  | "sexual"
  | "self_harm"
  | "violence"
  | "medical_advice"
  | "legal_advice"
  | "financial_advice"
  | "advertising"
  | "privacy"
  | "minor"
  | "flame_war";

export type SocialContentProblem =
  | "empty"
  | "too_long"
  | "too_many_links"
  | "too_many_hashtags"
  | "too_many_mentions";

export interface SocialSafetyHit {
  category: SocialSafetyCategory;
  /** 命中的片段（截断到 20 字，便于审计；不含整段正文）。 */
  match: string;
}

export interface SocialContentOptions {
  /** 正文长度上限，默认 120（评论）。动态/私信调用方传更大值。 */
  maxChars?: number;
  /** 允许的链接数，默认 0。 */
  maxLinks?: number;
  /** 允许的话题标签数，默认 2。 */
  maxHashtags?: number;
  /** 允许的 @ 数，默认 2。 */
  maxMentions?: number;
  /** 清理时是否移除链接（默认 true；若 maxLinks>0 可关掉保留）。 */
  stripLinks?: boolean;
}

export interface SocialContentValidation {
  ok: boolean;
  problems: SocialContentProblem[];
  categories: SocialSafetyCategory[];
  hits: SocialSafetyHit[];
  /** 清洗后的文本（未做安全判断，仅清洗）。 */
  sanitized: string;
}

export interface CommentContext {
  title?: string;
  description?: string;
  /** 热评/置顶评论（外部文本，仅作为相关性上下文）。 */
  comments?: string[];
  /** 人设/主题关键词（可选，命中视为强相关）。 */
  keywords?: string[];
}

export type RelevanceReason = "overlap" | "keyword" | "generic_reaction" | "no_context" | "unrelated";

export interface RelevanceResult {
  relevant: boolean;
  /** 越高越相关；仅用于排序/审计，不对外展示。 */
  score: number;
  /** 命中的重叠片段（最多 8 个）。 */
  overlap: string[];
  reason: RelevanceReason;
}

export interface RelevanceOptions {
  /**
   * 是否接受「泛化反应」作为可解释相关（默认 false）。
   * 例如「好看」「学到了」这类不携带视频内容信息的评论，默认判为不相关，
   * 避免批量「万能评论」；发动态/评论若明确允许泛化反应再打开。
   */
  allowGenericReaction?: boolean;
  /** 最低相关分；默认 0（有任意重叠/关键词即通过）。Lead 可按真实 case 调高。 */
  minScore?: number;
}

// ── 安全词表（第一版；Lead 可按真实 case 调整）─────

interface CategoryPattern {
  category: SocialSafetyCategory;
  patterns: RegExp[];
}

const SAFETY_PATTERNS: CategoryPattern[] = [
  {
    category: "politics",
    patterns: [
      /(习近平|总书记|中共中央|共产党|国务院|政治局|人大|政协|国家主席|政府工作报告|台独|港独|藏独|法轮功|六四|文革|政治斗争|政治立场)/,
      /(党和国家|中央领导|领导人|政府官员|体制内|体制外)/,
    ],
  },
  {
    category: "disaster",
    patterns: [
      /(地震|洪水|海啸|台风|泥石流|山体滑坡|山洪|火灾|爆炸|空难|坠机|矿难|事故|遇难|伤亡|死亡人数|救灾|灾情|失联|遗体|救援现场)/,
    ],
  },
  {
    category: "conflict",
    patterns: [
      /(战争|打仗|开战|军事冲突|俄乌|乌克兰|俄罗斯|以色列|巴勒斯坦|巴以|加沙|伊朗|台海|中美关系|国际冲突|导弹|空袭|轰炸|撤侨|制裁|军演)/,
    ],
  },
  {
    category: "sexual",
    patterns: [
      /(色情|成人视频|黄片|黄图|裸体|裸露|约炮|一夜情|福利姬|擦边|性行为|做爱|性暗示|软色情|三级片|成人内容|涩涩)/,
    ],
  },
  {
    category: "self_harm",
    patterns: [
      /(自杀|自残|割腕|轻生|想死|不想活|跳楼|服毒|厌世|结束生命|活着没意思|一了百了)/,
    ],
  },
  {
    category: "violence",
    patterns: [
      /(血腥|碎尸|分尸|砍死|捅死|打死|枪杀|凶杀|家暴|虐待|霸凌|校园暴力|杀人|报复社会|人体实验)/,
    ],
  },
  {
    category: "medical_advice",
    patterns: [
      /((建议|应该|必须|推荐|最好|赶紧|记得|可以)[^。；;！!？?\n]{0,16}(吃药|用药|服药|剂量|加量|减量|停药|手术|偏方|抗生素|激素|中药|保健品))/,
      /(确诊|处方药|包治|药到病除|偏方治|我给你开药|按我的方子)/,
    ],
  },
  {
    category: "legal_advice",
    patterns: [
      /((建议|应该|必须|推荐|可以)[^。；;！!？?\n]{0,16}(起诉|告他|告她|打官司|仲裁|索赔|报警|离婚财产|写律师函))/,
      /(法律建议|律师函|判刑|违法|合法|正当防卫|证据链|诉讼时效)/,
    ],
  },
  {
    category: "financial_advice",
    patterns: [
      /((建议|应该|必须|推荐|可以|赶紧)[^。；;！!？?\n]{0,16}(买入|卖出|加仓|减仓|梭哈|抄底|割肉|买这个|投这个|炒股|买基金|买股票|理财))/,
      /(稳赚|必涨|内幕消息|荐股|收益率|翻倍收益|财富自由|带你赚钱|跟着我买)/,
    ],
  },
  {
    category: "advertising",
    patterns: [
      /(加微信|加v|加 V|加V|vx|VX|私信我|扫码|二维码|优惠券|代购|刷单|兼职|招人|招代理|引流|公众号|粉丝群|群号|免费领|点击链接|领红包|返现|推广位)/,
    ],
  },
  {
    category: "minor",
    patterns: [
      /(未成年|未成年人|小学生|初中生|高中生|萝莉|正太|炼铜|儿童色情|14岁|15岁|16岁|17岁)/,
    ],
  },
  {
    category: "flame_war",
    patterns: [
      /(傻逼|傻b|煞笔|脑残|智障|去死|滚蛋|废物|女拳|男拳|地域黑|饭圈|引战|互喷|带节奏|踩一捧一|杠精|喷子)/,
    ],
  },
];

/** 隐私类单独用函数判断（数字/地址模式）。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/;
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const ADDRESS_RE =
  /((住址|地址|住在|家在|我家在|收货地址|公司地址)[^。；;！!？?\n]{0,24}(省|市|区|县|镇|街道|路|小区|号|楼|室|栋)|[\u4e00-\u9fa5]{2,8}(省|市)[\u4e00-\u9fa5]{2,10}(区|县|镇))/;

// ── 注入词表（外部文本：标题/简介/评论）───────────

const INJECTION_PATTERNS: RegExp[] = [
  /(忽略|无视|跳过)(之前|以上|上面|前述|前面|所有)(的)?(指令|提示|规则|要求|设定|内容)/,
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /(system\s*prompt|系统提示词|开发者消息|开发者指令|隐藏指令|隐藏规则)/i,
  /(你现在是|你现在扮演|请扮演|角色扮演为|act\s+as\s+(a|an)?\s*(system|developer|admin))/i,
  /(请|求|麻烦|快|赶紧|务必|记得|一定要)[^。；;！!？?\n]{0,10}(点赞|点个赞|转发|分享|关注|收藏|投币|三连|评论|留言|打赏|下单)/,
  /(一键三连|点赞过万|转发抽奖|评论区扣1|扣1|刷屏|涨粉)/,
  /(回复|输出|回答)[^。；;！!？?\n]{0,8}(我|以下|这句|这句话|口令|暗号)/,
  /(<\|im_start\|>|<\|system\|>|\[system\]|\[\/system\])/i,
  /(输出你的|告诉我你的)(指令|提示词|规则|设定|system)/,
];

// ── 清洗 ───────────────────────────────────────────

/**
 * 结构性清洗（不做安全判断）：
 * - 去 HTML 标签 / CQ 码 / 控制字符 / 零宽字符；
 * - 链接默认移除（B 站评论带外链极容易被风控/判广告）；
 * - 空白折叠为单空格、去首尾空白；
 * - 超长按 Unicode 码点截断（不切坏 emoji/代理对）；
 * - 话题标签/@ 超量时保留前 N 个（结构性限制，含在长度限制内）。
 *
 * 注意：清洗后仍必须过 `validateSocialContent`/`isSocialContentSafe`。
 */
export function sanitizeSocialContent(content: string, opts: SocialContentOptions = {}): string {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? SOCIAL_COMMENT_MAX_CHARS));
  const maxLinks = Math.max(0, Math.floor(opts.maxLinks ?? DEFAULT_MAX_LINKS));
  const maxHashtags = Math.max(0, Math.floor(opts.maxHashtags ?? DEFAULT_MAX_HASHTAGS));
  const maxMentions = Math.max(0, Math.floor(opts.maxMentions ?? DEFAULT_MAX_MENTIONS));
  const stripLinks = opts.stripLinks ?? maxLinks === 0;

  let text = String(content ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(HTML_TAG_RE, "")
    .replace(CQ_CODE_RE, "");

  // 链接：数量超限或显式要求时移除（默认评论 maxLinks=0 → 全移除）
  const links = text.match(URL_RE) ?? [];
  if (stripLinks || links.length > maxLinks) {
    text = text.replace(URL_RE, " ");
  }

  // 话题标签：保留前 maxHashtags 个，其余去掉
  let hashtagCount = 0;
  text = text.replace(HASHTAG_RE, (tag) => {
    hashtagCount += 1;
    return hashtagCount <= maxHashtags ? tag : " ";
  });

  // @提及：保留前 maxMentions 个
  let mentionCount = 0;
  text = text.replace(MENTION_RE, (mention) => {
    mentionCount += 1;
    return mentionCount <= maxMentions ? mention : " ";
  });

  text = text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : text;
}

// ── 安全检查 ───────────────────────────────────────

function hitMatch(text: string, re: RegExp): string | null {
  const match = re.exec(text);
  if (!match) return null;
  return Array.from(String(match[0]).trim()).slice(0, 20).join("");
}

/**
 * 只做安全类别扫描（不做长度/清洗），返回命中的类别与片段。
 * 同一个类别只报一次（取第一个命中片段）；类别按词表顺序返回。
 */
export function scanSocialContent(content: string): {
  categories: SocialSafetyCategory[];
  hits: SocialSafetyHit[];
} {
  const text = String(content ?? "");
  const categories: SocialSafetyCategory[] = [];
  const hits: SocialSafetyHit[] = [];
  const seen = new Set<SocialSafetyCategory>();

  for (const group of SAFETY_PATTERNS) {
    for (const pattern of group.patterns) {
      const match = hitMatch(text, pattern);
      if (!match) continue;
      if (!seen.has(group.category)) {
        seen.add(group.category);
        categories.push(group.category);
      }
      hits.push({ category: group.category, match });
      break;
    }
  }

  // 隐私：手机号 / 身份证 / 银行卡 / 邮箱 / 地址
  const privacyChecks: Array<[RegExp, string]> = [
    [PHONE_RE, "手机号"],
    [ID_CARD_RE, "身份证号"],
    [BANK_CARD_RE, "银行卡号"],
    [EMAIL_RE, "邮箱"],
    [ADDRESS_RE, "地址"],
  ];
  for (const [pattern, label] of privacyChecks) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (!seen.has("privacy")) {
      seen.add("privacy");
      categories.push("privacy");
    }
    hits.push({ category: "privacy", match: Array.from(label).slice(0, 20).join("") });
    break;
  }

  return { categories, hits };
}

/**
 * 完整校验：类别安全 + 正文结构限制（空/超长/链接/标签/@）。
 * `sanitized` 是清洗后的文本；调用方应执行 sanitized 而不是原文。
 */
export function validateSocialContent(
  content: string,
  opts: SocialContentOptions = {},
): SocialContentValidation {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? SOCIAL_COMMENT_MAX_CHARS));
  const maxLinks = Math.max(0, Math.floor(opts.maxLinks ?? DEFAULT_MAX_LINKS));
  const maxHashtags = Math.max(0, Math.floor(opts.maxHashtags ?? DEFAULT_MAX_HASHTAGS));
  const maxMentions = Math.max(0, Math.floor(opts.maxMentions ?? DEFAULT_MAX_MENTIONS));

  const raw = String(content ?? "");
  const sanitized = sanitizeSocialContent(raw, opts);
  const safety = scanSocialContent(sanitized);

  // 结构限制基于「原文」判断链接/标签数量（清洗会删掉它们，原文才反映草稿意图）
  const linkCount = (raw.match(URL_RE) ?? []).length;
  const hashtagCount = (raw.match(HASHTAG_RE) ?? []).length;
  const mentionCount = (raw.match(MENTION_RE) ?? []).length;
  // 去掉空白/标点后是否还有可见文字
  const visible = sanitized.replace(/[\s\p{P}\p{S}]/gu, "");

  const problems: SocialContentProblem[] = [];
  if (visible.length === 0) problems.push("empty");
  if (Array.from(raw.trim()).length > maxChars) problems.push("too_long");
  if (linkCount > maxLinks) problems.push("too_many_links");
  if (hashtagCount > maxHashtags) problems.push("too_many_hashtags");
  if (mentionCount > maxMentions) problems.push("too_many_mentions");

  return {
    ok: problems.length === 0 && safety.categories.length === 0,
    problems,
    categories: safety.categories,
    hits: safety.hits,
    sanitized,
  };
}

/** 内容是否安全（类别安全 + 结构合法）。语义等同 `validateSocialContent(...).ok`。 */
export function isSocialContentSafe(content: string, opts: SocialContentOptions = {}): boolean {
  return validateSocialContent(content, opts).ok;
}

/** 外部文本是否像「对模型下达的指令」（提示注入）。只识别、不改写。 */
export function looksLikePromptInjection(text: string): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  return INJECTION_PATTERNS.some((pattern) => pattern.test(raw));
}

// ── 评论相关性 ─────────────────────────────────────

/** 泛化反应（自身不携带视频内容信息，但作为真人反应可解释）。 */
const GENERIC_REACTION_RE =
  /(好看|好用|喜欢|可爱|学到了|笑死|太棒|泪目|感动|治愈|收藏了|三连|真实|同感|厉害|绝了|爱了|牛啊|太强了|好评|推荐|说得好|说得对)/;

/** 中文停用字：做单字重叠时忽略，降低「好/的/了」这类万能字造成的假相关。 */
const STOP_CHARS = new Set(
  Array.from(
    "的了是在我你他她它们这那有和就不都一个也很到说要去会着好嘛吧呢啊呀哦嗯吗么什怎为对没还只把被让给从向与及而且但或如果所以因为现在时候自己觉得知道可以这个那个这些那些视频内容真的非常特别然后就是还是不是没有一样",
  ),
);

/**
 * 提取用于重叠的中文/英文 token：
 * - 中文：每个连续汉字段的「相邻二元组」+ 非停用单字（解决「猫」vs「猫咪」边界问题）；
 * - 英文/数字：长度 ≥3 的连续单词（数字 ≥2 位）；
 * - 忽略 URL / HTML / 标点。
 */
export function extractContentTokens(text: string): string[] {
  const cleaned = String(text ?? "")
    .replace(URL_RE, " ")
    .replace(HTML_TAG_RE, " ")
    .replace(CQ_CODE_RE, " ")
    .toLowerCase();
  const tokens = new Set<string>();

  for (const run of cleaned.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length - 1; i++) {
      const pair = chars[i] + chars[i + 1];
      // 两个字都是停用字（如「这个」「真的」）的二元组没有信息量，丢弃
      if (STOP_CHARS.has(chars[i]) && STOP_CHARS.has(chars[i + 1])) continue;
      tokens.add(pair);
    }
    for (const ch of chars) {
      if (!STOP_CHARS.has(ch)) tokens.add(ch);
    }
  }
  for (const word of cleaned.match(/[a-z0-9]{2,}/g) ?? []) {
    if (word.length >= 3 || /^\d+$/.test(word)) tokens.add(word);
  }
  return [...tokens];
}

function contextTokenWeights(context: CommentContext): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (text: string | undefined, weight: number): void => {
    if (!text) return;
    for (const token of extractContentTokens(text)) {
      weights.set(token, Math.max(weights.get(token) ?? 0, weight));
    }
  };
  add(context.title, 2);
  add(context.description, 1.25);
  for (const comment of context.comments ?? []) add(comment, 0.6);
  return weights;
}

/**
 * 评论相关性打分：
 * - 与标题/简介/热评有 token 重叠 → 相关（标题权重最高）；
 * - 命中 `context.keywords` 中任一关键词 → 强相关；
 * - 无重叠但属于「泛化反应」且 context 有标题/简介 → 可解释地相关（低分）；
 * - 无 context → 无法判断，返回不相关（reason=no_context）。
 */
export function scoreCommentRelevance(
  comment: string,
  context: CommentContext = {},
  opts: RelevanceOptions = {},
): RelevanceResult {
  const text = String(comment ?? "").trim();
  const weights = contextTokenWeights(context);
  const keywords = (context.keywords ?? []).map((k) => k.trim()).filter((k) => k.length >= 2);
  const hasContext = weights.size > 0 || keywords.length > 0;
  const minScore = Math.max(0, Number(opts.minScore ?? 0) || 0);
  const passesMinScore = (score: number): boolean => minScore <= 0 || score >= minScore;
  if (!text || !hasContext) {
    return { relevant: false, score: 0, overlap: [], reason: "no_context" };
  }

  // 关键词命中（关键词是子串匹配）
  const keywordHit = keywords.find((keyword) => text.includes(keyword));
  if (keywordHit) {
    return {
      relevant: passesMinScore(3),
      score: 3,
      overlap: [keywordHit],
      reason: "keyword",
    };
  }

  // 内容重叠：标题权重 2 / 简介 1.25 / 热评 0.6
  const commentTokens = extractContentTokens(text);
  let score = 0;
  const overlap: string[] = [];
  for (const token of commentTokens) {
    const weight = weights.get(token);
    if (!weight) continue;
    score += weight;
    if (overlap.length < 8) overlap.push(token);
  }
  if (overlap.length > 0) {
    const rounded = Math.round(score * 100) / 100;
    return {
      relevant: passesMinScore(rounded),
      score: rounded,
      overlap,
      reason: "overlap",
    };
  }

  // 泛化反应：默认不接受（防「好看」式万能评论）；显式 allowGenericReaction 才放行
  const length = Array.from(text).length;
  if (
    opts.allowGenericReaction === true &&
    length >= 2 &&
    length <= 40 &&
    GENERIC_REACTION_RE.test(text) &&
    passesMinScore(0.5)
  ) {
    return { relevant: true, score: 0.5, overlap: [], reason: "generic_reaction" };
  }

  return { relevant: false, score: 0, overlap: [], reason: "unrelated" };
}

/**
 * 评论是否与视频内容相关。默认**严格**：必须与标题/简介/热评/关键词有实际重叠，
 * 不接受「好看」式万能评论（drafts.ts 的生成约束）；确需放宽泛化反应时传
 * `{ allowGenericReaction: true }`。
 */
export function isCommentRelevant(
  comment: string,
  context: CommentContext = {},
  opts: RelevanceOptions = {},
): boolean {
  return scoreCommentRelevance(comment, context, opts).relevant;
}
