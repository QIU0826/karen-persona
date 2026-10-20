/**
 * 消息意图（v0.6）：把「错字撤回」扩展成一族「发出去又想改」的真实动作。
 *
 * 真人不只打错字会撤回，还有：
 *  - **说重了**：情绪上来发了一句冲的，几秒后觉得过分 → 撤回（typology: regret）；
 *  - **重发**：发出去发现表述不清/有歧义 → 撤回换一句更短的；
 *  - **犹豫**：打了半天又删掉，最后只回一句很短的（表现为"很慢 + 很短"，不撤回）。
 *
 * 设计约束（与 typo-recall 一致）：
 * - **纯决策**：不发送、不撤回忆，bridge 负责执行；
 *  - **共享护栏**：私聊限定、危机轮禁用、15s 撤回窗口由 bridge 保证、全局冷却；
 *  - **一轮最多演一次**，避免多气泡放大触发率；
 *  - 记忆里始终落正确原文（撤回只是 transport 表演）。
 */
import { introduceTypo, isTypoEligibleText, type TypoRecallSettings } from "./typo-recall.js";

export type MessageIntent = "none" | "typo_recall" | "regret_recall" | "rewrite" | "hesitate";

export interface IntentSettings {
  /** 总开关 */
  enabled: boolean;
  /** 每轮触发任一意图的概率（默认 0.04；各意图再按下表分配） */
  probability: number;
  /** 撤回延迟（毫秒，默认 1500） */
  delayMs: number;
  /** 同一用户两次撤回的最小间隔（分钟，默认 20；0=不限） */
  cooldownMinutes: number;
}

export const DEFAULT_INTENT_SETTINGS: IntentSettings = {
  enabled: true,
  probability: 0.04,
  delayMs: 1500,
  cooldownMinutes: 20,
};

/** 各意图在总概率里的占比（错字最常见，说话重了次之） */
export const INTENT_WEIGHTS: Record<Exclude<MessageIntent, "none" | "hesitate">, number> = {
  typo_recall: 0.55,
  regret_recall: 0.3,
  rewrite: 0.15,
};

export interface IntentContext {
  /** 本轮要发的那条气泡 */
  text: string;
  /** 情绪向量 -1..1（用来判断"说重了"与"犹豫"） */
  emotionVector?: number;
  /** 是否夜间（犹豫更容易发生在深夜） */
  isNight?: boolean;
  isGroup?: boolean;
  isCrisis?: boolean;
  safetySent?: boolean;
  now?: number;
}

export interface IntentPlan {
  intent: MessageIntent;
  reason: string;
  /** 先发出去的版本（typo 时是错字版；regret/rewrite 是原文） */
  sentText?: string;
  /** 撤回后重发的正文（typo 时是正确原文；rewrite 时是更短的版本） */
  followUpText?: string;
  /** 撤回延迟 */
  delayMs?: number;
}

export interface IntentDeps {
  lastRecallAt?: number;
  random?: () => number;
}

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

/** 情绪很冲的话才值得"说重了撤回"：负面情绪 + 带攻击/绝对化词 */
const REGRET_PATTERN = /(烦死|闭嘴|滚|懒得|随便你|爱咋咋|你懂什么|别问了|无语|没意思)/;

/**
 * 把一条长句改短（rewrite 用）：取第一句，去掉尾巴的连词。
 * 真人撤回重发时通常会让话更短、更利落。
 */
export function shortenForRewrite(text: string): string {
  const firstSentence = text.split(/[。！？!?…\n]/).filter((s) => s.trim().length > 0)[0] ?? text;
  let candidate = firstSentence.replace(/[，,、；;：:]+$/, "").trim();
  // 没有句末标点但很长时，退一步在第一处逗号断开（真人重发常常只说一半）
  if (candidate === text.trim() && Array.from(candidate).length > 24) {
    const commaAt = candidate.search(/[，,]/);
    if (commaAt > 4) candidate = candidate.slice(0, commaAt).trim();
  }
  return Array.from(candidate).length >= 2 ? candidate : text;
}

/** 决定这一轮要不要演「发出去又想改」，以及演哪一种。 */
export function planMessageIntent(
  ctx: IntentContext,
  settings: IntentSettings = DEFAULT_INTENT_SETTINGS,
  deps: IntentDeps = {},
): IntentPlan {
  if (!settings.enabled) return { intent: "none", reason: "disabled" };
  if (ctx.isGroup) return { intent: "none", reason: "group_unsupported" };
  if (ctx.isCrisis || ctx.safetySent) return { intent: "none", reason: "crisis" };

  const text = (ctx.text ?? "").trim();
  if (text.length < 4) return { intent: "none", reason: "text_too_short" };

  const now = ctx.now ?? Date.now();
  const cooldownMs = clamp(settings.cooldownMinutes ?? 20, 0, 24 * 60) * 60_000;
  if (deps.lastRecallAt !== undefined && cooldownMs > 0) {
    const elapsed = now - deps.lastRecallAt;
    if (elapsed >= 0 && elapsed < cooldownMs) return { intent: "none", reason: "cooldown" };
  }

  const random = deps.random ?? Math.random;
  const probability = clamp(settings.probability ?? 0.04, 0, 1);
  if (probability <= 0 || random() >= probability) {
    // 没抽中撤回：深夜 + 情绪低时，有一定概率表现为"犹豫"（打很久，最终只回一句短的）
    const hesitateChance = (ctx.isNight ? 0.08 : 0.03) + Math.max(0, -(ctx.emotionVector ?? 0)) * 0.1;
    if (random() < hesitateChance) {
      return { intent: "hesitate", reason: "late_night_or_low_mood" };
    }
    return { intent: "none", reason: "probability_miss" };
  }

  // 抽中了 → 按权重分配意图；不合适的意图降级到 typo
  const roll = random();
  const regretEligible = REGRET_PATTERN.test(text) || (ctx.emotionVector ?? 0) < -0.45;
  const rewriteEligible = shortenForRewrite(text).length < text.length - 2;
  const typoEligible = isTypoEligibleText(text);

  let intent: MessageIntent;
  if (roll < INTENT_WEIGHTS.typo_recall && typoEligible) intent = "typo_recall";
  else if (roll < INTENT_WEIGHTS.typo_recall + INTENT_WEIGHTS.regret_recall && regretEligible) {
    intent = "regret_recall";
  } else if (rewriteEligible) intent = "rewrite";
  else if (typoEligible) intent = "typo_recall";
  else return { intent: "none", reason: "no_eligible_intent" };

  const delayMs = Math.round(
    clamp(settings.delayMs ?? DEFAULT_INTENT_SETTINGS.delayMs, MIN_DELAY_MS, MAX_DELAY_MS),
  );

  if (intent === "typo_recall") {
    const typoText = introduceTypo(text, random);
    if (!typoText) return { intent: "none", reason: "no_typo_variant" };
    return { intent, reason: "ok", sentText: typoText, followUpText: text, delayMs };
  }
  if (intent === "regret_recall") {
    // 撤回后重发一条更收着的版本（去掉最冲的措辞，留一句短的）
    const softer = shortenForRewrite(text);
    return {
      intent,
      reason: "ok",
      sentText: text,
      followUpText: softer === text ? `${softer}…算了` : softer,
      delayMs,
    };
  }
  return { intent: "rewrite", reason: "ok", sentText: text, followUpText: shortenForRewrite(text), delayMs };
}

/** 把 intent 设置从 typo_recall 配置映射过来（同一个开关，行为向后兼容）。 */
export function intentSettingsFromTypo(typo: TypoRecallSettings): IntentSettings {
  return {
    enabled: typo.enabled,
    probability: typo.probability,
    delayMs: typo.delayMs,
    cooldownMinutes: typo.cooldownMinutes,
  };
}
