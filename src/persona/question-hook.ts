/**
 * 「反问钩子」：让她偶尔主动问一句具体的小问题（v0.9.9 实验性）。
 *
 * 背景：行为评测基线里问句率只有 17–25%，真实长跑评审多次说
 * 「几乎不主动反问用户，聊天像单方面应答，缺少来回拉扯」。
 * 真人聊天会顺手接一个具体问题；她目前更偏陈述。
 *
 * 设计边界（避免变成采访机器）：
 * - **冷却**：最近 2 条回复里已经有问句 → 不触发；
 * - **概率**：基础 35%（够明显但不密集）；
 * - **危机/糟心事轮**：不触发（先接情绪，别追着问）；
 * - 提示要求问「他刚说的某个具体细节」，禁止泛泛的「你呢 / 你今天怎么样」。
 *
 * 纯函数、随机源可注入，便于单测与离线评测（behavior-eval 的 question-hook 变体）。
 */

export const QUESTION_HOOK_PROBABILITY = 0.35;
export const QUESTION_HOOK_COOLDOWN_TURNS = 2;

/** 她最近一条回复是否已经带了问句 */
export function replyAsksQuestion(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return false;
  return /[？?]/.test(text) || /[吗呢吧么嘛]\s*$/.test(text);
}

export interface QuestionHookContext {
  /** 她最近几条回复（新的在后） */
  recentReplies: string[];
  /** 用户这轮说的话 */
  userText: string;
  /** 危机信号轮：只说安全的话 */
  isCrisis?: boolean;
  /** 对方在讲糟心事：先接情绪，不追着问 */
  isTroubleTalk?: boolean;
  /** 当前亲密度 0-10（太生疏时先不追问私事） */
  closeness?: number;
}

/** 最低亲密度：刚认识就追问细节显得冒犯 */
export const QUESTION_HOOK_MIN_CLOSENESS = 1;

/** 要不要这一轮加「反问钩子」 */
export function shouldAddQuestionHook(
  ctx: QuestionHookContext,
  deps: { random?: () => number; probability?: number; enabled?: boolean } = {},
): boolean {
  if (deps.enabled === false) return false;
  if (ctx.isCrisis) return false;
  if (ctx.isTroubleTalk) return false;
  if ((ctx.closeness ?? 10) < QUESTION_HOOK_MIN_CLOSENESS) return false;
  // 冷却：最近 N 条回复里只要有一条是问句就不加
  const recent = (ctx.recentReplies ?? []).slice(-QUESTION_HOOK_COOLDOWN_TURNS);
  if (recent.some((reply) => replyAsksQuestion(reply))) return false;
  // 对方这轮已经问了问题 → 先回答，别马上反抛问题
  if (/[？?]/.test(ctx.userText ?? "")) return false;
  const probability = deps.probability ?? QUESTION_HOOK_PROBABILITY;
  const random = deps.random ?? Math.random;
  return random() < probability;
}

/** 反问钩子的内部提示（只在 shouldAddQuestionHook 为真时使用） */
export function buildQuestionHookNote(): string {
  return (
    "\n[内部提示] 这轮可以在回完之后，**顺着他说的话问一个具体的小问题**" +
    "（关于刚提到的某个细节，比如「那你们组长平时也这样？」），一句就够；" +
    "不要泛泛问「你呢」「你今天怎么样」，也不要在问完后再补一段长解释。"
  );
}
