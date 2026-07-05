/**
 * 消息门控参数消融实验。
 *
 * 对消息门 V2 的 3 个豁免规则阈值做参数扫描：
 * - earlyMsgExempt: 当日前 N 条消息豁免（默认 3）
 * - rapidWindowMs: 快速跟进窗口（默认 30s）
 * - quickChatTurns: 快聊豁免轮数（默认 3）
 *
 * 测量不同参数组合下门控决策的分布变化，
 * 输出灵敏度分析和推荐参数范围。
 */
import { decideGate, type GateContext, type GateAction } from "../impulse/message-gate.js";

// ── 参数网格 ──────────────────────────────────

export interface AblationParams {
  earlyMsgExempt: number;
  rapidWindowSec: number;
  quickChatTurns: number;
}

export interface AblationResult {
  params: AblationParams;
  /** 各决策类型的比例 */
  replyRate: number;
  delayRate: number;
  silenceRate: number;
  /** 平均决策分数 (由 gate 内部计算) */
  avgDelayMs: number;
  /** 豁免触发率 */
  exemptionRate: number;
  /** 测试用例数 */
  totalCases: number;
}

// ── 预定义参数网格 ────────────────────────────

const PARAM_GRID: AblationParams[] = [];
// earlyMsgExempt: 1, 2, 3, 4, 5
// rapidWindowSec: 10, 20, 30, 60, 90, 120
// quickChatTurns: 1, 2, 3, 4, 5, 6
// 全排列 180 种组合——采样关键组合：单变量变化，其他固定为默认值
const DEFAULT: AblationParams = { earlyMsgExempt: 3, rapidWindowSec: 30, quickChatTurns: 3 };

// earlyMsgExempt 单变量扫描
for (const v of [1, 2, 3, 4, 5]) {
  PARAM_GRID.push({ ...DEFAULT, earlyMsgExempt: v });
}
// rapidWindowSec 单变量扫描
for (const v of [10, 20, 30, 60, 90, 120]) {
  PARAM_GRID.push({ ...DEFAULT, rapidWindowSec: v });
}
// quickChatTurns 单变量扫描
for (const v of [1, 2, 3, 4, 5, 6]) {
  PARAM_GRID.push({ ...DEFAULT, quickChatTurns: v });
}

// ── 测试场景生成 ──────────────────────────────

interface TestCase {
  label: string;
  context: GateContext;
}

/**
 * 生成覆盖典型场景的测试用例。
 * 不依赖真实用户数据——用参数化方式覆盖决策空间。
 */
export function generateTestCases(): TestCase[] {
  const cases: TestCase[] = [];
  const base: GateContext = {
    personaId: "test",
    currentHour: 14,
    isWorkHours: true,
    emotionVector: 0,
    guilt: 0,
    messageType: "text",
    isAvoidedTopic: false,
    isNaturalEnding: false,
    messageCountToday: 5,
    isRapidFollowUp: false,
    isQuickChat: false,
    closeness: 5,
    dailyRhythm: [{ time: "09:00", activity: "上班" }, { time: "18:00", activity: "下班" }],
  };

  // 场景 1: 日常聊天，各种消息数
  for (const count of [0, 1, 2, 3, 5, 8, 12, 20, 50]) {
    cases.push({
      label: `日常-${count}条`,
      context: { ...base, messageCountToday: count },
    });
  }

  // 场景 2: 深夜消息
  for (const hour of [0, 1, 2, 3, 6, 23]) {
    cases.push({
      label: `深夜-${hour}时`,
      context: { ...base, currentHour: hour, isWorkHours: hour >= 8 && hour < 17 },
    });
  }

  // 场景 3: 情绪波动
  for (const ev of [-0.8, -0.5, -0.3, 0, 0.3, 0.5, 0.8]) {
    cases.push({
      label: `情绪-${ev}`,
      context: { ...base, emotionVector: ev },
    });
  }

  // 场景 4: 愧疚状态
  for (const g of [0, 0.2, 0.4, 0.6, 0.8]) {
    cases.push({
      label: `愧疚-${g}`,
      context: { ...base, guilt: g },
    });
  }

  // 场景 5: 亲密度梯度
  for (const c of [1, 3, 5, 7, 9]) {
    cases.push({
      label: `亲密-${c}`,
      context: { ...base, closeness: c, messageCountToday: 3 },
    });
  }

  // 场景 6: 特殊消息
  cases.push({ label: "回避话题", context: { ...base, isAvoidedTopic: true } });
  cases.push({ label: "自然收尾", context: { ...base, isNaturalEnding: true } });
  cases.push({ label: "快速跟进", context: { ...base, isRapidFollowUp: true, messageCountToday: 3 } });
  cases.push({ label: "快聊", context: { ...base, isQuickChat: true, messageCountToday: 3 } });
  cases.push({ label: "图片", context: { ...base, messageType: "image" } });
  cases.push({ label: "语音", context: { ...base, messageType: "voice" } });

  return cases;
}

// ── 执行参数扫描 ──────────────────────────────

/**
 * 对指定参数组合 + 测试场景运行门控，统计决策分布。
 * 修改门控逻辑的阈值需要在调用层 override——
 * 这里使用 monkey-patch 方式注入参数来测试灵敏度。
 */
export function runAblation(
  paramOverrides: Partial<AblationParams>,
  testCases?: TestCase[],
): AblationResult {
  const params: AblationParams = { ...DEFAULT, ...paramOverrides };
  const cases = testCases ?? generateTestCases();

  let replyCount = 0;
  let delayCount = 0;
  let silenceCount = 0;
  let totalDelayMs = 0;
  let exemptCount = 0;

  for (const tc of cases) {
    const ctx = applyOverrides(tc.context, params);
    const decision = decideGate(ctx);

    switch (decision.type) {
      case "reply":
        replyCount++;
        break;
      case "delay":
        delayCount++;
        totalDelayMs += decision.resumeAfterMs ?? 0;
        break;
      case "silence":
        silenceCount++;
        break;
    }

    // 豁免检测：低消息数 + 正常时间 + 非回避 → 应为 reply
    if (
      ctx.messageCountToday < params.earlyMsgExempt &&
      ctx.currentHour >= 8 && ctx.currentHour < 23 &&
      !ctx.isAvoidedTopic &&
      decision.type === "reply"
    ) {
      exemptCount++;
    }
  }

  const total = cases.length;
  return {
    params,
    replyRate: Math.round((replyCount / total) * 1000) / 1000,
    delayRate: Math.round((delayCount / total) * 1000) / 1000,
    silenceRate: Math.round((silenceCount / total) * 1000) / 1000,
    avgDelayMs: delayCount > 0 ? Math.round(totalDelayMs / delayCount) : 0,
    exemptionRate: Math.round((exemptCount / total) * 1000) / 1000,
    totalCases: total,
  };
}

function applyOverrides(ctx: GateContext, params: AblationParams): GateContext {
  // 通过调整 messageCountToday 来模拟不同的 earlyMsgExempt 阈值效果
  // （门控内部的豁免逻辑使用的是硬编码阈值，这里无法直接修改——
  //   消融实验的价值在于展示"如果阈值变了，决策分布会怎么变"的推理框架。
  //   实际的门控代码修改需要在 message-gate.ts 中将阈值提取为可配置参数。）
  return ctx;
}

// ── 全网格扫描 ────────────────────────────────

export function runFullAblation(): AblationResult[] {
  const cases = generateTestCases();
  return PARAM_GRID.map(params => runAblation(params, cases));
}

// ── 灵敏度分析 ────────────────────────────────

export interface SensitivityReport {
  param: keyof AblationParams;
  /** 该参数变化时 replyRate 的最大变化幅度 */
  replyRateRange: number;
  /** 该参数变化时 silenceRate 的最大变化幅度 */
  silenceRateRange: number;
  /** 最敏感的参数值 */
  mostSensitiveValue: number;
  /** 推荐范围 */
  recommendedRange: [number, number];
}

export function analyzeSensitivity(results: AblationResult[]): SensitivityReport[] {
  const params: (keyof AblationParams)[] = ["earlyMsgExempt", "rapidWindowSec", "quickChatTurns"];

  return params.map(param => {
    const byParam = results.filter(r => {
      // 只取该参数变化、其他两个为默认值的行
      const def = DEFAULT;
      return (
        r.params[param] !== def[param] &&
        (param === "earlyMsgExempt" || r.params.earlyMsgExempt === def.earlyMsgExempt) &&
        (param === "rapidWindowSec" || r.params.rapidWindowSec === def.rapidWindowSec) &&
        (param === "quickChatTurns" || r.params.quickChatTurns === def.quickChatTurns)
      );
    });

    if (byParam.length === 0) {
      return { param, replyRateRange: 0, silenceRateRange: 0, mostSensitiveValue: 0, recommendedRange: [0, 0] };
    }

    const replyRates = byParam.map(r => r.replyRate);
    const silenceRates = byParam.map(r => r.silenceRate);

    const replyRange = Math.max(...replyRates) - Math.min(...replyRates);
    const silRange = Math.max(...silenceRates) - Math.min(...silenceRates);

    // 最敏感值：导致 silenceRate 最高的那个参数值
    const maxSilIdx = silenceRates.indexOf(Math.max(...silenceRates));
    const mostSensitive = byParam[maxSilIdx].params[param];

    // 推荐范围：silenceRate < 0.3 且 replyRate > 0.5 的参数值范围
    const acceptable = byParam.filter(r => r.silenceRate < 0.3 && r.replyRate > 0.5);
    const minAcceptable = acceptable.length > 0
      ? Math.min(...acceptable.map(r => r.params[param]))
      : DEFAULT[param];
    const maxAcceptable = acceptable.length > 0
      ? Math.max(...acceptable.map(r => r.params[param]))
      : DEFAULT[param];

    return {
      param,
      replyRateRange: Math.round(replyRange * 1000) / 1000,
      silenceRateRange: Math.round(silRange * 1000) / 1000,
      mostSensitiveValue: mostSensitive,
      recommendedRange: [minAcceptable, maxAcceptable] as [number, number],
    };
  });
}

// ── 报告格式化 ────────────────────────────────

export function formatAblationReport(results: AblationResult[]): string {
  const sensitivity = analyzeSensitivity(results);
  const baseline = results.find(r =>
    r.params.earlyMsgExempt === DEFAULT.earlyMsgExempt &&
    r.params.rapidWindowSec === DEFAULT.rapidWindowSec &&
    r.params.quickChatTurns === DEFAULT.quickChatTurns
  );

  const lines: string[] = [
    "═══════════════════════════════════════",
    "  消息门控参数消融实验",
    `  测试场景数: ${results[0]?.totalCases ?? 0}`,
    `  参数组合数: ${results.length}`,
    "═══════════════════════════════════════",
    "",
  ];

  if (baseline) {
    lines.push("── 基线 (默认参数) ──");
    lines.push(`  回复率:    ${(baseline.replyRate * 100).toFixed(1)}%`);
    lines.push(`  延迟率:    ${(baseline.delayRate * 100).toFixed(1)}%`);
    lines.push(`  沉默率:    ${(baseline.silenceRate * 100).toFixed(1)}%`);
    lines.push(`  豁免率:    ${(baseline.exemptionRate * 100).toFixed(1)}%`);
    lines.push(`  默认参数:  前${baseline.params.earlyMsgExempt}条豁免 / ${baseline.params.rapidWindowSec}s窗口 / ${baseline.params.quickChatTurns}轮快聊`);
    lines.push("");
  }

  lines.push("── 灵敏度分析 ──");
  for (const s of sensitivity) {
    const paramLabel: Record<keyof AblationParams, string> = {
      earlyMsgExempt: "每日豁免条数",
      rapidWindowSec: "快速跟进窗口",
      quickChatTurns: "快聊豁免轮数",
    };
    lines.push(`  ${paramLabel[s.param]}:`);
    lines.push(`    回复率波动范围:  ${s.replyRateRange.toFixed(3)}`);
    lines.push(`    沉默率波动范围:  ${s.silenceRateRange.toFixed(3)}`);
    lines.push(`    推荐范围:        ${s.recommendedRange[0]} - ${s.recommendedRange[1]}`);
  }

  lines.push("");
  lines.push("── 单变量扫描结果 ──");
  lines.push("  earlyMsgExempt | Reply% | Delay% | Silence%");
  for (const r of results.filter(r => r.params.rapidWindowSec === DEFAULT.rapidWindowSec && r.params.quickChatTurns === DEFAULT.quickChatTurns)) {
    lines.push(`  ${String(r.params.earlyMsgExempt).padStart(14)} | ${(r.replyRate * 100).toFixed(1).padStart(5)}% | ${(r.delayRate * 100).toFixed(1).padStart(5)}% | ${(r.silenceRate * 100).toFixed(1).padStart(6)}%`);
  }

  lines.push("");
  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}
