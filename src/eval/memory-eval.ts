/**
 * 记忆评测集 + 离线 recall harness + 真实模型验证（M1 记忆金标集）。
 *
 * 目标：用可复现的方式回答两个问题——
 * 1. 用户说过的事实，之后还能不能被「想起来」？（facts 注入 / T2 检索 / 合并）
 * 2. 真实模型拿到这些记忆后，回答里到底有没有用上？（--live）
 *
 * 数据隔离：
 * - 所有写入都发生在 `KAREN_DATA_DIR` 指向的临时目录里，绝不碰真实 data/；
 * - vector.ts 的 db 是模块级单例，因此进/出临时目录都要 closeVectorDb()；
 * - 离线检索强制 EMBEDDING_PROVIDER=ngram，保证不联网、结果可复现。
 *
 * 与生产路径的差异（如实标注）：
 * - T2 检索走同步 `retrieveRelevantMemories`（n-gram + FTS5 RRF），不是 Qwen 语义路径；
 * - live 只用 `chat()` + 紧凑 system prompt + facts/T2 上下文，不跑完整 pipeline/
 *   人设六层组装；
 * - live 采样 ≤20 条、complexity=simple（max_tokens 160），控制真实 token 成本。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chat } from "../ai/chat.js";
import { getChatModel } from "../ai/router.js";
import { OWNER_CLI } from "../data/owner.js";
import {
  buildRagContext,
  retrieveRelevantMemories,
  storeConversationEpisode,
  type RetrievedMemory,
} from "../data/retriever.js";
import {
  getUserFactsContext,
  upsertUserFacts,
  type ExtractedFact,
  type FactCategory,
} from "../data/user-facts.js";
import {
  closeVectorDb,
  getVectorDb,
  searchEpisodesByFts,
  setCurrentPersona,
} from "../data/vector.js";

// ── 常量 ──────────────────────────────────────

/** 评测专用人设 ID（T2 按 persona 隔离，不与人设真实数据混用）。 */
export const EVAL_PERSONA = "memory-eval";
/** anti-forget 回归场景单独一个人设，避免污染 gold 的 T2 语料。 */
export const ANTI_FORGET_PERSONA = "memory-eval-anti-forget";
/** 评测统一 owner（与生产 CLI 用户一致；写入/读取必须一致）。 */
export const EVAL_OWNER = OWNER_CLI;
/** live 默认调用条数（成本控制）。金标扩到 40 条后，可用 --limit=40 全跑（约 ¥0.02）。 */
export const MAX_LIVE_SAMPLES = 40;
/** T2 最大召回深度（recall@8 的上限）。 */
export const RECALL_DEPTH = 8;

const GOLD_CATEGORIES = ["姓名", "城市", "工作", "宠物", "项目", "偏好", "计划"] as const;
type GoldCategory = (typeof GOLD_CATEGORIES)[number];

const VALID_FACT_CATEGORIES: FactCategory[] = [
  "profile",
  "work",
  "pet",
  "preference",
  "plan",
  "relationship",
  "other",
];

/** 评测正文里禁止出现的「考我/查岗」类表达（live 违规统计）。 */
const VIOLATION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "考我", re: /考我/ },
  { label: "考考你", re: /考考你/ },
  { label: "查岗", re: /查岗/ },
  { label: "抽查", re: /抽查/ },
  { label: "我记性没那么差", re: /记性没那么差/ },
];

/** 模拟聊天时她当时的回复（记忆积累的真实形态：摘要行 = 用户话 + 她的回复）。 */
const SIMULATED_REPLIES = [
  "嗯，我记住了。",
  "好，记下了。",
  "原来是这样。",
  "行，我记着。",
];

const FACTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS user_facts (
    owner_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    fact_value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, fact_key)
  );
`;

// ── 类型 ──────────────────────────────────────

export interface GoldFact {
  key: string;
  value: string;
  category: FactCategory;
}

export interface GoldCase {
  id: string;
  category: GoldCategory;
  /** direct = 直接问事实；indirect = 间接回忆（问句里不直接点破要回忆的值） */
  type: "direct" | "indirect";
  /** 用户当时说的话（种进 T2 的记忆） */
  statement: string;
  /** 之后问的句子（检索 query / live 输入） */
  probe: string;
  /** 期望在回答或注入上下文中出现的子串（任一命中即算 hit） */
  expect: string[];
  fact: GoldFact;
}

export interface GroupStats {
  total: number;
  factsHits: number;
  factsHitRate: number;
  recallHits: { at1: number; at3: number; at8: number };
  recallAt1: number;
  recallAt3: number;
  recallAt8: number;
  mergedHits: number;
  mergedHitRate: number;
}

export interface OfflineMetrics extends GroupStats {
  categories: Record<string, GroupStats>;
  direct: GroupStats;
  indirect: GroupStats;
  /** 诊断：FTS5 关键词路至少召回 1 条候选的 probe 数（混合检索是否真的两路都在工作）。 */
  ftsProbeHits: number;
  ftsProbeHitRate: number;
}

export interface CaseEval {
  case: GoldCase;
  factsHit: boolean;
  t2Rank: number | null;
  mergedHit: boolean;
  top: RetrievedMemory[];
  factsContext: string;
  ragContext: string;
  /** 诊断：该 probe 的 FTS5 候选数。 */
  ftsCandidates: number;
}

export interface TopMemory {
  rank: number;
  content: string;
  relevance: number;
  confidence: string;
}

export interface CaseFailure {
  id: string;
  category: string;
  type: string;
  probe: string;
  expect: string[];
  factsHit: boolean;
  t2Rank: number | null;
  mergedHit: boolean;
  top: TopMemory[];
}

export interface AntiForgetResult {
  owner: string;
  persona: string;
  probe: string;
  expected: string;
  /** facts 层是否仍注入正确事实（anti-forget 的核心修复） */
  factsHit: boolean;
  /** 只看 T2 检索是否还能召回正确记忆（可能被「不知道」挤掉，如实记录） */
  t2Hit: boolean;
  t2CorrectRank: number | null;
  /** 「我不知道/没说过」那条自我强化记忆的排名（1-based） */
  denialRank: number | null;
  /** facts + T2 合并后是否仍含正确事实（回归断言的通过条件） */
  mergedHit: boolean;
  passed: boolean;
  top: TopMemory[];
}

export interface SeedResult {
  dataDir: string;
  facts: number;
  episodes: number;
}

export interface OfflineEvalResult {
  cases: number;
  metrics: OfflineMetrics;
  failures: CaseFailure[];
  antiForget: AntiForgetResult | null;
  seeded: SeedResult;
  dataDir: string;
  cleanedUp: boolean;
}

export interface EvaluateOfflineOptions {
  /** 指定临时数据目录；不传则自动 mkdtemp。结束后默认删除。 */
  dataDir?: string;
  /** 覆盖 gold（测试/实验用） */
  cases?: GoldCase[];
  /** 保留临时目录（调试用；报告里不要提交真实用户数据） */
  keepData?: boolean;
  /** 是否跑 anti-forget 回归（默认 true） */
  includeAntiForget?: boolean;
}

export interface LiveCaseResult {
  id: string;
  category: string;
  type: string;
  probe: string;
  expect: string[];
  reply: string;
  hit: boolean;
  violations: string[];
  error?: string;
}

export interface LiveUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costCny: number;
}

export interface LiveEvalResult {
  model: string;
  providerBaseUrl: string;
  startedAt: string;
  durationMs: number;
  sampleSize: number;
  totalGold: number;
  offline: OfflineMetrics;
  metrics: {
    hits: number;
    hitRate: number;
    errorCount: number;
    violationCases: number;
    violationRate: number;
    patternCounts: Record<string, number>;
  };
  usage: LiveUsageSummary | null;
  cases: LiveCaseResult[];
  dataDir: string;
}

export interface EvaluateLiveOptions {
  dataDir?: string;
  cases?: GoldCase[];
  limit?: number;
  keepData?: boolean;
}

// ── gold 加载与校验 ────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 校验 gold 结构与覆盖度（≥20 条、7 类、direct/indirect 都有、id 唯一）。 */
export function validateGoldCases(cases: GoldCase[]): void {
  if (!Array.isArray(cases) || cases.length < 20) {
    throw new Error(`memory-gold 至少需要 20 条 case，当前 ${Array.isArray(cases) ? cases.length : 0} 条`);
  }
  const ids = new Set<string>();
  const types = new Set<string>();
  const categories = new Set<string>();
  const factByKey = new Map<string, GoldFact>();

  for (const [index, item] of cases.entries()) {
    const where = `memory-gold[${index}]`;
    if (!isNonEmptyString(item.id)) throw new Error(`${where}.id 不能为空`);
    if (ids.has(item.id)) throw new Error(`${where}.id 重复: ${item.id}`);
    ids.add(item.id);
    if (!GOLD_CATEGORIES.includes(item.category)) {
      throw new Error(`${where}.category 非法: ${String(item.category)}`);
    }
    categories.add(item.category);
    if (item.type !== "direct" && item.type !== "indirect") {
      throw new Error(`${where}.type 必须是 direct/indirect`);
    }
    types.add(item.type);
    if (!isNonEmptyString(item.statement)) throw new Error(`${where}.statement 不能为空`);
    if (!isNonEmptyString(item.probe)) throw new Error(`${where}.probe 不能为空`);
    if (!Array.isArray(item.expect) || item.expect.length === 0 || !item.expect.every(isNonEmptyString)) {
      throw new Error(`${where}.expect 必须是非空字符串数组`);
    }
    if (!item.fact || !isNonEmptyString(item.fact.key) || !isNonEmptyString(item.fact.value)) {
      throw new Error(`${where}.fact 缺少 key/value`);
    }
    if (!VALID_FACT_CATEGORIES.includes(item.fact.category)) {
      throw new Error(`${where}.fact.category 非法: ${String(item.fact.category)}`);
    }
    const prev = factByKey.get(item.fact.key);
    if (prev && (prev.value !== item.fact.value || prev.category !== item.fact.category)) {
      throw new Error(
        `${where}.fact 与同 key 的其他 case 不一致: ${item.fact.key} ` +
          `(${prev.value}/${prev.category} vs ${item.fact.value}/${item.fact.category})`
      );
    }
    factByKey.set(item.fact.key, item.fact);
  }

  const missing = GOLD_CATEGORIES.filter((c) => !categories.has(c));
  if (missing.length > 0) throw new Error(`memory-gold 缺少类别: ${missing.join(", ")}`);
  if (!types.has("direct") || !types.has("indirect")) {
    throw new Error("memory-gold 必须同时包含 direct 与 indirect case");
  }
}

/** 读取 gold JSON（优先显式路径，其次模块同目录，最后 cwd/src/eval）。 */
export function loadGoldCases(filePath?: string): GoldCase[] {
  // CommonJS 构建（tsc → dist/eval）下 __dirname 可用；tsx 直跑时指向 src/eval。
  const candidates = [
    filePath,
    path.join(__dirname, "memory-gold.json"),
    path.resolve(process.cwd(), "src/eval/memory-gold.json"),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  let lastError: unknown;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (!Array.isArray(parsed)) throw new Error("顶层必须是数组");
      const cases = parsed as GoldCase[];
      validateGoldCases(cases);
      return cases;
    } catch (err) {
      lastError = err;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "文件不存在");
  throw new Error(`无法加载 memory-gold.json: ${reason}`);
}

// ── 临时数据目录 / env ────────────────────────

interface EnvSnapshot {
  KAREN_DATA_DIR?: string;
  EMBEDDING_PROVIDER?: string;
}

function snapshotEnv(): EnvSnapshot {
  return {
    KAREN_DATA_DIR: process.env.KAREN_DATA_DIR,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  if (snapshot.KAREN_DATA_DIR === undefined) delete process.env.KAREN_DATA_DIR;
  else process.env.KAREN_DATA_DIR = snapshot.KAREN_DATA_DIR;
  if (snapshot.EMBEDDING_PROVIDER === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = snapshot.EMBEDDING_PROVIDER;
}

function createTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "karen-memory-eval-"));
}

function enterDataDir(dir: string): void {
  // 先关旧库，避免单例继续指向真实 data/。
  closeVectorDb();
  fs.mkdirSync(dir, { recursive: true });
  process.env.KAREN_DATA_DIR = dir;
}

/**
 * 防呆：评测会删掉自己用的数据目录，绝不允许把仓库真实 data/（或其子目录）
 * 或仓库根目录当评测目录。
 */
function assertSafeEvalDataDir(dir: string): void {
  const resolved = path.resolve(dir);
  const realData = path.resolve("data");
  const repoRoot = path.resolve(".");
  if (resolved === realData || resolved.startsWith(`${realData}${path.sep}`)) {
    throw new Error(`拒绝使用真实数据目录做评测: ${resolved}；请用 mkdtemp 临时目录`);
  }
  if (resolved === repoRoot || resolved === path.parse(resolved).root) {
    throw new Error(`拒绝使用仓库根/文件系统根做评测目录: ${resolved}`);
  }
}

/**
 * 确保 user_facts 表存在。
 *
 * user-facts.ts 的 tableReady 是模块级缓存；同一进程第二次换库时它不会重新建表。
 * 评测会在同进程重复跑（可复现性测试），所以这里按同一 DDL 幂等补建。
 */
function ensureFactsTable(): void {
  getVectorDb().exec(FACTS_TABLE_DDL);
}

// ── 种数据 ────────────────────────────────────

function uniqueFacts(cases: GoldCase[]): ExtractedFact[] {
  const byKey = new Map<string, ExtractedFact>();
  for (const item of cases) {
    if (!byKey.has(item.fact.key)) {
      byKey.set(item.fact.key, {
        key: item.fact.key,
        value: item.fact.value,
        category: item.fact.category,
      });
    }
  }
  return [...byKey.values()];
}

function uniqueStatements(cases: GoldCase[]): string[] {
  return [...new Set(cases.map((c) => c.statement))];
}

/**
 * 写入一个评测场景：user_facts + T2 episodes（真实 API，模拟聊天后的记忆积累）。
 *
 * 副作用：把 KAREN_DATA_DIR 指向 tmpDir、强制 ngram 离线 embedding、
 * 关闭并重开 vector db 单例。仅用于评测进程/独立测试文件。
 */
export function seedScenario(tmpDir: string, cases: GoldCase[] = loadGoldCases()): SeedResult {
  validateGoldCases(cases);
  assertSafeEvalDataDir(tmpDir);
  process.env.EMBEDDING_PROVIDER = "ngram"; // 离线可复现，绝不联网
  enterDataDir(tmpDir);
  ensureFactsTable();

  const facts = uniqueFacts(cases);
  const written = upsertUserFacts(EVAL_OWNER, facts);

  setCurrentPersona(EVAL_PERSONA);
  const statements = uniqueStatements(cases);
  for (const [index, statement] of statements.entries()) {
    storeConversationEpisode(statement, SIMULATED_REPLIES[index % SIMULATED_REPLIES.length]);
  }

  return { dataDir: tmpDir, facts: written, episodes: statements.length };
}

/** anti-forget 回归场景：正确事实 + 一条「我不知道/没记过」的自我强化记忆。 */
function seedAntiForgetScenario(): SeedResult {
  process.env.EMBEDDING_PROVIDER = "ngram";
  ensureFactsTable();

  const fact: ExtractedFact = { key: "girlfriend", value: "小满", category: "relationship" };
  upsertUserFacts(EVAL_OWNER, [fact]);

  setCurrentPersona(ANTI_FORGET_PERSONA);
  storeConversationEpisode("我女朋友叫小满，我们在一起三年了。", "小满，记住了。");
  // 模拟她曾经答「不知道」——这条会与 probe 高度相似，是自我强化的来源。
  storeConversationEpisode("我女朋友叫什么来着？", "这个你没跟我说过呀，我不知道。");

  return { dataDir: process.env.KAREN_DATA_DIR ?? "", facts: 1, episodes: 2 };
}

// ── 离线评测 ──────────────────────────────────

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

function topMemories(memories: RetrievedMemory[], limit = 3): TopMemory[] {
  return memories.slice(0, limit).map((memory, index) => ({
    rank: index + 1,
    content: memory.content,
    relevance: round4(memory.relevance),
    confidence: memory.confidence,
  }));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 对每条 gold 计算 facts 命中 / T2 排名 / 合并命中（需已 seed 且 db 可用）。 */
function evaluateCases(cases: GoldCase[], depth: number = RECALL_DEPTH): CaseEval[] {
  // 评测要看事实层的「全覆盖」，因此显式放开注入上限（生产路径仍按 MAX_FACTS_IN_PROMPT 截断）
  const factsContext = getUserFactsContext(EVAL_OWNER, 100);

  return cases.map((item) => {
    const memories = retrieveRelevantMemories(item.probe, depth);
    const ragContext = buildRagContext(memories);
    const mergedContext = `${factsContext}\n${ragContext}`;
    return {
      case: item,
      factsHit: matchesAny(factsContext, item.expect),
      t2Rank: rankOf(memories, item.expect),
      mergedHit: matchesAny(mergedContext, item.expect),
      top: memories,
      factsContext,
      ragContext,
      ftsCandidates: searchEpisodesByFts(item.probe, depth).length,
    };
  });
}

function groupStats(entries: CaseEval[]): GroupStats {
  const total = entries.length;
  const factsHits = entries.filter((entry) => entry.factsHit).length;
  const at1 = entries.filter((entry) => entry.t2Rank !== null && entry.t2Rank <= 1).length;
  const at3 = entries.filter((entry) => entry.t2Rank !== null && entry.t2Rank <= 3).length;
  const at8 = entries.filter((entry) => entry.t2Rank !== null && entry.t2Rank <= 8).length;
  const mergedHits = entries.filter((entry) => entry.mergedHit).length;
  return {
    total,
    factsHits,
    factsHitRate: total > 0 ? round4(factsHits / total) : 0,
    recallHits: { at1, at3, at8 },
    recallAt1: total > 0 ? round4(at1 / total) : 0,
    recallAt3: total > 0 ? round4(at3 / total) : 0,
    recallAt8: total > 0 ? round4(at8 / total) : 0,
    mergedHits,
    mergedHitRate: total > 0 ? round4(mergedHits / total) : 0,
  };
}

function aggregateMetrics(entries: CaseEval[]): OfflineMetrics {
  const base = groupStats(entries);
  const categories: Record<string, GroupStats> = {};
  for (const category of GOLD_CATEGORIES) {
    const subset = entries.filter((entry) => entry.case.category === category);
    if (subset.length > 0) categories[category] = groupStats(subset);
  }
  const ftsProbeHits = entries.filter((entry) => entry.ftsCandidates > 0).length;
  return {
    ...base,
    categories,
    direct: groupStats(entries.filter((entry) => entry.case.type === "direct")),
    indirect: groupStats(entries.filter((entry) => entry.case.type === "indirect")),
    ftsProbeHits,
    ftsProbeHitRate: entries.length > 0 ? round4(ftsProbeHits / entries.length) : 0,
  };
}

function buildFailures(entries: CaseEval[]): CaseFailure[] {
  return entries
    .filter((entry) => !entry.mergedHit || !entry.factsHit || entry.t2Rank === null)
    .map((entry) => ({
      id: entry.case.id,
      category: entry.case.category,
      type: entry.case.type,
      probe: entry.case.probe,
      expect: entry.case.expect,
      factsHit: entry.factsHit,
      t2Rank: entry.t2Rank,
      mergedHit: entry.mergedHit,
      top: topMemories(entry.top),
    }));
}

/** anti-forget：先有正确记忆，再有「不知道」记忆，最后问同一事实。 */
function runAntiForgetScenario(): AntiForgetResult {
  const probe = "我女朋友叫什么来着，你还记得吗？";
  const expected = "小满";
  seedAntiForgetScenario();

  // 评测要看事实层的「全覆盖」，因此显式放开注入上限（生产路径仍按 MAX_FACTS_IN_PROMPT 截断）
  const factsContext = getUserFactsContext(EVAL_OWNER, 100);
  const memories = retrieveRelevantMemories(probe, 8);
  const ragContext = buildRagContext(memories);
  const factsHit = matchesAny(factsContext, [expected]);
  const t2CorrectRank = rankOf(memories, [expected]);
  const denialIndex = memories.findIndex((memory) =>
    /不知道|没记过|没说过|没跟我说过/.test(memory.content)
  );
  const mergedHit = matchesAny(`${factsContext}\n${ragContext}`, [expected]);

  return {
    owner: EVAL_OWNER,
    persona: ANTI_FORGET_PERSONA,
    probe,
    expected,
    factsHit,
    t2Hit: t2CorrectRank !== null,
    t2CorrectRank,
    denialRank: denialIndex >= 0 ? denialIndex + 1 : null,
    mergedHit,
    // 回归断言：即使「不知道」记忆排到前面，facts 层也必须保住正确事实。
    passed: factsHit && mergedHit,
    top: topMemories(memories, 5),
  };
}

/**
 * 离线评测：临时目录 seed → 逐条算 facts / T2 recall@{1,3,8} / 合并命中 → anti-forget。
 * 不联网（强制 ngram），跑完恢复 env 并删除临时目录。
 */
export function evaluateOffline(options: EvaluateOfflineOptions = {}): OfflineEvalResult {
  const cases = options.cases ?? loadGoldCases();
  validateGoldCases(cases);

  const dataDir = options.dataDir ?? createTempDataDir();
  assertSafeEvalDataDir(dataDir); // 必须在 try/finally 之前：防止误删真实 data/
  const envSnapshot = snapshotEnv();
  const includeAntiForget = options.includeAntiForget !== false;
  let result: Omit<OfflineEvalResult, "cleanedUp">;
  let cleanedUp = false;

  try {
    const seeded = seedScenario(dataDir, cases);
    const entries = evaluateCases(cases);
    const antiForget = includeAntiForget ? runAntiForgetScenario() : null;
    result = {
      cases: cases.length,
      metrics: aggregateMetrics(entries),
      failures: buildFailures(entries),
      antiForget,
      seeded,
      dataDir,
    };
  } finally {
    closeVectorDb();
    restoreEnv(envSnapshot);
    if (!options.keepData) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      cleanedUp = true;
    }
  }

  return { ...result, cleanedUp };
}

// ── live 评测 ─────────────────────────────────

function normalizeReply(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function detectViolations(reply: string): string[] {
  const hits: string[] = [];
  for (const pattern of VIOLATION_PATTERNS) {
    if (pattern.re.test(reply) && !hits.includes(pattern.label)) hits.push(pattern.label);
  }
  return hits;
}

function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return truncateText(message || "未知错误", 200);
}

/** 轮转选样：每个类别依次取一条，保证 7 类都覆盖，再按原顺序输出。 */
export function selectLiveSample(cases: GoldCase[], limit: number): GoldCase[] {
  const buckets = new Map<string, GoldCase[]>();
  for (const item of cases) {
    const bucket = buckets.get(item.category) ?? [];
    bucket.push(item);
    buckets.set(item.category, bucket);
  }
  const categories = [...buckets.keys()];
  const picked: GoldCase[] = [];
  for (let round = 0; picked.length < limit; round++) {
    let added = false;
    for (const category of categories) {
      const bucket = buckets.get(category) ?? [];
      if (round < bucket.length && picked.length < limit) {
        picked.push(bucket[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked.sort((a, b) => cases.indexOf(a) - cases.indexOf(b));
}

/** live 用紧凑 system prompt：只保留「记得、别反问、别考我」相关行为。 */
export function buildLiveSystemPrompt(factsContext: string, ragContext: string): string {
  const memory = [factsContext.trim(), ragContext.trim()].filter(Boolean).join("\n");
  return [
    "你是 Karen，一个住在 QQ 里的 AI 虚拟人，和对方是熟人，正在闲聊。",
    "说话像真人发消息：口语化、短句、1~2 句，不超过 40 字。",
    "你确实记得对方告诉过你的事；记得就自然接住，别反问对方，也别测试对方。",
    "禁止说「考我」「考考你」「查岗」「抽查」「我记性没那么差」这类话。",
    "不要编造对方没说过的事；不确定就含糊带过。",
    "不要用括号描写动作，不要自称 AI 或助手。",
    memory ? `\n${memory}\n（以上是你记得的事，别直接罗列成清单，也别反问对方记不记得。）` : "",
  ].join("\n");
}

function readUsageSummary(): LiveUsageSummary | null {
  try {
    const row = getVectorDb()
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(cost_cny), 0) AS cost_cny
         FROM llm_usage`
      )
      .get() as { calls: number; prompt_tokens: number; completion_tokens: number; cost_cny: number };
    return {
      calls: Number(row.calls),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      costCny: round4(Number(row.cost_cny)),
    };
  } catch {
    return null;
  }
}

/**
 * Live 评测：真实调用 DeepSeek 生成回答，统计 expect 命中率与「考我/查岗」违规表达。
 * 全部数据（含 llm_usage 成本）写入临时目录，跑完删除；真实 data/ 不受影响。
 */
export async function evaluateLive(options: EvaluateLiveOptions = {}): Promise<LiveEvalResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === "sk-your-key-here") {
    throw new Error("未配置 DEEPSEEK_API_KEY（live 模式需要真实 Key，请通过 .env 提供）");
  }

  const cases = options.cases ?? loadGoldCases();
  validateGoldCases(cases);
  const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_LIVE_SAMPLES, cases.length));
  const sample = selectLiveSample(cases, limit);

  const dataDir = options.dataDir ?? createTempDataDir();
  assertSafeEvalDataDir(dataDir); // 必须在 try/finally 之前：防止误删真实 data/
  const envSnapshot = snapshotEnv();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  try {
    seedScenario(dataDir, cases);
    const offlineEntries = evaluateCases(cases);
    const modelConfig = getChatModel("simple");
    const results: LiveCaseResult[] = [];

    for (const item of sample) {
      const entry = offlineEntries.find((candidate) => candidate.case.id === item.id);
      if (!entry) throw new Error(`内部错误：找不到 case ${item.id} 的离线结果`);
      const systemPrompt = buildLiveSystemPrompt(entry.factsContext, entry.ragContext);

      let reply = "";
      let error: string | undefined;
      try {
        reply = await chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: item.probe },
          ],
          undefined,
          { complexity: "simple" } // max_tokens=160，成本可控
        );
        reply = reply.trim();
      } catch (err) {
        error = describeError(err);
      }

      const normalizedReply = normalizeReply(reply);
      const hit =
        !error && item.expect.some((expect) => normalizedReply.includes(normalizeReply(expect)));
      results.push({
        id: item.id,
        category: item.category,
        type: item.type,
        probe: item.probe,
        expect: item.expect,
        reply: truncateText(reply.replace(/\s+/g, " "), 200),
        hit,
        violations: detectViolations(reply),
        ...(error ? { error } : {}),
      });
    }

    const hits = results.filter((item) => item.hit).length;
    const errorCount = results.filter((item) => item.error).length;
    const violationCases = results.filter((item) => item.violations.length > 0).length;
    const patternCounts: Record<string, number> = {};
    for (const pattern of VIOLATION_PATTERNS) patternCounts[pattern.label] = 0;
    for (const item of results) {
      for (const label of item.violations) patternCounts[label] = (patternCounts[label] ?? 0) + 1;
    }

    const usage = readUsageSummary();
    const total = results.length;

    return {
      model: modelConfig.model,
      providerBaseUrl: modelConfig.baseUrl,
      startedAt,
      durationMs: Date.now() - startMs,
      sampleSize: total,
      totalGold: cases.length,
      offline: aggregateMetrics(offlineEntries),
      metrics: {
        hits,
        hitRate: total > 0 ? round4(hits / total) : 0,
        errorCount,
        violationCases,
        violationRate: total > 0 ? round4(violationCases / total) : 0,
        patternCounts,
      },
      usage,
      cases: results,
      dataDir,
    };
  } finally {
    closeVectorDb();
    restoreEnv(envSnapshot);
    if (!options.keepData) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

// ── Markdown 输出 ─────────────────────────────

function pct(hits: number, total: number): string {
  if (total <= 0) return "0.0% (0/0)";
  return `${((hits / total) * 100).toFixed(1)}% (${hits}/${total})`;
}

function qualityCell(stats: GroupStats): string {
  return [
    pct(stats.factsHits, stats.total),
    pct(stats.recallHits.at1, stats.total),
    pct(stats.recallHits.at3, stats.total),
    pct(stats.recallHits.at8, stats.total),
    pct(stats.mergedHits, stats.total),
  ].join(" | ");
}

function escapeCell(text: string, maxChars = 80): string {
  return truncateText(text.replace(/\s+/g, " "), maxChars).replace(/\|/g, "\\|");
}

/** 离线结果 → Markdown 表格 + 失败明细 + anti-forget 明细。 */
export function formatOfflineMarkdown(result: OfflineEvalResult): string {
  const { metrics } = result;
  const lines: string[] = [];
  lines.push(`### 离线记忆评测（gold ${result.cases} 条）`);
  lines.push("");
  lines.push("| 指标 | 结果 |");
  lines.push("| --- | --- |");
  lines.push(`| facts 注入命中率 | ${pct(metrics.factsHits, metrics.total)} |`);
  lines.push(`| T2 recall@1 | ${pct(metrics.recallHits.at1, metrics.total)} |`);
  lines.push(`| T2 recall@3 | ${pct(metrics.recallHits.at3, metrics.total)} |`);
  lines.push(`| T2 recall@8 | ${pct(metrics.recallHits.at8, metrics.total)} |`);
  lines.push(`| facts + T2 合并命中率 | ${pct(metrics.mergedHits, metrics.total)} |`);
  lines.push(`| FTS5 路有候选的 probe（诊断） | ${pct(metrics.ftsProbeHits, metrics.total)} |`);
  lines.push(`| 直接问事实（${metrics.direct.total} 条） | ${qualityCell(metrics.direct)} |`);
  lines.push(`| 间接回忆（${metrics.indirect.total} 条） | ${qualityCell(metrics.indirect)} |`);
  lines.push("");
  lines.push("> 分类列顺序：facts / recall@1 / recall@3 / recall@8 / 合并。");
  lines.push("");
  lines.push("#### 分类指标");
  lines.push("");
  lines.push("| 类别 | n | facts | recall@1 | recall@3 | recall@8 | 合并 |");
  lines.push("| --- | ---: | --- | --- | --- | --- | --- |");
  for (const [category, stats] of Object.entries(metrics.categories)) {
    lines.push(
      `| ${category} | ${stats.total} | ${pct(stats.factsHits, stats.total)} | ` +
        `${pct(stats.recallHits.at1, stats.total)} | ${pct(stats.recallHits.at3, stats.total)} | ` +
        `${pct(stats.recallHits.at8, stats.total)} | ${pct(stats.mergedHits, stats.total)} |`
    );
  }
  lines.push("");

  lines.push("#### anti-forget 回归");
  lines.push("");
  if (!result.antiForget) {
    lines.push("未启用。");
  } else {
    const anti = result.antiForget;
    lines.push("| 项 | 结果 |");
    lines.push("| --- | --- |");
    lines.push(`| 正确事实仍在 facts 注入中 | ${anti.factsHit ? "PASS" : "FAIL"} |`);
    lines.push(`| T2 仍召回正确记忆 | ${anti.t2Hit ? `PASS（rank ${anti.t2CorrectRank}）` : "FAIL（未召回）"} |`);
    lines.push(`| 「不知道」记忆排名 | ${anti.denialRank ?? "未召回"} |`);
    lines.push(`| 合并上下文仍含正确事实 | ${anti.mergedHit ? "PASS" : "FAIL"} |`);
    lines.push(`| 回归结论 | ${anti.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");

  lines.push("#### 失败明细");
  lines.push("");
  if (result.failures.length === 0) {
    lines.push("无（所有 case 的 facts、T2@8、合并均命中）。");
  } else {
    lines.push("> 失败 = facts 未命中 / T2@8 未召回 / 合并未命中的并集。");
    lines.push("");
    lines.push("| id | 类别 | 类型 | expect | facts | T2 rank | 合并 | top1（截断） |");
    lines.push("| --- | --- | --- | --- | --- | ---: | --- | --- |");
    for (const failure of result.failures) {
      const top1 = failure.top[0] ? escapeCell(failure.top[0].content, 60) : "-";
      lines.push(
        `| ${failure.id} | ${failure.category} | ${failure.type} | ${failure.expect.join(" / ")} | ` +
          `${failure.factsHit ? "✓" : "✗"} | ${failure.t2Rank ?? "-"} | ` +
          `${failure.mergedHit ? "✓" : "✗"} | ${top1} |`
      );
    }
  }
  return lines.join("\n");
}

/** live 结果 → Markdown 表格（指标 + 违规统计 + 逐条回答）。 */
export function formatLiveMarkdown(result: LiveEvalResult): string {
  const lines: string[] = [];
  lines.push("### Live 真实模型验证");
  lines.push("");
  lines.push(`- 模型：\`${result.model}\`（baseURL: \`${result.providerBaseUrl}\`）`);
  lines.push(`- 样本：${result.sampleSize} / ${result.totalGold} 条（上限 ${MAX_LIVE_SAMPLES}）`);
  lines.push(`- 时间：${result.startedAt}，耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.usage) {
    lines.push(
      `- token / 成本：prompt ${result.usage.promptTokens} + completion ${result.usage.completionTokens}，` +
        `≈ ¥${result.usage.costCny.toFixed(6)}（${result.usage.calls} 次调用，按项目成本表估算）`
    );
  }
  lines.push(
    `- 同一批种子的离线检索（全量 ${result.totalGold} 条）：facts ${pct(result.offline.factsHits, result.offline.total)} / ` +
      `recall@1 ${pct(result.offline.recallHits.at1, result.offline.total)} / ` +
      `recall@3 ${pct(result.offline.recallHits.at3, result.offline.total)} / ` +
      `recall@8 ${pct(result.offline.recallHits.at8, result.offline.total)} / ` +
      `合并 ${pct(result.offline.mergedHits, result.offline.total)} / ` +
      `FTS候选 ${pct(result.offline.ftsProbeHits, result.offline.total)}`
  );
  lines.push("");
  lines.push("| 指标 | 结果 |");
  lines.push("| --- | --- |");
  lines.push(`| expect 命中率 | ${pct(result.metrics.hits, result.sampleSize)} |`);
  lines.push(`| 调用失败 | ${pct(result.metrics.errorCount, result.sampleSize)} |`);
  lines.push(
    `| 出现违规表达的 case | ${pct(result.metrics.violationCases, result.sampleSize)} |`
  );
  lines.push("");
  lines.push("#### 违规表达计数");
  lines.push("");
  lines.push("| 模式 | 命中次数 |");
  lines.push("| --- | ---: |");
  for (const [label, count] of Object.entries(result.metrics.patternCounts)) {
    lines.push(`| ${label} | ${count} |`);
  }
  lines.push("");
  lines.push("#### 逐条结果");
  lines.push("");
  lines.push("| id | 类别 | 类型 | expect | 命中 | 违规 | 回答（截断） |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const item of result.cases) {
    const reply = item.error ? `[ERROR] ${item.error}` : item.reply || "（空回复）";
    lines.push(
      `| ${item.id} | ${item.category} | ${item.type} | ${item.expect.join(" / ")} | ` +
        `${item.hit ? "✓" : "✗"} | ${item.violations.join("、") || "-"} | ${escapeCell(reply)} |`
    );
  }
  return lines.join("\n");
}

/** CLI 一行汇总（便于粘贴到汇报）。 */
export function formatOfflineSummary(result: OfflineEvalResult): string {
  const m = result.metrics;
  const anti = result.antiForget ? (result.antiForget.passed ? "PASS" : "FAIL") : "skipped";
  return (
    `汇总｜gold=${result.cases} facts=${pct(m.factsHits, m.total)} ` +
    `recall@1=${pct(m.recallHits.at1, m.total)} recall@3=${pct(m.recallHits.at3, m.total)} ` +
    `recall@8=${pct(m.recallHits.at8, m.total)} merged=${pct(m.mergedHits, m.total)} ` +
    `anti-forget=${anti}`
  );
}

export function formatLiveSummary(result: LiveEvalResult): string {
  return (
    `汇总｜live model=${result.model} samples=${result.sampleSize} ` +
    `expect=${pct(result.metrics.hits, result.sampleSize)} ` +
    `violation-cases=${result.metrics.violationCases} errors=${result.metrics.errorCount}`
  );
}
