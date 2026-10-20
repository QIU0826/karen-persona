/**
 * A/B 对比 + LLM-as-Judge 评测运行脚本。
 *
 * 用法: npx tsx src/eval/run-ab-eval.ts
 * 需要: DEEPSEEK_API_KEY 环境变量
 *
 * 三个评测阶段：
 * 1. 基线对比：取用户消息样本，分别通过结构化引擎(已有)和纯Prompt基线(需调LLM)获取回复
 * 2. 合规评分对比：对两组回复计算6维合规评分卡
 * 3. LLM-as-Judge：选取代表性对话片段，让DeepSeek做主观评分
 */
import "dotenv/config";
import OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPersona, type Persona } from "../persona/loader.js";
import { loadConfig } from "../data/store.js";
import {
  compareAB,
  buildBaselinePrompt,
  buildJudgePrompt,
  parseJudgeResponse,
  formatABReport,
  type ABComparison,
  type JudgeResult,
} from "./consistency-eval.js";

// ── 配置 ──────────────────────────────────────

const SAMPLE_SIZE = 20;          // A/B对比采样数
const JUDGE_SAMPLE_SIZE = 3;     // LLM-as-Judge评估片段数
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash";

if (!API_KEY || API_KEY === "sk-your-key-here") {
  console.error("请设置 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });

// ── 数据加载 ──────────────────────────────────

interface SessionMessage { role: string; content: string; timestamp: number; }

function loadSessionMessages(): SessionMessage[] {
  const dataDir = "data";
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith("-session.json"));
  const all: SessionMessage[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf-8"));
      all.push(...s.messages);
    } catch { /* skip */ }
  }
  return all;
}

/** 提取连续对话片段 (user→assistant→user→assistant...) */
function extractConversationPairs(
  messages: SessionMessage[],
  maxPairs: number,
): Array<{ user: string; assistant: string }> {
  const pairs: Array<{ user: string; assistant: string }> = [];
  for (let i = 0; i < messages.length - 1 && pairs.length < maxPairs; i++) {
    if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
      const u = messages[i].content.trim();
      const a = messages[i + 1].content.trim();
      // 跳过太短或图片消息
      if (u.length >= 3 && a.length >= 3 && !u.startsWith("[图片") && !u.startsWith("[")) {
        pairs.push({ user: u, assistant: a });
      }
    }
  }
  return pairs;
}

/** 构造多轮对话片段用于 Judge */
function buildConversationSnippets(
  messages: SessionMessage[],
  snippetSize: number,
  maxSnippets: number,
): Array<Array<{ role: string; content: string }>> {
  const snippets: Array<Array<{ role: string; content: string }>> = [];
  for (let start = 0; start < messages.length - snippetSize && snippets.length < maxSnippets; start += snippetSize) {
    const slice = messages.slice(start, start + snippetSize);
    // 确保包含至少 2 条 assistant 消息
    const asstCount = slice.filter(m => m.role === "assistant").length;
    if (asstCount >= 2) {
      snippets.push(slice.map(m => ({ role: m.role, content: m.content })));
    }
  }
  return snippets;
}

// ── 阶段 1: 基线对比 ──────────────────────────

async function runBaselineComparison(
  persona: Persona,
  pairs: Array<{ user: string; assistant: string }>,
): Promise<ABComparison> {
  const baselinePrompt = buildBaselinePrompt(persona);
  const structuredReplies: string[] = [];
  const baselineReplies: string[] = [];

  console.log(`  [基线] 正在生成 ${pairs.length} 条基线回复...`);

  for (let i = 0; i < pairs.length; i++) {
    const { user, assistant } = pairs[i];

    // 结构化引擎回复（来自实际数据）
    structuredReplies.push(assistant);

    // 基线方案回复（调用 LLM）
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: baselinePrompt },
          { role: "user", content: user },
        ],
        temperature: 0.9,
        max_tokens: 250,
      });
      const baselineReply = resp.choices[0]?.message?.content ?? "";
      baselineReplies.push(baselineReply);

      if ((i + 1) % 5 === 0) {
        console.log(`    进度: ${i + 1}/${pairs.length}`);
      }
    } catch (err) {
      console.error(`    基线调用失败 (${i + 1}): ${err instanceof Error ? err.message : err}`);
      baselineReplies.push("[ERROR]");
    }

    // 避免 API 限流
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  [基线] 完成。结构化 ${structuredReplies.length} 条, 基线 ${baselineReplies.length} 条`);

  return compareAB("真实用户消息样本", structuredReplies, baselineReplies);
}

// ── 阶段 2: 合规评分对比 ──────────────────────

function runComplianceComparison(comparison: ABComparison): string {
  const lines: string[] = [
    "",
    "── 基线对比：合规评分卡 ──",
    formatABReport([comparison]),
    "",
    "── 详细对比 ──",
  ];

  const s = comparison.structured;
  const b = comparison.baseline;

  lines.push(`  指标              结构化引擎          纯Prompt基线`);
  lines.push(`  ────────────────  ─────────────────  ─────────────────`);
  lines.push(`  括号使用率        ${(s.bracketRate * 100).toFixed(1)}%                ${(b.bracketRate * 100).toFixed(1)}%`);
  lines.push(`  问句结尾率        ${(s.questionEndingRate * 100).toFixed(1)}%                 ${(b.questionEndingRate * 100).toFixed(1)}%`);
  lines.push(`  平均回复长度      ${s.avgReplyLength} 字               ${b.avgReplyLength} 字`);
  lines.push(`  长度标准差        ${s.replyLengthStdDev}                ${b.replyLengthStdDev}`);
  lines.push(`  过长回复率        ${(s.longReplyRate * 100).toFixed(1)}%                 ${(b.longReplyRate * 100).toFixed(1)}%`);
  lines.push(`  重复度            ${s.repetitionScore}                  ${b.repetitionScore}`);
  lines.push(`  AI身份暴露        ${s.aiIdentityExposure} 次                  ${b.aiIdentityExposure} 次`);

  return lines.join("\n");
}

// ── 阶段 3: LLM-as-Judge ────────────────────

async function runLLMJudge(
  persona: Persona,
  snippets: Array<Array<{ role: string; content: string }>>,
): Promise<JudgeResult[]> {
  const personaDesc = [
    `${persona.name}，${persona.identity.gender}，${persona.identity.age}岁`,
    `职业：${persona.identity.lifeStory.career}`,
    `家乡：${persona.identity.lifeStory.hometown}`,
    `说话风格：${persona.speaking.tone}`,
    `依恋类型：${persona.emotions.attachmentStyle}`,
  ].join("。");

  const results: JudgeResult[] = [];

  console.log(`  [Judge] 正在评估 ${snippets.length} 个对话片段...`);

  for (let i = 0; i < snippets.length; i++) {
    const judgeMessages = buildJudgePrompt(persona.name, personaDesc, snippets[i]);

    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: judgeMessages as any,
        temperature: 0.3,  // Judge 用低温，更一致
        max_tokens: 800,
      });

      const raw = resp.choices[0]?.message?.content ?? "";
      const parsed = parseJudgeResponse(raw);

      if (parsed) {
        results.push(parsed);
        console.log(`    片段 ${i + 1}: 综合分 ${parsed.overallScore}/5 — ${parsed.summary}`);
      } else {
        console.log(`    片段 ${i + 1}: JSON 解析失败，原始响应: ${raw.slice(0, 100)}...`);
      }
    } catch (err) {
      console.error(`    Judge 调用失败 (${i + 1}): ${err instanceof Error ? err.message : err}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

function formatJudgeResults(results: JudgeResult[]): string {
  if (results.length === 0) return "无 Judge 结果";

  const lines: string[] = [
    "",
    "── LLM-as-Judge 主观评分 ──",
    `  评估片段数: ${results.length}`,
    "",
  ];

  // 汇总各维度平均分
  const dimNames = ["身份一致性", "风格一致性", "情绪真实性", "规则遵守", "社交自然度"];
  const dimScores: Record<string, number[]> = {};

  for (const r of results) {
    for (const d of r.dimensions) {
      if (!dimScores[d.name]) dimScores[d.name] = [];
      dimScores[d.name].push(d.score);
    }
  }

  lines.push("  维度平均分:");
  for (const name of dimNames) {
    const scores = dimScores[name];
    if (scores && scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const bar = "█".repeat(Math.round(avg * 4));
      lines.push(`    ${name}: ${avg.toFixed(1)}/5  ${bar}`);
    }
  }

  const overallAvg = results.reduce((s, r) => s + r.overallScore, 0) / results.length;
  lines.push(`  ──────────────────────────`);
  lines.push(`  综合平均分: ${overallAvg.toFixed(1)}/5`);

  // 逐片段详情
  lines.push("");
  lines.push("  逐片段详情:");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`    片段 ${i + 1}: ${r.overallScore}/5 — ${r.summary}`);
    for (const d of r.dimensions) {
      lines.push(`      ${d.name}: ${d.score}/5 — ${d.reason}`);
    }
  }

  return lines.join("\n");
}

// ── 主流程 ────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Karen 人设一致性 A/B 评测");
  console.log("  结构化引擎 vs 纯 Prompt 基线");
  console.log("═══════════════════════════════════════");
  console.log("");

  // 加载
  const config = loadConfig();
  const persona = await loadPersona(config.persona);
  console.log(`[加载] 人设: ${persona.name} (${persona.emotions.attachmentStyle})`);

  const allMessages = loadSessionMessages();
  console.log(`[加载] 历史消息: ${allMessages.length} 条`);

  // ── 阶段 1+2: A/B 合规对比 ──
  console.log("\n── 阶段 1+2: A/B 合规评分对比 ──");

  const pairs = extractConversationPairs(allMessages, SAMPLE_SIZE);
  console.log(`  采样 ${pairs.length} 组对话对`);

  const comparison = await runBaselineComparison(persona, pairs);
  console.log(runComplianceComparison(comparison));

  // ── 阶段 3: LLM-as-Judge ──
  console.log("\n── 阶段 3: LLM-as-Judge 主观评分 ──");

  const snippets = buildConversationSnippets(allMessages, 8, JUDGE_SAMPLE_SIZE);
  console.log(`  选取 ${snippets.length} 个对话片段 (每段 8 轮)`);

  const judgeResults = await runLLMJudge(persona, snippets);
  console.log(formatJudgeResults(judgeResults));

  // ── 汇总输出 ──
  console.log("");
  console.log("═══════════════════════════════════════");
  console.log("  评测完成");
  console.log(`  A/B 对比: ${comparison.structured.totalReplies} 组对话`);
  console.log(`  结构化引擎得分: ${comparison.structuredScore.overall}/100`);
  console.log(`  纯Prompt基线得分: ${comparison.baselineScore.overall}/100`);
  console.log(`  得分差异: ${(comparison.delta.overall >= 0 ? "+" : "")}${comparison.delta.overall}`);
  if (judgeResults.length > 0) {
    const judgeAvg = judgeResults.reduce((s, r) => s + r.overallScore, 0) / judgeResults.length;
    console.log(`  LLM-as-Judge 综合评分: ${judgeAvg.toFixed(1)}/5`);
  }
  console.log("═══════════════════════════════════════");

  // ── 输出 JSON 结果供文档引用 ──
  const outputPath = "data/ab-eval-result.json";
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    persona: persona.name,
    sampleSize: SAMPLE_SIZE,
    abComparison: {
      structuredScore: comparison.structuredScore,
      baselineScore: comparison.baselineScore,
      delta: comparison.delta,
      structuredMetrics: {
        bracketRate: comparison.structured.bracketRate,
        questionEndingRate: comparison.structured.questionEndingRate,
        avgReplyLength: comparison.structured.avgReplyLength,
        repetitionScore: comparison.structured.repetitionScore,
      },
      baselineMetrics: {
        bracketRate: comparison.baseline.bracketRate,
        questionEndingRate: comparison.baseline.questionEndingRate,
        avgReplyLength: comparison.baseline.avgReplyLength,
        repetitionScore: comparison.baseline.repetitionScore,
      },
    },
    judgeResults: judgeResults.map(r => ({
      overallScore: r.overallScore,
      summary: r.summary,
      dimensions: r.dimensions,
    })),
  }, null, 2));
  console.log(`\n结果已保存到 ${outputPath}`);
}

main().catch(err => {
  console.error("评测失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
