/**
 * 锚点复筛评测 CLI（v0.8.5）。
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/anchor-eval.ts --offline   # 只校验金标结构
 *   node node_modules/tsx/dist/cli.mjs scripts/anchor-eval.ts             # live（真实模型，约 ¥0.003）
 *   ... --write-report                                                   # 写到 docs/ANCHOR_EVAL_REPORT.md
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const writeReport = argv.includes("--write-report");

  const { loadAnchorGold, runAnchorEvalLive, formatAnchorEvalReport } = await import(
    "../src/eval/anchor-eval.js"
  );
  const cases = loadAnchorGold();
  const positives = cases.filter((c) => c.expect.anchor).length;
  console.log(`金标：${cases.length} 条（该记 ${positives} / 不该记 ${cases.length - positives}）`);

  if (offline) {
    console.log("离线校验通过（结构/kind/两类齐全）");
    return;
  }

  const { refineAnchorsWithLLM } = await import("../src/schedule/anchor-llm.js");
  const { getChatModel } = await import("../src/ai/router.js");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const result = await runAnchorEvalLive({ cases, chatFn: (p) => refineAnchorsWithLLM(p) });
  const model = getChatModel().model;
  const s = result.summary;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${s.batches} 批`);
  console.log(
    `准确率 ${pct(s.accuracy)}｜精确率 ${pct(s.precision)}｜召回 ${pct(s.recall)}｜kind ${pct(s.kindAccuracy)}`,
  );
  console.log(`混淆：TP ${s.truePositives} / FP ${s.falsePositives} / FN ${s.falseNegatives} / TN ${s.trueNegatives}`);
  const wrong = result.items.filter((i) => i.expected !== i.decided);
  if (wrong.length > 0) {
    console.log("误判：");
    for (const w of wrong) {
      console.log(`  - ${w.id}: 期望${w.expected ? "该记" : "不该记"} → 实际${w.decided ? "该记" : "不该记"}`);
    }
  }

  if (writeReport) {
    const md = formatAnchorEvalReport(result, { model, startedAt });
    const out = path.join("docs", "ANCHOR_EVAL_REPORT.md");
    fs.writeFileSync(out, md + "\n", "utf-8");
    console.log(`报告已写入 ${out}`);
  }
}

main().catch((err: unknown) => {
  console.error("评测失败:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
