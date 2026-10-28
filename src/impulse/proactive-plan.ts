/**
 * 主动消息决策（v0.4.0）。
 *
 * 背景：以前她「主动找你」只有一条链路——生活流心跳（因果链/天气/情绪/时间）
 * 外加 >72h 的沉默保温。问题有两个：
 *  1. 她说完一句话、对方一直没回时，她不会像真人那样「过一会儿补一句」；
 *     而冷场几小时想开个新话头，也没有独立链路，只能等生活流碰巧触发。
 *  2. 决策是黑箱：返回 null 时调用方拿不到原因，`/why` 只能解释"为什么这样回"，
 *     解释不了"她为什么没来找我"。
 *
 * 这里把主动拆成四条**独立可关**的链路（顺序即优先级）：
 *  - follow_up      没人接话补一句（她上一条没被回，20 分钟~3 小时）
 *  - silence_revive 沉默保温（>72h 关系重启，语气收敛）
 *  - life_share     生活流冲动（她自己的生活有进展，原有逻辑）
 *  - open_topic     冷场开话题（3~72 小时没说话，主动开个话头）
 *
 * 每次决策都会给出 skip 原因，供 `/why` 展示与日志观测。
 * 纯函数：时间、随机数、窗口标记全部由调用方注入，方便单测。
 */

// ── 类型 ──────────────────────────────────────

export type ProactiveChannel = "follow_up" | "silence_revive" | "life_share" | "open_topic";

export interface ProactiveChannels {
  follow_up: boolean;
  silence_revive: boolean;
  life_share: boolean;
  open_topic: boolean;
}

export const DEFAULT_PROACTIVE_CHANNELS: ProactiveChannels = {
  follow_up: true,
  silence_revive: true,
  life_share: true,
  open_topic: true,
};

/** 全部关闭（`KAREN_PROACTIVE_CHANNELS=off` 调试用） */
export const ALL_CHANNELS_OFF: ProactiveChannels = {
  follow_up: false,
  silence_revive: false,
  life_share: false,
  open_topic: false,
};

export type ProactiveSkipReason =
  | "paused"
  | "daily_cap"
  | "min_gap"
  | "no_signal"
  | "in_conversation"
  | "unanswered_wait"
  | "channel_off"
  | "low_closeness"
  | "follow_up_too_soon"
  | "follow_up_expired"
  | "follow_up_already"
  | "open_topic_too_soon"
  | "open_topic_expired"
  | "open_topic_already"
  | "silence_phase_low"
  | "silence_revive_already"
  | "probability_miss";

export interface ProactiveSignals {
  /** 当前时间戳（ms） */
  now: number;
  /** 用户最后一条消息时间（没有则 null） */
  lastUserAt: number | null;
  /** 她最后一条消息时间（没有则 null） */
  lastHerAt: number | null;
  /** 本轮冷场里已经补过话的时间（没有则 null） */
  followUpAt: number | null;
  /** 本轮冷场里已经开过话题的时间（没有则 null） */
  openTopicAt: number | null;
  /** 上次主动消息发送时间 */
  lastProactiveAt: number | null;
  /** 今天已主动发送次数 */
  proactiveCountToday: number;
  /** 每天上限（默认 4） */
  maxPerDay: number;
  /** 两次主动消息最小间隔（ms，默认 30 分钟） */
  minGapMs: number;
  closeness: number;
  /** 沉默阶段（getSilencePhase，0-4） */
  silencePhase: number;
  /** 这轮失联里是否已经发过重启消息（对方回话后重置） */
  silenceReviveSent: boolean;
  /** 生活流是否有候选（因果链/天气/情绪/时间） */
  hasLifeCandidate: boolean;
  /** 生活流候选里最高的优先级（0-10） */
  lifePriority: number;
  /** 对方上一次回话之后，她已经主动发过几条还没被回 */
  unansweredProactive: number;
  /** 是否被 /pause 暂停 */
  paused: boolean;
  channels: ProactiveChannels;
}

export type ProactiveDecision =
  | { action: "skip"; reason: ProactiveSkipReason; detail: string }
  | { action: "send"; channel: ProactiveChannel; detail: string };

export interface DecideOptions {
  random?: () => number;
}

// ── 窗口常量（可测） ──────────────────────────

/** 「没人接话」窗口：她说完 20 分钟后才会补一句（太快像催命） */
export const FOLLOW_UP_MIN_MS = 20 * 60 * 1000;
/** 超过 3 小时就不算「等回话」，改由 open_topic 接手 */
export const FOLLOW_UP_MAX_MS = 3 * 60 * 60 * 1000;
/** 冷场开话题：至少 3 小时没说话 */
export const OPEN_TOPIC_MIN_MS = 3 * 60 * 60 * 1000;
/** 超过 72 小时交给 silence_revive（关系重启），不重复开话题 */
export const OPEN_TOPIC_MAX_MS = 72 * 60 * 60 * 1000;
/** 沉默保温至少要真的安静这么久（避免她刚说完话就"重启联系"） */
export const SILENCE_REVIVE_MIN_MS = 6 * 60 * 60 * 1000;
/** 补话/开话题的最低亲密度门槛 */
export const FOLLOW_UP_MIN_CLOSENESS = 2;
export const OPEN_TOPIC_MIN_CLOSENESS = 2.5;

/** 对方不回时，一天内最多连推几条就收手（真人也不会一直发） */
export const MAX_UNANSWERED_PROACTIVE = 2;
/** 超过这么久没回音，就不再受"连推上限"约束（隔天可以再试着联系） */
export const UNANSWERED_RESET_MS = 24 * 60 * 60 * 1000;

const FOLLOW_UP_CHANCE = 0.55;
const OPEN_TOPIC_CHANCE = 0.4;
const SILENCE_REVIVE_CHANCE = 0.75;

// ── 文案 ──────────────────────────────────────

export const CHANNEL_LABEL: Record<ProactiveChannel, string> = {
  follow_up: "没人接话补一句",
  silence_revive: "沉默保温",
  life_share: "生活流分享",
  open_topic: "冷场开话题",
};

export const SKIP_REASON_LABEL: Record<ProactiveSkipReason, string> = {
  paused: "主动消息已暂停（/pause）",
  daily_cap: "今天主动次数已到上限",
  min_gap: "距上次主动消息太近",
  no_signal: "还没有可用的触发信号",
  in_conversation: "对方刚发过消息，这一轮轮不到她主动",
  unanswered_wait: "已经主动了几条没被回，先等等（一天内不连推）",
  channel_off: "这条链路被配置关掉了",
  low_closeness: "亲密度还不够主动开口",
  follow_up_too_soon: "她刚说完，还不该催",
  follow_up_expired: "等回话的时间窗已过",
  follow_up_already: "这轮冷场里已经补过一句",
  open_topic_too_soon: "冷场时间还不够长",
  open_topic_expired: "沉默太久，改用沉默保温",
  open_topic_already: "这轮冷场里已经开过话头",
  silence_phase_low: "还没到需要重启联系的阶段",
  silence_revive_already: "这轮失联已经主动问过一次了",
  probability_miss: "触发了，但这次随机没选中",
};

// ── 决策 ──────────────────────────────────────

interface Candidate {
  channel: ProactiveChannel;
  /** 优先级：越大越优先 */
  priority: number;
  /** 命中概率（0-1） */
  chance: number;
  /** 适用的沉默窗口（0: <20min，1: 20min~3h，2: 3h~72h，3: >72h）。用于挑选"最相关的跳过原因" */
  windows: number[];
  /** 返回 null 表示可用，否则返回跳过原因 */
  check: () => ProactiveSkipReason | null;
  detail: string;
}

/** 每个沉默窗口里"最该由谁开口"——用于挑选最相关的跳过原因 */
export const WINDOW_OWNER: Record<number, ProactiveChannel> = {
  0: "follow_up",
  1: "follow_up",
  2: "open_topic",
  3: "silence_revive",
};

/** 当前沉默时长落在哪个窗口（只用于解释跳过原因，不改变可用性判定） */
export function silenceWindow(silenceMs: number): number {
  if (silenceMs < FOLLOW_UP_MIN_MS) return 0;
  if (silenceMs <= FOLLOW_UP_MAX_MS) return 1;
  if (silenceMs <= OPEN_TOPIC_MAX_MS) return 2;
  return 3;
}

function skip(reason: ProactiveSkipReason, detail?: string): ProactiveDecision {
  return { action: "skip", reason, detail: detail ?? SKIP_REASON_LABEL[reason] };
}

/**
 * 决定「她此刻要不要主动发消息、走哪条链路、为什么」。
 *
 * 评估顺序 = 优先级顺序；命中第一条可用链路后掷骰子，
 * 没中就返回 probability_miss（不降级到下一条，避免语义错位：
 * 正在等回话的窗口里不该突然变成"分享生活"）。
 */
export function decideProactive(
  s: ProactiveSignals,
  opts: DecideOptions = {},
): ProactiveDecision {
  const random = opts.random ?? Math.random;

  // 1. 硬性治理：暂停 / 单日上限 / 最小间隔
  if (s.paused) return skip("paused");
  if (s.proactiveCountToday >= s.maxPerDay) {
    return skip("daily_cap", `今天已主动 ${s.proactiveCountToday}/${s.maxPerDay} 次`);
  }
  if (s.lastProactiveAt !== null && s.now - s.lastProactiveAt < s.minGapMs) {
    const minutes = Math.ceil((s.minGapMs - (s.now - s.lastProactiveAt)) / 60000);
    return skip("min_gap", `距上次主动不足 ${Math.round(s.minGapMs / 60000)} 分钟（还要等约 ${minutes} 分钟）`);
  }

  // 2. 基础信号：至少要有一条历史消息
  const lastAt = Math.max(s.lastUserAt ?? 0, s.lastHerAt ?? 0);
  if (lastAt <= 0) return skip("no_signal", "还没有任何对话记录");

  const silenceMs = s.now - lastAt;
  // 最后一句是她说的？否则对方刚发完等着被回，不该插主动消息
  const herTurn = s.lastHerAt !== null && (s.lastUserAt === null || s.lastHerAt >= s.lastUserAt);
  if (!herTurn) return skip("in_conversation");

  // 2b. 对方一直不回时收手：一天内连推达到上限就先等（隔天再试）
  if (s.unansweredProactive >= MAX_UNANSWERED_PROACTIVE && silenceMs < UNANSWERED_RESET_MS) {
    return skip(
      "unanswered_wait",
      `已经主动 ${s.unansweredProactive} 条都没被回，先等等（隔天再说）`,
    );
  }

  // 3. 组装候选链路（顺序即优先级）
  // 「已经补过/开过」以**对方最后一次说话**为界：她自己的消息不算重置窗口，
  // 否则她补完一句后会把自己的消息当成新窗口，接着补第二句（像刷屏）。
  const windowStart = s.lastUserAt ?? lastAt;
  const followUpDone = s.followUpAt !== null && s.followUpAt >= windowStart;
  const openTopicDone = s.openTopicAt !== null && s.openTopicAt >= windowStart;

  const candidates: Candidate[] = [
    {
      channel: "follow_up",
      priority: 100,
      chance: FOLLOW_UP_CHANCE,
      windows: [0, 1],
      detail: "我上一条还没回音，隔了一会儿想补一句",
      check: () => {
        if (!s.channels.follow_up) return "channel_off";
        if (s.closeness < FOLLOW_UP_MIN_CLOSENESS) return "low_closeness";
        if (silenceMs < FOLLOW_UP_MIN_MS) return "follow_up_too_soon";
        if (silenceMs > FOLLOW_UP_MAX_MS) return "follow_up_expired";
        if (followUpDone) return "follow_up_already";
        return null;
      },
    },
    {
      channel: "silence_revive",
      priority: 90,
      chance: SILENCE_REVIVE_CHANCE,
      windows: [2, 3],
      detail: "好久没联系了，我有点在意，想问问",
      check: () => {
        if (!s.channels.silence_revive) return "channel_off";
        if (s.silenceReviveSent) return "silence_revive_already";
        if (s.silencePhase < 4 && silenceMs <= OPEN_TOPIC_MAX_MS) return "silence_phase_low";
        if (silenceMs < SILENCE_REVIVE_MIN_MS) return "silence_phase_low";
        return null;
      },
    },
    {
      channel: "life_share",
      priority: 40 + Math.round(Math.max(0, Math.min(10, s.lifePriority)) * 5),
      chance: Math.min(0.75, Math.max(0, s.lifePriority) / 10),
      windows: [0, 1, 2, 3],
      detail: "我这边生活里有点事，想到了你",
      check: () => {
        if (!s.channels.life_share) return "channel_off";
        if (!s.hasLifeCandidate) return "no_signal";
        return null;
      },
    },
    {
      channel: "open_topic",
      priority: 50,
      chance: OPEN_TOPIC_CHANCE,
      windows: [2],
      detail: "几小时没说话了，我想主动找个话头",
      check: () => {
        if (!s.channels.open_topic) return "channel_off";
        if (s.closeness < OPEN_TOPIC_MIN_CLOSENESS) return "low_closeness";
        if (silenceMs < OPEN_TOPIC_MIN_MS) return "open_topic_too_soon";
        if (silenceMs > OPEN_TOPIC_MAX_MS) return "open_topic_expired";
        if (openTopicDone) return "open_topic_already";
        return null;
      },
    },
  ];

  candidates.sort((a, b) => b.priority - a.priority);

  const eligible = candidates.filter((c) => c.check() === null);

  // 4. 全不可用 → 报告「当下这个沉默窗口」里最相关的那条链路的原因
  //    （不能用全局最高优先级：冷场 4 小时时若报"补话窗口已过"没人看得懂）
  if (eligible.length === 0) {
    const rank = silenceWindow(silenceMs);
    const owner = WINDOW_OWNER[rank];
    const relevant = candidates.filter((c) => c.windows.includes(rank));
    const target = relevant.find((c) => c.channel === owner) ?? relevant[0] ?? candidates[0];
    const reason = target.check() ?? "no_signal";
    return skip(reason, `${CHANNEL_LABEL[target.channel]}：${SKIP_REASON_LABEL[reason]}`);
  }

  const picked = eligible[0];
  if (random() > picked.chance) {
    return skip(
      "probability_miss",
      `${CHANNEL_LABEL[picked.channel]}：这次随机没选中（概率 ${Math.round(picked.chance * 100)}%）`,
    );
  }

  return { action: "send", channel: picked.channel, detail: picked.detail };
}

/**
 * 链路 → 提示词注入。
 * 每条链路的说话姿态不同：补话不能催、开话题不能空泛、重启联系要收着。
 */
export function buildChannelNote(channel: ProactiveChannel, lifeDescription = ""): string {
  switch (channel) {
    case "follow_up":
      return [
        `你上一条消息对方还没回。别追问、别催、别撒娇，也别问"在吗"。`,
        `自然地补一句：说说你刚刚在做的一件小事，或者接着你上一条里提到的某个点再展开一两句。`,
        `一条就够，不要连发，不要提到"我没回你"这件事。`,
      ].join("\n");
    case "open_topic":
      return [
        `你们已经好几个小时没说话了。你忽然想到他，想主动说点什么。`,
        `从你此刻生活里一件具体的小事开头（吃了什么、看到什么、手上在做什么），`,
        `不要用"最近咋样""在干嘛"这种泛泛的开场。一两句就好。`,
      ].join("\n");
    case "silence_revive":
      return [
        `对方好几天没消息了。你有点在意，但语气要收着：不要质问、不要抱怨、不要连发。`,
        `像平常一样发一条，装作没那么在意，但你确实想他了。`,
      ].join("\n");
    case "life_share":
    default:
      return lifeDescription
        ? `你生活里发生了一件事：${lifeDescription}\n你想到了对方，觉得可以跟他说。`
        : "你此刻在自己生活里，想到对方，想跟他说句话。";
  }
}

/** 供 /why 与日志渲染 */
/**
 * 到点的「主动计划」是否允许绕过 decideProactive 的 skip。
 *
 * v0.8.14 原本允许计划由头绕过所有 skip，是为了避免「明确想说的话被随机概率吞掉」；
 * 但真机 2026-10-28 发现它会连「已经主动 N 条没被回」「今日上限」「间隔/免打扰/对方刚说完」
 * 这类硬治理一起绕过，导致用户不回时同一话题连续追发。
 * 因此只保留概率性 skip 可绕过；所有硬性治理一律生效。
 */
export function canPlannedTopicBypassSkip(decision: ProactiveDecision): boolean {
  return decision.action === "skip" && decision.reason === "probability_miss";
}

export function formatProactiveDecision(d: ProactiveDecision): string {
  return d.action === "send"
    ? `发送 · ${CHANNEL_LABEL[d.channel]}`
    : `跳过 · ${SKIP_REASON_LABEL[d.reason]}`;
}
