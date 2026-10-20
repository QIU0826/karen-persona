/**
 * 意图式主动性（v0.8）。
 *
 * 现在的问题：主动消息是「规则触发 + 掷骰子」——有没有话说、说什么由几类信号临时凑，
 * 缺一个「她今天想找他聊什么」的意图层，也没有按"他到底爱不爱回"来校准频率。
 *
 * 这里补三件事（全部纯函数，LLM 只负责生成草案文本）：
 *  1. **每日计划**：一天 2–3 个「由头」（她生活里的事 / 没聊完的话题 / 情绪想分享），
 *     每个带类型、时效窗、优先级；
 *  2. **到点挑选**：此刻该不该发、发哪一个（受冷却/单日上限/免打扰/他刚回过等约束）；
 *  3. **频率校准**：按他最近的回复率调整每天主动条数——老不回就少找，回得勤就自然一点。
 */

export type InitiativeKind = "life_event" | "open_thread" | "mood_share" | "missing_you";

export interface InitiativeItem {
  /** 一句话由头（给模型当上下文，不是最终消息） */
  topic: string;
  kind: InitiativeKind;
  /** 0-1，越大越想说 */
  urgency: number;
  /** 适合发送的时间窗（小时，闭区间；跨天用 start > end 表示，如 22→2） */
  windowStart: number;
  windowEnd: number;
  /** 当天是否已经用过 */
  used?: boolean;
}

export interface DailyInitiativePlan {
  day: string;
  items: InitiativeItem[];
  createdAt: number;
}

export const INITIATIVE_KIND_LABELS: Record<InitiativeKind, string> = {
  life_event: "她生活里的事",
  open_thread: "没聊完的话题",
  mood_share: "想分享的心情",
  missing_you: "有点想他",
};

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

/** 时间窗判定（支持跨天，如 22→2） */
export function isInWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * 生成每日计划的 prompt（纯函数）。
 * 输入她今天的生活线索（日记忆/因果链/未完成话题），产出一个"想找他说什么"的草案。
 */
export function buildDailyPlanPrompt(input: {
  herName: string;
  userName: string;
  day: string;
  closeness: number;
  /** 最近几天的日记忆摘要（可空） */
  recentDigests?: string[];
  /** 未完成的话题（可空） */
  openThreads?: string[];
  /** 她生活里正在发生的事（因果链/天气，可空） */
  lifeSignals?: string[];
}): { system: string; user: string } {
  const system = [
    "你在帮一个角色规划「今天可能想主动找对方说些什么」。",
    "只输出 JSON，不要解释。",
    '格式：{"items":[{"topic":"...","kind":"life_event|open_thread|mood_share|missing_you","urgency":0.6,"window_start":9,"window_end":12}]}',
    "要求：",
    "- 2–3 条即可，不要更多；",
    "- topic 写一句具体的话头（≤20 字），像她心里冒出来的念头，不要写成问候语；",
    "- kind 只能取四类之一；urgency 0–1；",
    "- window_start/window_end 用 0–23 的整数（可跨天，如 22→2），要符合她的作息；",
    "- 只用给到的线索，不要编造没有的事。",
  ].join("\n");

  const user = [
    `她的名字：${input.herName}；对方：${input.userName}；日期：${input.day}；亲密度：${input.closeness.toFixed(1)}/10`,
    input.lifeSignals?.length ? `她生活里的事：${input.lifeSignals.join("；")}` : "她生活里的事：（无特别的事）",
    input.openThreads?.length ? `没聊完的话题：${input.openThreads.join("；")}` : "没聊完的话题：（无）",
    input.recentDigests?.length ? `最近几天：${input.recentDigests.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** 解析每日计划（容错：代码块/前后说明/字段类型不对都能兜住）。 */
export function parseDailyPlan(content: string, day: string, now = Date.now()): DailyInitiativePlan | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const rawItems = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) return null;

  const kinds: InitiativeKind[] = ["life_event", "open_thread", "mood_share", "missing_you"];
  const items: InitiativeItem[] = [];
  for (const raw of rawItems.slice(0, 3)) {
    const obj = raw as Record<string, unknown>;
    const topic = typeof obj.topic === "string" ? obj.topic.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!topic) continue;
    const kind = kinds.includes(obj.kind as InitiativeKind) ? (obj.kind as InitiativeKind) : "life_event";
    const urgency = Number.isFinite(Number(obj.urgency)) ? clamp(Number(obj.urgency), 0, 1) : 0.5;
    const ws = Number.isFinite(Number(obj.window_start)) ? clamp(Math.round(Number(obj.window_start)), 0, 23) : 10;
    const we = Number.isFinite(Number(obj.window_end)) ? clamp(Math.round(Number(obj.window_end)), 0, 23) : 12;
    items.push({ topic, kind, urgency, windowStart: ws, windowEnd: we });
  }
  if (items.length === 0) return null;
  return { day, items, createdAt: now };
}

export interface InitiativeSignals {
  hour: number;
  /** 亲密度 0-10 */
  closeness: number;
  /** 今天已经主动发了几条 */
  sentToday: number;
  /** 每日上限（由校准得出） */
  dailyCap: number;
  /** 距上次主动消息的分钟数（null=今天还没发过） */
  minutesSinceLast: number | null;
  /** 最小间隔（分钟） */
  minGapMinutes: number;
  /** 免打扰时段 */
  quietHours: { start: number; end: number };
  /** 他最近刚回过消息（<10 分钟）→ 现在不适合另起话题 */
  userRecentlyReplied: boolean;
}

export type InitiativeDecision =
  | { action: "skip"; reason: string }
  | { action: "send"; item: InitiativeItem; reason: string };

/**
 * 到点挑选：从今天的计划里选出此刻该发的一条。
 * 优先级 = urgency；同时受时效窗 / 上限 / 间隔 / 免打扰 / 他刚回 约束。
 */
export function pickDueInitiative(
  plan: DailyInitiativePlan | null,
  signals: InitiativeSignals,
): InitiativeDecision {
  if (!plan || plan.items.length === 0) return { action: "skip", reason: "no_plan" };
  if (isInWindow(signals.hour, signals.quietHours.start, signals.quietHours.end)) {
    return { action: "skip", reason: "quiet_hours" };
  }
  if (signals.sentToday >= signals.dailyCap) return { action: "skip", reason: "daily_cap" };
  if (
    signals.minutesSinceLast !== null &&
    signals.minutesSinceLast < signals.minGapMinutes
  ) {
    return { action: "skip", reason: "min_gap" };
  }
  if (signals.userRecentlyReplied) return { action: "skip", reason: "user_just_replied" };

  const due = plan.items
    .filter((item) => !item.used && isInWindow(signals.hour, item.windowStart, item.windowEnd))
    .sort((a, b) => b.urgency - a.urgency);

  if (due.length === 0) return { action: "skip", reason: "no_item_due" };

  // 亲密度低时只发"没聊完的话题/她生活里的事"，不发"有点想他"（太早太黏）
  const filtered =
    signals.closeness < 4 ? due.filter((item) => item.kind !== "missing_you") : due;
  const picked = filtered[0] ?? due[0];
  return { action: "send", item: picked, reason: `due:${picked.kind}` };
}

/** 标记某条由头已用（当天不再重复） */
export function markInitiativeUsed(plan: DailyInitiativePlan, topic: string): DailyInitiativePlan {
  return {
    ...plan,
    items: plan.items.map((item) => (item.topic === topic ? { ...item, used: true } : item)),
  };
}

/**
 * 频率校准：按他最近的回复率决定每天主动几条。
 *
 * 直觉：他回得多，她敢多找；他老不回，她就少找、甚至几天不找（真人会收敛）。
 * 返回 0–3（0 = 今天别主动，1–2 = 正常，3 = 聊得热络）。
 */
export function calibratedDailyCap(input: {
  /** 最近 10 次主动消息里他回复了几次（0–10） */
  repliesToInitiative: number;
  /** 最近 10 条他消息里主动找她几次（0–10） */
  hisInitiatives: number;
  closeness: number;
  /**
   * 她是否发过主动消息（v0.8.14）。
   * 没发过时"回复率 0"不代表"他不回"——不能用它判成 0 条，
   * 否则会死锁：不发 → 没回复 → 更不敢发。
   */
  hasSentHistory?: boolean;
}): { cap: number; reason: string } {
  const closeness = clamp(input.closeness, 0, 10);
  const responseRate = clamp(input.repliesToInitiative / 10, 0, 1);
  const hisRate = clamp(input.hisInitiatives / 10, 0, 1);
  // 从没主动过：先试探 1 条（否则永远没数据，永远判成"他不回"）
  if (input.hasSentHistory === false) {
    return { cap: 1, reason: "还没主动过，先试探一条" };
  }
  if (responseRate < 0.2 && closeness < 6) return { cap: 0, reason: "他基本不回，先别找" };
  if (responseRate < 0.35) return { cap: 1, reason: "回得少，少找一点" };
  if (hisRate > 0.4 || responseRate > 0.7) return { cap: 3, reason: "聊得热络，可以多找" };
  return { cap: 2, reason: "正常节奏" };
}
