/**
 * 情绪状态机（域四核心）。
 * Phase 3: 情绪向量 + 基线偏移 + 冲动强度。
 * Phase 4: 接入演化引擎的基线漂移和觉察延迟。
 */

export interface EmotionState {
  /** 当前情绪向量，-1(极负) 到 1(极正) */
  vector: number;
  /** 情绪基线，中性为 0。Phase 4 会因累积事件缓慢漂移 */
  baseline: number;
  /** 当前情绪波动幅度 */
  arousal: number; // 0-1, 高 arousal = 激动(无论正负), 低 arousal = 平静
  /** 最后一次更新时间 */
  lastUpdated: number;
}

export function createEmotionState(baseline: number = 0): EmotionState {
  return {
    vector: baseline,
    baseline,
    arousal: 0.1,
    lastUpdated: Date.now(),
  };
}

/** 手动调整情绪偏移 */
export function adjustEmotion(
  state: EmotionState,
  delta: number,
  reason: string
): EmotionState {
  const newVector = Math.max(-1, Math.min(1, state.vector + delta));
  const newArousal = Math.min(1, state.arousal + Math.abs(delta) * 0.5);

  console.log(`[情绪] ${reason}: ${state.vector.toFixed(2)} → ${newVector.toFixed(2)} (delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`);

  return {
    ...state,
    vector: newVector,
    arousal: newArousal,
    lastUpdated: Date.now(),
  };
}

/**
 * 自然恢复——情绪向量缓慢向基线回归。
 * 每调用一次，向量向基线移动一小步。
 */
export function naturalRecover(state: EmotionState): EmotionState {
  const recoveryRate = 0.02; // 每次恢复的速率
  const distance = state.baseline - state.vector;
  if (Math.abs(distance) < 0.01) return state;

  const newVector = state.vector + distance * recoveryRate;
  const newArousal = Math.max(0.05, state.arousal * 0.95); // 平静下来

  return {
    ...state,
    vector: Math.round(newVector * 100) / 100,
    arousal: Math.round(newArousal * 100) / 100,
    lastUpdated: Date.now(),
  };
}

/**
 * 计算冲动强度。
 * 冲动 = 情绪强度 × arousal × 亲密度缩放
 */
export function calculateImpulseIntensity(
  state: EmotionState,
  closeness: number
): number {
  const emotionalPressure = Math.abs(state.vector - state.baseline);
  const closenessFactor = closeness / 10; // 0-1
  const intensity = emotionalPressure * (0.3 + state.arousal * 0.7) * (0.5 + closenessFactor * 0.5);
  return Math.min(1, Math.round(intensity * 100) / 100);
}

/** 情绪状态的文字描述 */
export function describeEmotion(state: EmotionState): string {
  const v = state.vector;
  const a = state.arousal;

  if (a < 0.15) return "平静";

  if (v > 0.5) return a > 0.6 ? "兴奋" : "开心";
  if (v > 0.2) return a > 0.6 ? "激动" : "愉悦";
  if (v > -0.2) return "中性";
  if (v > -0.5) return a > 0.6 ? "烦躁" : "闷闷不乐";
  return a > 0.6 ? "崩溃" : "低落";
}
