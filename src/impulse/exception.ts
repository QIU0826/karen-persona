/**
 * 破例冲动（域六）。
 * Phase 4: 破例阈值 + 破例自我觉察。
 */

export interface ExceptionState {
  /** 基础冲动阈值（由 L3 说话风格决定） */
  baseThreshold: number;
  /** 破例历史记录 */
  history: Array<{
    date: string;
    action: string;
    wasException: boolean;
    hadSelfAwareness: boolean;
  }>;
}

/**
 * 计算破例阈值。
 * 破例阈值 = 基础阈值 × 亲密度折扣 × 情绪折扣 × 相关性加权
 */
export function calculateExceptionThreshold(
  baseThreshold: number,
  closeness: number,
  emotionIntensity: number,
  relevanceToUser: number
): number {
  const closenessDiscount = 1 - (closeness / 10) * 0.5; // 越亲密阈值越低
  const emotionDiscount = 1 - Math.abs(emotionIntensity) * 0.3; // 情绪越强阈值越低
  const relevanceBoost = 1 - relevanceToUser * 0.4; // 越关乎用户阈值越低

  return baseThreshold * closenessDiscount * emotionDiscount * relevanceBoost;
}

/**
 * 判断是否为破例。
 * 常规：冲动强度 > 消息门阈值 → 发出
 * 破例：冲动强度 < 消息门阈值 → 但突破了破例阈值 → 发出
 */
export function isException(
  impulseIntensity: number,
  gateThreshold: number,
  exceptionThreshold: number
): boolean {
  // 正常通过门的不算破例
  if (impulseIntensity >= gateThreshold) return false;
  // 没通过门但突破了破例阈值 → 破例
  return impulseIntensity >= exceptionThreshold;
}

/**
 * 破例后的自我觉察消息。
 * 不同人设类型的破例表达方式不同。
 */
export function exceptionSelfAwareness(
  personaType: "高冷型" | "回避型" | "话痨型" | "安全型",
  action: string
): string | null {
  switch (personaType) {
    case "高冷型":
      // 破例本身就是最大的亲密信号
      if (Math.random() > 0.6) {
        return "……我居然主动找你了。这不像我。……算了当我没说。";
      }
      return null;

    case "回避型":
      // 破例 → 立刻后悔 → 可能撤回
      if (Math.random() > 0.5) {
        return "我没发什么。……好吧我发了。你就当我今天不太正常。";
      }
      return null;

    case "话痨型":
      // 不叫破例，叫日常
      return null;

    default:
      return Math.random() > 0.8 ? "我今天好像话有点多……" : null;
  }
}

/**
 * 推断人设类型标签。
 */
export function inferPersonaType(
  speakingStyle: string,
  attachmentStyle: string
): "高冷型" | "回避型" | "话痨型" | "安全型" {
  if (attachmentStyle === "回避型") return "回避型";
  if (speakingStyle.includes("话痨") || speakingStyle.includes("活跃")) return "话痨型";
  if (speakingStyle.includes("高冷") || speakingStyle.includes("寡言")) return "高冷型";
  return "安全型";
}
