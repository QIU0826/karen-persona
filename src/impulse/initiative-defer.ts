/**
 * 深夜主动冲动的「早上补发」（v0.9.18）。
 *
 * 问题（CLAUDE 已知问题）：她深夜想找你，被免打扰挡下后**这个冲动就消失了**——
 * 第二天早上她不会想起来，只会等新的随机由头。用户体感是"她晚上想说话，早上就忘了"。
 *
 * 做法：被深夜门挡下时把冲动存进持久化状态（来源/她的生活素材/强度/时间），
 * 第二天免打扰结束后（7:00 起）：
 *  - 他在这期间回过来 / 她已经主动发过 → 丢弃（已经聊上了，旧冲动过期）；
 *  - 超过 12 小时 → 丢弃（别拿昨天的事硬说）；
 *  - 否则作为高优先级候选复用，并在描述里注明「昨晚没发出去、现在自然地说，
 *    不要提系统/延迟」。
 *
 * 纯函数，便于单测；不碰 IO。
 */
/** 与 orchestrator 里 ImpulseCandidate 结构兼容的最小形状（避免循环依赖）。 */
export interface ImpulseCandidateLike {
  source: string;
  description: string;
  intensity: number;
  priority: number;
}

/** 被深夜门挡下的冲动快照（持久化到 persona-state）。 */
export interface DeferredImpulse {
  /** 被挡下的时间戳 */
  at: number;
  /** 触发源：因果链/天气/情绪/时间/主动计划 */
  source: string;
  /** 她生活中正在发生的事（注入 prompt 的素材） */
  description: string;
  intensity: number;
}

/** 超过这个时长就不再补发（别拿昨天的情绪硬说）。 */
export const DEFERRED_IMPULSE_TTL_MS = 12 * 60 * 60 * 1000;

export type DeferredResolution =
  | { action: "none" }
  | { action: "wait"; reason: string }
  | { action: "drop"; reason: string }
  | { action: "reuse"; reason: string; impulse: DeferredImpulse };

export interface ResolveDeferredInput {
  deferred: DeferredImpulse | null | undefined;
  now: number;
  hour: number;
  /** 最后一次用户消息时间（毫秒），无消息为 null */
  userLastMessageAt: number | null;
  /** 上次主动消息时间（0/null 表示从没发过） */
  lastProactiveSentAt: number | null;
  /** 免打扰起止（小时，与 config 的 quiet_hours_start/end 一致；start==end 视为关闭） */
  quietHours?: { startHour?: number; endHour?: number };
}

/** 是否在免打扰时段内（与 config 一致：小时粒度，start > end 视为跨夜）。 */
export function inQuietHours(
  hour: number,
  quietHours?: { startHour?: number; endHour?: number },
): boolean {
  const clampHour = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 23
      ? Math.floor(value)
      : fallback;
  const start = clampHour(quietHours?.startHour, 23);
  const end = clampHour(quietHours?.endHour, 7);
  if (start === end) return false;
  const current = Math.floor(hour);
  return start > end ? current >= start || current < end : current >= start && current < end;
}

/**
 * 决定一个被挡下的冲动现在该怎么处理。
 * 调用方只在「非免打扰 + 有心跳」时处理，因此这里主要判断过期/复用。
 */
export function resolveDeferredImpulse(input: ResolveDeferredInput): DeferredResolution {
  const { deferred } = input;
  if (!deferred || !Number.isFinite(deferred.at) || deferred.at <= 0) {
    return { action: "none" };
  }
  if (!deferred.description.trim()) return { action: "drop", reason: "empty_description" };

  const age = input.now - deferred.at;
  if (age < 0) return { action: "drop", reason: "clock_skew" };
  if (age > DEFERRED_IMPULSE_TTL_MS) return { action: "drop", reason: "stale" };

  const quiet = inQuietHours(Math.floor(input.hour), input.quietHours);
  if (quiet) return { action: "wait", reason: "still_quiet_hours" };

  // 他之后来过消息 → 已经聊上了，不需要再补
  if (input.userLastMessageAt !== null && input.userLastMessageAt > deferred.at) {
    return { action: "drop", reason: "user_replied_since" };
  }
  // 她之后已经主动发过 → 冲动已被别的链路消化
  if (input.lastProactiveSentAt !== null && input.lastProactiveSentAt > deferred.at) {
    return { action: "drop", reason: "already_sent_since" };
  }
  return { action: "reuse", reason: "morning_pickup", impulse: deferred };
}

/**
 * 把被挡下的冲动变成一个高优先级候选。
 * 描述里明确「昨晚没发出去、现在自然地说」——避免模型说出"系统不让我发"这类出戏的话。
 */
export function buildDeferredCandidate(impulse: DeferredImpulse): ImpulseCandidateLike {
  return {
    source: "早上想起",
    description:
      `${impulse.description}（这是你昨晚没发出去、现在才想起要跟他说的；` +
      `自然地提，别解释为什么昨晚没说。）`,
    intensity: Math.max(0.35, Math.min(0.9, impulse.intensity)),
    priority: 8,
  };
}

/** 从一次被挡下的候选构造持久化快照（只存第一候选的素材，控制体积）。 */
export function createDeferredImpulse(
  now: number,
  candidate: Pick<ImpulseCandidateLike, "source" | "description" | "intensity">,
): DeferredImpulse {
  return {
    at: now,
    source: candidate.source,
    description: candidate.description,
    intensity: candidate.intensity,
  };
}

/** 状态文件里的字段可能来自旧版本/手改；做一次容错归一化。 */
export function normalizeDeferredImpulse(raw: unknown): DeferredImpulse | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0;
  const source = typeof record.source === "string" ? record.source : "";
  const description = typeof record.description === "string" ? record.description : "";
  const intensity =
    typeof record.intensity === "number" && Number.isFinite(record.intensity)
      ? record.intensity
      : 0.4;
  if (at <= 0 || !description.trim()) return null;
  return { at, source, description: description.slice(0, 200), intensity };
}
