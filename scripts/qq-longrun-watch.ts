#!/usr/bin/env tsx
/**
 * 真实 QQ 长跑观察 CLI（只读）。
 *
 * 用法：
 *   npx tsx scripts/qq-longrun-watch.ts --duration 3600
 *   npx tsx scripts/qq-longrun-watch.ts --duration 600 --interval 5
 *   npm run qq:watch -- --duration 1800
 *
 * 行为：
 * - 从启动时刻开始观察（只看新消息/新调用）；
 * - 每 N 秒打印新回合（用户 → 她，含延迟）与成本变化；
 * - 结束时在 data/ 写一份 JSON + Markdown 报告（600 权限，含对话原文）；
 * - Ctrl-C 也会先落报告再退出。
 *
 * 注意：只读打开 data/memory.sqlite，不会影响正在运行的桥接。
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../src/data/paths.js";
import {
  buildRealRunReport,
  collectRealRunSnapshot,
  formatRealRunReportMarkdown,
  type RealRunReport,
} from "../src/eval/qq-realrun.js";

interface Args {
  durationSec: number;
  intervalSec: number;
  outBase: string | null;
}

function parseArgs(argv: string[]): Args {
  const durationIndex = argv.indexOf("--duration");
  const intervalIndex = argv.indexOf("--interval");
  const outIndex = argv.indexOf("--out");
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    durationSec: durationIndex >= 0 ? parsePositive(argv[durationIndex + 1], 3600) : 3600,
    intervalSec: intervalIndex >= 0 ? parsePositive(argv[intervalIndex + 1], 10) : 10,
    outBase: outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : null,
  };
}

const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const dir = dataDir();
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
const base = args.outBase ? path.resolve(args.outBase) : path.join(dir, `realrun-${stamp}`);
const jsonPath = base.endsWith(".json") ? base : `${base}.json`;
const mdPath = jsonPath.replace(/\.json$/, ".md");

let lastTurnCount = 0;
let lastCalls = 0;
let lastFacts = 0;
let finished = false;

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function printNewTurns(report: RealRunReport): void {
  const fresh = report.turns.slice(lastTurnCount);
  for (const turn of fresh) {
    const latency = turn.latencyMs === null ? "?" : `${turn.latencyMs}ms`;
    console.log(`\n[${latency}] 用户：${preview(turn.user)}`);
    console.log(`         她：${preview(turn.assistant, 120)}`);
  }
  lastTurnCount = report.turns.length;
  if (report.cost.calls !== lastCalls) {
    console.log(
      `  成本：新增 ${report.cost.calls - lastCalls} 次调用，累计 ¥${report.cost.totalCny.toFixed(6)}`,
    );
    lastCalls = report.cost.calls;
  }
  if (report.memory.facts !== lastFacts) {
    console.log(`  用户事实：${lastFacts} → ${report.memory.facts} 条`);
    lastFacts = report.memory.facts;
  }
}

function finish(reason: string): void {
  if (finished) return;
  finished = true;
  try {
    const snapshot = collectRealRunSnapshot({ sinceMs: startedAt });
    const report = buildRealRunReport(snapshot, { sinceMs: startedAt });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.writeFileSync(mdPath, formatRealRunReportMarkdown(report), { encoding: "utf-8", mode: 0o600 });
    console.log(`\n观察结束（${reason}）：`);
    console.log(`  回合 ${report.turnCount} · 空回复 ${report.quality.emptyReplies} · 重复 ${report.quality.duplicateReplies}`);
    if (report.latency) {
      console.log(`  延迟 平均 ${report.latency.avgMs}ms · P95 ${report.latency.p95Ms}ms`);
    }
    console.log(`  成本 ¥${report.cost.totalCny.toFixed(6)}（${report.cost.calls} 次）`);
    if (report.flags.length > 0) {
      console.log(`  ⚠️ ${report.flags.join("；")}`);
    }
    console.log(`  报告：${jsonPath}`);
    console.log(`        ${mdPath}`);
  } catch (err) {
    console.error("写报告失败:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

function poll(): void {
  if (finished) return;
  try {
    const snapshot = collectRealRunSnapshot({ sinceMs: startedAt });
    const report = buildRealRunReport(snapshot, { sinceMs: startedAt });
    printNewTurns(report);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= args.durationSec * 1000) {
      finish(`已观察 ${args.durationSec}s`);
      return;
    }
  } catch (err) {
    console.error("观察失败:", err instanceof Error ? err.message : err);
  }
  setTimeout(poll, args.intervalSec * 1000);
}

process.on("SIGINT", () => finish("Ctrl-C"));
process.on("SIGTERM", () => finish("SIGTERM"));

console.log("真实 QQ 长跑观察（只读）");
console.log(`  数据目录：${dir}`);
console.log(`  观察时长：${args.durationSec}s · 轮询 ${args.intervalSec}s`);
console.log(`  现在去 QQ 给她发消息；新回合会实时打印在这里。`);
console.log(`  报告输出：${jsonPath}`);
const initial = collectRealRunSnapshot({ sinceMs: startedAt });
const initialReport = buildRealRunReport(initial, { sinceMs: startedAt });
console.log(
  `  当前已有：${initialReport.messageCount} 条历史消息（不在本次窗口）· 同意记录：${
    initialReport.memory.hasConsent
      ? `18+ ${initialReport.memory.ageConfirmed ? "已确认" : "未确认"}`
      : "无（新用户首条会收到披露+18+ 确认）"
  }`,
);
lastTurnCount = initialReport.turnCount;
lastCalls = initialReport.cost.calls;
lastFacts = initialReport.memory.facts;
setTimeout(poll, args.intervalSec * 1000);
