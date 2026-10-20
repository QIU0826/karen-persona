/**
 * 回复里的「主动性」注入（v0.8.11）。
 *
 * 问题：21 轮真实回归里，LLM 评审连续两轮给「主动性 3/4 分」，原话是
 * 「会主动分享店里的事…但**话题多围绕用户提问展开，自己开新话题偏少**」。
 *
 * 根因：v0.8 的「每日由头计划」只喂给**主动消息（心跳）**，正常回复时完全不提这些由头，
 * 所以她永远在"回答问题"，不会想起"我今天本来想跟他说这件事"。
 *
 * 这个模块只做纯函数的事：把今天的由头挑一条变成一句注入文本。
 * 什么时候不该注入（都刻意做得保守，避免她变成"强行转话题"的人）：
 *  - 用户在直接问问题（先把问题答好）；
 *  - 关系还生（亲密度 <3，不熟的阶段不该主动抖自己的事）；
 *  - 危机语境 / 今天没有由头。
 */

import type { DailyInitiativePlan } from "../impulse/initiative-plan.js";

export interface InitiativeReplyHintInput {
  plan: DailyInitiativePlan | null | undefined;
  /** 用户这轮说的原话 */
  userText: string;
  closeness: number;
  /** 已发生过的消息条数（用来轮换由头，避免每轮都说同一件） */
  messageCount: number;
  isCrisis?: boolean;
}

/** 以问号结尾 / 明显的提问句式 → 先答问题，不塞自己的事 */
const QUESTION_PATTERN = /([？?]\s*$)|(^(你|您|你们)[^。！？\n]{0,20}(吗|呢|么)[？?]?$)/;

/** 生关系阶段（亲密度低于此值不主动抖自己的事） */
export const INITIATIVE_REPLY_MIN_CLOSENESS = 3;

export function buildInitiativeReplyHint(input: InitiativeReplyHintInput): string {
  if (input.isCrisis) return "";
  if (!input.plan || input.plan.items.length === 0) return "";
  if (input.closeness < INITIATIVE_REPLY_MIN_CLOSENESS) return "";
  const text = (input.userText ?? "").trim();
  if (QUESTION_PATTERN.test(text)) return "";

  const index = Math.abs(input.messageCount) % input.plan.items.length;
  const item = input.plan.items[index];
  if (!item) return "";

  return (
    "\n## 你今天本来想跟他说的事\n" +
    `「${item.topic}」\n` +
    "如果这轮有能自然接上的地方，就顺口带出来一句（别一次说完、别硬转话题）；接不上就先不说，等下次。\n"
  );
}
