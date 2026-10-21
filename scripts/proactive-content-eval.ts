#!/usr/bin/env node
/**
 * 主动由头内容评测（v0.9.4）：before / after 真实模型对照。
 *
 * 背景：评审反馈「主动性 3/5、几乎不分享自己的日常」。根因是计划生成只喂了「他的事」
 * （日记忆/未完成话题），而 persona.world 里她自己的生活从来没用上。
 *
 * 本脚本用**同一批上下文**分别用旧 prompt（v0.9.3，冻结副本）与新 prompt 生成计划，
 * 再用真实模型评审「有多少条是她自己的生活 / 有多少条只是在追问对方」。
 *
 * 成本约 ¥0.02（16 次生成 + 2 次评审）。用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/proactive-content-eval.ts
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import "dotenv/config";
import { buildDailyPlanPrompt, buildLifeSignals, parseDailyPlan } from "../src/impulse/initiative-plan.js";

const DAY = "2026-10-21";

const persona = JSON.parse(fs.readFileSync(path.join(process.cwd(), "personas/xiaoya/persona.json"), "utf8")) as {
  name?: string;
  world?: Parameters<typeof buildLifeSignals>[0]["world"];
};
const world = persona.world ?? null;

/** 8 个典型上下文（时间/星期/亲密度/天气/情绪） */
const CONTEXTS = [
  { id: "weekday-morning", hour: 9, weekday: 1, closeness: 4, weather: { condition: "晴", temperature: 22 }, emotion: "平静" },
  { id: "weekday-afternoon", hour: 15, weekday: 2, closeness: 5, weather: { condition: "多云", temperature: 20 }, emotion: "有点困" },
  { id: "workday-evening", hour: 20, weekday: 3, closeness: 6, weather: { condition: "小雨", temperature: 18 }, emotion: "放松" },
  { id: "late-night", hour: 23, weekday: 4, closeness: 7, weather: null, emotion: "有点低落" },
  { id: "weekend-morning", hour: 10, weekday: 6, closeness: 3, weather: { condition: "晴", temperature: 25 }, emotion: "开心" },
  { id: "weekend-rain", hour: 16, weekday: 7, closeness: 2, weather: { condition: "大雨", temperature: 19 }, emotion: "无聊" },
  { id: "cold-start", hour: 21, weekday: 5, closeness: 1.5, weather: null, emotion: "平静" },
  { id: "close-evening", hour: 19, weekday: 2, closeness: 8, weather: { condition: "晴", temperature: 21 }, emotion: "想他" },
] as const;

const RECENT_DIGESTS = [
  "2026-10-19：他月底要上线晚风信箱项目，天天加班；被老板谈了话，怕被裁。",
  "2026-10-20：他去面试了一家创业公司，还在犹豫；房东临时变卦，周末搬不了家。",
];
const OPEN_THREADS = ["裁员的事到底怎么落还没定", "周末搬家去哪住还没商量"];

/** v0.9.3 冻结的旧 prompt（用作对照基线；不要改它，改了对照就失效） */
function buildLegacyPlanPrompt(input: {
  herName: string;
  userName: string;
  day: string;
  closeness: number;
}): { system: string; user: string } {
  const system = [
    "你在帮一个角色规划「今天可能想主动找对方说些什么」。",
    "只输出 JSON，不要解释。",
    '格式：{"items":[{"topic":"...","kind":"life_event|open_thread|mood_share|missing_you","urgency":0.6,"window_start":9,"window_end":12}]}',
    "要求：",
    "- 2–3 条即可，不要更多；",
    "- topic 写一句具体的话头（≤20 字），像她心里冒出来的念头，不要写成问候语；",
    "- kind 只能取四类之一；urgency 0–1；",
    "- window_start/window_end 用 0–23 的整数（可跨天，如 22→2），要符合她的作息；",
    "- 只用给到的线索，不要编造没有的事。",
  ].join("\n");
  const user = [
    `她的名字：${input.herName}；对方：${input.userName}；日期：${input.day}；亲密度：${input.closeness.toFixed(1)}/10`,
    "她生活里的事：（无特别的事）",
    `没聊完的话题：${OPEN_THREADS.join("；")}`,
    `最近几天：${RECENT_DIGESTS.join(" / ")}`,
  ].join("\n");
  return { system, user };
}

interface JudgeResult {
  selfLifeItems: number;
  askOnlyItems: number;
  naturalScore: number;
  comment: string;
}

async function main(): Promise<number> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（读仓库 .env）");
    return 2;
  }
  const client = new OpenAI({ apiKey, baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com" });
  const model = process.env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-flash";

  const callJson = async (system: string, user: string): Promise<string> => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
      max_tokens: 400,
      thinking: { type: "disabled" },
    } as never);
    return response.choices[0]?.message?.content ?? "";
  };

  const legacyPlans: string[] = [];
  const newPlans: string[] = [];
  for (const context of CONTEXTS) {
    const legacyRaw = await callJson(
      buildLegacyPlanPrompt({ herName: "小雅", userName: "阿哲", day: DAY, closeness: context.closeness }).system,
      buildLegacyPlanPrompt({ herName: "小雅", userName: "阿哲", day: DAY, closeness: context.closeness }).user,
    );
    const legacy = parseDailyPlan(legacyRaw, DAY);
    legacyPlans.push(legacy?.items.map((item) => `[${item.kind}] ${item.topic}`).join("\n") ?? "（解析失败）");

    const lifeSignals = buildLifeSignals({
      world,
      hour: context.hour,
      weekday: context.weekday,
      emotionLabel: context.emotion,
      weather: context.weather,
      random: () => 0,
    });
    const prompt = buildDailyPlanPrompt({
      herName: "小雅",
      userName: "阿哲",
      day: DAY,
      closeness: context.closeness,
      lifeSignals,
      recentDigests: RECENT_DIGESTS,
      openThreads: OPEN_THREADS,
    });
    const newRaw = await callJson(prompt.system, prompt.user);
    const next = parseDailyPlan(newRaw, DAY);
    newPlans.push(next?.items.map((item) => `[${item.kind}] ${item.topic}`).join("\n") ?? "（解析失败）");
  }

  const judgeSystem = [
    "你是严格的角色扮演评审。给你同一个角色（咖啡店店员小雅）在多组上下文里生成的「主动找对方说话」的由头清单。",
    "统计并只输出 JSON：",
    '{"selfLifeItems":N,"askOnlyItems":N,"naturalScore":1-5,"comment":"一句话"}',
    "- selfLifeItems：有多少条是**她自己的生活/自己的事**（店里、朋友、她的目标、她的心情/经历），而不是关于对方的；",
    "- askOnlyItems：有多少条**只是在追问/关心对方的事**、完全没有她自己的内容；",
    "- naturalScore：这些由头像不像她心里冒出来的念头（而不是客服式问候/采访提纲），1–5；",
    "只输出 JSON，不要解释。",
  ].join("\n");
  const judgeUser = (label: string, plans: string[]): string =>
    `【${label}】\n` + plans.map((plan, index) => `—— 上下文 ${index + 1} ——\n${plan || "（空）"}`).join("\n");

  const judge = async (label: string, plans: string[]): Promise<JudgeResult> => {
    const raw = await callJson(judgeSystem, judgeUser(label, plans));
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<JudgeResult>;
      return {
        selfLifeItems: Number(parsed.selfLifeItems ?? 0),
        askOnlyItems: Number(parsed.askOnlyItems ?? 0),
        naturalScore: Number(parsed.naturalScore ?? 0),
        comment: String(parsed.comment ?? ""),
      };
    } catch {
      return { selfLifeItems: 0, askOnlyItems: 0, naturalScore: 0, comment: `解析失败：${raw.slice(0, 60)}` };
    }
  };

  console.log("— 主动由头内容评测（真实模型，before/after）—");
  const legacyJudge = await judge("旧 prompt（v0.9.3：无她自己的生活线索）", legacyPlans);
  const newJudge = await judge("新 prompt（v0.9.4：她自己的生活线索 + 规则）", newPlans);

  console.log("\n| 指标 | 旧 prompt | 新 prompt |");
  console.log("|---|---|---|");
  console.log(`| 她自己的生活条目 | ${legacyJudge.selfLifeItems} | ${newJudge.selfLifeItems} |`);
  console.log(`| 纯追问对方条目 | ${legacyJudge.askOnlyItems} | ${newJudge.askOnlyItems} |`);
  console.log(`| 像不像她的念头（1-5） | ${legacyJudge.naturalScore} | ${newJudge.naturalScore} |`);
  console.log(`\n旧评语：${legacyJudge.comment}`);
  console.log(`新评语：${newJudge.comment}`);

  console.log("\n—— 新 prompt 生成的由头示例（前 3 组）——");
  for (const plan of newPlans.slice(0, 3)) console.log(plan || "（空）", "\n");

  const improved =
    newJudge.selfLifeItems > legacyJudge.selfLifeItems &&
    newJudge.askOnlyItems <= legacyJudge.askOnlyItems;
  const acceptable = newJudge.naturalScore >= 3;
  console.log("— 结论 —");
  if (improved && acceptable) {
    console.log(
      `  ✅ 她自己的生活条目 ${legacyJudge.selfLifeItems} → ${newJudge.selfLifeItems}，纯追问 ${legacyJudge.askOnlyItems} → ${newJudge.askOnlyItems}；主观自然度 ${newJudge.naturalScore}/5`,
    );
    return 0;
  }
  console.log(
    `  ✗ 未达到目标：自述 ${legacyJudge.selfLifeItems} → ${newJudge.selfLifeItems}；纯追问 ${legacyJudge.askOnlyItems} → ${newJudge.askOnlyItems}；自然度 ${newJudge.naturalScore}/5`,
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[主动由头内容评测失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
