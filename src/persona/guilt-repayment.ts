/**
 * 负债偿还追踪（域四核心）。
 * Phase 3: guilt/resentment 状态机 + 三种偿还结局 + 逃避偿还。
 */

export interface GuiltState {
  /** 未清偿的负债 0-1 */
  guilt: number;
  /** 未被确认的委屈积累 0-1 */
  resentment: number;
  /** 待确认的偿还尝试 */
  pendingRepayment: {
    attempted: boolean;
    action: string;
    timestamp: number;
    confirmed: "pending" | "accepted" | "rejected" | "unnoticed";
    unnoticedCount: number;
  } | null;
}

export function createGuiltState(): GuiltState {
  return {
    guilt: 0,
    resentment: 0,
    pendingRepayment: null,
  };
}

/** 制造负债 */
export function incurGuilt(state: GuiltState, amount: number, reason: string): GuiltState {
  const newGuilt = Math.min(1, state.guilt + amount);
  console.log(`[负债] +${amount.toFixed(2)} → guilt=${newGuilt.toFixed(2)} (${reason})`);
  return { ...state, guilt: newGuilt };
}

/**
 * 记录偿还尝试。
 * 人设做了补偿行为，等待用户反应。
 */
export function attemptRepayment(
  state: GuiltState,
  action: string
): GuiltState {
  if (state.guilt < 0.05) return state; // 没有负债，无需偿还

  console.log(`[偿还] 尝试: ${action} (guilt=${state.guilt.toFixed(2)})`);
  return {
    ...state,
    pendingRepayment: {
      attempted: true,
      action,
      timestamp: Date.now(),
      confirmed: "pending",
      unnoticedCount: state.pendingRepayment?.unnoticedCount ?? 0,
    },
  };
}

/**
 * 用户反馈到达 → 确认偿还结果。
 * 结局A: 接受 → guilt 大幅消解
 * 结局B: 拒绝 → guilt 加深
 * 结局C: 未注意 → guilt 表面消解但 resentment 积累
 */
export function confirmRepayment(
  state: GuiltState,
  userResponse: "accepted" | "rejected" | "unnoticed"
): GuiltState {
  if (!state.pendingRepayment || !state.pendingRepayment.attempted) return state;

  switch (userResponse) {
    case "accepted": {
      const reduction = Math.min(state.guilt, 0.6);
      console.log(`[偿还] ✅ 对方接受 → guilt ${state.guilt.toFixed(2)} → ${(state.guilt - reduction).toFixed(2)}`);
      return {
        ...state,
        guilt: Math.round((state.guilt - reduction) * 100) / 100,
        resentment: Math.max(0, state.resentment - 0.2),
        pendingRepayment: null,
      };
    }

    case "rejected": {
      const increase = 0.2;
      console.log(`[偿还] ❌ 对方拒绝 → guilt 加深 +${increase}`);
      return {
        ...state,
        guilt: Math.min(1, state.guilt + increase),
        resentment: Math.min(1, state.resentment + 0.1),
        pendingRepayment: null,
      };
    }

    case "unnoticed": {
      const unnoticedCount = (state.pendingRepayment.unnoticedCount || 0) + 1;
      console.log(`[偿还] ⚠ 对方未注意 (第${unnoticedCount}次) → resentment 积累`);
      return {
        ...state,
        guilt: Math.max(0, state.guilt - 0.15), // 表面消解一点
        resentment: Math.min(1, state.resentment + 0.3),
        pendingRepayment: {
          ...state.pendingRepayment,
          confirmed: "unnoticed",
          unnoticedCount,
        },
      };
    }
  }
}

/**
 * 自然衰减：guilt 每天衰减 0.02，resentment 不自然衰减（只有被确认后才消解）
 */
export function dailyDecay(state: GuiltState): GuiltState {
  return {
    ...state,
    guilt: Math.max(0, state.guilt - 0.02),
    // resentment 不自然衰减
  };
}

/**
 * resentment 对行为的可见影响。
 */
export function resentmentEffect(state: GuiltState): {
  replyDelay: boolean;
  passiveAggressive: boolean;
  withdrawal: boolean;
} {
  const r = state.resentment;
  return {
    replyDelay: r > 0.3,       // 回复变慢
    passiveAggressive: r > 0.5, // 被动攻击
    withdrawal: r > 0.7,       // 明显撤回
  };
}
