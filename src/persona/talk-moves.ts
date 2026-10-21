/**
 * 「说话动作」选择器（talk move）。
 *
 * 15 轮真实验证的 LLM 评审指出两个问题：
 * - **主动开启话题偏少**：多数轮次只顺着问话回应（主动 3/5）；
 * - **共情略浅**：对方吐槽加班/挨批时，她接得住但不够深（真人感扣分项）。
 *
 * 这个模块只做一件事：根据这一轮的情况，给模型一句**内部提示**，让它在回复里
 * 做一个具体的说话动作（先接住情绪 / 顺手补一句自己的近况），而不是泛泛要求「更像人」。
 *
 * 设计边界：
 * - 不做情绪打分，只识别「他是不是在讲自己的糟心事」这种**谈话行为**；
 * - 低概率触发、带冷却（连续两轮不重复同一个动作），避免变成套路；
 * - 纯函数、可注入随机源，便于单测；提示文案是内部提示，不会被用户看到。
 */

export type TalkMove = "empathize" | "self-disclose" | "none";

export interface TalkMoveContext {
  /** 用户这一轮说的话（可含 CQ 码） */
  userText: string;
  /** 当前小时 0-23 */
  hour: number;
  /** 当前亲密度 0-10 */
  closeness: number;
  /** 危机信号轮：只说安全的话，不做说话动作 */
  isCrisis?: boolean;
  /** 最近几轮做过的动作（新的在后） */
  recentMoves?: TalkMove[];
  /** 免打扰时段（start==end 视为关闭） */
  quietHours?: { start: number; end: number };
  /**
   * 她自己的生活素材（v0.9.5）：例如「这会儿在咖啡店工作」「最近在学会拉花」。
   * 有素材时 self-disclose 提示会给一句具体可说的内容，而不是空泛地"补一句近况"。
   */
  lifeSignal?: string;
}

export interface TalkMoveDecision {
  move: TalkMove;
  /** 稳定原因字符串（日志/测试用） */
  reason: string;
  /** 追加到 system prompt 的内部提示（none 时为空串） */
  note: string;
}

/** 顺手补一句自己近况的概率（太高会显得爱抢话） */
export const SELF_DISCLOSE_PROBABILITY = 0.28;

/** 自我暴露的最低亲密度（不熟的时候不主动讲自己的事） */
export const SELF_DISCLOSE_MIN_CLOSENESS = 1.5;

/**
 * 「他在讲自己的糟心事」——这是**谈话行为**识别（他在倒苦水），不是情绪打分。
 * 只用来决定「先接住」这个动作，不参与情绪建模。
 */
const TROUBLE_TALK =
  /(被骂|挨批|被批|被说|加班|崩溃|崩了|难受|好丧|有点丧|烦死|好烦|太累|累死|不顺|出\s*bug|被裁|分手|吵架|生病|失眠|委屈|压力大)/;

/** 对方是否在讲自己的糟心事（谈话行为识别，不参与情绪建模）。 */
export function isTroubleTalk(text: string | null | undefined): boolean {
  const raw = typeof text === "string" ? text : "";
  const normalized = raw.replace(/\[CQ:[^\]]+\]/g, " ");
  return TROUBLE_TALK.test(normalized);
}

const EMPATHIZE_NOTE =
  "\n[内部提示] 他刚在讲自己的糟心事：先用一句话接住（认同，或者问一句具体发生了什么），别马上把话题转到你自己身上。";

const SELF_DISCLOSE_NOTE =
  "\n[内部提示] 这轮如果你只是回答，可以在最后顺手补一句你自己的近况或念头（一句就够），让话题往前走，但别抢他的话头。";

/**
 * self-disclose 的内部提示（v0.9.5）。
 *
 * 背景：旧提示只说"补一句自己的近况"，没给素材——模型要么不说，要么说得很空。
 * 现在把她的真实生活线索（作息/目标/压力源/朋友/天气）塞进去当"可说的一件事"，
 * 让她讲的是**具体的生活**，而不是泛泛的"我今天还行"。
 */
function buildSelfDiscloseNote(lifeSignal?: string): string {
  const signal = (lifeSignal ?? "").replace(/\s+/g, " ").trim();
  if (!signal) return SELF_DISCLOSE_NOTE;
  return (
    "\n[内部提示] 这轮可以在回完他之后，顺手说你自己的**一件具体的小事**（一句就够，别展开）：" +
    `「${signal}」。` +
    "用你自己的话讲，像随口提一句，不要照抄、不要说教、不要每轮都提。"
  );
}

/** A/B 开关：`KAREN_SELF_SHARE_MATERIAL=off` 时退回旧版空泛提示（仅评测用） */
function selfShareMaterialEnabled(): boolean {
  return (process.env.KAREN_SELF_SHARE_MATERIAL ?? "").toLowerCase() !== "off";
}

function isQuietHour(hour: number, quiet?: { start: number; end: number }): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const h = ((hour % 24) + 24) % 24;
  return quiet.start < quiet.end
    ? h >= quiet.start && h < quiet.end
    : h >= quiet.start || h < quiet.end;
}

function none(reason: string): TalkMoveDecision {
  return { move: "none", reason, note: "" };
}

/**
 * 决定这一轮要不要做一个「说话动作」。
 * 顺序：关闭 → 危机 → 免打扰 → 糟心事（接住）→ 亲密度/冷却/概率（补一句自己）。
 */
export function decideTalkMove(
  ctx: TalkMoveContext,
  deps: { random?: () => number; enabled?: boolean } = {},
): TalkMoveDecision {
  if (deps.enabled === false) return none("disabled");
  if (ctx.isCrisis) return none("crisis");
  if (isQuietHour(ctx.hour, ctx.quietHours)) return none("quiet_hours");

  const recent = ctx.recentMoves ?? [];
  const text = (ctx.userText ?? "").replace(/\[CQ:[^\]]+\]/g, " ");

  // 1) 他在倒苦水 → 先接住（连续两轮不重复，避免变成「抱抱」机器）
  if (TROUBLE_TALK.test(text) && !recent.slice(-2).includes("empathize")) {
    return { move: "empathize", reason: "trouble_talk", note: EMPATHIZE_NOTE };
  }

  // 2) 低概率顺手补一句自己的近况
  if (ctx.closeness < SELF_DISCLOSE_MIN_CLOSENESS) return none("low_closeness");
  if (recent.slice(-2).includes("self-disclose")) return none("cooldown");

  const random = deps.random ?? Math.random;
  if (random() >= SELF_DISCLOSE_PROBABILITY) return none("probability_miss");
  const note = selfShareMaterialEnabled()
    ? buildSelfDiscloseNote(ctx.lifeSignal)
    : SELF_DISCLOSE_NOTE;
  return { move: "self-disclose", reason: "self_disclose", note };
}
