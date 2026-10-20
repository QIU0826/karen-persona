/**
 * 跨轮重复 A/B 评测（真实模型）。
 *
 * 用处：验证「反重复注入」是否真的让她的连续回复不那么像复读机。
 * 三组对照：
 * - baseline：`KAREN_NO_ANTI_REPEAT=1`，不注入「避免重复自己」块；
 * - openers：生产默认，只给开头片段（避免模型照抄整句）；
 * - full：`KAREN_REPEAT_NOTE_MODE=full`，回放最近几条完整短句 + 点名重复开头；
 * - 同一个临时数据目录、不同 owner（ab:<arm>-rN）保证互不污染；
 * - 用 detectRepetition 统计相邻回复的复读对/连续同开头/相似度，并统计套话句式命中。
 *
 * 用法（需要 .env 里的 DEEPSEEK_API_KEY，会产生少量真实调用费用）：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs src/eval/repetition-eval.ts --live --runs 3
 *
 * 输出：JSON（scenario / runs / aggregate / 明细回复），供人工写进 docs 评测报告。
 * 不联网的纯函数部分有单测（repetition-eval.test.ts），CI 不跑 --live。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRepetition } from "../persona/anti-repetition.js";

/**
 * 故意设计成「用户重复问同类型问题」的场景：正常聊天里人也会遇到，
 * 但模型很容易连续用同一个开头/同一句安慰。6 轮足够观察复读。
 */
export const REPETITION_SCENARIO: string[] = [
  "在干嘛",
  "在干嘛呢",
  "你在干嘛呀",
  "我好累啊",
  "我真的很累",
  "今天真的好累",
];

/** AI 味/套话高频片段：用来观察「换汤不换药」的句式复读（词法相似度抓不到）。 */
const FORMULAIC_PATTERNS = [
  "是不是",
  "要不要",
  "有没有",
  "我记得",
  "其实",
  "确实",
  "哈哈",
  "话说",
  "然后呢",
  "我跟你说",
  "早点",
  "别太",
];

/** 判定一句回复是否以问句收尾（套话式"关心"的典型形态）。 */
function endsWithQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}

export interface RepetitionPair {
  from: number;
  to: number;
  score: number;
  kind: string;
  duplicate: boolean;
}

export interface RepetitionMetrics {
  arm: string;
  turns: number;
  /** 相邻回复的复读对数（detectRepetition 判定 duplicate） */
  duplicatePairs: number;
  /** 相邻回复开头词（前 2 字）重复的次数 */
  openerRepeats: number;
  /** 相邻回复平均相似度 */
  avgScore: number;
  /** 相邻回复最高相似度 */
  maxScore: number;
  /** 以问句收尾的回复条数 */
  questionReplies: number;
  /** 套话/固定句式命中次数（越多越"AI 味"） */
  formulaicHits: number;
  pairs: RepetitionPair[];
  replies: string[];
}

/** 统计一组回复的跨轮重复程度（纯函数，可单测）。 */
export function summarizeRepetition(arm: string, replies: string[]): RepetitionMetrics {
  const pairs: RepetitionPair[] = [];
  let duplicatePairs = 0;
  let openerRepeats = 0;
  let total = 0;
  let maxScore = 0;

  for (let i = 1; i < replies.length; i++) {
    // 与生产一致：只和最近 3 条自己说过的话比较
    const previous = replies.slice(Math.max(0, i - 3), i);
    const result = detectRepetition(replies[i], previous);
    pairs.push({
      from: i - 1,
      to: i,
      score: Number(result.score.toFixed(3)),
      kind: result.kind,
      duplicate: result.duplicate,
    });
    total += result.score;
    maxScore = Math.max(maxScore, result.score);
    if (result.duplicate) duplicatePairs++;
    if (result.kind === "opener" || (i >= 1 && openerOf(replies[i]) === openerOf(replies[i - 1]))) {
      openerRepeats++;
    }
  }

  const adjacentCount = Math.max(0, replies.length - 1);
  const joined = replies.join("\n");
  return {
    arm,
    turns: replies.length,
    duplicatePairs,
    openerRepeats,
    avgScore: adjacentCount > 0 ? Number((total / adjacentCount).toFixed(3)) : 0,
    maxScore: Number(maxScore.toFixed(3)),
    questionReplies: replies.filter((reply) => endsWithQuestion(reply)).length,
    formulaicHits: FORMULAIC_PATTERNS.reduce(
      (sum, pattern) => sum + (joined.match(new RegExp(pattern, "g"))?.length ?? 0),
      0,
    ),
    pairs,
    replies,
  };
}

/** 开头词：去标点后前 2 个字（与 anti-repetition 的判定口径一致）。 */
function openerOf(text: string): string {
  const cleaned = text
    .replace(/\[(?:CQ:[^\]]*|图片|语音|表情|贴纸|视频|文件|撤回)\]/g, "")
    .replace(/^[\s，,、；;：:。.!！?？…~～]+|[\s，,、；;：:。.!！?？…~～]+$/g, "")
    .trim();
  return cleaned.slice(0, 2);
}

/** 多次运行的聚合指标（同一 arm 跑 N 次取均值，降低模型随机性）。 */
export interface ArmAggregate {
  arm: string;
  runs: number;
  avgDuplicatePairs: number;
  avgOpenerRepeats: number;
  avgScore: number;
  avgMaxScore: number;
  avgQuestionReplies: number;
  avgFormulaicHits: number;
}

export function aggregateArm(arm: string, runs: RepetitionMetrics[]): ArmAggregate {
  const count = Math.max(1, runs.length);
  const mean = (pick: (m: RepetitionMetrics) => number): number =>
    Number((runs.reduce((sum, run) => sum + pick(run), 0) / count).toFixed(3));
  return {
    arm,
    runs: runs.length,
    avgDuplicatePairs: mean((m) => m.duplicatePairs),
    avgOpenerRepeats: mean((m) => m.openerRepeats),
    avgScore: mean((m) => m.avgScore),
    avgMaxScore: mean((m) => m.maxScore),
    avgQuestionReplies: mean((m) => m.questionReplies),
    avgFormulaicHits: mean((m) => m.formulaicHits),
  };
}

export interface ArmRun {
  metrics: RepetitionMetrics;
  logs: string[];
}

/**
 * 跑一个 arm（顺序发完整个场景），收集她的回复。
 * 注意：调用前必须已设置 KAREN_DATA_DIR；本函数只动态 import 业务模块，
 * 避免 vector.js 单例在设置目录前就初始化。
 */
export async function runArm(arm: string, owner: string): Promise<ArmRun> {
  const { loadConfig } = await import("../data/store.js");
  const { loadPersona } = await import("../persona/loader.js");
  const { initConversation, processMessage } = await import("../pipeline/orchestrator.js");

  const config = loadConfig();
  const persona = await loadPersona(config.persona);
  const state = await initConversation(persona, config, owner);
  const replies: string[] = [];
  const logs: string[] = [];

  for (const userText of REPETITION_SCENARIO) {
    const result = await processMessage(state, userText, { bypassGate: true });
    if (result.reply) replies.push(result.reply);
    for (const line of result.logs) {
      if (line.startsWith("[重复]")) logs.push(`${arm} ${line}`);
    }
  }

  return { metrics: summarizeRepetition(arm, replies), logs };
}

function parseRuns(argv: string[]): number {
  const index = argv.indexOf("--runs");
  const value = index >= 0 ? Number(argv[index + 1]) : 3;
  return Number.isFinite(value) && value >= 1 ? Math.min(10, Math.floor(value)) : 3;
}

interface EvalOutput {
  scenario: string[];
  runsPerArm: number;
  aggregate: ArmAggregate[];
  results: Array<{ round: number; arm: string; metrics: RepetitionMetrics }>;
  repetitionLogs: string[];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log(
      "用法: tsx src/eval/repetition-eval.ts --live [--runs N]（会调用真实 DeepSeek，产生少量费用）",
    );
    console.log("场景:", REPETITION_SCENARIO.join(" / "));
    return;
  }
  // 只在 live 模式加载 .env，避免单测 import 本模块时把真实 Key 带进测试进程
  await import("dotenv/config");
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY（.env）");
    process.exit(1);
  }

  const runsPerArm = parseRuns(process.argv);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-repetition-"));
  process.env.KAREN_DATA_DIR = dir;
  const output: EvalOutput = {
    scenario: REPETITION_SCENARIO,
    runsPerArm,
    aggregate: [],
    results: [],
    repetitionLogs: [],
  };

  try {
    // baseline（关闭）、openers（生产默认）、full（回放整句，仅对照）三组
    for (const arm of ["baseline", "openers", "full"] as const) {
      const armRuns: RepetitionMetrics[] = [];
      for (let round = 1; round <= runsPerArm; round++) {
        if (arm === "baseline") {
          process.env.KAREN_NO_ANTI_REPEAT = "1";
          delete process.env.KAREN_REPEAT_NOTE_MODE;
        } else if (arm === "full") {
          delete process.env.KAREN_NO_ANTI_REPEAT;
          process.env.KAREN_REPEAT_NOTE_MODE = "full";
        } else {
          delete process.env.KAREN_NO_ANTI_REPEAT;
          delete process.env.KAREN_REPEAT_NOTE_MODE;
        }
        const run = await runArm(arm, `ab:${arm}-r${round}`);
        armRuns.push(run.metrics);
        output.results.push({ round, arm, metrics: run.metrics });
        output.repetitionLogs.push(...run.logs);
      }
      output.aggregate.push(aggregateArm(arm, armRuns));
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    delete process.env.KAREN_NO_ANTI_REPEAT;
    delete process.env.KAREN_REPEAT_NOTE_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const entryName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(ts|js|mjs|cjs)$/, "")
  : "";
const invokedDirectly = entryName === "repetition-eval";
if (invokedDirectly) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
