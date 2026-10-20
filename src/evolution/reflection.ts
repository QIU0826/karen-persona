/**
 * 反思循环（v0.8 剩余项）：把「觉察 → 否认 → 承认」做成真的三段弧线。
 *
 * 为什么需要：现在的演化是「后台参数漂移 + 每 7 天写一篇日记」，缺了中间那段——
 * 真人改变不是数据更新，是**先发现不对劲、再嘴硬、最后认下来**。没有这个过程，
 * 她要么永远不变，要么像被改设置一样突然变了。
 *
 * 本模块是纯状态机（可单测）：
 *  - `signal`：触发反思的现象（他说你最近话少了 / 你自己发现总在主动 / 冲突后反复想起）；
 *  - `phase`：觉察 → 否认 → 承认 → 整合；每段有停留时长与语气倾向；
 *  - 承认之后才允许「真的改」（输出 `applyChange` 建议，由调用方落到基线/语气/关系）；
 *  - 否认期不是失败：真人会嘴硬，反复被戳才承认（`pushCount`）。
 */

export type ReflectionPhase = "none" | "noticing" | "denying" | "admitting" | "integrating";

export type ReflectionSignalKind =
  | "user_pointed_out"   // 他明确说你变了/话少了/太黏
  | "self_observed"      // 自己发现（连续几轮冷场/总在主动/总在道歉）
  | "conflict_echo"      // 冲突之后还在想
  | "milestone";         // 关系跨过一个坎

export interface ReflectionState {
  phase: ReflectionPhase;
  /** 这次反思的由头（一句话，不含用户原文细节） */
  topic: string | null;
  signalKind: ReflectionSignalKind | null;
  /** 被戳次数：否认期需要反复推动 */
  pushCount: number;
  /** 进入当前 phase 的时间 */
  phaseSince: number;
  /** 是否已经改过（承认后只改一次） */
  changeApplied: boolean;
  updatedAt: number;
}

export const REFLECTION_PHASE_LABELS: Record<ReflectionPhase, string> = {
  none: "平静",
  noticing: "察觉到点什么",
  denying: "嘴硬",
  admitting: "认了",
  integrating: "慢慢改",
};

/** 各阶段的语气倾向（注入 prompt 用一句话） */
export const PHASE_TONE: Record<ReflectionPhase, string> = {
  none: "",
  noticing: "你隐约觉得自己这段时间有点不对劲，但还没细想",
  denying: "被说中时你会先否认，嘴上不肯承认（但心里知道）",
  admitting: "你终于愿意承认那件事了，语气会软一点、诚实一点",
  integrating: "你在慢慢调整，偶尔会自嘲一句以前的样子",
};

/** 各阶段的最短停留时长（毫秒）：否认期要撑一会儿，不能一戳就认 */
export const PHASE_DURATION_MS: Record<ReflectionPhase, number> = {
  none: 0,
  noticing: 2 * 3600_000,   // 2 小时
  denying: 6 * 3600_000,    // 6 小时（真人嘴硬得久一点）
  admitting: 12 * 3600_000, // 12 小时
  integrating: 72 * 3600_000,
};

export function createReflectionState(now = Date.now()): ReflectionState {
  return {
    phase: "none",
    topic: null,
    signalKind: null,
    pushCount: 0,
    phaseSince: now,
    changeApplied: false,
    updatedAt: now,
  };
}

/** 从「平静」进入「察觉」的门槛：同一类信号要出现够多次 */
export const SIGNAL_THRESHOLD = 2;

export interface ReflectionSignal {
  kind: ReflectionSignalKind;
  /** 一句话现象描述（给 prompt 当上下文，不落用户原文） */
  topic: string;
  /** 力度 0-1（他说得很重 = 1） */
  weight?: number;
}

/**
 * 喂一个信号，返回新的反思状态。
 *
 * 规则：
 * - 平静期：同类信号累计到 2 次才「察觉」（避免一句玩笑就被反思）；
 * - 察觉期：停留够久 → 进入否认（真人先嘴硬）；如果信号来自他直接点破，直接跳到否认；
 * - 否认期：被戳到 2 次（pushCount≥2）且停留够久 → 承认；
 * - 承认期：停留够久 → 整合；
 * - 整合期：停留够久 → 回到平静，并标记 changeApplied（只改一次）。
 */
export function applyReflectionSignal(
  state: ReflectionState,
  signal: ReflectionSignal,
  options: { now?: number; recentSignalCount?: number } = {},
): ReflectionState {
  const now = options.now ?? Date.now();
  const count = options.recentSignalCount ?? 1;
  const elapsed = now - state.phaseSince;

  switch (state.phase) {
    case "none": {
      // 他直接点破 → 跳过"自己察觉"，直接到「察觉」并准备好嘴硬
      const threshold = signal.kind === "user_pointed_out" ? 1 : SIGNAL_THRESHOLD;
      if (count < threshold) {
        return { ...state, updatedAt: now };
      }
      return {
        ...state,
        phase: "noticing",
        topic: signal.topic,
        signalKind: signal.kind,
        pushCount: 0,
        phaseSince: now,
        updatedAt: now,
      };
    }
    case "noticing": {
      const pushed = signal.kind === "user_pointed_out" || count >= 2;
      // 停留够久或又被戳 → 进入否认（先嘴硬）
      if (elapsed >= PHASE_DURATION_MS.noticing || pushed) {
        return {
          ...state,
          phase: "denying",
          topic: state.topic ?? signal.topic,
          pushCount: pushed ? 1 : state.pushCount,
          phaseSince: now,
          updatedAt: now,
        };
      }
      return { ...state, updatedAt: now };
    }
    case "denying": {
      const pushes = state.pushCount + (signal.kind === "user_pointed_out" ? 1 : 0);
      // 被反复戳（≥2）且待够 6 小时 → 承认
      if (pushes >= 2 && elapsed >= PHASE_DURATION_MS.denying) {
        return { ...state, phase: "admitting", pushCount: pushes, phaseSince: now, updatedAt: now };
      }
      return { ...state, pushCount: pushes, updatedAt: now };
    }
    case "admitting": {
      if (elapsed >= PHASE_DURATION_MS.admitting) {
        return { ...state, phase: "integrating", phaseSince: now, updatedAt: now };
      }
      return { ...state, updatedAt: now };
    }
    case "integrating": {
      if (elapsed >= PHASE_DURATION_MS.integrating) {
        return {
          ...state,
          phase: "none",
          topic: null,
          signalKind: null,
          pushCount: 0,
          phaseSince: now,
          changeApplied: true,
          updatedAt: now,
        };
      }
      return { ...state, updatedAt: now };
    }
    default:
      return state;
  }
}

/** 是否应该「真的改」（承认期已过一半，且还没改过）。 */
export function shouldApplyChange(state: ReflectionState, now = Date.now()): boolean {
  return (
    !state.changeApplied &&
    state.phase === "integrating" &&
    now - state.phaseSince >= PHASE_DURATION_MS.admitting / 2
  );
}

/**
 * 生成反思的「自我陈述」（她心里的话，不直接发出去）。
 * 用于写进独白/日志，以及承认期的一两句软话。
 */
export function buildReflectionStatement(state: ReflectionState): string | null {
  if (!state.topic) return null;
  switch (state.phase) {
    case "noticing":
      return `好像……${state.topic}。是不是我自己也有点问题。`;
    case "denying":
      return `哪有，${state.topic}又怎么样，我又没做错什么。`;
    case "admitting":
      return `好吧，${state.topic}。我承认，是有点。`;
    case "integrating":
      return `${state.topic}这事，我以后注意点。`;
    default:
      return null;
  }
}

/** 注入 prompt 的一句话（只在非平静期出现，避免长期污染上下文）。 */
export function buildReflectionInjection(state: ReflectionState): string {
  const tone = PHASE_TONE[state.phase];
  if (!tone) return "";
  const topic = state.topic ? `（关于：${state.topic}）` : "";
  return `\n「心里的坎」${tone}${topic}\n`;
}

/** 从现象字符串里判断是否在说他"你变了/你话少了/你太黏"这类点破。 */
export function looksLikeUserPointingOut(text: string): boolean {
  const t = text ?? "";
  return /(你最近|你这两天|你有点|你是不是|你怎么老是|你怎么总|你变了|你话变|你话少|你太黏|你冷淡)/.test(t);
}
