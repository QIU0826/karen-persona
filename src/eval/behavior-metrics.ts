/**
 * 行为评测指标（v0.9.8）。
 *
 * 背景：v0.9.5/v0.9.7 的 mock 长跑 A/B 都只有「单次 6 轮」，评审 ±1 波动、
 * 自述率 2/6 vs 3/6 完全在噪声内，无法判断改动有没有效。
 *
 * 这里把「回复质量指标」抽成纯函数，配合 behavior-eval 脚本做
 * **固定消息序列 × 多次重复** 的离线评测，输出均值与范围，而不是单次结论。
 */

export interface BehaviorRunMetrics {
  /** 提到她自己生活的轮数占比 */
  mentionRate: number;
  /** 平均每条回复字数（去空白） */
  avgChars: number;
  /** 带问句的回复占比（？/?/吗/呢/吧/么 结尾或含问号） */
  questionRate: number;
  /** 完全重复（归一化后相同）的回复对数 */
  duplicatePairs: number;
  /** 开头 4 字相同的回复对数（复读感） */
  repeatedOpenerPairs: number;
  replies: number;
}

/** 归一化：去标点/空白/大小写，只留内容字符 */
export function normalizeReply(text: string): string {
  return (text ?? "").replace(/[\s，。！？、,.!?~～…：:；;"'“”‘’（）()【】\[\]]/g, "").toLowerCase();
}

/** 完全重复的回复对数（O(n^2)，n 很小） */
export function countDuplicatePairs(replies: string[]): number {
  const normalized = replies.map(normalizeReply).filter((text) => text.length > 0);
  let pairs = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (normalized[i] === normalized[j]) pairs += 1;
    }
  }
  return pairs;
}

/** 开头 4 字相同的回复对数（忽略空白） */
export function countRepeatedOpeners(replies: string[], openerLen = 4): number {
  const openers = replies
    .map((reply) => normalizeReply(reply).slice(0, openerLen))
    .filter((opener) => opener.length === openerLen);
  let pairs = 0;
  for (let i = 0; i < openers.length; i += 1) {
    for (let j = i + 1; j < openers.length; j += 1) {
      if (openers[i] === openers[j]) pairs += 1;
    }
  }
  return pairs;
}

/** 是否带问句语气 */
export function isQuestionReply(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return false;
  return /[？?]/.test(text) || /[吗呢吧么嘛]$/.test(text);
}

/** 计算一组回复的运行指标 */
export function computeBehaviorMetrics(replies: string[], mentioned: boolean[]): BehaviorRunMetrics {
  const nonEmpty = replies.filter((reply) => reply.trim().length > 0);
  const totalChars = nonEmpty.reduce(
    (sum, reply) => sum + reply.replace(/[\s，。！？、,.!?~～…]/g, "").length,
    0,
  );
  const questions = nonEmpty.filter(isQuestionReply).length;
  return {
    mentionRate: replies.length > 0 ? mentioned.filter(Boolean).length / replies.length : 0,
    avgChars: nonEmpty.length > 0 ? totalChars / nonEmpty.length : 0,
    questionRate: nonEmpty.length > 0 ? questions / nonEmpty.length : 0,
    duplicatePairs: countDuplicatePairs(nonEmpty),
    repeatedOpenerPairs: countRepeatedOpeners(nonEmpty),
    replies: replies.length,
  };
}

export interface MetricRange {
  mean: number;
  min: number;
  max: number;
}

/** 多次重复的聚合（均值 + 范围；范围就是 min..max） */
export function aggregateBehaviorMetrics(runs: BehaviorRunMetrics[]): {
  mentionRate: MetricRange;
  avgChars: MetricRange;
  questionRate: MetricRange;
  duplicatePairs: MetricRange;
  repeatedOpenerPairs: MetricRange;
} {
  const range = (values: number[]): MetricRange => {
    if (values.length === 0) return { mean: 0, min: 0, max: 0 };
    const sum = values.reduce((acc, value) => acc + value, 0);
    return {
      mean: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  };
  return {
    mentionRate: range(runs.map((run) => run.mentionRate)),
    avgChars: range(runs.map((run) => run.avgChars)),
    questionRate: range(runs.map((run) => run.questionRate)),
    duplicatePairs: range(runs.map((run) => run.duplicatePairs)),
    repeatedOpenerPairs: range(runs.map((run) => run.repeatedOpenerPairs)),
  };
}

/** 输出人类可读范围："33%（17–50%）" */
export function formatRangePercent(range: MetricRange): string {
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  return `${pct(range.mean)}（${pct(range.min)}–${pct(range.max)}）`;
}

/** 输出数值范围："18.7（12.0–24.5）" */
export function formatRangeNumber(range: MetricRange): string {
  const round = (value: number): string => value.toFixed(1);
  return `${round(range.mean)}（${round(range.min)}–${round(range.max)}）`;
}
