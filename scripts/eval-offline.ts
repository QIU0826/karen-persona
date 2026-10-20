/**
 * 离线评测守门（v0.8.6）：CI 里跑，防止记忆检索 / 锚点判断悄悄退化。
 *
 * 为什么需要：`npm test` 只验证**结构**（金标格式、评测函数逻辑），不验证**指标**；
 * 改了检索或 prompt 之后指标掉了，单测却全绿——所以要有一个跑真实指标并卡阈值的入口。
 *
 * - 两套金标都跑：memory（40 条，离线 ngram+FTS5）与 anchor（30 条，结构校验）；
 * - 只在本地跑（不联网、不花 token、几秒完成），适合放进 CI；
 * - 阈值故意留余量（见 THRESHOLDS），失败时打印实测值，便于判断是真退化还是噪声。
 *
 * 用法：`npm run eval:offline`（CI 用）；`npm run eval:offline -- --verbose` 看明细。
 */
import { evaluateOffline, formatOfflineSummary } from "../src/eval/memory-eval.js";
import { loadAnchorGold } from "../src/eval/anchor-eval.js";
import { VALID_ANCHOR_KINDS } from "../src/schedule/anchor-refine.js";

/**
 * 阈值（离线评测是确定性的——强制 ngram、不联网、不跑模型，所以可以卡得比较紧）。
 * 留 2–5 个百分点余量，避免未来小的合理调整就要改阈值。
 */
export const THRESHOLDS = {
  /** 事实层命中率（低于这个说明注入/facts 链路坏了） */
  factsHitRate: 0.95,
  /** T2 recall@8（低于这个说明检索主干退化） */
  recallAt8: 0.9,
  /** 合并上下文命中率（facts + RAG 都没命中才算失败） */
  mergedHitRate: 0.95,
  /** anti-forget 回归必须通过 */
  antiForgetMustPass: true,
  /** 锚点金标至少这么多条，且两类都要有 */
  anchorMinCases: 30,
} as const;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 把离线记忆指标与阈值比对（纯函数：CI 与单测共用，保证"守门真的会失败"）。 */
export function buildMemoryChecks(
  metrics: {
    factsHitRate: number;
    factsHits: number;
    total: number;
    recallAt1: number;
    recallAt3: number;
    recallAt8: number;
    mergedHitRate: number;
    mergedHits: number;
  },
  antiForget: { passed: boolean; mergedHit: boolean } | null,
): CheckResult[] {
  const checks: CheckResult[] = [];
  checks.push({
    name: `记忆 facts 命中率 ≥ ${pct(THRESHOLDS.factsHitRate)}`,
    ok: metrics.factsHitRate >= THRESHOLDS.factsHitRate,
    detail: `实测 ${pct(metrics.factsHitRate)}（${metrics.factsHits}/${metrics.total}）`,
  });
  checks.push({
    name: `记忆 recall@8 ≥ ${pct(THRESHOLDS.recallAt8)}`,
    ok: metrics.recallAt8 >= THRESHOLDS.recallAt8,
    detail: `实测 ${pct(metrics.recallAt8)}（@1 ${pct(metrics.recallAt1)} / @3 ${pct(metrics.recallAt3)}）`,
  });
  checks.push({
    name: `合并上下文命中率 ≥ ${pct(THRESHOLDS.mergedHitRate)}`,
    ok: metrics.mergedHitRate >= THRESHOLDS.mergedHitRate,
    detail: `实测 ${pct(metrics.mergedHitRate)}（${metrics.mergedHits}/${metrics.total}）`,
  });
  const antiForgetOk = antiForget ? antiForget.passed === true : false;
  checks.push({
    name: "anti-forget 回归通过",
    ok: THRESHOLDS.antiForgetMustPass ? antiForgetOk : true,
    detail: antiForget
      ? `合并上下文${antiForget.mergedHit ? "含" : "缺"}正确事实，结论 ${antiForgetOk ? "PASS" : "FAIL"}`
      : "未跑（includeAntiForget=false）",
  });
  return checks;
}

/** 锚点金标结构检查（纯函数）。 */
export function buildAnchorCheck(cases: Array<{ expect: { anchor: boolean; kind?: string } }>): CheckResult {
  const positives = cases.filter((c) => c.expect.anchor).length;
  const kindValid = cases.every(
    (c) => !c.expect.kind || VALID_ANCHOR_KINDS.includes(c.expect.kind as never),
  );
  const ok =
    cases.length >= THRESHOLDS.anchorMinCases && positives > 0 && positives < cases.length && kindValid;
  return {
    name: `锚点金标 ≥ ${THRESHOLDS.anchorMinCases} 条且两类齐全`,
    ok,
    detail: `${cases.length} 条（该记 ${positives} / 不该记 ${cases.length - positives}），kind ${kindValid ? "合法" : "有非法值"}`,
  };
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const checks: CheckResult[] = [];

  // ── 1. 记忆金标离线指标 ──────────────────
  const memory = evaluateOffline();
  if (verbose) console.log(formatOfflineSummary(memory));
  checks.push(...buildMemoryChecks(memory.metrics, memory.antiForget));

  // ── 2. 锚点金标结构 ──────────────────────
  try {
    checks.push(buildAnchorCheck(loadAnchorGold()));
  } catch (err: unknown) {
    checks.push({
      name: `锚点金标 ≥ ${THRESHOLDS.anchorMinCases} 条且两类齐全`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 输出 ────────────────────────────────
  console.log("── 离线评测守门 ─────────────────────────");
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}｜${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} 项未达标：${failed.map((f) => f.name).join("；")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n全部达标（${checks.length} 项）`);
}

main().catch((err: unknown) => {
  console.error("离线评测失败:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
