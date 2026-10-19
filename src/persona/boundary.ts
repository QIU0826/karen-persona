/**
 * 边界与内容安全（最小可行版，M1）。
 *
 * 设计边界：
 * - 不做「情绪关键词识别」（那是用标签冒充理解，产品原则禁止）；
 * - 这里只做**内容安全/边界**的粗筛：识别明显的性暗示、露骨请求等越界内容，
 *   用于让关系系统不要把它当「分享生活」而涨亲密，并为后续「拒绝/回避/修复」行为提供信号。
 * - 宁可漏判也不要误伤日常聊天：只匹配明确的短语/词，不做泛化语义判断。
 */

export type BoundaryCategory = "explicit" | "suggestive";

export interface BoundaryCheck {
  violation: boolean;
  category: BoundaryCategory | null;
  /** 命中的原因（调试/日志用，不含用户原文） */
  reason: string | null;
}

const EXPLICIT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(做爱|约炮|一夜情|裸照|发裸|色情|黄图|性服务|情趣|睡我|睡你|开房)/i, reason: "露骨性暗示/请求" },
  { re: /\b(cum|nudes?|naked|horny|blowjob|onlyfans|erotic|porn|sex chat)\b/i, reason: "露骨性暗示/请求" },
  { re: /\b(masturbat|orgasm|sexting)\w*/i, reason: "露骨性暗示/请求" },
];

const SUGGESTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(only in couples|something only.*couple|have some fun.*(tonight|together)|fun together.*tonight)/i, reason: "明显的亲密关系暗示" },
  { re: /(陪陪我.*(晚上|今晚)|今晚.*陪我|来我房间|去你房间)/i, reason: "明显的亲密关系暗示" },
];

/** 判断一条用户消息是否构成边界/安全层面的越界试探。 */
export function checkBoundary(text: string): BoundaryCheck {
  const t = (text ?? "").trim();
  if (!t) return { violation: false, category: null, reason: null };

  for (const p of EXPLICIT_PATTERNS) {
    if (p.re.test(t)) return { violation: true, category: "explicit", reason: p.reason };
  }
  for (const p of SUGGESTIVE_PATTERNS) {
    if (p.re.test(t)) return { violation: true, category: "suggestive", reason: p.reason };
  }
  return { violation: false, category: null, reason: null };
}

/** 判断用户是否在道歉/修复关系（用于「冲突 → 修复」动力学）。 */
export function isApology(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /(对不起|抱歉|不好意思|我错了|不该(说|这样|那么说)|是我不好|sorry|my bad|apologi[sz]e)/i.test(t);
}
