/**
 * 真实模型长跑回归（临时数据目录）：30 轮混合场景，一起压
 * 记忆/事实抽取/时间感/反重复/AI 味/延迟/成本，找残留 bug。
 *
 * 用法（需要 .env 的 DEEPSEEK_API_KEY，会产生少量真实调用费用）：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs src/eval/longrun-sim.ts --live
 *   ... --live --turns 20   # 只跑前 N 轮
 *
 * 输出：JSON（逐轮回复 + 指标 + 失败明细），同时打印人读摘要。
 * 不联网的纯函数（repStats / 检查）有单测（longrun-sim.test.ts）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRepetition } from "../persona/anti-repetition.js";

export interface LongRunTurn {
  /** 用户消息 */
  text: string;
  /** 期望回答中出现的关键词（任一命中即通过） */
  expect?: string[];
  /** 场景标签（报告分组用） */
  label?: string;
}

/** 30 轮混合场景：事实 → 闲聊 → 记忆提问 → 重复施压 → 新计划 → 再回忆。 */
export const LONGRUN_SCENARIO: LongRunTurn[] = [
  { text: "我叫林哲，在杭州做产品设计。", label: "fact" },
  { text: "我养了只橘猫叫团子，特别能吃。", label: "fact" },
  { text: "最近在做一个咖啡品牌包装项目，忙死了。", label: "fact" },
  { text: "今天天气还行，你那边呢？", label: "chat" },
  { text: "我下班了，累瘫。", label: "chat" },
  { text: "你平时喜欢吃什么？", label: "chat" },
  { text: "周末一般干嘛？", label: "chat" },
  { text: "我最近睡不太好。", label: "chat" },
  { text: "你还记得我叫什么吗？", expect: ["林哲"], label: "memory" },
  { text: "我在做什么项目来着？", expect: ["咖啡"], label: "memory" },
  { text: "我的猫叫啥？", expect: ["团子"], label: "memory" },
  { text: "今天好累啊", label: "repeat" },
  { text: "上班累死了", label: "repeat" },
  { text: "我感觉每天都好累", label: "repeat" },
  { text: "真的好累 不想动", label: "repeat" },
  { text: "你说我为啥这么累", label: "repeat" },
  { text: "我们聊了这么多，你还记得我在哪工作吗？", expect: ["杭州", "产品设计"], label: "memory" },
  { text: "换个话题，最近有什么好看的电影吗？", label: "chat" },
  { text: "我不太爱出门。", label: "chat" },
  { text: "对了，我下周三要去云南出差。", label: "fact" },
  { text: "你帮我记一下这个安排。", label: "chat" },
  { text: "感觉最近压力有点大。", label: "chat" },
  { text: "不过还好，快熬过去了。", label: "chat" },
  { text: "我晚上准备煮面吃。", label: "chat" },
  { text: "你晚上吃什么？", label: "chat" },
  { text: "在吗", label: "chat" },
  { text: "我下周三要去哪来着？", expect: ["云南"], label: "memory" },
  { text: "你还记得我的猫吗？", expect: ["团子"], label: "memory" },
  { text: "今天上班又被老板骂了。", label: "chat" },
  { text: "谢谢你陪我聊。", label: "chat" },
];

export interface LongRunReply {
  turn: number;
  label: string;
  user: string;
  reply: string;
  latencyMs: number;
  error?: string;
  logs: string[];
}

export interface MemoryCheck {
  turn: number;
  user: string;
  expect: string[];
  reply: string;
  pass: boolean;
}

export interface QualityFlags {
  /** 出现括号动作描述（（）、()、【】、[]）的轮次 */
  bracketTurns: number[];
  /** 任一行以逗号/顿号结尾的轮次 */
  trailingCommaTurns: number[];
  /** 出现「考我/查岗/抽查/我记性没那么差」的轮次 */
  memoryDeflectionTurns: number[];
  /** 单行超过 30 字的轮次（碎短句要求 5-15 字，宽容到 30） */
  longLineTurns: number[];
  /** 空回复轮次 */
  emptyTurns: number[];
}

export interface LongRunMetrics {
  turns: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  errors: Array<{ turn: number; error: string }>;
  memoryChecks: MemoryCheck[];
  memoryPassRate: number;
  /** 相邻回复被 detectRepetition 判为复读的对数 */
  duplicatePairs: number;
  avgRepetitionScore: number;
  maxRepetitionScore: number;
  flags: QualityFlags;
  avgReplyChars: number;
  questionEndingRate: number;
}

// 只看中文括号/【】以及「内含中文的 ASCII 方括号」（动作描述）；
// 纯符号方括号通常是颜文字（(:3[▓▓]），不算违规
const BRACKET_RE = /（[^）]*）|【[^】]*】|\[[^\]]*[\u4e00-\u9fff][^\]]*\]/;
const DEFLECTION_RE = /记性没那么差|记性没那么好|我记性不好|考我|查岗|抽查/;
const TRAILING_SOFT_RE = /[，,、；;]\s*$/;

function lines(reply: string): string[] {
  return reply
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 汇总 30 轮回复的指标（纯函数，可单测）。 */
export function summarizeLongRun(replies: LongRunReply[]): LongRunMetrics {
  const valid = replies.filter((row) => !row.error && row.reply.trim());
  const latencies = replies.map((row) => row.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
  const avg = latencies.length > 0 ? latencies.reduce((sum, n) => sum + n, 0) / latencies.length : 0;

  const flags: QualityFlags = {
    bracketTurns: [],
    trailingCommaTurns: [],
    memoryDeflectionTurns: [],
    longLineTurns: [],
    emptyTurns: [],
  };
  for (const row of replies) {
    if (!row.error && !row.reply.trim()) flags.emptyTurns.push(row.turn);
    if (row.error || !row.reply.trim()) continue;
    if (BRACKET_RE.test(row.reply)) flags.bracketTurns.push(row.turn);
    if (lines(row.reply).some((line) => TRAILING_SOFT_RE.test(line))) {
      flags.trailingCommaTurns.push(row.turn);
    }
    if (DEFLECTION_RE.test(row.reply)) flags.memoryDeflectionTurns.push(row.turn);
    if (lines(row.reply).some((line) => line.length > 30)) flags.longLineTurns.push(row.turn);
  }

  let duplicatePairs = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  for (let i = 1; i < valid.length; i++) {
    const previous = valid.slice(Math.max(0, i - 3), i).map((row) => row.reply);
    const result = detectRepetition(valid[i].reply, previous);
    scoreSum += result.score;
    scoreMax = Math.max(scoreMax, result.score);
    if (result.duplicate) duplicatePairs++;
  }

  const memoryChecks: MemoryCheck[] = [];
  for (const row of replies) {
    if (row.error) continue;
    const turn = LONGRUN_SCENARIO[row.turn - 1];
    if (!turn?.expect?.length) continue;
    const reply = row.reply;
    memoryChecks.push({
      turn: row.turn,
      user: row.user,
      expect: turn.expect,
      reply,
      pass: turn.expect.some((keyword) => reply.includes(keyword)),
    });
  }

  const allLines = valid.flatMap((row) => lines(row.reply));
  const questionLines = allLines.filter((line) => /[?？]\s*$/.test(line)).length;
  const avgChars =
    valid.length > 0
      ? valid.reduce((sum, row) => sum + row.reply.replace(/\s/g, "").length, 0) / valid.length
      : 0;

  return {
    turns: replies.length,
    avgLatencyMs: Math.round(avg),
    p95LatencyMs: latencies[p95Index] ?? 0,
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
    errors: replies.filter((row) => row.error).map((row) => ({ turn: row.turn, error: row.error! })),
    memoryChecks,
    memoryPassRate:
      memoryChecks.length > 0
        ? Number((memoryChecks.filter((check) => check.pass).length / memoryChecks.length).toFixed(3))
        : 0,
    duplicatePairs,
    avgRepetitionScore:
      valid.length > 1 ? Number((scoreSum / (valid.length - 1)).toFixed(3)) : 0,
    maxRepetitionScore: Number(scoreMax.toFixed(3)),
    flags,
    avgReplyChars: Math.round(avgChars),
    questionEndingRate:
      allLines.length > 0 ? Number((questionLines / allLines.length).toFixed(3)) : 0,
  };
}

// ── 真实运行 ──────────────────────────────────

export interface LongRunResult {
  dataDir: string;
  replies: LongRunReply[];
  metrics: LongRunMetrics;
  facts: Array<{ key: string; value: string }>;
  /** T3 压缩结果（30 轮通常不够 40 条，但便于观测） */
  t3: { summaries: number; uncompressed: number; newest: string | null };
  counts: { t2: number; t1: number; facts: number };
  cost: {
    calls: number;
    costCny: number;
    byKind: Array<{ kind: string; calls: number; costCny: number }>;
  };
}

export async function runLongRunLive(options: { turns?: number } = {}): Promise<LongRunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-longrun-"));
  process.env.KAREN_DATA_DIR = dir;

  try {
    const { loadConfig } = await import("../data/store.js");
    const { loadPersona } = await import("../persona/loader.js");
    const { initConversation, processMessage } = await import("../pipeline/orchestrator.js");
    const { listUserFacts } = await import("../data/user-facts.js");
    const { getVectorDb } = await import("../data/vector.js");
    const { getCostReport } = await import("../obs/cost-tracker.js");

    const config = loadConfig();
    const persona = await loadPersona(config.persona);
    const state = await initConversation(persona, config);

    const turns = Math.min(LONGRUN_SCENARIO.length, Math.max(1, options.turns ?? LONGRUN_SCENARIO.length));
    const replies: LongRunReply[] = [];

    for (let index = 0; index < turns; index++) {
      const turn = LONGRUN_SCENARIO[index];
      const startedAt = Date.now();
      try {
        const result = await processMessage(state, turn.text, { bypassGate: true });
        replies.push({
          turn: index + 1,
          label: turn.label ?? "chat",
          user: turn.text,
          reply: result.reply,
          latencyMs: Date.now() - startedAt,
          logs: result.logs.filter((line) => line.startsWith("[检索+]") || line.startsWith("[依赖]")),
        });
      } catch (err) {
        replies.push({
          turn: index + 1,
          label: turn.label ?? "chat",
          user: turn.text,
          reply: "",
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          logs: [],
        });
      }
    }

    const db = getVectorDb();
    const counts = {
      t2: Number((db.prepare("SELECT COUNT(*) c FROM t2_episodes").get() as { c: number }).c),
      t1: Number((db.prepare("SELECT COUNT(*) c FROM t1_snapshots").get() as { c: number }).c),
      facts: Number((db.prepare("SELECT COUNT(*) c FROM user_facts").get() as { c: number }).c),
    };
    const t3Row = db
      .prepare(
        `SELECT content FROM t2_episodes
         WHERE persona_id = ? AND source = 't3_summary' ORDER BY id DESC LIMIT 1`,
      )
      .get(state.storagePersona) as { content: string } | undefined;
    const uncompressed = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) c FROM t2_episodes
             WHERE persona_id = ? AND source IN ('chat','event','causal_chain','user_trace')
               AND strength > 0.1 AND COALESCE(t3_compressed, 0) = 0`,
          )
          .get(state.storagePersona) as { c: number }
      ).c,
    );
    const t3 = {
      summaries: Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) c FROM t2_episodes WHERE persona_id = ? AND source = 't3_summary'`,
            )
            .get(state.storagePersona) as { c: number }
        ).c,
      ),
      uncompressed,
      newest: t3Row?.content ?? null,
    };
    const report = getCostReport(2);
    const cost = {
      calls: report.total.calls,
      costCny: report.total.cost_cny,
      byKind: report.by_kind.map((bucket) => ({
        kind: bucket.kind,
        calls: bucket.calls,
        costCny: bucket.cost_cny,
      })),
    };

    return {
      dataDir: dir,
      replies,
      metrics: summarizeLongRun(replies),
      facts: listUserFacts(state.owner).map((fact) => ({ key: fact.key, value: fact.value })),
      t3,
      counts,
      cost,
    };
  } finally {
    // 由调用方决定是否保留数据目录（CLI 默认清理）
  }
}

function formatMarkdown(result: LongRunResult): string {
  const m = result.metrics;
  const lines = [
    `# 长跑回归（${m.turns} 轮）`,
    "",
    `- 延迟：avg ${m.avgLatencyMs}ms / p95 ${m.p95LatencyMs}ms / max ${m.maxLatencyMs}ms`,
    `- 记忆检查：${(m.memoryPassRate * 100).toFixed(0)}%（${m.memoryChecks.filter((c) => c.pass).length}/${m.memoryChecks.length}）`,
    `- 复读对：${m.duplicatePairs}；平均相似度 ${m.avgRepetitionScore}；最高 ${m.maxRepetitionScore}`,
    `- 平均回复长度：${m.avgReplyChars} 字；问句收尾比例：${(m.questionEndingRate * 100).toFixed(0)}%`,
    `- 错误：${m.errors.length}；空回复：${m.flags.emptyTurns.length}`,
    `- 括号动作：${m.flags.bracketTurns.length} 轮；逗号结尾：${m.flags.trailingCommaTurns.length} 轮`,
    `- 记忆防御话术：${m.flags.memoryDeflectionTurns.length} 轮；超长行：${m.flags.longLineTurns.length} 轮`,
    `- 数据：T2 ${result.counts.t2} / T1 ${result.counts.t1} / facts ${result.counts.facts} / T3 摘要 ${result.t3.summaries}（未压缩 ${result.t3.uncompressed}）`,
    `- 成本：${result.cost.calls} 次 / ¥${result.cost.costCny}`,
    "",
    "## 记忆检查明细",
    ...m.memoryChecks.map(
      (check) =>
        `- T${check.turn} ${check.pass ? "✅" : "❌"} 「${check.user}」期望 ${check.expect.join("/")} → ${check.reply.replace(/\n/g, " / ").slice(0, 80)}`,
    ),
    "",
    "## 抽取到的事实",
    ...result.facts.map((fact) => `- ${fact.key} = ${fact.value}`),
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log("用法: tsx src/eval/longrun-sim.ts --live [--turns N]（会调用真实 DeepSeek）");
    console.log(`场景 ${LONGRUN_SCENARIO.length} 轮：事实 → 闲聊 → 记忆 → 重复施压 → 新计划 → 再回忆`);
    return;
  }
  await import("dotenv/config");
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY（.env）");
    process.exit(1);
  }
  const turnsIndex = process.argv.indexOf("--turns");
  const turns = turnsIndex >= 0 ? Number(process.argv[turnsIndex + 1]) : undefined;
  const result = await runLongRunLive({ turns });
  console.log(formatMarkdown(result));
  console.log("\n```json\n" + JSON.stringify(result, null, 2) + "\n```");
  try {
    fs.rmSync(result.dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const entryName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(ts|js|mjs|cjs)$/, "")
  : "";
if (entryName === "longrun-sim") {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
