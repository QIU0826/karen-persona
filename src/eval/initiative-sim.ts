/**
 * 意图式主动性离线模拟（纯函数，v0.8.13）。
 *
 * 为什么需要：主动消息（心跳）是「她有自己的生活」的核心卖点，但
 *  - 21 轮真实回归都是**主动对话**，心跳永远不会触发；
 *  - 旧 `proactive-sim.ts` 只覆盖 v0.4 的四条链路，**没覆盖 v0.8 的意图式主动**
 *    （每日由头 → 到点挑选 → 回复率校准）；
 *  - 真机观察要等真实被冷落 10 分钟才有样本。
 *
 * 这里把「一整天 96 次心跳 × 四种关系热度」跑一遍，产出可断言的结果与产品红线。
 * 零成本：不调用模型，计划由测试数据构造。
 */
import {
  calibratedDailyCap,
  markInitiativeUsed,
  pickDueInitiative,
  type DailyInitiativePlan,
  type InitiativeItem,
} from "../impulse/initiative-plan.js";

export interface SimItem {
  topic: string;
  kind: InitiativeItem["kind"];
  windowStart: number;
  windowEnd: number;
  urgency: number;
}

export interface DayProfile {
  day: string;
  /** 最近 10 次主动消息里他回复了几次（0–10） */
  repliesToInitiative: number;
  /** 最近 10 条他消息里主动找她几次（0–10） */
  hisInitiatives: number;
  closeness: number;
  items: SimItem[];
  /** 是否发过主动消息（默认 true；全新关系传 false） */
  hasSentHistory?: boolean;
}

export interface SentRecord {
  /** 当天第几分钟（0–1439） */
  minuteOfDay: number;
  topic: string;
  kind: string;
}

export interface DaySimResult {
  profile: string;
  cap: number;
  capReason: string;
  sent: SentRecord[];
  skipReasons: Record<string, number>;
  /** 心跳次数 */
  beats: number;
}

/** 她一天的由头：生活里的事 / 没聊完的话题 / 想他（按时间窗） */
export const DEFAULT_DAY_ITEMS: SimItem[] = [
  { topic: "下午被老板叫去谈话，有点闷", kind: "life_event", windowStart: 19, windowEnd: 23, urgency: 0.6 },
  { topic: "裁员的传闻到底怎么样了", kind: "open_thread", windowStart: 21, windowEnd: 24, urgency: 0.5 },
  { topic: "有点想他", kind: "missing_you", windowStart: 22, windowEnd: 24, urgency: 0.3 },
];

/** 四种关系热度：热络 / 正常 / 冷淡 / 生疏（生疏 = 亲密度低） */
export const DEFAULT_PROFILES: DayProfile[] = [
  { day: "热络", repliesToInitiative: 8, hisInitiatives: 5, closeness: 6.5, items: DEFAULT_DAY_ITEMS },
  { day: "正常", repliesToInitiative: 5, hisInitiatives: 2, closeness: 5, items: DEFAULT_DAY_ITEMS },
  { day: "冷淡", repliesToInitiative: 1, hisInitiatives: 0, closeness: 4, items: DEFAULT_DAY_ITEMS },
  { day: "生疏", repliesToInitiative: 3, hisInitiatives: 1, closeness: 2.5, items: DEFAULT_DAY_ITEMS },
  // v0.8.14：全新关系（她还没主动过）——应试探 1 条，而不是死锁 0 条
  { day: "全新", repliesToInitiative: 0, hisInitiatives: 0, closeness: 1.5, items: DEFAULT_DAY_ITEMS, hasSentHistory: false },
];

export const SIM_BEAT_INTERVAL_MINUTES = 15;
export const SIM_QUIET_HOURS = { start: 2, end: 7 };
export const SIM_MIN_GAP_MINUTES = 30;

function makePlan(day: string, items: SimItem[]): DailyInitiativePlan {
  return {
    day,
    createdAt: 0,
    items: items.map((item) => ({ ...item, used: false })),
  };
}

/** 跑一天（24h × 每 15 分钟一次心跳） */
export function simulateDay(profile: DayProfile): DaySimResult {
  const { cap, reason } = calibratedDailyCap({
    repliesToInitiative: profile.repliesToInitiative,
    hisInitiatives: profile.hisInitiatives,
    closeness: profile.closeness,
    hasSentHistory: profile.hasSentHistory ?? true,
  });
  let plan = makePlan(profile.day, profile.items);
  const sent: SentRecord[] = [];
  let lastSentAtMin: number | null = null;
  const skipReasons: Record<string, number> = {};
  let beats = 0;

  for (let minutes = 0; minutes < 24 * 60; minutes += SIM_BEAT_INTERVAL_MINUTES) {
    beats += 1;
    const hour = Math.floor(minutes / 60) % 24;
    const decision = pickDueInitiative(plan, {
      hour,
      closeness: profile.closeness,
      sentToday: sent.length,
      dailyCap: cap,
      minutesSinceLast: lastSentAtMin === null ? null : minutes - lastSentAtMin,
      minGapMinutes: SIM_MIN_GAP_MINUTES,
      quietHours: SIM_QUIET_HOURS,
      userRecentlyReplied: false,
    });
    if (decision.action === "send") {
      lastSentAtMin = minutes;
      sent.push({ minuteOfDay: minutes, topic: decision.item.topic, kind: decision.item.kind });
      plan = markInitiativeUsed(plan, decision.item.topic);
    } else {
      skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
    }
  }
  return { profile: profile.day, cap, capReason: reason, sent, skipReasons, beats };
}

export interface RedlineFailure {
  profile: string;
  message: string;
}

/** 产品红线：跑完后校验这些必须成立 */
export function checkRedlines(results: DaySimResult[]): RedlineFailure[] {
  const failures: RedlineFailure[] = [];
  const byProfile = new Map(results.map((r) => [r.profile, r]));

  for (const r of results) {
    if (r.sent.length > Math.min(r.cap, 3)) {
      failures.push({ profile: r.profile, message: `发出 ${r.sent.length} 条超过日上限 ${r.cap}` });
    }
    // 免打扰时段绝不能发（02:00–07:00）
    for (const item of r.sent) {
      const hour = Math.floor(item.minuteOfDay / 60);
      if (hour >= SIM_QUIET_HOURS.start && hour < SIM_QUIET_HOURS.end) {
        failures.push({ profile: r.profile, message: `免打扰时段发消息（${hour} 点）` });
      }
    }
    // 同一天两条主动消息至少间隔 30 分钟
    for (let i = 1; i < r.sent.length; i++) {
      const gap = r.sent[i]!.minuteOfDay - r.sent[i - 1]!.minuteOfDay;
      if (gap < SIM_MIN_GAP_MINUTES) {
        failures.push({ profile: r.profile, message: `两条主动消息只隔 ${gap} 分钟` });
      }
    }
    // 每条由头当天只用一次
    const topics = r.sent.map((s) => s.topic);
    if (new Set(topics).size !== topics.length) {
      failures.push({ profile: r.profile, message: "同一条由头发了两次" });
    }
  }

  const hot = byProfile.get("热络");
  if (hot && hot.sent.length < 1) {
    failures.push({ profile: "热络", message: "回复率很高却一条都没发（过分保守）" });
  }
  const cold = byProfile.get("冷淡");
  if (cold && cold.sent.length > 0) {
    failures.push({ profile: "冷淡", message: "回复率 <20% 仍在主动（该收敛）" });
  }
  const fresh = byProfile.get("全新");
  if (fresh && fresh.sent.length === 0) {
    failures.push({ profile: "全新", message: "全新关系一条都不发（会死锁：不发→没回复→更不敢发）" });
  }
  const distant = byProfile.get("生疏");
  if (distant && distant.sent.some((s) => s.kind === "missing_you")) {
    failures.push({ profile: "生疏", message: "亲密度低时发「有点想他」（太早太黏）" });
  }
  return failures;
}
