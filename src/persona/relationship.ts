/**
 * 关系成长（M1-2）。
 *
 * 设计原则：
 * - 亲密度不是「聊得越多涨得越快」，而是由**结构性事件**驱动：深度对话、连续多天互动、
 *   主动分享生活细节。绝对不使用关键词检测情绪/讨好程度。
 * - 增长缓慢、有每日上限（默认 +0.1/天），并且全程可解释（每条变化都有 reason）。
 * - 只增不减（M1 保守策略）：缺席不惩罚用户，避免情感陪伴产品里的「冷暴力式」设计。
 * - 阈值跨越时记录里程碑，供关系时间线展示（M1-3）。
 */
import type { MessageComplexity } from "../ai/router.js";

/** 一次关系变化事件（供时间线展示） */
export interface RelationshipEvent {
  at: number;
  delta: number;
  closeness: number;
  reason: string;
}

/** 关系里程碑（只增不减，按阈值记录一次） */
export interface RelationshipMilestone {
  id: string;
  at: number;
  title: string;
  closeness: number;
}

import { createRelationshipDims, type RelationshipDims } from "./relationship-dims.js";

export interface RelationshipState {
  /** v0.8：五维关系（亲密/信任/张力/互惠/依赖）；老状态缺省时按 closeness 生成 */
  dims?: RelationshipDims;
  /** 当前亲密度 0-10，保留 2 位小数 */
  closeness: number;
  /** 最近的事件（最多保留 200 条） */
  events: RelationshipEvent[];
  /** 已达成的里程碑 */
  milestones: RelationshipMilestone[];
  /** 最后一次关系评估时间戳 */
  lastEvaluatedAt: number;
  /** 上一次互动发生的自然日（YYYY-M-D），用于「连续多天」判定 */
  lastInteractionDay: string;
  /** 连续互动的天数 */
  interactionStreak: number;
  /** 当天已获得的亲密度增量（正数部分，用于每日上限） */
  dailyGain: number;
  /** dailyGain 所属自然日 */
  dailyGainDay: string;
  /** 最近一次「冲突/越界」时间戳（用于修复窗口判定；null=没有未化解的冲突） */
  lastConflictAt: number | null;
  /** 最近一次冲突的原因（简短描述，不含用户原文） */
  lastConflictReason: string | null;
}

/** 每日亲密度增长上限 */
export const MAX_DAILY_GAIN = 0.1;
/** 亲密度上限 / 下限 */
export const MAX_CLOSENESS = 10;
export const MIN_CLOSENESS = 0;

/** 里程碑阈值（跨过即记录） */
const MILESTONES: Array<{ threshold: number; id: string; title: string }> = [
  { threshold: 3.5, id: "getting-familiar", title: "开始熟络起来" },
  { threshold: 5, id: "starting-to-care", title: "开始有点在意" },
  { threshold: 7, id: "quite-close", title: "变得很亲近" },
  { threshold: 9, id: "important-person", title: "成为重要的人" },
];

export function createRelationshipState(initialCloseness: number): RelationshipState {
  const closeness = clamp(initialCloseness);
  return {
    closeness,
    dims: createRelationshipDims(closeness),
    events: [],
    milestones: [],
    lastEvaluatedAt: 0,
    lastInteractionDay: "",
    interactionStreak: 0,
    dailyGain: 0,
    dailyGainDay: "",
    lastConflictAt: null,
    lastConflictReason: null,
  };
}

function clamp(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.max(MIN_CLOSENESS, Math.min(MAX_CLOSENESS, rounded));
}

/** 本地自然日 key（YYYY-M-D） */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/** 昨天/今天的自然日差（用于连续互动判定） */
function isConsecutiveDay(prevDay: string, currentDay: string): boolean {
  if (!prevDay) return false;
  const [py, pm, pd] = prevDay.split("-").map(Number);
  const [cy, cm, cd] = currentDay.split("-").map(Number);
  if (![py, pm, pd, cy, cm, cd].every((n) => Number.isFinite(n))) return false;
  const prev = Date.UTC(py, pm - 1, pd);
  const curr = Date.UTC(cy, cm - 1, cd);
  return curr - prev === 24 * 60 * 60 * 1000;
}

export interface RelationshipEvaluationInput {
  /** 当前亲密度（来自 persona.relationship.closeness / 持久化状态） */
  currentCloseness: number;
  /** 用户本轮消息 */
  userText: string;
  /** 她本轮的最终回复（已渲染前/后的合并文本均可） */
  replyText: string;
  /** 消息复杂度（由 ai/router 规则分级） */
  complexity: MessageComplexity;
  /** 当前负债（冲突信号，仅用于避免在冲突时涨亲密） */
  guilt: number;
  /** 用户本轮是否越界（由 content/boundary 粗筛 + 调用方判定） */
  isBoundaryViolation?: boolean;
  /** 用户本轮是否在道歉/修复 */
  isApology?: boolean;
  now?: Date;
}

export interface RelationshipEvaluation {
  delta: number;
  reason: string;
  /** 本次事件是否属于冲突/越界（写入 lastConflictAt） */
  conflict?: boolean;
  /** 本次事件是否属于修复（清除未化解冲突） */
  repair?: boolean;
}

/**
 * 评估本轮是否产生关系变化。
 * 只返回「结构性事件」带来的增量，且已经过每日上限裁剪。
 * 同一天多次触发同一类事件只计一次。
 */
export function evaluateRelationshipEvent(
  state: RelationshipState,
  input: RelationshipEvaluationInput,
): RelationshipEvaluation | null {
  const now = input.now ?? new Date();
  const day = dayKey(now);

  // 1) 越界/冲突：关系不是奖励，而是需要修复的事件（不涨，轻微降温）
  if (input.isBoundaryViolation) {
    return {
      delta: -0.03,
      reason: "越界试探，她感到不舒服",
      conflict: true,
    };
  }

  // 2) 道歉/修复：在冲突后的 24 小时窗口内，关系可以小幅修复
  if (input.isApology && state.lastConflictAt && now.getTime() - state.lastConflictAt < 24 * 60 * 60 * 1000) {
    return {
      delta: 0.02,
      reason: "对方道歉了，关系开始修复",
      repair: true,
    };
  }

  // 3) 愧疚状态下不推进关系（先修复再靠近）
  if (input.guilt > 0.3) return null;

  // 每日上限
  const gainedToday = state.dailyGainDay === day ? state.dailyGain : 0;
  const remaining = MAX_DAILY_GAIN - gainedToday;
  if (remaining <= 0.001) return null;

  let delta = 0;
  const reasons: string[] = [];

  // 1) 深度对话：用户表达了较长的内容，或复杂度被判为 complex
  if (
    (input.complexity === "complex" || input.userText.trim().length >= 40) &&
    input.replyText.trim().length >= 6
  ) {
    delta += 0.03;
    reasons.push("聊到了一些更深的东西");
  }

  // 2) 连续多天互动：昨天也聊过（每天最多一次）
  if (state.lastInteractionDay && isConsecutiveDay(state.lastInteractionDay, day)) {
    delta += 0.02;
    reasons.push("连续几天都有联系");
  }

  // 3) 主动分享生活细节：既要有长度，也要有「在讲自己的事」的信号；
  //    排除「ok, let's switch to another」这种纯话题切换，避免白送亲密度。
  const trimmed = input.userText.trim();
  const looksLikeLifeSharing = /(我|今天|昨天|昨晚|刚才|最近|发现|觉得|吃了|去了|看到|遇到|跟.*说)/.test(trimmed);
  if (trimmed.length >= 25 && !/[?？]\s*$/.test(trimmed) && looksLikeLifeSharing) {
    delta += 0.015;
    reasons.push("愿意分享自己的生活");
  }

  if (delta <= 0) return null;

  // 应用每日上限（保留 3 位小数避免浮点误差）
  delta = Math.round(Math.min(delta, remaining) * 1000) / 1000;
  if (delta <= 0) return null;

  return { delta, reason: reasons.join("；") };
}

/**
 * 应用一次关系事件：更新亲密度、记录事件、跨阈值记录里程碑、维护连续互动与每日上限。
 * 返回新的 RelationshipState（不修改入参）。
 */
export function applyRelationshipEvent(
  state: RelationshipState,
  delta: number,
  reason: string,
  now: Date = new Date(),
  flags: { conflict?: boolean; repair?: boolean } = {},
): RelationshipState {
  const day = dayKey(now);
  const previousDay = state.lastInteractionDay;

  // 连续互动维护：今天第一次互动时结算
  let streak = state.interactionStreak;
  if (previousDay !== day) {
    streak = isConsecutiveDay(previousDay, day) ? streak + 1 : 1;
  } else if (streak === 0) {
    streak = 1;
  }

  // 每日增量结算
  let dailyGain = state.dailyGain;
  let dailyGainDay = state.dailyGainDay;
  if (dailyGainDay !== day) {
    dailyGain = 0;
    dailyGainDay = day;
  }
  if (delta > 0) dailyGain = Math.round((dailyGain + delta) * 1000) / 1000;

  const from = state.closeness;
  const to = clamp(from + delta);

  const events = [
    ...state.events,
    { at: now.getTime(), delta: Math.round((to - from) * 1000) / 1000, closeness: to, reason },
  ].slice(-200);

  const hasConflict = flags.conflict === true;
  const isRepair = flags.repair === true;

  const milestones = [...state.milestones];
  for (const m of MILESTONES) {
    const already = milestones.some((x) => x.id === m.id);
    if (!already && from < m.threshold && to >= m.threshold) {
      milestones.push({ id: m.id, at: now.getTime(), title: m.title, closeness: to });
    }
  }

  return {
    ...state,
    closeness: to,
    events,
    milestones,
    lastEvaluatedAt: now.getTime(),
    lastInteractionDay: day,
    interactionStreak: streak,
    dailyGain,
    dailyGainDay,
    lastConflictAt: hasConflict ? now.getTime() : isRepair ? null : state.lastConflictAt,
    lastConflictReason: hasConflict ? reason : isRepair ? null : state.lastConflictReason,
  };
}

/** 只记录「今天来过」，不改变亲密度（例如被门控沉默时也要维护连续互动） */
export function touchInteraction(state: RelationshipState, now: Date = new Date()): RelationshipState {
  const day = dayKey(now);
  if (state.lastInteractionDay === day) return state;
  const streak = isConsecutiveDay(state.lastInteractionDay, day) ? state.interactionStreak + 1 : 1;
  return { ...state, lastInteractionDay: day, interactionStreak: streak, lastEvaluatedAt: now.getTime() };
}

/** 当前已达成的最新里程碑（供 prompt / 时间线使用） */
export function latestMilestone(state: RelationshipState): RelationshipMilestone | null {
  return state.milestones.length > 0 ? state.milestones[state.milestones.length - 1] : null;
}

/** 亲密度 → 人类可读标签 */
export function closenessLabel(closeness: number): string {
  if (closeness < 2) return "刚认识";
  if (closeness < 3.5) return "有点眼熟";
  if (closeness < 5) return "开始熟络";
  if (closeness < 7) return "有点在意";
  if (closeness < 9) return "很亲近";
  return "重要的人";
}
