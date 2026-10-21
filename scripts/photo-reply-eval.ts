#!/usr/bin/env node
/**
 * 「发照片」回复重复度评测（v0.9.19，问题复现用）。
 *
 * 背景：用户反馈「问照片的事情，每次回复内容差不多」「人机感」。
 * 本脚本用**生产 system prompt** + 生产 media-request 内部提示，连问 10 种照片相关请求，
 * 输出逐条回复、跨回复相似度、高频重复短语——先量化再修。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/photo-reply-eval.ts --seeds 2
 * 成本：2 种子 × 10 条 ≈ 20 次调用 ≈ ¥0.02。
 */
import OpenAI from "openai";
import "dotenv/config";
import { loadConfig } from "../src/data/store.js";
import { loadPersona } from "../src/persona/loader.js";
import { buildPrompt } from "../src/persona/prompt-builder.js";
import { buildMediaRequestNote, detectMediaRequest } from "../src/impulse/media-request.js";

const PHOTO_MESSAGES = [
  "给我拍张照片看看呗",
  "你店里现在什么样，拍一张",
  "发张你那只猫的照片",
  "晚霞好看吗，拍张看看",
  "今天下雨了，拍张你窗外的",
  "你午饭吃了啥，拍给我看看",
  "拍张你现在的样子",
  "街上人多吗，拍张街景",
  "你吧台收拾好了没，拍张",
  "最近没看到你发照片了，来一张",
];

function stripPunct(text: string): string {
  return text.replace(/[\s，。！？、；：,.!?;:…—~～“”"'（）()]/g, "");
}

/** 字符 bigram Jaccard（跨回复相似度）。 */
function bigramJaccard(a: string, b: string): number {
  const grams = (text: string): Set<string> => {
    const s = stripPunct(text);
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const gram of ga) if (gb.has(gram)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/** 高频 3-gram（中文按字）统计。 */
function topNgrams(replies: string[], n = 3): Array<{ gram: string; count: number }> {
  const counter = new Map<string, number>();
  for (const reply of replies) {
    const s = stripPunct(reply);
    const seen = new Set<string>();
    for (let i = 0; i < s.length - n + 1; i += 1) {
      const gram = s.slice(i, i + n);
      if (seen.has(gram)) continue;
      seen.add(gram);
      counter.set(gram, (counter.get(gram) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([gram, count]) => ({ gram, count }))
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seedArg = argv.indexOf("--seeds");
  const seeds = seedArg >= 0 ? Number(argv[seedArg + 1] ?? "2") : 2;
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（读仓库 .env）");
    process.exit(2);
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  });
  const model = process.env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-flash";
  const config = loadConfig();
  const persona = await loadPersona("xiaoya");

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

  const allReplies: string[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    console.log(`\n—— 种子 ${seed} ——`);
    for (const userText of PHOTO_MESSAGES) {
      const request = detectMediaRequest(userText);
      const note = buildMediaRequestNote(request);
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
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: reply });
      allReplies.push(reply);
      const hint = request.photo ? "📷" : "  ";
      console.log(`${hint} 用户：${userText}`);
      console.log(`    她：${reply || "（空）"}`);
    }
  }

  console.log("\n—— 跨回复相似度（字符 bigram Jaccard）——");
  const pairs: Array<{ score: number; a: number; b: number }> = [];
  for (let i = 0; i < allReplies.length; i += 1) {
    for (let j = i + 1; j < allReplies.length; j += 1) {
      pairs.push({ score: bigramJaccard(allReplies[i]!, allReplies[j]!), a: i, b: j });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const avg = pairs.reduce((sum, pair) => sum + pair.score, 0) / Math.max(1, pairs.length);
  console.log(`平均相似度：${avg.toFixed(3)}（0=完全不同，1=完全一样）`);
  console.log(`最高 3 对：`);
  for (const pair of pairs.slice(0, 3)) {
    console.log(
      `  ${pair.score.toFixed(2)} ｜「${allReplies[pair.a]}」 vs 「${allReplies[pair.b]}」`
    );
  }

  console.log("\n—— 高频重复片段（≥2 次）——");
  const ngrams = topNgrams(allReplies);
  if (ngrams.length === 0) console.log("（无）");
  for (const item of ngrams) console.log(`  ${item.count}× ${item.gram}`);
}

main().catch((err) => {
  console.error("[photo-reply-eval] 失败：", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
