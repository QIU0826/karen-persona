/**
 * 社交分寸 social_tact（域四 / L5 子属性）。
 * Phase 3: 感知精度 + 配合意愿。
 */

export interface SocialTact {
  /** 读气氛的能力 0-1。1=极其敏锐 */
  perceptionAccuracy: number;
  /** 愿意配合的程度 0-1。1=高度配合，0=不迁就 */
  cooperationWillingness: number;
}

/**
 * 根据 L4 依恋类型创建默认社交分寸。
 * 注意：这个推导是"默认值"，用户可以覆盖。
 * 回避型 ≠ 低感知，回避型往往是高感知低配合。
 */
export function createSocialTact(attachmentStyle: string): SocialTact {
  switch (attachmentStyle) {
    case "安全型":
      return { perceptionAccuracy: 0.65, cooperationWillingness: 0.7 };
    case "焦虑型":
      // 高感知但过度配合，由恐惧驱动
      return { perceptionAccuracy: 0.75, cooperationWillingness: 0.9 };
    case "回避型":
      // 高感知但低配合：读得懂但选择不迁就
      return { perceptionAccuracy: 0.8, cooperationWillingness: 0.3 };
    case "混乱型":
      return { perceptionAccuracy: 0.5, cooperationWillingness: 0.5 };
    default:
      return { perceptionAccuracy: 0.6, cooperationWillingness: 0.6 };
  }
}

/**
 * 在给定亲密度下，人设会暴露多少真实态度。
 * 暴露比例 = 基础配合意愿 × 亲密度缩放 × 感知精度的调节
 *
 * 感知精度高 → 更清楚什么该说什么不该说
 * 配合意愿高 → 更愿意迁就对方
 * 亲密度高 → 更少伪装
 */
export function exposureRatio(
  tact: SocialTact,
  closeness: number
): number {
  const closenessFactor = closeness / 10; // 越亲密越真实
  // 低亲密度时配合意愿主导（礼貌版本），高亲密度时越来越真实
  const ratio = tact.cooperationWillingness * (1 - closenessFactor) + closenessFactor;
  return Math.round(ratio * 100) / 100;
}

/**
 * 判断"关门式表达"（"我不想聊这个"）在当前亲密度下的含义。
 * 低亲密度关门 = 推开 = 可能产生轻微负债
 * 高亲密度关门 = 不需要解释 = 无负债
 */
export function analyzeDoorClosing(
  _tact: SocialTact,
  closeness: number
): {
  isDoorClosing: boolean;
  needsSoften: boolean;
  perceivedByUser: "rejection" | "trust" | "neutral";
} {
  if (closeness < 3) {
    return { isDoorClosing: true, needsSoften: true, perceivedByUser: "rejection" };
  }
  if (closeness < 7) {
    return { isDoorClosing: true, needsSoften: closeness < 5, perceivedByUser: "neutral" };
  }
  return { isDoorClosing: true, needsSoften: false, perceivedByUser: "trust" };
}
