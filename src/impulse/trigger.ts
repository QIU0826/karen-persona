/**
 * 冲动触发管理（域六）。
 * Phase 4: 四种触发源 + 冲动强度计算。
 */

export type TriggerSource =
  | "external_event"    // 外部事件关联 →"想到你"
  | "internal_state"    // 内部状态波动 →"想分享/求助"
  | "user_silence"      // 用户沉默 →"你怎么不回我"
  | "exception";        // 破例冲动

export interface ImpulseTrigger {
  source: TriggerSource;
  description: string;
  intensity: number; // 0-1
  relatedMemory?: string; // 关联的 T2 记忆
  relatedChain?: string; // 关联的因果链
}

/**
 * 外部事件关联触发。
 * 人设生活中发生的事让她想到了用户。
 */
export function externalEventImpulse(
  eventDescription: string,
  closeness: number
): ImpulseTrigger | null {
  // 事件和用户的关联概率 = 亲密度 / 20
  const linkChance = closeness / 20;
  if (Math.random() > linkChance) return null;

  return {
    source: "external_event",
    description: eventDescription,
    intensity: 0.3 + Math.random() * 0.4,
  };
}

/**
 * 内部状态波动触发。
 * 情绪偏离基线 → 想分享（高 arousal）或求助（低 arousal）。
 */
export function internalStateImpulse(
  emotionVector: number,
  arousal: number,
  closeness: number
): ImpulseTrigger | null {
  const pressure = Math.abs(emotionVector);
  // 压力足够 + 亲密度够 → 可能产生冲动
  const chance = pressure * closeness / 10;
  if (Math.random() > chance) return null;

  const isShare = arousal > 0.5;
  return {
    source: "internal_state",
    description: isShare ? "今天超级开心，想跟你说" : "今天有点闷，想找人说话",
    intensity: pressure * (0.5 + arousal * 0.5),
  };
}

/**
 * 用户沉默触发。
 * 用户 N 小时没回复 → 按阶段产生不同强度的冲动。
 */
export function userSilenceImpulse(
  silenceHours: number,
  _closeness: number,
  attachmentStyle: string
): ImpulseTrigger | null {
  // 阶段1: < 6h → 不觉得有问题
  if (silenceHours < 6) return null;

  // 阶段2: 6-24h → 开始注意
  if (silenceHours < 24) {
    if (attachmentStyle === "焦虑型") {
      return { source: "user_silence", description: "开始有点担心了", intensity: 0.3 };
    }
    return null; // 安全型/回避型不行动
  }

  // 阶段3: 24-72h → 有行动
  if (silenceHours < 72) {
    const intensity = attachmentStyle === "焦虑型" ? 0.7 :
                       attachmentStyle === "回避型" ? 0 : 0.3;
    if (intensity === 0) return null;
    return {
      source: "user_silence",
      description: intensity > 0.5 ? "你是生我气了吗" : "你是不是很忙",
      intensity,
    };
  }

  // 阶段4: > 72h → 重启联系
  return {
    source: "user_silence",
    description: "最近咋样", // 假装什么都没发生
    intensity: 0.5,
  };
}

/**
 * 计算冲动是否通过消息门。
 * 日常冲动通过阈值 = 0.3，高强度情绪可以降低阈值。
 */
export function impulsePassesGate(
  impulse: ImpulseTrigger,
  baselineThreshold: number = 0.3
): boolean {
  // 情绪驱动的冲动降低阈值门槛
  const adjustedThreshold = impulse.source === "internal_state"
    ? baselineThreshold * 0.6
    : impulse.source === "user_silence"
    ? baselineThreshold * 0.4
    : baselineThreshold;

  return impulse.intensity > adjustedThreshold;
}
