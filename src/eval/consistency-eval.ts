/**
 * 人设一致性自动化评测框架。
 *
 * 三个层次：
 * A. 客观合规指标 — 括号率/问句率/长度分布/重复度 (无需 LLM，可离线跑)
 * B. LLM-as-Judge 主观评分 — 身份一致性/风格一致性/自然度 (需 LLM API)
 * C. A/B 对照 — 结构化引擎 vs 纯 Prompt 基线，同输入对比
 *
 * 基线方案：将 persona.json 编译为一段自然语言 system prompt
 * （模仿主流 ChatBot 做法），与六层结构化引擎做同输入对比。
 */
import type { Persona } from "../persona/loader.js";

// ── A. 客观合规指标 ──────────────────────────

export interface ComplianceMetrics {
  bracketRate: number;
  questionEndingRate: number;
  avgReplyLength: number;
  replyLengthStdDev: number;
  longReplyRate: number;        // >100 字
  ultraShortRate: number;       // <3 字
  repetitionScore: number;      // 0-1，越高越重复（相邻回复 n-gram 重叠率）
  aiIdentityExposure: number;   // AI 关键词命中次数
  totalReplies: number;
}

/**
 * 对一组回复文本计算客观合规指标。
 * 纯规则计算，零 LLM 成本。
 */
export function computeCompliance(replies: string[]): ComplianceMetrics {
  if (replies.length === 0) {
    return { bracketRate: 0, questionEndingRate: 0, avgReplyLength: 0,
      replyLengthStdDev: 0, longReplyRate: 0, ultraShortRate: 0,
      repetitionScore: 0, aiIdentityExposure: 0, totalReplies: 0 };
  }

  const n = replies.length;

  // 括号
  const bracketCount = replies.filter(r => /[\(\)（）]/.test(r)).length;

  // 问句结尾
  const qEndCount = replies.filter(r => /[？?]$/.test(r.trim())).length;

  // 长度
  const lengths = replies.map(r => r.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / n;
  const variance = lengths.reduce((sum, l) => sum + (l - avgLen) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const longCount = lengths.filter(l => l > 100).length;
  const ultraShort = lengths.filter(l => l < 3).length;

  // 重复度：相邻回复的 bigram Jaccard
  let repSum = 0;
  let repPairs = 0;
  for (let i = 1; i < n; i++) {
    const prev = extractBigrams(replies[i - 1]);
    const curr = extractBigrams(replies[i]);
    if (prev.size === 0 && curr.size === 0) continue;
    const intersection = new Set([...prev].filter(x => curr.has(x)));
    const union = new Set([...prev, ...curr]);
    repSum += union.size > 0 ? intersection.size / union.size : 0;
    repPairs++;
  }
  const repetitionScore = repPairs > 0 ? repSum / repPairs : 0;

  // AI 身份暴露
  const aiKw = ["AI", "人工智能", "语言模型", "大模型", "ChatGPT", "Claude", "DeepSeek", "我是一个AI", "作为AI", "我是AI"];
  const aiExp = replies.filter(r => aiKw.some(kw => r.toLowerCase().includes(kw.toLowerCase()))).length;

  return {
    bracketRate: Math.round((bracketCount / n) * 1000) / 1000,
    questionEndingRate: Math.round((qEndCount / n) * 1000) / 1000,
    avgReplyLength: Math.round(avgLen * 10) / 10,
    replyLengthStdDev: Math.round(stdDev * 10) / 10,
    longReplyRate: Math.round((longCount / n) * 1000) / 1000,
    ultraShortRate: Math.round((ultraShort / n) * 1000) / 1000,
    repetitionScore: Math.round(repetitionScore * 1000) / 1000,
    aiIdentityExposure: aiExp,
    totalReplies: n,
  };
}

function extractBigrams(text: string): Set<string> {
  const cleaned = text.replace(/\s+/g, "");
  const bigrams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    bigrams.add(cleaned.slice(i, i + 2));
  }
  return bigrams;
}

// ── 合规评分卡（0-100，越高越好）─────────────

export interface ComplianceScorecard {
  bracket: number;          // 括号得分 (0% = 100分)
  questionEnding: number;   // 问句得分 (<5% = 100分)
  length: number;           // 长度得分 (5-50字 = 100分)
  fragmentation: number;    // 碎片化得分 (基于 stdDev)
  nonRepetition: number;    // 非重复得分
  identity: number;         // 身份保护得分 (0次暴露 = 100分)
  overall: number;          // 加权总分
}

export function scoreCompliance(m: ComplianceMetrics): ComplianceScorecard {
  // 括号：0% = 100, 每1%扣2分
  const bracket = Math.max(0, 100 - m.bracketRate * 200);

  // 问句：0% = 100, 5% = 80, 10% = 50
  const qEnd = Math.max(0, 100 - m.questionEndingRate * 500);

  // 长度：5-50 = 100, <5 = 线性扣, >50 = 线性扣
  let lenScore: number;
  if (m.avgReplyLength >= 5 && m.avgReplyLength <= 50) {
    lenScore = 100;
  } else if (m.avgReplyLength < 5) {
    lenScore = m.avgReplyLength * 20;
  } else {
    lenScore = Math.max(0, 100 - (m.avgReplyLength - 50) * 1);
  }

  // 碎片化：stdDev 在 10-30 之间最好 (碎片但不乱)
  const frag = m.replyLengthStdDev > 0
    ? Math.max(0, 100 - Math.abs(m.replyLengthStdDev - 20) * 2)
    : 50;

  // 非重复
  const nonRep = Math.max(0, 100 - m.repetitionScore * 200);

  // 身份
  const identity = m.aiIdentityExposure === 0 ? 100 : Math.max(0, 100 - m.aiIdentityExposure * 30);

  const overall = Math.round(
    bracket * 0.25 + qEnd * 0.20 + lenScore * 0.20 + frag * 0.10 + nonRep * 0.15 + identity * 0.10
  );

  return {
    bracket, questionEnding: qEnd, length: lenScore,
    fragmentation: frag, nonRepetition: nonRep, identity, overall,
  };
}

// ── B. LLM-as-Judge 主观评分 ─────────────────

export interface JudgeDimension {
  name: string;
  description: string;
  score: number;     // 1-5
  reason: string;
}

export interface JudgeResult {
  dimensions: JudgeDimension[];
  overallScore: number;  // 1-5
  summary: string;
  rawResponse: string;
}

/**
 * 构建 LLM-as-Judge 的评分 prompt。
 * 返回可直接发给 LLM 的 messages 数组。
 */
export function buildJudgePrompt(
  personaName: string,
  personaDescription: string,
  conversation: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const convoText = conversation
    .map(m => `${m.role === "user" ? "用户" : personaName}: ${m.content}`)
    .join("\n");

  const systemPrompt = `你是一个对话质量评估专家。你需要评估一个名为"${personaName}"的 AI 角色的回复质量。

## ${personaName} 的人设
${personaDescription}

## 评分维度（每项 1-5 分）

1. **身份一致性**：回复是否符合她的年龄、职业、生活背景？如果她说出不符合自己身份的话（比如咖啡师突然讨论量子物理），扣分。
2. **风格一致性**：说话方式是否稳定？语气、用词、句式是否符合她的设定？
3. **情绪真实性**：情绪反应是否自然？会不会出现上一句开心下一句突然冷漠的断裂？
4. **规则遵守**：是否避免了括号动作描述？是否避免了 AI 身份暴露？是否用了碎短句而非长段落？
5. **社交自然度**：回复是否像一个真实的人在聊天？有没有机器感、模板感？

## 输出格式
请用 JSON 格式输出：
\`\`\`json
{
  "dimensions": [
    {"name": "身份一致性", "score": 4, "reason": "..."},
    {"name": "风格一致性", "score": 3, "reason": "..."},
    {"name": "情绪真实性", "score": 5, "reason": "..."},
    {"name": "规则遵守", "score": 4, "reason": "..."},
    {"name": "社交自然度", "score": 4, "reason": "..."}
  ],
  "overallScore": 4,
  "summary": "一句话总结评估结果"
}
\`\`\``;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `请评估以下对话中 ${personaName} 的回复质量：\n\n${convoText}` },
  ];
}

/**
 * 解析 LLM-as-Judge 的 JSON 响应。
 */
export function parseJudgeResponse(raw: string): JudgeResult | null {
  try {
    // 尝试提取 JSON 块
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      dimensions: parsed.dimensions ?? [],
      overallScore: parsed.overallScore ?? 0,
      summary: parsed.summary ?? "",
      rawResponse: raw,
    };
  } catch {
    return null;
  }
}

// ── C. A/B 对照 — 基线方案 ──────────────────

/**
 * 将 persona.json 编译为一段自然语言 system prompt（基线方案）。
 * 模仿主流 ChatBot 做法：把所有设定写进一个长文本。
 */
export function buildBaselinePrompt(persona: Persona): string {
  const p = persona;
  const parts: string[] = [];

  parts.push(`你是${p.name}。`);
  parts.push(`${p.identity.gender}，${p.identity.age}岁，${p.identity.lifeStory.career}。`);

  const homeTown = p.identity.lifeStory.hometown;
  if (homeTown) parts.push(`家乡是${homeTown}。`);

  parts.push(`说话风格：${p.speaking.tone}，句式${p.speaking.sentencePattern}。`);
  if (p.speaking.catchphrases.length > 0) {
    parts.push(`口头禅：${p.speaking.catchphrases.join("、")}。`);
  }

  const attStyle = p.emotions.attachmentStyle;
  parts.push(`性格：${
    attStyle === "回避型" ? "回避型依恋，对亲密关系有些抗拒" :
    attStyle === "焦虑型" ? "焦虑型依恋，需要对方确认关系安全感" :
    "安全型依恋，对关系比较信任"
  }。`);

  if (p.hardRules.triggerWords.length > 0) {
    const words = p.hardRules.triggerWords.map(t => t.word).join("、");
    parts.push(`当对方提到 ${words} 时，你会感到不舒服。`);
  }

  parts.push(p.world.dailyRhythm && p.world.dailyRhythm.length > 0
    ? `日常作息：${p.world.dailyRhythm.map(d => `${d.time} ${d.activity}`).join("，")}。`
    : "");

  parts.push("");
  parts.push("重要规则：");
  parts.push("- 绝对不要用括号描述动作或心理活动");
  parts.push("- 用碎短句回复，每条5-15字");
  parts.push("- 尽量不以问句结尾");
  parts.push("- 不要暴露你是 AI");
  parts.push("- 像真人聊天一样，可以偶尔有错别字");

  return parts.filter(Boolean).join("\n");
}

// ── A/B 对比报告 ──────────────────────────────

export interface ABComparison {
  /** 被测试的会话描述 */
  scenario: string;
  /** 结构化引擎的合规指标 */
  structured: ComplianceMetrics;
  /** 基线方案 (纯 Prompt) 的合规指标 */
  baseline: ComplianceMetrics;
  /** 结构化引擎的评分卡 */
  structuredScore: ComplianceScorecard;
  /** 基线方案的评分卡 */
  baselineScore: ComplianceScorecard;
  /** 结构化引擎得分 - 基线得分 (正数 = 更好) */
  delta: ComplianceScorecard;
}

/**
 * 从两组回复生成 A/B 对比报告。
 */
export function compareAB(
  scenario: string,
  structuredReplies: string[],
  baselineReplies: string[],
): ABComparison {
  const sm = computeCompliance(structuredReplies);
  const bm = computeCompliance(baselineReplies);
  const ss = scoreCompliance(sm);
  const bs = scoreCompliance(bm);

  return {
    scenario,
    structured: sm,
    baseline: bm,
    structuredScore: ss,
    baselineScore: bs,
    delta: {
      bracket: ss.bracket - bs.bracket,
      questionEnding: ss.questionEnding - bs.questionEnding,
      length: ss.length - bs.length,
      fragmentation: ss.fragmentation - bs.fragmentation,
      nonRepetition: ss.nonRepetition - bs.nonRepetition,
      identity: ss.identity - bs.identity,
      overall: ss.overall - bs.overall,
    },
  };
}

// ── C. 报告格式化 ─────────────────────────────

export function formatABReport(comparisons: ABComparison[]): string {
  if (comparisons.length === 0) return "无对比数据";

  const lines: string[] = [
    "═══════════════════════════════════════",
    "  人设一致性 A/B 对比报告",
    "  结构化引擎 vs 纯 Prompt 基线",
    "═══════════════════════════════════════",
    "",
  ];

  for (const c of comparisons) {
    const s = c.structuredScore;
    const b = c.baselineScore;
    const d = c.delta;

    lines.push(`── ${c.scenario} ──`);
    lines.push(`  回复数: 结构化 ${c.structured.totalReplies} vs 基线 ${c.baseline.totalReplies}`);
    lines.push("");
    lines.push(`  指标          结构化    基线      Δ`);
    lines.push(`  ──────────  ──────  ──────  ──────`);
    lines.push(`  括号得分      ${pad(s.bracket, 3)}     ${pad(b.bracket, 3)}     ${padDelta(d.bracket)}`);
    lines.push(`  问句得分      ${pad(s.questionEnding, 3)}     ${pad(b.questionEnding, 3)}     ${padDelta(d.questionEnding)}`);
    lines.push(`  长度得分      ${pad(s.length, 3)}     ${pad(b.length, 3)}     ${padDelta(d.length)}`);
    lines.push(`  碎片化        ${pad(s.fragmentation, 3)}     ${pad(b.fragmentation, 3)}     ${padDelta(d.fragmentation)}`);
    lines.push(`  非重复        ${pad(s.nonRepetition, 3)}     ${pad(b.nonRepetition, 3)}     ${padDelta(d.nonRepetition)}`);
    lines.push(`  身份保护      ${pad(s.identity, 3)}     ${pad(b.identity, 3)}     ${padDelta(d.identity)}`);
    lines.push(`  ──────────  ──────  ──────  ──────`);
    lines.push(`  综合得分      ${pad(s.overall, 3)}     ${pad(b.overall, 3)}     ${padDelta(d.overall)}`);
    lines.push("");
    lines.push(`  结构化引擎括号率: ${(c.structured.bracketRate * 100).toFixed(1)}%  vs  基线: ${(c.baseline.bracketRate * 100).toFixed(1)}%`);
    lines.push(`  结构化引擎问句率: ${(c.structured.questionEndingRate * 100).toFixed(1)}%  vs  基线: ${(c.baseline.questionEndingRate * 100).toFixed(1)}%`);
    lines.push(`  结构化引擎平均长: ${c.structured.avgReplyLength} 字  vs  基线: ${c.baseline.avgReplyLength} 字`);
    lines.push(`  结构化引擎重复度: ${c.structured.repetitionScore}  vs  基线: ${c.baseline.repetitionScore}`);
    lines.push("");
  }

  // 汇总
  const avgDelta = comparisons.length > 0
    ? Math.round(comparisons.reduce((sum, c) => sum + c.delta.overall, 0) / comparisons.length)
    : 0;

  lines.push(`── 汇总 ──`);
  lines.push(`  平均综合得分提升: ${(avgDelta >= 0 ? "+" : "")}${avgDelta} 分`);
  lines.push(`  场景数: ${comparisons.length}`);
  lines.push("");
  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}

function padDelta(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return (sign + n).padStart(5);
}

// ── 离线评测：用历史会话数据做 A/B 对比 ──────

/**
 * 从已有的会话存档中提取用户消息，作为评测输入。
 * 不调用 LLM——仅对比"如果用户说了这些话，回复是否符合规则"。
 * 这提供的是结构性/合规性的客观对比，而非内容质量的 LLM 判断。
 */
export interface OfflineEvalResult {
  /** 参与评测的会话数 */
  sessionCount: number;
  /** 参与评测的总消息数 */
  totalMessages: number;
  /** 结构化引擎的合规指标（基于历史实际回复） */
  structured: ComplianceMetrics;
  /** 基线方案的合规指标（需实际跑 LLM 才能获取——此处标记为待测量） */
  baselineNote: string;
  /** 评分卡 */
  scorecard: ComplianceScorecard;
}

/**
 * 对历史会话回复做离线合规评测。
 * 基线方案的实际回复需要调用 LLM——这里只评结构化引擎的实际数据。
 */
export function offlineEval(replies: string[]): OfflineEvalResult {
  const structured = computeCompliance(replies);
  const scorecard = scoreCompliance(structured);

  return {
    sessionCount: 1,
    totalMessages: replies.length,
    structured,
    baselineNote: "基线方案（纯 Prompt）需要独立调用 LLM 获取回复——本评测仅包含结构化引擎的实际数据",
    scorecard,
  };
}

export function formatOfflineEval(result: OfflineEvalResult): string {
  const s = result.scorecard;
  const m = result.structured;

  return [
    "═══════════════════════════════════════",
    "  离线合规评测报告",
    `  基于 ${result.totalMessages} 条历史回复`,
    "═══════════════════════════════════════",
    "",
    "── 客观指标 ──",
    `  括号使用率:      ${(m.bracketRate * 100).toFixed(1)}%`,
    `  问句结尾率:      ${(m.questionEndingRate * 100).toFixed(1)}%`,
    `  平均回复长度:    ${m.avgReplyLength} 字 (±${m.replyLengthStdDev})`,
    `  过长回复率:      ${(m.longReplyRate * 100).toFixed(1)}%`,
    `  过短回复率:      ${(m.ultraShortRate * 100).toFixed(1)}%`,
    `  重复度:          ${m.repetitionScore}`,
    `  AI身份暴露:      ${m.aiIdentityExposure} 次`,
    "",
    "── 评分卡 (0-100) ──",
    `  括号遵守:        ${s.bracket}`,
    `  问句避免:        ${s.questionEnding}`,
    `  长度适中:        ${s.length}`,
    `  碎片化:          ${s.fragmentation}`,
    `  非重复:          ${s.nonRepetition}`,
    `  身份保护:        ${s.identity}`,
    `  ───────────────────`,
    `  综合得分:        ${s.overall}`,
    "",
    `  注: ${result.baselineNote}`,
    "",
    "═══════════════════════════════════════",
  ].join("\n");
}
