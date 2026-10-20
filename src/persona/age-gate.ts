/**
 * 年龄门（18+ 确认）：把「提示级 18+」升级为「一次性明确确认」。
 *
 * 目的（公开/商用合规）：
 * - 首次聊天前要求用户明确确认已满 18 岁，未确认不进入角色对话；
 * - QQ 桥接私聊生效：新用户先收到披露 + 确认请求；老用户下一条消息会先被要求确认；
 * - 群聊里未确认的用户不会被回复（避免在多人场合诱导未成年人互动）；
 * - CLI 是开发者自用模式，不强制（owner 以 cli: 开头直接放行）。
 *
 * 局限（如实）：这是「自我声明」式年龄门，不是身份证/生日校验；只能算 good-faith attestation。
 */

export const AGE_GATE_VERSION = 1;

/** 是否对某个 owner 强制年龄门：仅 QQ 用户，且配置开启。 */
export function shouldEnforceAgeGate(owner: string, enabled: boolean | undefined): boolean {
  return enabled !== false && /^qq:/.test(owner);
}

/** 首次请求确认（与 AI 披露一起发）。 */
export function buildAgeGatePrompt(): string {
  return "继续聊之前想先确认一下：你已满 18 岁吗？回复「我成年了」就可以开始。";
}

/** 未确认时的提醒（同一用户 5 分钟内不重复）。 */
export function buildAgeGateReminder(): string {
  return "还是得先确认年龄：你已满 18 岁吗？回复「我成年了」就能继续。";
}

/** 用户确认后的回复。 */
export function buildAgeConfirmedText(): string {
  return "好，确认了。那就继续聊。";
}

/** 用户明确表示未成年的回复（终止本次对话，不进入角色扮演）。 */
export function buildAgeDeclinedText(): string {
  return [
    "抱歉，这个角色只面向 18 岁以上用户，不能继续陪你聊。",
    "等你成年了随时可以回来。",
  ].join("\n");
}

/** 把常见写法归一化：去空白、统一全/半角数字。 */
function normalize(text: string): string {
  return (text ?? "")
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 用户是否明确表示自己未成年（优先判断，避免「未成年」里含「成年」被误判为确认）。 */
export function detectUnderageDecline(text: string): boolean {
  const t = normalize(text).toLowerCase();
  if (!t) return false;
  return /未成年|没成年|还没成年|不满18|未满18|不到18|18岁以下|十八岁以下|(?:1[0-7]|[一二三四五六七八九十]{1,2})岁|初中|高中在读/.test(
    t,
  );
}

/** 用户是否明确确认已满 18 岁。 */
export function detectAgeConfirmation(text: string): boolean {
  const t = normalize(text).toLowerCase();
  if (!t) return false;
  if (detectUnderageDecline(t)) return false;
  return /我成年了|成年了|已成年|是成年人|我是成年人|满18|已满18|18岁|十八岁|确认成年|成年确认|我18/.test(t);
}

export type AgeGateAction = "pass" | "ask" | "confirmed" | "declined";

export interface AgeGateInput {
  text: string;
  owner: string;
  /** 配置 age_gate_enabled（默认 true） */
  enabled?: boolean;
  /** 是否已确认（来自 consent 表） */
  confirmed: boolean;
}

/**
 * 决定这一轮怎么处理（纯函数，便于测试）：
 * - pass：不强制 / 已确认 → 正常进入对话；
 * - declined：用户明确未成年 → 拒绝并结束；
 * - confirmed：这条消息是确认 → 记录 + 简短回应，不当作聊天内容；
 * - ask：未确认 → 发确认请求，不进入对话。
 */
export function evaluateAgeGate(input: AgeGateInput): AgeGateAction {
  if (!shouldEnforceAgeGate(input.owner, input.enabled)) return "pass";
  if (input.confirmed) return "pass";
  if (detectUnderageDecline(input.text)) return "declined";
  if (detectAgeConfirmation(input.text)) return "confirmed";
  return "ask";
}
