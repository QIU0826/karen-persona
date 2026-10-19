/**
 * 运行时指标采集器。
 * 从 SQLite 数据库和会话存档中提取可量化指标，生成结构化报告。
 *
 * 三个维度：
 * 1. 实际运行数据 — 延迟、吞吐、存储增长
 * 2. 人格一致性 — L1规则遵守率、碎片化指数、风格稳定性
 * 3. 用户交互 — 会话频率、参与深度、亲密度轨迹
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = "data/memory.sqlite";
const DATA_DIR = "data";

// ── 类型 ──────────────────────────────────────

export interface RuntimeMetrics {
  /** 记忆系统 */
  memory: {
    t1Count: number;
    t2Count: number;
    t2WithEmbedding: number;
    t3Count: number;
    t2AvgStrength: number;
    t2DecayedCount: number;
    monologueCount: number;
    journalCount: number;
  };
  /** T2 增长曲线（按月） */
  t2Growth: Array<{ month: string; count: number }>;
  /** 嵌入覆盖率 */
  embeddingCoverage: number;
}

export interface ConsistencyMetrics {
  /** L1 规则遵守 */
  rules: {
    /** 括号使用率 (应为 0%) */
    bracketRate: number;
    /** 问句结尾率 (应 < 5%) */
    questionEndingRate: number;
    /** 平均回复长度 (应为 5-50 字) */
    avgReplyLength: number;
    /** 过长回复占比 (>100字) */
    longReplyRate: number;
    /** AI 身份暴露次数 */
    aiIdentityExposure: number;
  };
  /** 碎片化指数 (0-1: 多短句 = 1, 长段落 = 0) */
  fragmentationIndex: number;
  /** 总回复数 */
  totalReplies: number;
  /** 总消息数 */
  totalMessages: number;
}

export interface InteractionMetrics {
  /** 会话统计 */
  sessions: {
    total: number;
    avgMessagesPerSession: number;
    avgSpanHours: number;
    maxSpanHours: number;
  };
  /** 参与度 */
  engagement: {
    /** 用户平均消息长度 */
    avgUserMsgLength: number;
    /** 她平均消息长度 */
    avgHerMsgLength: number;
    /** 用户发起率 (用户先说话的比例) */
    userInitiationRate: number;
  };
  /** 亲密度轨迹 */
  closeness: {
    starting: number;
    current: number;
    delta: number;
    peak: number;
    trough: number;
  };
  /** 情绪摘要 */
  emotion: {
    avgValence: number;
    positiveRate: number;
    negativeRate: number;
    neutralRate: number;
  };
}

export interface MetricsReport {
  generatedAt: string;
  runtime: RuntimeMetrics;
  consistency: ConsistencyMetrics;
  interaction: InteractionMetrics;
}

// ── 1. 运行时指标 ──────────────────────────────

function collectRuntimeMetrics(): RuntimeMetrics {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const t1Count = (db.prepare("SELECT COUNT(*) as c FROM t1_snapshots").get() as any).c;
  const t2Count = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes").get() as any).c;
  const t2WithEmb = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE embedding IS NOT NULL").get() as any).c;
  const t2AvgStr = (db.prepare("SELECT AVG(strength) as s FROM t2_episodes").get() as any).s;
  const t2Decayed = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE strength < 0.3").get() as any).c;
  const monoCount = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE source = 'internal_monologue'").get() as any).c;
  const journalCount = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE source = 'persona_journal'").get() as any).c;
  const t3Count = (db.prepare("SELECT COUNT(*) as c FROM t2_episodes WHERE source = 't3_summary'").get() as any).c;

  // T2 月度增长
  const t2Growth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
    FROM t2_episodes
    WHERE created_at IS NOT NULL
    GROUP BY month ORDER BY month
  `).all() as Array<{ month: string; count: number }>;

  const embCoverage = t2Count > 0 ? t2WithEmb / t2Count : 0;

  db.close();

  return {
    memory: {
      t1Count, t2Count, t2WithEmbedding: t2WithEmb, t3Count,
      t2AvgStrength: Math.round(t2AvgStr * 1000) / 1000,
      t2DecayedCount: t2Decayed,
      monologueCount: monoCount,
      journalCount,
    },
    t2Growth,
    embeddingCoverage: Math.round(embCoverage * 1000) / 1000,
  };
}

// ── 2. 人格一致性评测 ──────────────────────────

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface SessionFile {
  personaId: string;
  startedAt: number;
  lastActiveAt: number;
  messages: SessionMessage[];
}

function loadSessions(): SessionFile[] {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith("-session.json"));
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8")) as SessionFile;
    } catch {
      return null;
    }
  }).filter(Boolean) as SessionFile[];
}

function collectConsistencyMetrics(): ConsistencyMetrics {
  const sessions = loadSessions();
  const allReplies: SessionMessage[] = [];
  const allMessages: SessionMessage[] = [];

  for (const s of sessions) {
    for (const m of s.messages) {
      allMessages.push(m);
      if (m.role === "assistant") allReplies.push(m);
    }
  }

  if (allReplies.length === 0) {
    return {
      rules: { bracketRate: 0, questionEndingRate: 0, avgReplyLength: 0, longReplyRate: 0, aiIdentityExposure: 0 },
      fragmentationIndex: 0,
      totalReplies: 0,
      totalMessages: 0,
    };
  }

  // 括号检测
  const bracketPattern = /[\(\)（）]/;
  const bracketCount = allReplies.filter(m => bracketPattern.test(m.content)).length;

  // 问句结尾检测
  const questionEndPattern = /[？?]$/;
  const questionEndCount = allReplies.filter(m => questionEndPattern.test(m.content.trim())).length;

  // 回复长度
  const lengths = allReplies.map(m => m.content.length);
  const avgLen = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const longCount = lengths.filter(l => l > 100).length;

  // AI 身份暴露（关键词）
  const aiKeywords = ["AI", "人工智能", "语言模型", "训练", "大模型", "ChatGPT", "Claude", "DeepSeek", "我是一个AI", "作为AI"];
  const aiExposure = allReplies.filter(m =>
    aiKeywords.some(kw => m.content.toLowerCase().includes(kw.toLowerCase()))
  ).length;

  // 碎片化指数: burst 风格 = \n\n 分隔的独立行数/总行数
  let totalLines = 0;
  let burstGroups = 0;
  for (const m of allReplies) {
    const lines = m.content.split("\n").filter(l => l.trim());
    totalLines += lines.length;
    // 两个空格 + 换行 = 一条 burst fragment
    burstGroups += m.content.split("  \n").filter(s => s.trim()).length;
  }
  const fragIndex = allReplies.length > 0
    ? Math.round(Math.min(1, burstGroups / allReplies.length) * 1000) / 1000
    : 0;

  return {
    rules: {
      bracketRate: Math.round((bracketCount / allReplies.length) * 1000) / 1000,
      questionEndingRate: Math.round((questionEndCount / allReplies.length) * 1000) / 1000,
      avgReplyLength: avgLen,
      longReplyRate: Math.round((longCount / allReplies.length) * 1000) / 1000,
      aiIdentityExposure: aiExposure,
    },
    fragmentationIndex: fragIndex,
    totalReplies: allReplies.length,
    totalMessages: allMessages.length,
  };
}

// ── 3. 用户交互数据 ────────────────────────────

function collectInteractionMetrics(): InteractionMetrics {
  const sessions = loadSessions();

  if (sessions.length === 0) {
    return {
      sessions: { total: 0, avgMessagesPerSession: 0, avgSpanHours: 0, maxSpanHours: 0 },
      engagement: { avgUserMsgLength: 0, avgHerMsgLength: 0, userInitiationRate: 0 },
      closeness: { starting: 0, current: 0, delta: 0, peak: 0, trough: 0 },
      emotion: { avgValence: 0, positiveRate: 0, negativeRate: 0, neutralRate: 0 },
    };
  }

  // 会话统计
  const msgCounts = sessions.map(s => s.messages.length);
  const spans = sessions.map(s => (s.lastActiveAt - s.startedAt) / 3600000);
  const avgMsgs = Math.round(msgCounts.reduce((a, b) => a + b, 0) / sessions.length);
  const avgSpan = Math.round(spans.reduce((a, b) => a + b, 0) / sessions.length * 10) / 10;
  const maxSpan = Math.round(Math.max(...spans) * 10) / 10;

  // 参与度
  const allUserMsgs = sessions.flatMap(s => s.messages.filter(m => m.role === "user"));
  const allHerMsgs = sessions.flatMap(s => s.messages.filter(m => m.role === "assistant"));
  const avgUserLen = Math.round(allUserMsgs.reduce((sum, m) => sum + m.content.length, 0) / Math.max(1, allUserMsgs.length));
  const avgHerLen = Math.round(allHerMsgs.reduce((sum, m) => sum + m.content.length, 0) / Math.max(1, allHerMsgs.length));

  // 用户发起率：会话第一条消息是 user 的比例
  const userInitSessions = sessions.filter(s => s.messages.length > 0 && s.messages[0].role === "user").length;

  // 亲密度轨迹 (从 T1 快照)
  const db = new Database(DB_PATH);
  const t1Rows = db.prepare(
    "SELECT closeness, emotion_vector FROM t1_snapshots WHERE persona_id != 'unknown' ORDER BY created_at"
  ).all() as Array<{ closeness: number; emotion_vector: number }>;
  db.close();

  const closeVals = t1Rows.map(r => r.closeness);
  const emoVals = t1Rows.map(r => r.emotion_vector);

  const closeStart = closeVals[0] ?? 0;
  const closeCurr = closeVals[closeVals.length - 1] ?? 0;
  const closePeak = closeVals.length > 0 ? Math.max(...closeVals) : 0;
  const closeTrough = closeVals.length > 0 ? Math.min(...closeVals) : 0;

  const emoAvg = emoVals.length > 0 ? Math.round(emoVals.reduce((a, b) => a + b, 0) / emoVals.length * 1000) / 1000 : 0;
  const posRate = emoVals.length > 0 ? Math.round(emoVals.filter(v => v > 0.1).length / emoVals.length * 1000) / 1000 : 0;
  const negRate = emoVals.length > 0 ? Math.round(emoVals.filter(v => v < -0.1).length / emoVals.length * 1000) / 1000 : 0;
  const neuRate = emoVals.length > 0 ? Math.round(emoVals.filter(v => Math.abs(v) <= 0.1).length / emoVals.length * 1000) / 1000 : 0;

  return {
    sessions: {
      total: sessions.length,
      avgMessagesPerSession: avgMsgs,
      avgSpanHours: avgSpan,
      maxSpanHours: maxSpan,
    },
    engagement: {
      avgUserMsgLength: avgUserLen,
      avgHerMsgLength: avgHerLen,
      userInitiationRate: Math.round((userInitSessions / sessions.length) * 1000) / 1000,
    },
    closeness: {
      starting: closeStart,
      current: closeCurr,
      delta: Math.round((closeCurr - closeStart) * 10) / 10,
      peak: closePeak,
      trough: closeTrough,
    },
    emotion: {
      avgValence: emoAvg,
      positiveRate: posRate,
      negativeRate: negRate,
      neutralRate: neuRate,
    },
  };
}

// ── 聚合报告生成 ──────────────────────────────

export function generateMetricsReport(): MetricsReport {
  return {
    generatedAt: new Date().toISOString(),
    runtime: collectRuntimeMetrics(),
    consistency: collectConsistencyMetrics(),
    interaction: collectInteractionMetrics(),
  };
}

export function formatMetricsReport(report: MetricsReport): string {
  const { runtime, consistency, interaction } = report;

  return [
    "═══════════════════════════════════════",
    "  Karen 运行时指标报告",
    `  生成时间: ${report.generatedAt}`,
    "═══════════════════════════════════════",
    "",
    "── 记忆系统 ──────────────────────────",
    `  T1 人格快照:   ${runtime.memory.t1Count} 条`,
    `  T2 情节记忆:   ${runtime.memory.t2Count} 条 (${runtime.memory.t2DecayedCount} 条已衰减)`,
    `  T3 长期摘要:   ${runtime.memory.t3Count} 条`,
    `  内心独白:      ${runtime.memory.monologueCount} 条`,
    `  人设日记:      ${runtime.memory.journalCount} 条`,
    `  T2 平均强度:   ${runtime.memory.t2AvgStrength}`,
    `  嵌入覆盖率:    ${(runtime.embeddingCoverage * 100).toFixed(1)}%`,
    "",
    "── T2 增长趋势 ───────────────────────",
    ...runtime.t2Growth.map(r => `  ${r.month}:  ${"█".repeat(Math.min(50, r.count))} ${r.count}`),
    "",
    "── 人格一致性 ────────────────────────",
    `  总回复数:      ${consistency.totalReplies}`,
    `  括号使用率:    ${(consistency.rules.bracketRate * 100).toFixed(1)}%  (目标: 0%)`,
    `  问句结尾率:    ${(consistency.rules.questionEndingRate * 100).toFixed(1)}%  (目标: <5%)`,
    `  平均回复长度:  ${consistency.rules.avgReplyLength} 字  (目标: 5-50)`,
    `  过长回复率:    ${(consistency.rules.longReplyRate * 100).toFixed(1)}%  (目标: <5%)`,
    `  AI身份暴露:    ${consistency.rules.aiIdentityExposure} 次  (目标: 0)`,
    `  碎片化指数:    ${consistency.fragmentationIndex}  (越接近1越碎片化)`,
    "",
    "── 用户交互 ──────────────────────────",
    `  会话数:        ${interaction.sessions.total}`,
    `  平均消息/会话: ${interaction.sessions.avgMessagesPerSession}`,
    `  平均跨度:      ${interaction.sessions.avgSpanHours} 小时`,
    `  最长跨度:      ${interaction.sessions.maxSpanHours} 小时`,
    `  用户平均消息长度: ${interaction.engagement.avgUserMsgLength} 字`,
    `  Karen平均消息长度: ${interaction.engagement.avgHerMsgLength} 字`,
    `  用户发起率:    ${(interaction.engagement.userInitiationRate * 100).toFixed(0)}%`,
    "",
    "── 亲密度轨迹 ────────────────────────",
    `  起始: ${interaction.closeness.starting} → 当前: ${interaction.closeness.current}`,
    `  净变化: ${(interaction.closeness.delta >= 0 ? "+" : "")}${interaction.closeness.delta}`,
    `  峰值: ${interaction.closeness.peak}  谷值: ${interaction.closeness.trough}`,
    "",
    "── 情绪分布 ──────────────────────────",
    `  平均效价:      ${interaction.emotion.avgValence}`,
    `  正面: ${(interaction.emotion.positiveRate * 100).toFixed(0)}%  ` +
    `中性: ${(interaction.emotion.neutralRate * 100).toFixed(0)}%  ` +
    `负面: ${(interaction.emotion.negativeRate * 100).toFixed(0)}%`,
    "",
    "═══════════════════════════════════════",
  ].join("\n");
}
