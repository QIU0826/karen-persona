/**
 * 情绪基线漂移（域五）。
 * Phase 4: 事件强度加权累积 + 觉察延迟 + 回弹残留。
 */

export interface DriftState {
  /** 后台实际基线 */
  actualBaseline: number;
  /** 人设自我报告的基线（觉察延迟后的值） */
  perceivedBaseline: number;
  /** 累积的漂移压力 */
  pressure: number;
  /** 上次觉察时间 */
  lastAwareness: number;
  /** 漂移历史记录 */
  history: Array<{ date: string; from: number; to: number; reason: string }>;
}

export function createDriftState(initialBaseline: number = 0): DriftState {
  return {
    actualBaseline: initialBaseline,
    perceivedBaseline: initialBaseline,
    pressure: 0,
    lastAwareness: Date.now(),
    history: [],
  };
}

/**
 * 添加漂移压力。
 * 事件强度 × 新近度权重 → 累积压力。
 * 近的事件权重大，远的衰减。
 */
export function addDriftPressure(
  state: DriftState,
  eventIntensity: number,
  daysAgo: number = 0
): DriftState {
  const recencyWeight = Math.exp(-daysAgo / 7); // 7 天半衰期
  state.pressure += eventIntensity * recencyWeight;

  // 压力超过阈值 → 基线偏移
  if (Math.abs(state.pressure) > 0.3) {
    const shift = Math.sign(state.pressure) * 0.05;
    const oldBaseline = state.actualBaseline;
    state.actualBaseline = Math.max(-0.3, Math.min(0.3, state.actualBaseline + shift));
    state.pressure *= 0.5; // 释放一半压力

    state.history.push({
      date: new Date().toISOString(),
      from: oldBaseline,
      to: state.actualBaseline,
      reason: `漂移压力累积 ${state.pressure.toFixed(2)}`,
    });

    console.log(
      `[基线漂移] ${oldBaseline.toFixed(2)} → ${state.actualBaseline.toFixed(2)} (压力: ${state.pressure.toFixed(2)})`
    );
  }

  return state;
}

/**
 * 单次高强度事件直接触发漂移。
 */
export function intenseEventImpact(
  state: DriftState,
  intensity: number,
  reason: string
): DriftState {
  // 高强度事件跳过累积，直接偏移
  const shift = intensity * 0.2 * (Math.random() > 0.5 ? 1 : -1);
  const oldBaseline = state.actualBaseline;
  state.actualBaseline = Math.max(-0.3, Math.min(0.3, state.actualBaseline + shift));

  state.history.push({
    date: new Date().toISOString(),
    from: oldBaseline,
    to: state.actualBaseline,
    reason,
  });

  console.log(`[基线漂移-高强度] ${reason}: ${oldBaseline.toFixed(2)} → ${state.actualBaseline.toFixed(2)}`);
  return state;
}

/**
 * 觉察检查。
 * 满足条件 → 人设"意识到"自己的基线变化。
 */
export function checkAwareness(
  state: DriftState,
  userPointedOut: boolean = false
): { aware: boolean; message: string | null } {
  const gap = Math.abs(state.actualBaseline - state.perceivedBaseline);
  const daysSinceLast = (Date.now() - state.lastAwareness) / (1000 * 60 * 60 * 24);

  // 用户点破 → 立即觉察
  if (userPointedOut && gap > 0.05) {
    state.perceivedBaseline = state.actualBaseline;
    state.lastAwareness = Date.now();
    return { aware: true, message: "……是有一点，我自己都没注意到。" };
  }

  // 自发觉察：gap > 0.15 且距上次 > 14 天
  if (gap > 0.15 && daysSinceLast > 14) {
    const old = state.perceivedBaseline;
    state.perceivedBaseline = state.actualBaseline;
    state.lastAwareness = Date.now();
    const direction = state.actualBaseline > old ? "最近好像状态好一点了" : "最近不知道怎么了，有点闷";
    return { aware: true, message: direction };
  }

  return { aware: false, message: null };
}

/**
 * 自然回弹：每天向初始基线恢复一点点。
 * 保留 20% 残留。
 */
export function dailyRebound(state: DriftState, initialBaseline: number): DriftState {
  const distance = initialBaseline - state.actualBaseline;
  if (Math.abs(distance) < 0.01) return state;

  const rebound = distance * 0.02 * 0.8; // 80% 可回弹
  state.actualBaseline = Math.round((state.actualBaseline + rebound) * 100) / 100;

  // 感知基线也缓慢跟进
  state.perceivedBaseline += (state.actualBaseline - state.perceivedBaseline) * 0.01;

  return state;
}

/** 获取 baseline-drift 对情绪状态机的影响值 */
export function getDriftOffset(state: DriftState): number {
  return state.actualBaseline;
}
