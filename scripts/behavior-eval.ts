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
import {
  buildMentionPacingNote,
  detectSelfMention,
  recordMention,
  type MentionHistory,
} from "../src/persona/mention-pacing.js";
import {
  aggregateBehaviorMetrics,
  computeBehaviorMetrics,
  formatRangeNumber,
  formatRangePercent,
  type BehaviorRunMetrics,
} from "../src/eval/behavior-metrics.js";

/** 固定用户消息序列（覆盖：闲聊/关心/事实/重复提问/情绪/邀约） */
const USER_MESSAGES = [
  "在吗，今天过得咋样",
  "我今天加班到八点，累死了",
  "你店里今天忙不忙啊",
  "对了，我叫阿哲，在上海做程序员",
  "你养的那只猫叫啥来着",
  "我周末想去周边逛逛，有啥推荐吗",
  "说真的，你平时下班都干嘛",
  "我今天被组长说了几句，有点郁闷",
  "你晚饭吃了没",
  "我今天加班到八点，累死了", // 重复提问（测复述/复读）
  "你养的那只猫叫啥来着", // 重复提问
  "行，那我先去洗澡了，晚点聊",
];

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
}

const VARIANTS: Variant[] = [
  { id: "baseline", label: "基线（无提及预算）", pacing: false },
  { id: "mention-pacing", label: "自述提及预算（v0.9.7）", pacing: true },
];

interface RunResult {
  variant: string;
  seed: number;
  replies: string[];
  mentioned: boolean[];
  metrics: BehaviorRunMetrics;
  usage: { prompt: number; completion: number };
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
  const model = process.env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-flash";

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

      for (const userText of USER_MESSAGES) {
        const note = variant.pacing ? buildMentionPacingNote(mentionHistory) : "";
        const response = await client.chat.completions.create({
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
        const reply = response.choices[0]?.message?.content?.trim() ?? "";
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
      results.push({ variant: variant.id, seed, replies, mentioned, metrics, usage });
      process.stdout.write(
        `  [${variant.id} seed ${seed}] 自述 ${Math.round(metrics.mentionRate * 100)}% 字数 ${metrics.avgChars.toFixed(1)} 问句 ${Math.round(metrics.questionRate * 100)}% 重复对 ${metrics.duplicatePairs}\n`,
      );
    }
  }

  console.log("\n| 变体 | 自述提及率 | 平均字数 | 问句率 | 完全重复对 | 开头复读对 |");
  console.log("|---|---|---|---|---|---|");
  const summary: Record<string, ReturnType<typeof aggregateBehaviorMetrics>> = {};
  for (const variant of variants) {
    const runs = results.filter((result) => result.variant === variant.id);
    const agg = aggregateBehaviorMetrics(runs.map((run) => run.metrics));
    summary[variant.id] = agg;
    console.log(
      `| ${variant.label} | ${formatRangePercent(agg.mentionRate)} | ${formatRangeNumber(agg.avgChars)} | ${formatRangePercent(agg.questionRate)} | ${formatRangeNumber(agg.duplicatePairs)} | ${formatRangeNumber(agg.repeatedOpenerPairs)} |`,
    );
  }

  // 变体差异（相对基线；只报均值差，样本小不下结论）
  const baseline = summary.baseline;
  const pacing = summary["mention-pacing"];
  if (baseline && pacing) {
    const delta = (a: number, b: number): string => `${a >= b ? "+" : ""}${Math.round((a - b) * 100)}pp`;
    console.log("\n— 与基线相比（均值差）—");
    console.log(`自述提及率：${delta(pacing.mentionRate.mean, baseline.mentionRate.mean)}`);
    console.log(`平均字数：${delta(pacing.avgChars.mean / 20, baseline.avgChars.mean / 20)}（比例近似）`);
    console.log(`问句率：${delta(pacing.questionRate.mean, baseline.questionRate.mean)}`);
    console.log(`完全重复对：${delta(pacing.duplicatePairs.mean / 10, baseline.duplicatePairs.mean / 10)}（比例近似）`);
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
  const cost = totalUsage.prompt * 0.0000005 + totalUsage.completion * 0.000002;
  console.log(`\n成本估算：≈¥${cost.toFixed(4)}（prompt ${totalUsage.prompt} / completion ${totalUsage.completion} tokens）`);

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
