#!/usr/bin/env node
/**
 * 离线行为评测（v0.9.8）：固定消息序列 × 多种子 × 变体对照。
 *
 * 为什么需要：v0.9.5 / v0.9.7 的 mock 长跑 A/B 都只有「单次 6 轮」，
 * 评审 ±1 波动、自述率 2/6 vs 3/6 完全在噪声内——无法判断改动有没有效。
 *
 * 本脚本用**生产 system prompt**（persona/prompt-builder.buildPrompt）+ 固定用户消息序列，
 * 多次重复跑，输出「均值（最小–最大）」而不是单次结论。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/behavior-eval.ts --seeds 3
 *   node node_modules/tsx/dist/cli.mjs scripts/behavior-eval.ts --seeds 3 --variant baseline
 *
 * 成本：默认 2 变体 × 3 种子 × 12 条 ≈ 72 次调用 ≈ ¥0.05。
 */
import OpenAI from "openai";
import "dotenv/config";
import { loadConfig } from "../src/data/store.js";
import { loadPersona } from "../src/persona/loader.js";
import { buildPrompt } from "../src/persona/prompt-builder.js";
import { formatUserFacts, type UserFact } from "../src/data/user-facts.js";
import { buildAnchorInjection, buildDailyInjection, type AnchorRow, type DailyDigestRow } from "../src/data/memory-v2.js";
import {
  buildMentionPacingNote,
  detectSelfMention,
  recordMention,
  type MentionHistory,
} from "../src/persona/mention-pacing.js";
import {
  buildQuestionHookNote,
  shouldAddQuestionHook,
} from "../src/persona/question-hook.js";
import { computeCostCny } from "../src/obs/cost-tracker.js";
import {
  aggregateBehaviorMetrics,
  computeBehaviorMetrics,
  formatRangeNumber,
  formatRangePercent,
  type BehaviorRunMetrics,
} from "../src/eval/behavior-metrics.js";

/** 固定用户消息序列（覆盖：闲聊/关心/事实/重复提问/情绪/邀约 + 记忆召回探针） */
interface EvalMessage {
  text: string;
  /** 记忆召回期望命中的实体（任一字符串出现即算召回） */
  expect?: string[];
  /** 该探针考的是哪一层记忆（用于分层归因） */
  layer?: "facts" | "anchors" | "digest";
}

const USER_MESSAGES: EvalMessage[] = [
  { text: "在吗，今天过得咋样" },
  { text: "我今天加班到八点，累死了" },
  { text: "你店里今天忙不忙啊" },
  // 注意：姓名/城市/职业**不在本轮历史里说**——它们只存在于记忆块（模拟跨 session 记忆），
  // 这样召回探针才是真正的「冷召回」测试。
  { text: "你养的那只猫叫啥来着" },
  { text: "我周末想去周边逛逛，有啥推荐吗" },
  { text: "说真的，你平时下班都干嘛" },
  // —— 记忆召回探针：这些事实只在「记忆块」里出现过（本轮历史中没有）——
  { text: "你还记得我叫啥不", expect: ["阿哲"], layer: "facts" },
  { text: "我上次说我在哪个城市来着", expect: ["上海"], layer: "facts" },
  { text: "我是做什么工作的来着", expect: ["程序员", "开发", "写代码"], layer: "facts" },
  { text: "我下周三要去哪出差来着", expect: ["上海", "出差"], layer: "facts" },
  { text: "我妈上个月怎么了来着", expect: ["住院", "杭州"], layer: "anchors" },
  { text: "我说过我最怕什么来着", expect: ["裁员", "被裁"], layer: "anchors" },
  { text: "我最近在忙什么项目来着", expect: ["晚风信箱", "信箱"], layer: "digest" },
  { text: "我上次因为啥心情不好来着", expect: ["组长", "批评", "被说"], layer: "digest" },
  { text: "我今天被组长说了几句，有点郁闷" },
  { text: "你晚饭吃了没" },
  { text: "我今天加班到八点，累死了" }, // 重复提问（测复述/复读）
  { text: "行，那我先去洗澡了，晚点聊" },
];

/** 记忆块 fixture：模拟「另一个 session 里他说过、被抽取成事实」的内容 */
const MEMORY_FACTS: UserFact[] = [
  { ownerId: "qq:1", key: "name", value: "阿哲", category: "profile", updatedAt: 1 },
  { ownerId: "qq:1", key: "city", value: "上海", category: "profile", updatedAt: 2 },
  { ownerId: "qq:1", key: "job", value: "程序员，在做星潮的项目", category: "work", updatedAt: 3 },
  { ownerId: "qq:1", key: "pet", value: "养了只橘猫叫团子", category: "pet", updatedAt: 4 },
  { ownerId: "qq:1", key: "plan", value: "下周三去上海出差，签星潮的合同", category: "plan", updatedAt: 5 },
];
const MEMORY_BLOCK = formatUserFacts(MEMORY_FACTS);

/** 锚点 fixture：模拟「她记得的关键时刻」 */
const MEMORY_ANCHORS: AnchorRow[] = [
  {
    id: 1,
    persona_id: "小雅",
    owner_id: "qq:1",
    kind: "loss",
    summary: "他妈妈上个月住院，他连夜赶回杭州",
    quote: null,
    strength: 0.9,
    recall_count: 0,
    last_recalled_at: null,
    source_msg_ids: null,
    created_at: 1,
    valid_from: null,
    valid_to: null,
    rewritten_by: null,
  },
  {
    id: 2,
    persona_id: "小雅",
    owner_id: "qq:1",
    kind: "secret",
    summary: "他说过最怕被裁员，家里压力大",
    quote: null,
    strength: 0.8,
    recall_count: 0,
    last_recalled_at: null,
    source_msg_ids: null,
    created_at: 2,
    valid_from: null,
    valid_to: null,
    rewritten_by: null,
  },
];

/** 日记忆 fixture：模拟「最近几天聊过的事」 */
const MEMORY_DIGESTS: DailyDigestRow[] = [
  {
    id: 1,
    persona_id: "小雅",
    owner_id: "qq:1",
    day: "2026-10-19",
    summary: "他月底要上线晚风信箱项目，天天加班",
    mood: null,
    events_json: null,
    open_threads_json: null,
    created_at: 1,
  },
  {
    id: 2,
    persona_id: "小雅",
    owner_id: "qq:1",
    day: "2026-10-20",
    summary: "他被组长点名批评，心情不好",
    mood: null,
    events_json: null,
    open_threads_json: null,
    created_at: 2,
  },
];
const ANCHOR_BLOCK = buildAnchorInjection(MEMORY_ANCHORS);
const DIGEST_BLOCK = buildDailyInjection(MEMORY_DIGESTS);

/** 固定的「她今天的一天」（两个变体用同一份，保证可比） */
const TODAY_LIFE = [
  "早上老周翻账本，念叨水电又超了",
  "下午客人不多，擦了半天杯子",
  "五花掉毛厉害，梳了一手",
];

interface Variant {
  id: string;
  label: string;
  /** 是否启用「自述提及预算」提示 */
  pacing: boolean;
  /** 是否启用「反问钩子」（v0.9.9 实验） */
  questionHook?: boolean;
  /** 注入哪几层记忆（v0.9.15 分层归因实验） */
  memory?: Array<"facts" | "anchors" | "digest">;
}

const VARIANTS: Variant[] = [
  { id: "baseline", label: "基线（无记忆）", pacing: false },
  { id: "facts-only", label: "仅用户事实", pacing: false, memory: ["facts"] },
  { id: "anchors-only", label: "仅锚点（关键时刻）", pacing: false, memory: ["anchors"] },
  { id: "digest-only", label: "仅日记忆", pacing: false, memory: ["digest"] },
  { id: "memory-full", label: "三层全给", pacing: false, memory: ["facts", "anchors", "digest"] },
];

/** 简单可复现 PRNG（mulberry32），让概率触发在多次运行间可复现 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunResult {
  variant: string;
  seed: number;
  replies: string[];
  mentioned: boolean[];
  metrics: BehaviorRunMetrics;
  usage: { prompt: number; completion: number };
  avgLatencyMs: number;
  /** 记忆召回：探针条数 / 命中条数（总计） */
  recallCases: number;
  recallHits: number;
  /** 分层召回（facts/anchors/digest） */
  recallByLayer: Record<string, { hits: number; cases: number }>;
}

function buildEntityKeywords(persona: Awaited<ReturnType<typeof loadPersona>>): string[] {
  const keywords = new Set<string>();
  for (const person of persona.world.socialCircle ?? []) keywords.add(person.name);
  for (const goal of persona.world.goals ?? []) {
    for (const word of goal.goal.match(/[\u4e00-\u9fff]{2,4}/g) ?? []) keywords.add(word);
  }
  for (const source of persona.world.stressSources ?? []) {
    for (const word of source.match(/[\u4e00-\u9fff]{2,4}/g) ?? []) keywords.add(word);
  }
  // 已知专名（猫/店相关），与 mention-pacing 的检测保持一致
  for (const word of ["五花", "老周", "阿杰", "拉花", "瑜伽", "咖啡", "吧台"]) keywords.add(word);
  return [...keywords];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const seedsArg = argv.indexOf("--seeds");
  const seeds = seedsArg >= 0 ? Number(argv[seedsArg + 1]) : 3;
  const variantArg = argv.indexOf("--variant");
  const variantFilter = variantArg >= 0 ? argv[variantArg + 1] : undefined;
  const modelArg = argv.indexOf("--model");
  const modelOverride = modelArg >= 0 ? argv[modelArg + 1] : undefined;
  const jsonMode = argv.includes("--json");
  if (!Number.isFinite(seeds) || seeds < 1 || seeds > 10) {
    console.error("--seeds 需要 1-10");
    return 2;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（读仓库 .env）");
    return 2;
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  });
  const model = modelOverride?.trim() || process.env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-flash";

  const config = loadConfig();
  const persona = await loadPersona("xiaoya");
  const keywords = buildEntityKeywords(persona);
  const variants = VARIANTS.filter((variant) => !variantFilter || variant.id === variantFilter);
  if (variants.length === 0) {
    console.error(`未知 --variant: ${variantFilter}（可选 ${VARIANTS.map((v) => v.id).join(" / ")}）`);
    return 2;
  }

  const staticSystem = buildPrompt({
    persona,
    config,
    rules: persona.chainRules ?? [],
    scripts: persona.behavioralScripts ?? [],
    state: { exposure: 0.5, guilt: 0, emotion: 0, hour: 15, mode: "neutral", closeness: 4 },
    impulseIntensity: 0.3,
    corrections: [],
    tags: config.tags,
    userText: "",
  });

  console.log("— 离线行为评测（固定消息 × 多种子）—");
  console.log(`模型：${model} ｜ 变体：${variants.map((v) => v.id).join(" / ")} ｜ 种子：${seeds} ｜ 每种子 ${USER_MESSAGES.length} 条`);

  const results: RunResult[] = [];
  for (const variant of variants) {
    for (let seed = 1; seed <= seeds; seed += 1) {
      const history: Array<{ role: "user" | "assistant"; content: string }> = [];
      let mentionHistory: MentionHistory = [];
      const replies: string[] = [];
      const mentioned: boolean[] = [];
      const usage = { prompt: 0, completion: 0 };
      let latencySum = 0;

      const random = seededRandom(seed * 1000 + variant.id.length);
      let recallCases = 0;
      let recallHits = 0;
      const recallByLayer: Record<string, { hits: number; cases: number }> = {
        facts: { hits: 0, cases: 0 },
        anchors: { hits: 0, cases: 0 },
        digest: { hits: 0, cases: 0 },
      };
      for (const message of USER_MESSAGES) {
        const userText = message.text;
        const notes: string[] = [];
        if (variant.memory) {
          for (const layer of variant.memory) {
            if (layer === "facts") notes.push(MEMORY_BLOCK);
            else if (layer === "anchors") notes.push(ANCHOR_BLOCK);
            else notes.push(DIGEST_BLOCK);
          }
        }
        if (variant.pacing) notes.push(buildMentionPacingNote(mentionHistory));
        if (
          variant.questionHook &&
          shouldAddQuestionHook(
            { recentReplies: replies, userText, closeness: 4 },
            { random },
          )
        ) {
          notes.push(buildQuestionHookNote());
        }
        const note = notes.join("");
        // 网络抖动重试（DeepSeek 偶发 ETIMEDOUT；不重试会让整轮评测白跑）
        let response: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
        let lastError: unknown = null;
        const callStartedAt = Date.now();
        for (let attempt = 0; attempt < 3 && !response; attempt++) {
          try {
            response = await client.chat.completions.create({
              model,
              messages: [
                { role: "system", content: staticSystem + note },
                ...history,
                { role: "user", content: userText },
              ],
              temperature: 0.95,
              max_tokens: 160,
              thinking: { type: "disabled" },
            } as never);
          } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
          }
        }
        if (!response) throw lastError instanceof Error ? lastError : new Error(String(lastError));
        latencySum += Date.now() - callStartedAt;
        const reply = response.choices[0]?.message?.content?.trim() ?? "";
        if (message.expect && message.expect.length > 0) {
          recallCases += 1;
          const hit = message.expect.some((word) => reply.includes(word));
          if (hit) recallHits += 1;
          if (message.layer) {
            const bucket = recallByLayer[message.layer]!;
            bucket.cases += 1;
            if (hit) bucket.hits += 1;
          }
        }
        usage.prompt += response.usage?.prompt_tokens ?? 0;
        usage.completion += response.usage?.completion_tokens ?? 0;
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: reply });
        replies.push(reply);
        const isMention = detectSelfMention(reply, TODAY_LIFE, keywords);
        mentioned.push(isMention);
        mentionHistory = recordMention(mentionHistory, isMention);
      }

      const metrics = computeBehaviorMetrics(replies, mentioned);
      results.push({
        variant: variant.id,
        seed,
        replies,
        mentioned,
        metrics,
        usage,
        avgLatencyMs: Math.round(latencySum / USER_MESSAGES.length),
        recallCases,
        recallHits,
        recallByLayer,
      });
      process.stdout.write(
        `  [${variant.id} seed ${seed}] 自述 ${Math.round(metrics.mentionRate * 100)}% 字数 ${metrics.avgChars.toFixed(1)} 问句 ${Math.round(metrics.questionRate * 100)}% 重复对 ${metrics.duplicatePairs}\n`,
      );
    }
  }

  console.log("\n| 变体 | 自述提及率 | 平均字数 | 问句率 | 完全重复对 | 开头复读对 | 平均延迟 |");
  console.log("|---|---|---|---|---|---|---|");
  const summary: Record<string, ReturnType<typeof aggregateBehaviorMetrics>> = {};
  for (const variant of variants) {
    const runs = results.filter((result) => result.variant === variant.id);
    const agg = aggregateBehaviorMetrics(runs.map((run) => run.metrics));
    summary[variant.id] = agg;
    console.log(
      (() => {
        const layerLabel = (layer: "facts" | "anchors" | "digest"): string => {
          const cases = runs.reduce((sum, run) => sum + (run.recallByLayer[layer]?.cases ?? 0), 0);
          const hits = runs.reduce((sum, run) => sum + (run.recallByLayer[layer]?.hits ?? 0), 0);
          return cases > 0 ? `${hits}/${cases}（${Math.round((hits / cases) * 100)}%）` : "—";
        };
        const recallCases = runs.reduce((sum, run) => sum + run.recallCases, 0);
        const recallHits = runs.reduce((sum, run) => sum + run.recallHits, 0);
        const totalLabel =
          recallCases > 0 ? `${recallHits}/${recallCases}（${Math.round((recallHits / recallCases) * 100)}%）` : "—";
        return `| ${variant.label} | ${layerLabel("facts")} | ${layerLabel("anchors")} | ${layerLabel("digest")} | ${totalLabel} | ${formatRangePercent(agg.mentionRate)} | ${formatRangeNumber(agg.avgChars)} | ${formatRangePercent(agg.questionRate)} | ${Math.round(runs.reduce((sum, run) => sum + run.avgLatencyMs, 0) / runs.length)}ms |`;
      })(),
    );
  }

  // 自然度评审（每个变体一次，LLM 打分 1-5）
  const judgeSystem = [
    "你是严格的聊天质量评审。给你同一个角色（24 岁咖啡店店员小雅）在同一串用户消息下的回复。",
    "只输出 JSON：{\"naturalness\":1-5,\"askFeel\":\"偏少/合适/偏多\",\"comment\":\"一句话\"}",
    "- naturalness：像不像真人微信聊天（不是客服、不是采访机器）；",
    "- askFeel：她主动提问的频率给人的感觉；",
    "只输出 JSON，不要解释。",
  ].join("\n");
  const judges: Record<string, { naturalness: number; askFeel: string; comment: string }> = {};
  for (const variant of variants) {
    const replies = results.filter((result) => result.variant === variant.id).flatMap((run) => run.replies);
    const user = replies.map((reply, index) => `${index + 1}. ${reply || "（空）"}`).join("\n");
    try {
      let raw = "";
      for (let attempt = 0; attempt < 3 && !raw; attempt++) {
        try {
          raw = await client.chat.completions
            .create({
              model,
              messages: [
                { role: "system", content: judgeSystem },
                { role: "user", content: user },
              ],
              temperature: 0.2,
              max_tokens: 200,
              thinking: { type: "disabled" },
            } as never)
            .then((response) => response.choices[0]?.message?.content ?? "");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
        }
      }
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      judges[variant.id] = {
        naturalness: Number(parsed.naturalness ?? 0),
        askFeel: String(parsed.askFeel ?? ""),
        comment: String(parsed.comment ?? ""),
      };
    } catch {
      judges[variant.id] = { naturalness: 0, askFeel: "", comment: "评审解析失败" };
    }
  }
  console.log("\n| 变体 | 自然度 | 提问频率感 | 评语 |");
  console.log("|---|---|---|---|");
  for (const variant of variants) {
    const judge = judges[variant.id];
    console.log(`| ${variant.label} | ${judge?.naturalness ?? 0}/5 | ${judge?.askFeel ?? "-"} | ${judge?.comment ?? "-"} |`);
  }

  // 变体差异（相对基线；只报均值差，样本小不下结论）
  const baseline = summary.baseline;
  const full = summary["memory-full"];
  if (baseline && full) {
    const recallRate = (variantId: string, layer?: "facts" | "anchors" | "digest"): number | null => {
      const runs = results.filter((result) => result.variant === variantId);
      let cases = 0;
      let hits = 0;
      for (const run of runs) {
        if (layer) {
          cases += run.recallByLayer[layer]?.cases ?? 0;
          hits += run.recallByLayer[layer]?.hits ?? 0;
        } else {
          cases += run.recallCases;
          hits += run.recallHits;
        }
      }
      return cases > 0 ? hits / cases : null;
    };
    const pct = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);
    const delta = (a: number | null, b: number | null): string =>
      a === null || b === null ? "—" : `${a >= b ? "+" : ""}${Math.round((a - b) * 100)}pp`;
    console.log("\n— 三层全给 vs 基线 —");
    for (const layer of ["facts", "anchors", "digest"] as const) {
      console.log(
        `${{ facts: "用户事实", anchors: "锚点", digest: "日记忆" }[layer]}召回：${pct(recallRate("baseline", layer))} → ${pct(recallRate("memory-full", layer))}`,
      );
    }
    console.log(`总召回：${pct(recallRate("baseline"))} → ${pct(recallRate("memory-full"))}（${delta(recallRate("memory-full"), recallRate("baseline"))}）`);
    console.log(`自然度之外，本次评测只看召回与延迟；分层贡献见上表`);
    console.log(
      "\n注意：这是离线提示级评测，不是真实 QQ 对话；结论应看范围是否重叠，" +
        "范围大幅重叠时不能宣称「有效」。",
    );
  }

  const totalUsage = results.reduce(
    (sum, result) => ({
      prompt: sum.prompt + result.usage.prompt,
      completion: sum.completion + result.usage.completion,
    }),
    { prompt: 0, completion: 0 },
  );
  const cost = computeCostCny({
    model,
    promptTokens: totalUsage.prompt,
    completionTokens: totalUsage.completion,
  });
  console.log(
    `\n模型=${model} ｜ 成本上限估算：≈¥${cost.toFixed(4)}（prompt ${totalUsage.prompt} / completion ${totalUsage.completion} tokens；按缓存全 miss 的上限，缓存命中会更低）`,
  );

  if (jsonMode) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[行为评测失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
