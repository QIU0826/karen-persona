/**
 * 锚点复筛的回归评测（v0.8.5）。
 *
 * 目的：把「该记 / 不该记」的判断变成可复现指标，避免以后改 prompt 时无声退化。
 *
 * 三件事：
 * 1. 离线校验金标集结构（类别齐全、kind 合法、id 唯一）；
 * 2. live：用**生产同一份 prompt**（`buildAnchorRefinePrompt`）让真实模型判断，统计
 *    accuracy / precision / recall / kind 准确率 + 误判明细；
 * 3. 成本控制：30 条分 3 批（每批 ≤12，与生产一致），一次评测约 ¥0.003。
 *
 * 注意：这是**判断质量**评测，不是端到端记忆效果评测（后者看 memory-eval）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  REFINE_MAX_CANDIDATES,
  buildAnchorRefinePrompt,
  parseAnchorVerdicts,
  type RefineCandidate,
} from "../schedule/anchor-refine.js";
import { VALID_ANCHOR_KINDS, type AnchorVerdict } from "../schedule/anchor-refine.js";

/** 金标集路径：先看 __dirname（CJS 构建），再回落到 cwd（tsx 直跑）。 */
export const ANCHOR_GOLD_PATH = path.resolve(process.cwd(), "src/eval/anchor-gold.json");

export interface AnchorGoldCase {
  id: string;
  content: string;
  expect: { anchor: boolean; kind?: string };
  note?: string;
}

/** 读金标集 + 结构校验（失败抛错，便于 CI 早发现）。 */
export function loadAnchorGold(filePath = ANCHOR_GOLD_PATH): AnchorGoldCase[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("anchor-gold 必须是数组");
  const ids = new Set<string>();
  const cases: AnchorGoldCase[] = [];
  for (const [i, item] of raw.entries()) {
    const where = `anchor-gold[${i}]`;
    if (typeof item !== "object" || item === null) throw new Error(`${where} 不是对象`);
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) throw new Error(`${where}.id 非法`);
    if (ids.has(obj.id)) throw new Error(`${where}.id 重复: ${obj.id}`);
    ids.add(obj.id);
    if (typeof obj.content !== "string" || !obj.content.trim()) throw new Error(`${where}.content 非法`);
    const expect = obj.expect as { anchor?: unknown; kind?: unknown } | undefined;
    if (!expect || typeof expect.anchor !== "boolean") throw new Error(`${where}.expect.anchor 非法`);
    if (expect.kind !== undefined) {
      if (typeof expect.kind !== "string" || !VALID_ANCHOR_KINDS.includes(expect.kind as never)) {
        throw new Error(`${where}.expect.kind 非法: ${String(expect.kind)}`);
      }
      if (!expect.anchor) throw new Error(`${where} 不进锚点却给了 kind`);
    }
    cases.push({
      id: obj.id,
      content: obj.content,
      expect: { anchor: expect.anchor, ...(expect.kind ? { kind: expect.kind as string } : {}) },
      ...(typeof obj.note === "string" ? { note: obj.note } : {}),
    });
  }
  const positives = cases.filter((c) => c.expect.anchor).length;
  if (positives === 0 || positives === cases.length) {
    throw new Error("anchor-gold 必须同时包含「该记」与「不该记」两类");
  }
  return cases;
}

export interface AnchorEvalItemResult {
  id: string;
  expected: boolean;
  decided: boolean;
  expectedKind?: string;
  decidedKind?: string;
  content: string;
  note?: string;
}

export interface AnchorEvalSummary {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  kindAccuracy: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  batches: number;
}

export interface AnchorEvalResult {
  items: AnchorEvalItemResult[];
  summary: AnchorEvalSummary;
  errors: string[];
}

/** 把金标分组（每批 ≤ REFINE_MAX_CANDIDATES，与生产一致）。 */
export function batchCases(cases: AnchorGoldCase[], size = REFINE_MAX_CANDIDATES): AnchorGoldCase[][] {
  const batches: AnchorGoldCase[][] = [];
  for (let i = 0; i < cases.length; i += size) {
    batches.push(cases.slice(i, i + size));
  }
  return batches;
}

/** 统计（纯函数，便于单测）。 */
export function summarize(items: AnchorEvalItemResult[]): AnchorEvalSummary {
  const total = items.length;
  const truePositives = items.filter((i) => i.expected && i.decided).length;
  const falsePositives = items.filter((i) => !i.expected && i.decided).length;
  const falseNegatives = items.filter((i) => i.expected && !i.decided).length;
  const trueNegatives = items.filter((i) => !i.expected && !i.decided).length;
  const decidedPositives = truePositives + falsePositives;
  const expectedPositives = truePositives + falseNegatives;
  const kindCorrect = items.filter(
    (i) => i.expected && i.decided && i.expectedKind && i.decidedKind === i.expectedKind,
  ).length;
  const kindConsidered = items.filter((i) => i.expected && i.decided && i.expectedKind).length;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    total,
    accuracy: total > 0 ? round3((truePositives + trueNegatives) / total) : 0,
    precision: decidedPositives > 0 ? round3(truePositives / decidedPositives) : 1,
    recall: expectedPositives > 0 ? round3(truePositives / expectedPositives) : 1,
    kindAccuracy: kindConsidered > 0 ? round3(kindCorrect / kindConsidered) : 1,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    batches: 0,
  };
}

/**
 * live 评测：真实调用模型判断。
 * `chatFn` 由调用方注入（生产用 refineAnchorsWithLLM，测试用假实现）。
 */
export async function runAnchorEvalLive(options: {
  cases: AnchorGoldCase[];
  chatFn: (prompt: { system: string; user: string }) => Promise<string | null>;
  batchSize?: number;
}): Promise<AnchorEvalResult> {
  const batches = batchCases(options.cases, options.batchSize ?? REFINE_MAX_CANDIDATES);
  const items: AnchorEvalItemResult[] = [];
  const errors: string[] = [];

  // 用「内容当 id」的映射，便于把 verdict index 还原到金标条目
  for (const batch of batches) {
    const candidates: RefineCandidate[] = batch.map((c, idx) => ({
      id: idx,
      content: c.content,
      salience: 0.6,
      createdAt: 0,
    }));
    const raw = await options.chatFn(
      buildAnchorRefinePrompt({
        day: "anchor-eval",
        herName: "她",
        userName: "你",
        candidates,
      }),
    );
    if (!raw) {
      errors.push(`批次失败：${batch.map((c) => c.id).join(",")}`);
      for (const c of batch) {
        items.push({
          id: c.id,
          expected: c.expect.anchor,
          decided: false,
          ...(c.expect.kind ? { expectedKind: c.expect.kind } : {}),
          content: c.content,
          ...(c.note ? { note: c.note } : {}),
        });
      }
      continue;
    }
    const verdicts = parseAnchorVerdicts(raw, candidates.length);
    const byIndex = new Map<number, AnchorVerdict>();
    for (const v of verdicts) byIndex.set(v.index, v);
    for (const [idx, c] of batch.entries()) {
      const verdict = byIndex.get(idx);
      items.push({
        id: c.id,
        expected: c.expect.anchor,
        decided: verdict?.anchor === true,
        ...(c.expect.kind ? { expectedKind: c.expect.kind } : {}),
        ...(verdict ? { decidedKind: verdict.kind } : {}),
        content: c.content,
        ...(c.note ? { note: c.note } : {}),
      });
    }
  }

  const summary = summarize(items);
  summary.batches = batches.length;
  return { items, summary, errors };
}

/** 生成 markdown 报告。 */
export function formatAnchorEvalReport(result: AnchorEvalResult, meta: { model: string; startedAt: string }): string {
  const s = result.summary;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "# 锚点复筛评测报告",
    "",
    `- 生成时间：${meta.startedAt}`,
    `- 模型：${meta.model}`,
    `- 样本：${s.total} 条（${s.batches} 批，每批 ≤12）`,
    "",
    "| 指标 | 结果 |",
    "| --- | --- |",
    `| 准确率 | **${pct(s.accuracy)}** |`,
    `| 精确率（判该记里真的该记） | ${pct(s.precision)} |`,
    `| 召回率（该记的抓到多少） | ${pct(s.recall)} |`,
    `| kind 准确率（只看双方都判该记且金标有 kind） | ${pct(s.kindAccuracy)} |`,
    "",
    `混淆：TP ${s.truePositives} / FP ${s.falsePositives} / FN ${s.falseNegatives} / TN ${s.trueNegatives}`,
    "",
  ];
  const wrong = result.items.filter((i) => i.expected !== i.decided);
  if (wrong.length > 0) {
    lines.push("## 误判明细", "", "| id | 期望 | 实际 | 内容（截断） |", "| --- | --- | --- | --- |");
    for (const w of wrong) {
      const content = w.content.replace(/\n/g, " ").slice(0, 40);
      lines.push(`| ${w.id} | ${w.expected ? "该记" : "不该记"} | ${w.decided ? "该记" : "不该记"} | ${content} |`);
    }
    lines.push("");
  }
  const kindWrong = result.items.filter(
    (i) => i.expected && i.decided && i.expectedKind && i.decidedKind && i.expectedKind !== i.decidedKind,
  );
  if (kindWrong.length > 0) {
    lines.push("## 类型判错", "", "| id | 期望 | 实际 |", "| --- | --- | --- |");
    for (const k of kindWrong) lines.push(`| ${k.id} | ${k.expectedKind} | ${k.decidedKind} |`);
    lines.push("");
  }
  if (result.errors.length > 0) {
    lines.push("## 批次失败", "", ...result.errors.map((e) => `- ${e}`), "");
  }
  return lines.join("\n");
}
