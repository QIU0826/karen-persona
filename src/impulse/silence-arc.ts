/**
 * 沉默弧线管理（域六）。
 * Phase 4: 阶段 1-4 + 重启消息上下文感知。
 */

export type SilencePhase = 1 | 2 | 3 | 4;
export type SilenceType = "selective" | "avoidant" | "guilt_driven" | "forgotten";

export interface SilenceState {
  /** 用户最后一条消息的时间戳 */
  userLastMessageAt: number;
  /** 用户最后一条消息的内容 */
  userLastMessage: string;
  /** 当前阶段 */
  phase: SilencePhase;
  /** 是否已发送重启消息 */
  restartSent: boolean;
}

export function createSilenceState(): SilenceState {
  return {
    userLastMessageAt: Date.now(),
    userLastMessage: "",
    phase: 1,
    restartSent: false,
  };
}

/** 更新用户最后活动时间 */
export function touchUserActivity(state: SilenceState, message: string): SilenceState {
  return {
    ...state,
    userLastMessageAt: Date.now(),
    userLastMessage: message,
    phase: 1,
    restartSent: false,
  };
}

/**
 * 计算当前沉默阶段。
 */
export function getSilencePhase(state: SilenceState): SilencePhase {
  const hours = (Date.now() - state.userLastMessageAt) / (1000 * 60 * 60);
  if (hours < 6) return 1;
  if (hours < 24) return 2;
  if (hours < 72) return 3;
  return 4;
}

/**
 * 生成阶段 4 重启消息。
 * 重启消息 = f(沉默时长, 用户最后一条消息的内容权重)
 */
export function generateRestartMessage(
  state: SilenceState,
  userLastMessage: string
): string {
  const hasEmotionalWeight =
    /累|烦|难过|不开心|压力|生病|焦虑|不太|有点/.test(userLastMessage) &&
    userLastMessage.length >= 3;

  if (hasEmotionalWeight) {
    return "你还好吗"; // 关心本来的状态，不追问沉默原因
  }

  // 轻量级消息 → 假装什么都不知道
  return "最近咋样";
}

/**
 * 判断人设沉默的类型。
 */
export function classifySilence(
  reason: string,
  guilt: number
): SilenceType {
  if (guilt > 0.3) return "guilt_driven";
  if (reason.includes("回避") || reason.includes("不想聊")) return "avoidant";
  if (reason.includes("忘了") || reason.includes("没看到")) return "forgotten";
  return "selective";
}

/**
 * 沉默弧线结尾策略。
 * 决定沉默结束后以什么方式重新接触。
 */
export function silenceEndingStrategy(
  silenceType: SilenceType,
  closeness: number
): "explain" | "no_explain" | "new_topic" | "pretend_nothing" {
  switch (silenceType) {
    case "selective":
      return "no_explain"; // 自然收尾，不需要解释
    case "avoidant":
      return closeness > 5 ? "new_topic" : "pretend_nothing";
    case "guilt_driven":
      return closeness > 7 ? "explain" : "pretend_nothing";
    case "forgotten":
      return "explain"; // "上次那个我忘回了"
  }
}
