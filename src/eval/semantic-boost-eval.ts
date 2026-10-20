/**
 * A 方案实验：用 DeepSeek 做「查询改写 + 候选重排」能否提升 T2 记忆召回。
 *
 * 背景（见 docs/DEEPSEEK_CAPABILITY_AUDIT.md §7）：DeepSeek 没有 embeddings 接口，
 * 拿不到真语义向量。但可以用它已有的 chat 能力做两件文本层的事：
 *   1. 查询改写：把用户的自然问句改写成「记忆库关键词串」（含同义/上位词），
 *      再交给 n-gram + FTS5 检索——绕开"同义表达不相似"的问题；
 *   2. 候选重排：把原问句召回的候选 + 改写问句召回的候选合并，让 Flash 判断相关性并重排。
 *
 * 本脚本**只做评测，不改生产检索行为**；结果用于决定是否值得接线。
 *
 * 用法（需要 .env 的 DEEPSEEK_API_KEY）：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs src/eval/semantic-boost-eval.ts --live
 *
 * 输出：基线 / 仅改写 / 改写+重排 三组的 recall@1/3/8、失败明细、token 成本。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { getChatModel } from "../ai/router.js";
import { retrieveRelevantMemories, type RetrievedMemory } from "../data/retriever.js";
import { loadGoldCases, seedScenario, type GoldCase } from "./memory-eval.js";

const TOP_K = 8;

export interface VariantMetrics {
  name: string;
  recallAt1: number;
  recallAt3: number;
  recallAt8: number;
  /** 相比基线发生名次变化的用例（+ 表示变好） */
  changed: Array<{ id: string; baselineRank: number | null; newRank: number | null }>;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function matchesAny(text: string, expects: string[]): boolean {
  const haystack = normalize(text);
  return expects.some((expect) => haystack.includes(normalize(expect)));
}

function rankOf(memories: RetrievedMemory[], expects: string[]): number | null {
  const index = memories.findIndex((memory) => matchesAny(memory.content, expects));
  return index >= 0 ? index + 1 : null;
}

function recall(ranks: Array<number | null>, at: number): number {
  const hits = ranks.filter((rank) => rank !== null && rank <= at).length;
  return Number((hits / Math.max(1, ranks.length)).toFixed(4));
}

function metricsFor(name: string, cases: GoldCase[], ranked: Array<RetrievedMemory[]>, baseRanks: Array<number | null>): VariantMetrics {
  const ranks = cases.map((item, index) => rankOf(ranked[index], item.expect));
  const changed = cases
    .map((item, index) => ({ id: item.id, baselineRank: baseRanks[index], newRank: ranks[index] }))
    .filter((row) => row.baselineRank !== row.newRank);
  return {
    name,
    recallAt1: recall(ranks, 1),
    recallAt3: recall(ranks, 3),
    recallAt8: recall(ranks, 8),
    changed,
  };
}

// ── DeepSeek 调用 ─────────────────────────────

interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };

async function callFlash(system: string, user: string, maxTokens: number): Promise<string> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
    timeout: 15_000,
    maxRetries: 1,
  });
  const response = await client.chat.completions.create(
    withThinking({
      model: modelConfig.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    }) as never,
  );
  usage.calls++;
  usage.promptTokens += response.usage?.prompt_tokens ?? 0;
  usage.completionTokens += response.usage?.completion_tokens ?? 0;
  return response.choices[0]?.message?.content?.trim() ?? "";
}

/** 把自然问句改写成「记忆库关键词串」。失败时返回空串（该用例退化为基线）。 */
export async function expandQuery(probe: string): Promise<string> {
  const text = await callFlash(
    "你是记忆检索的查询改写器。只输出一行关键词串，不要解释、不要标点以外的格式。",
    [
      "把下面这句话改写成适合在「记忆库」里做关键词检索的中文词串。",
      "要求：",
      "- 提取这句话真正想回忆的对象/事件/属性（人物、项目、地点、宠物、偏好、计划等）；",
      "- 补上可能出现在对方原话里的同义词/上位词（如「猫」→ 猫 橘猫 宠物；「项目」→ 项目 小程序 后端）；",
      "- 最多 12 个词，用空格分隔；不要写问句、不要写解释；",
      "",
      `原句：${probe}`,
      "",
      "只输出关键词串：",
    ].join("\n"),
    80,
  );
  // 容错：去掉引号/换行，压成单行
  return text.replace(/[「」"“”\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 对候选记忆做相关性重排；失败时返回原顺序。 */
export async function rerankCandidates(probe: string, candidates: RetrievedMemory[]): Promise<RetrievedMemory[]> {
  if (candidates.length <= 1) return candidates;
  const lines = candidates.map((memory, index) => {
    const text = memory.content.replace(/\s+/g, " ").slice(0, 90);
    return `[${index + 1}] ${text}`;
  });
  const raw = await callFlash(
    "你是记忆检索的重排器。只输出 JSON 数组，不要解释。",
    [
      `用户此刻说：${probe}`,
      "",
      "下面是按初步召回排出的记忆候选（编号 + 内容）。请判断哪些记忆与用户此刻的话真正相关，",
      "按相关度从高到低输出最多 8 个编号，用 JSON 数组表示，例如 [3,1,5]。",
      "如果都不相关，输出 []。",
      "",
      ...lines,
      "",
      "只输出 JSON 数组：",
    ].join("\n"),
    120,
  );
  const match = raw.match(/\[[\d,\s]*\]/);
  if (!match) return candidates;
  try {
    const order = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(order)) return candidates;
    const seen = new Set<number>();
    const picked: RetrievedMemory[] = [];
    for (const value of order) {
      const index = Number(value) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length || seen.has(index)) continue;
      seen.add(index);
      picked.push(candidates[index]);
      if (picked.length >= TOP_K) break;
    }
    // 重排器只挑相关项；未选中的按原顺序补到后面（保证 recall@8 不因漏选而损失）
    for (let i = 0; i < candidates.length && picked.length < TOP_K; i++) {
      if (!seen.has(i)) picked.push(candidates[i]);
    }
    return picked;
  } catch {
    return candidates;
  }
}

/** 合并两路候选（按 id 去重，保留先出现的顺序）。 */
function mergeCandidates(a: RetrievedMemory[], b: RetrievedMemory[], limit: number): RetrievedMemory[] {
  const seen = new Set<number>();
  const merged: RetrievedMemory[] = [];
  for (const item of [...a, ...b]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

// ── 主实验 ────────────────────────────────────

export interface ExperimentResult {
  cases: number;
  baseline: VariantMetrics;
  baseReranked: VariantMetrics;
  expanded: VariantMetrics;
  reranked: VariantMetrics;
  usage: LlmUsage;
  avgExpandMs: number;
  avgRerankMs: number;
  failures: Array<{
    id: string;
    type: string;
    baselineRank: number | null;
    expandedRank: number | null;
    rerankedRank: number | null;
    expansion: string;
  }>;
}

export async function runExperiment(cases: GoldCase[] = loadGoldCases()): Promise<ExperimentResult> {
  const baselineLists: RetrievedMemory[][] = [];
  const baseRerankedLists: RetrievedMemory[][] = [];
  const expandedLists: RetrievedMemory[][] = [];
  const rerankedLists: RetrievedMemory[][] = [];
  const expansions: string[] = [];
  let expandMsTotal = 0;
  let expandMsCount = 0;
  let rerankMsTotal = 0;
  let rerankMsCount = 0;

  for (const item of cases) {
    // 基线：生产当前的检索（n-gram + FTS5 OR → RRF）
    const base = retrieveRelevantMemories(item.probe, TOP_K);
    baselineLists.push(base);

    // 基线候选直接重排（1 次 LLM 调用，不扩写）：看「只加一次重排」值不值
    const basePool = retrieveRelevantMemories(item.probe, 12);
    const baseRerankStart = Date.now();
    let baseReranked: RetrievedMemory[];
    try {
      baseReranked = await rerankCandidates(item.probe, basePool);
    } catch {
      baseReranked = base;
    }
    rerankMsTotal += Date.now() - baseRerankStart;
    rerankMsCount++;
    baseRerankedLists.push(baseReranked);

    // 仅改写：用关键词串检索
    let expansion = "";
    const expandStart = Date.now();
    try {
      expansion = await expandQuery(item.probe);
    } catch {
      expansion = "";
    }
    expandMsTotal += Date.now() - expandStart;
    expandMsCount++;
    expansions.push(expansion);
    const expanded = expansion ? retrieveRelevantMemories(expansion, TOP_K) : base;
    expandedLists.push(expanded);

    // 改写 + 重排：合并两路 top12 候选 → Flash 重排 top8
    const pool = mergeCandidates(base, retrieveRelevantMemories(`${item.probe} ${expansion}`.trim(), 12), 12);
    let reranked: RetrievedMemory[];
    try {
      reranked = await rerankCandidates(item.probe, pool);
    } catch {
      reranked = expanded;
    }
    rerankedLists.push(reranked);
  }

  const baseRanks = cases.map((item, index) => rankOf(baselineLists[index], item.expect));
  const baseline = metricsFor("baseline", cases, baselineLists, baseRanks);
  const baseReranked = metricsFor("base+rerank", cases, baseRerankedLists, baseRanks);
  const expanded = metricsFor("expanded", cases, expandedLists, baseRanks);
  const reranked = metricsFor("expanded+rerank", cases, rerankedLists, baseRanks);

  const failures = cases
    .map((item, index) => ({
      id: item.id,
      type: item.type,
      baselineRank: baseRanks[index],
      baseRerankedRank: rankOf(baseRerankedLists[index], item.expect),
      expandedRank: rankOf(expandedLists[index], item.expect),
      rerankedRank: rankOf(rerankedLists[index], item.expect),
      expansion: expansions[index],
    }))
    .filter(
      (row) =>
        row.baselineRank !== row.baseRerankedRank ||
        row.baselineRank !== row.expandedRank ||
        row.baselineRank !== row.rerankedRank,
    );

  return {
    cases: cases.length,
    baseline,
    baseReranked,
    expanded,
    reranked,
    usage,
    avgExpandMs: expandMsCount > 0 ? Math.round(expandMsTotal / expandMsCount) : 0,
    avgRerankMs: rerankMsCount > 0 ? Math.round(rerankMsTotal / rerankMsCount) : 0,
    failures,
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log(
      "用法: tsx src/eval/semantic-boost-eval.ts --live（会调用真实 DeepSeek 做查询改写与重排，产生少量费用）",
    );
    return;
  }
  await import("dotenv/config");
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY（.env）");
    process.exit(1);
  }

  const savedEnv = process.env.KAREN_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-semantic-boost-"));
  try {
    const cases = loadGoldCases();
    seedScenario(dir, cases);
    const result = await runExperiment(cases);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    const { closeVectorDb } = await import("../data/vector.js");
    closeVectorDb();
    if (savedEnv === undefined) delete process.env.KAREN_DATA_DIR;
    else process.env.KAREN_DATA_DIR = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const entryName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(ts|js|mjs|cjs)$/, "")
  : "";
if (entryName === "semantic-boost-eval") {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
