#!/usr/bin/env node
/**
 * 回复里「她自己的生活」受控 A/B（v0.9.5）。
 *
 * 背景：评审另一条意见是「日常回复也几乎不分享自己的日常，只接话」。
 * v0.3.3 的 talk-moves（28% 概率补一句自己近况）之所以 A/B 未测出效果，
 * 是因为旧提示只说"补一句近况"、**没给任何素材**——模型要么不说，要么说得很空。
 *
 * 本脚本把「这一轮的回复」单独拿出来做受控对照：
 *   旧提示（空泛：补一句自己的近况）
 *   vs 新提示（带她的真实生活素材：店里冷清/五花掉毛/攒钱进度…）
 * 用真实模型生成回复，再让评审统计「有她具体生活的回复条数」与主观自然度。
 *
 * 成本约 ¥0.02。用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/selfshare-eval.ts
 */
import OpenAI from "openai";
import "dotenv/config";
import { buildLifeSignals } from "../src/impulse/initiative-plan.js";

/** 精简人设（仅用于受控评测，不是生产 prompt） */
const PERSONA = {
  name: "小雅",
  job: "24 岁，在嘉兴一家咖啡店当店员，老板叫老周，同事叫阿杰",
  life: ["养了只猫叫五花，最近掉毛严重", "在练拉花，郁金香还没成功", "攒钱想去日本，攒了三分之一", "闺蜜小雨在北京，最近在谈恋爱"],
  style: "说话短句、口语、像微信聊天；不解释、不总结、不列点；不提 AI",
};

const OPENERS = [
  "今天上班好累啊，感觉人都快废了",
  "在干嘛呢",
  "你那边今天天气怎么样",
  "我晚上准备点个外卖，你吃了吗",
  "突然有点丧，说不上来为什么",
  "周末你一般怎么过啊",
  "我最近在考虑要不要换个工作",
  "你平时几点睡啊",
  "今天被同事气到了，真的服了",
  "说真的，你觉得我这个人怎么样",
];

const OLD_NOTE =
  "\n[内部提示] 这轮如果你只是回答，可以在最后顺手补一句你自己的近况或念头（一句就够），让话题往前走，但别抢他的话头。";

function newNote(signal: string): string {
  return (
    "\n[内部提示] 这轮可以在回完他之后，顺手说你自己的**一件具体的小事**（一句就够，别展开）：" +
    `「${signal}」。` +
    "用你自己的话讲，像随口提一句，不要照抄、不要说教、不要每轮都提。"
  );
}

async function main(): Promise<number> {
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

  const systemBase = [
    `你是${PERSONA.name}。${PERSONA.job}。`,
    `你的生活：${PERSONA.life.join("；")}。`,
    `说话方式：${PERSONA.style}。`,
    "只输出要发出去的微信消息本身（1–3 个短句，可用 / 分隔气泡），不要解释。",
  ].join("\n");

  const signals = buildLifeSignals({
    world: {
      dailyRhythm: [{ activity: "咖啡店工作", day: "每天", time: "08:00-17:00" }],
      goals: [{ goal: "学会拉花", progress: "在练郁金香" }],
      stressSources: ["店里生意不太好，老周说可能要缩减人手"],
      socialCircle: [{ name: "小雨", relation: "大学闺蜜", influence: "最近在谈恋爱" }],
    },
    hour: 15,
    weekday: 3,
    random: () => 0,
  });
  // 每轮换一条素材，避免重复
  const signalFor = (index: number): string => signals[index % signals.length] ?? "今天店里客人不多";

  const generate = async (note: string, userText: string): Promise<string> => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemBase + note },
        { role: "user", content: userText },
      ],
      temperature: 0.9,
      max_tokens: 160,
      thinking: { type: "disabled" },
    } as never);
    return response.choices[0]?.message?.content?.trim() ?? "";
  };

  console.log("— 回复里「她自己的生活」受控 A/B —");
  const oldReplies: string[] = [];
  const newReplies: string[] = [];
  for (let i = 0; i < OPENERS.length; i++) {
    const userText = OPENERS[i]!;
    oldReplies.push(await generate(OLD_NOTE, userText));
    newReplies.push(await generate(newNote(signalFor(i)), userText));
  }

  const judgeSystem = [
    "你是严格的角色扮演评审。给你同一个角色（咖啡店店员小雅）在不同用户消息下的回复。",
    "对每一组回复判断：这条回复里有没有**她自己的具体生活内容**（她店里的情况/她的猫/她的目标/她的朋友/她的心情经历），",
    "而不是只回应对方或只反问对方。",
    "统计并只输出 JSON：",
    '{"selfLifeReplies":N,"askOnlyReplies":N,"naturalScore":1-5,"comment":"一句话"}',
    "- selfLifeReplies：有多少条回复含她自己的具体生活内容；",
    "- askOnlyReplies：有多少条**完全只是在回应/追问对方**、没有她自己的内容；",
    "- naturalScore：这些回复像不像真人微信聊天（1–5）；",
    "只输出 JSON，不要解释。",
  ].join("\n");
  const judgeUser = (label: string, replies: string[]): string =>
    `【${label}】\n` +
    replies.map((reply, index) => `—— 用户：${OPENERS[index]} ——\n她：${reply || "（空）"}`).join("\n");

  const judge = async (
    label: string,
    replies: string[],
  ): Promise<{ selfLifeReplies: number; askOnlyReplies: number; naturalScore: number; comment: string }> => {
    const raw = await client.chat.completions
      .create({
        model,
        messages: [
          { role: "system", content: judgeSystem },
          { role: "user", content: judgeUser(label, replies) },
        ],
        temperature: 0.2,
        max_tokens: 300,
        thinking: { type: "disabled" },
      } as never)
      .then((response) => response.choices[0]?.message?.content ?? "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      return {
        selfLifeReplies: Number(parsed.selfLifeReplies ?? 0),
        askOnlyReplies: Number(parsed.askOnlyReplies ?? 0),
        naturalScore: Number(parsed.naturalScore ?? 0),
        comment: String(parsed.comment ?? ""),
      };
    } catch {
      return { selfLifeReplies: 0, askOnlyReplies: 0, naturalScore: 0, comment: `解析失败：${raw.slice(0, 60)}` };
    }
  };

  const oldJudge = await judge("旧提示（空泛：补一句自己的近况）", oldReplies);
  const newJudge = await judge("新提示（带她的真实生活素材）", newReplies);

  console.log("\n| 指标 | 旧提示 | 新提示 |");
  console.log("|---|---|---|");
  console.log(`| 含她生活的回复 | ${oldJudge.selfLifeReplies} | ${newJudge.selfLifeReplies} |`);
  console.log(`| 纯回应/追问回复 | ${oldJudge.askOnlyReplies} | ${newJudge.askOnlyReplies} |`);
  console.log(`| 像真人微信（1-5） | ${oldJudge.naturalScore} | ${newJudge.naturalScore} |`);
  console.log(`\n旧评语：${oldJudge.comment}`);
  console.log(`新评语：${newJudge.comment}`);

  console.log("\n—— 新提示示例（前 3 条）——");
  for (let i = 0; i < 3; i++) {
    console.log(`用户：${OPENERS[i]}`);
    console.log(`她：${newReplies[i] || "（空）"}\n`);
  }

  const improved =
    newJudge.selfLifeReplies > oldJudge.selfLifeReplies ||
    newJudge.askOnlyReplies < oldJudge.askOnlyReplies;
  console.log("— 结论 —");
  if (improved) {
    console.log(
      `  ✅ 含她生活的回复 ${oldJudge.selfLifeReplies} → ${newJudge.selfLifeReplies}；纯追问 ${oldJudge.askOnlyReplies} → ${newJudge.askOnlyReplies}；自然度 ${newJudge.naturalScore}/5`,
    );
    return 0;
  }
  console.log(
    `  ✗ 未测出提升：含她生活 ${oldJudge.selfLifeReplies} → ${newJudge.selfLifeReplies}；纯追问 ${oldJudge.askOnlyReplies} → ${newJudge.askOnlyReplies}；自然度 ${newJudge.naturalScore}/5`,
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[selfshare 评测失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
