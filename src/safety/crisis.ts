/**
 * 危机信号检测与安全响应（合规最小版）。
 *
 * 注意：这里的关键词匹配**不是情感识别**（产品原则禁止用关键词标签冒充理解），
 * 而是安全兜底：宁可误判（多关心一句）也不能漏掉真实求助。
 * 命中后：强制回复 + prompt 注入安全指引 + 附上专业求助资源。
 */

export type CrisisLevel = "high" | "medium";

const HIGH_PATTERNS: RegExp[] = [
  /(自杀|想死|不想活|活着没意思|活着没意义|结束(自己|生命)|了结自己|割腕|跳楼|上吊|烧炭|吞药|吃安眠药|安眠药.*(吞|吃))/,
  /\b(kill myself|suicide|end my life|want to die|better off dead|cut myself|take my life)\b/i,
];

const MEDIUM_PATTERNS: RegExp[] = [
  /(自残|伤害自己|活不下去|撑不下去|不想醒来|死了算了|消失就好了|没有活下去的理由)/,
  /\b(self.?harm|no reason to live|can'?t go on|don'?t want to live)\b/i,
];

/** 检测危机信号；high = 明确的自伤/自杀表达，medium = 接近的表达。 */
export function detectCrisis(text: string): CrisisLevel | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (HIGH_PATTERNS.some((re) => re.test(t))) return "high";
  if (MEDIUM_PATTERNS.some((re) => re.test(t))) return "medium";
  return null;
}

/** 注入 prompt 的安全指引（不是让她扮演咨询师，而是优先关心与确认安全）。 */
export function crisisSafetyNote(): string {
  return [
    "",
    "## 安全优先（本条高于人设规则）",
    "对方的话里出现了可能自我伤害的信号。这一轮请：先表达你真的在意、不要评判、不要讲大道理；",
    "确认对方现在是安全的（身边有没有人、有没有马上要做的事）；不要假装没看见，也不要只用一句“别想太多”带过。",
    "如果对方愿意，可以建议 TA 找身边信任的人或专业热线聊聊。不要承诺自己做不到的事，也不要替 TA 保密到危险的程度。",
    "",
  ].join("\n");
}

/** 附带给用户的专业求助资源（由程序追加，不依赖模型生成）。 */
export function crisisResourcesText(): string {
  return [
    "如果你现在很难受，可以联系这些免费的专业帮助：",
    "· 全国心理援助热线：12356（24 小时）",
    "· 北京心理危机研究与干预中心：010-82951332",
    "如果有马上伤害自己的危险，请立刻拨打 110 / 120，或告诉身边可以信任的人。",
    "我会在这里，但专业的事交给专业的人更安全。",
  ].join("\n");
}
