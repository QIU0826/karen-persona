/**
 * P1 向量模型 spike（可重复运行）。
 *
 * 目的：同一份 20 条记忆金标，对比「现有 n-gram 向量」与「本地 Qwen3-Embedding」的
 * recall@1/3/8——决定 v0.5 是否切换到本地向量，以及切换后能提升多少。
 *
 * 前置：本地向量服务已启动（services/embed，默认 127.0.0.1:18083）。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/spike-embed.ts
 */
import fs from "node:fs";
import path from "node:path";
import { generateEmbedding } from "../src/data/embedding.js";

const EMBED_URL = process.env.KAREN_EMBED_URL ?? "http://127.0.0.1:18083";

interface GoldCase {
  id: string;
  category: string;
  type: string;
  statement: string;
  probe: string;
  expect: string[];
}

function cos(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedLocal(texts: string[], mode: "query" | "document"): Promise<number[][]> {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, mode }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const json = (await res.json()) as { vectors: number[][] };
  return json.vectors;
}

function rankByCosine(query: number[], docs: number[][]): number[] {
  return docs
    .map((d, i) => ({ i, s: cos(query, d) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

function recallAt(ranks: number[][], truth: number[], k: number): number {
  let hit = 0;
  for (let qi = 0; qi < ranks.length; qi++) {
    const top = ranks[qi].slice(0, k);
    if (top.includes(truth[qi])) hit += 1;
  }
  return hit / ranks.length;
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(path.join("src", "eval", "memory-gold.json"), "utf-8");
  const parsed = JSON.parse(raw) as GoldCase[] | { cases: GoldCase[] };
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  const statements = cases.map((c) => c.statement);
  const probes = cases.map((c) => c.probe);
  const truth = cases.map((_, i) => i); // 第 i 题的正确答案是第 i 条 statement

  console.log(`金标用例：${cases.length}\n`);

  // 1) n-gram（现有实现；无 Qwen Key 时走字符 n-gram）
  const t0 = Date.now();
  const docNgram = statements.map((s) => Array.from(generateEmbedding(s)));
  const queryNgram = probes.map((p) => Array.from(generateEmbedding(p)));
  const ngramMs = Date.now() - t0;
  const ngramRanks = queryNgram.map((q) => rankByCosine(q, docNgram));

  // 2) 本地向量（Qwen3-Embedding-0.6B，query 侧带任务指令）
  let localRanks: number[][] | null = null;
  let localMs = 0;
  try {
    const t1 = Date.now();
    const docLocal = await embedLocal(statements, "document");
    const queryLocal = await embedLocal(probes, "query");
    localMs = Date.now() - t1;
    localRanks = queryLocal.map((q) => rankByCosine(q, docLocal));
  } catch (err) {
    console.log(`本地服务不可用（${(err as Error).message}）——只报 n-gram 结果。\n`);
  }

  const table: Array<[string, number[], number, string]> = [
    ["n-gram（现有）", ngramRanks, ngramMs, `${docNgram[0]?.length ?? 0} 维`],
  ];
  if (localRanks) {
    table.push(["本地 Qwen3-Embedding", localRanks, localMs, `${(await embedLocal(["x"], "document"))[0].length} 维`]);
  }

  console.log("| 方案 | recall@1 | recall@3 | recall@8 | 耗时 | 说明 |");
  console.log("|---|---|---|---|---|---|");
  for (const [name, ranks, ms, note] of table) {
    console.log(
      `| ${name} | ${(recallAt(ranks, truth, 1) * 100).toFixed(0)}% | ${(recallAt(ranks, truth, 3) * 100).toFixed(0)}% | ${(recallAt(ranks, truth, 8) * 100).toFixed(0)}% | ${ms}ms | ${note} |`,
    );
  }

  if (localRanks) {
    console.log("\n逐题对比（本地未进 top1 的题）：");
    for (let i = 0; i < cases.length; i++) {
      if (localRanks[i][0] !== i) {
        console.log(`- [${cases[i].id}] ${cases[i].probe} → top1 是第 ${localRanks[i][0] + 1} 条（应为 ${i + 1}）`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error("[spike 失败]", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
