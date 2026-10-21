#!/usr/bin/env node
/**
 * 「她的一天」真实链路冒烟（v0.9.6）。
 *
 * 为什么需要：生活流是**新生成的虚构内容**，最大风险是编造——冒出人设里没有的人/地点，
 * 或者写成"今天心情不错"这种空话。这里用真实模型生成她的一天，并做硬性校验：
 *   1. 能解析、恰好 3 条、每条 ≤24 字；
 *   2. 不出现 AI 腔（AI/用户/对方/作为/模型）；
 *   3. **至少一半条目能对上她人设里的既有实体**（朋友/目标/压力源/作息/猫/天气），
 *      否则视为编造，失败退出。
 *
 * 成本约 ¥0.001。用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/life-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import "dotenv/config";
import { buildDailyLifePrompt, formatDailyLife, parseDailyLife } from "../src/impulse/daily-life.js";

const PERSONA_PATH = path.join(process.cwd(), "personas/xiaoya/persona.json");

/** 人设里已有的实体关键词（用于防编造校验） */
function groundKeywords(persona: Record<string, unknown>): string[] {
  const world = (persona.world ?? {}) as {
    socialCircle?: Array<{ name?: string }>;
    goals?: Array<{ goal?: string }>;
    stressSources?: string[];
    dailyRhythm?: Array<{ activity?: string }>;
  };
  const keywords = new Set<string>();
  for (const person of world.socialCircle ?? []) if (person.name) keywords.add(person.name);
  for (const goal of world.goals ?? []) {
    for (const word of (goal.goal ?? "").match(/[\u4e00-\u9fff]{2,}/g) ?? []) keywords.add(word);
  }
  for (const source of world.stressSources ?? []) {
    for (const word of source.match(/[\u4e00-\u9fff]{2,}/g) ?? []) keywords.add(word);
  }
  for (const entry of world.dailyRhythm ?? []) {
    for (const word of (entry.activity ?? "").match(/[\u4e00-\u9fff]{2,}/g) ?? []) keywords.add(word);
  }
  // 猫的名字在别的字段里出现过（五花），从 persona 全文中兜一遍高频专名不可靠，这里显式补
  for (const word of ["五花", "咖啡", "拉花", "瑜伽", "店", "猫"]) keywords.add(word);
  return [...keywords].filter((word) => word.length >= 2);
}

async function main(): Promise<number> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（读仓库 .env）");
    return 2;
  }
  const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, "utf8")) as Record<string, unknown>;
  const world = (persona.world ?? null) as Parameters<typeof buildDailyLifePrompt>[0]["world"];

  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = now.getDay() === 0 ? 7 : now.getDay();

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  });
  const model = process.env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-flash";
  const prompt = buildDailyLifePrompt({ herName: String(persona.name ?? "小雅"), day, weekday, world, weather: null });

  console.log("— 「她的一天」真实链路冒烟 —");
  const startedAt = Date.now();
  let content = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  for (let attempt = 0; attempt < 3 && !content; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 1.0,
        max_tokens: 300,
        thinking: { type: "disabled" },
      } as never);
      content = response.choices[0]?.message?.content?.trim() ?? "";
      usage = response.usage ?? usage;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const elapsed = Date.now() - startedAt;
  if (!content) {
    console.error(" ✗ 模型调用失败（重试 3 次）");
    return 1;
  }

  const plan = parseDailyLife(content, day);
  if (!plan) {
    console.error(" ✗ 无法解析成生活流：", content.slice(0, 120));
    return 1;
  }
  console.log(` 解析：${plan.events.length} 条 / 耗时 ${elapsed}ms`);
  console.log(` ${formatDailyLife(plan.events)}`);

  const failures: string[] = [];
  if (plan.events.length !== 3) failures.push(`条目数 ${plan.events.length} ≠ 3`);
  for (const event of plan.events) {
    if (event.text.length === 0 || event.text.length > 24) failures.push(`条目长度异常：${event.text}`);
  }
  const joined = plan.events.map((event) => event.text).join(" ");
  const aiWords = ["AI", "用户", "对方", "作为", "模型", "人工智能"];
  for (const word of aiWords) {
    if (joined.includes(word)) failures.push(`出现 AI 腔：${word}`);
  }
  const keywords = groundKeywords(persona);
  const grounded = plan.events.filter((event) => keywords.some((word) => event.text.includes(word)));
  if (grounded.length < 2) {
    failures.push(`接地条目只有 ${grounded.length}/3（至少 2 条要能对上人设既有实体）`);
  } else {
    console.log(
      ` 接地：${grounded.length}/3（命中：${grounded
        .flatMap((event) => keywords.filter((word) => event.text.includes(word)))
        .slice(0, 5)
        .join("、")}）`,
    );
  }

  const cost = (usage.prompt_tokens * 0.0000005 + usage.completion_tokens * 0.000002) * 1; // 粗略
  console.log(` 成本≈¥${cost.toFixed(5)}（prompt ${usage.prompt_tokens} / completion ${usage.completion_tokens} tokens）`);

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log(" ✅ 通过：3 条具体小事、无 AI 腔、至少 2 条对上她的人设世界");
    return 0;
  }
  for (const failure of failures) console.log(` ✗ ${failure}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[她的一天冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
