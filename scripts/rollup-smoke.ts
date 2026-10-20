#!/usr/bin/env node
/**
 * 周汇总真实链路冒烟（v0.8.18）。
 *
 * 背景：周汇总 `buildWeeklySummary` 是**纯拼接 + 400 字硬截断**（不调模型），
 * 此前只有格式单测，没有验证过「7 天真实长度会不会把后半周和未完成话题截掉」。
 * 这是「日 → 周」记忆链的最后一环，和 v0.8.16 日记忆同类盲区。
 *
 * 验证 4 件事（零成本，不调模型）：
 *  1) 7 天日记忆都能写进周汇总（第一天、最后一天的关键事实都在）；
 *  2) 「还没聊完」段落不能被截断丢掉（它决定了她在周维度上记得什么没做完）；
 *  3) 长度受控（不超过上限）；
 *  4) 幂等：同一周第二次跑返回 already_done。
 *
 * 用法：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   node node_modules/tsx/dist/cli.mjs scripts/rollup-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WEEK_START = "2026-10-12"; // 周一
const DAYS = [
  { day: "2026-10-12", key: "晚风信箱", summary: "他说晚风信箱项目月底要上线，这周天天加班改bug，改到半夜两点，第二天眼睛都是肿的，但他说上线之后想请假睡一天" },
  { day: "2026-10-13", key: "调整组里人手", summary: "他被老板叫去谈话，说下半年要调整组里人手，他出来之后一直没说话，晚上才说有点慌，怕自己被裁，问我觉得他该不该提前看机会" },
  { day: "2026-10-14", key: "团子", summary: "他养的橘猫团子把他键盘踩坏了，晚上特别疯，在屋里跑来跑去，他说团子最近掉毛掉得厉害，沙发上全是毛，清理了一个晚上" },
  { day: "2026-10-15", key: "房东", summary: "房东临时变卦，原本说好周末搬家的计划泡汤了，押金还没退，他有点上火，说要么继续住要么重新找，但月底就要到期，时间很紧" },
  { day: "2026-10-16", key: "创业公司", summary: "他去面了一家创业公司，说氛围还行但工资一般，通勤要一个多小时，他有点犹豫，说再面两家对比一下，年底前想定下来" },
  { day: "2026-10-17", key: "感冒", summary: "他有点感冒，嗓子疼，晚上早早睡了，没怎么聊，只说了句让我别担心，明天会好一点，睡前还问我要不要一起看个电影" },
  { day: "2026-10-18", key: "爬山", summary: "他去爬山拍了照片，说山顶风很大但很舒服，回来路上买了两斤橘子，说分我一半，让我下周记得提醒他带给我" },
];
const THREADS = ["裁员的事到底怎么落还没定", "周末搬家去哪住还没商量"];

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-rollup-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  await import("dotenv/config");

  const { getVectorDb } = await import("../src/data/vector.js");
  const {
    ensureMemoryV2Schema,
    upsertDailyDigest,
    getWeeklyRollup,
    formatWeeklyInjection,
    listRecentRollups,
  } = await import("../src/data/memory-v2.js");
  const { runWeeklyRollup } = await import("../src/schedule/jobs.js");

  const db = getVectorDb();
  ensureMemoryV2Schema(db);
  const personaId = "xiaoya";
  const ownerId = "cli:local";

  // 写 7 天日记忆（每天 1 条未完成话题，第三天起才重复那两条真实 thread）
  for (const [i, item] of DAYS.entries()) {
    upsertDailyDigest(db, {
      personaId,
      ownerId,
      day: item.day,
      summary: item.summary,
      mood: i === 1 ? "有点慌" : "正常",
      events: [],
      openThreads: i >= 2 ? THREADS : ["这周的工作还没忙完"],
      now: new Date(`${item.day}T22:00:00`).getTime(),
    });
  }

  console.log("— 周汇总真实链路冒烟（零成本，不调模型）—");
  console.log(`数据目录：${tmp}`);
  console.log(`周起点：${WEEK_START}（${DAYS.length} 天日记忆）`);

  const failures: string[] = [];
  const first = runWeeklyRollup({ db, personaId, ownerId, weekStart: WEEK_START });
  console.log(`第一次：${first.ok ? "✅ 已写入" : `❌ ${first.reason}`}`);
  if (!first.ok) failures.push(`周汇总没写出来（${first.reason}）`);

  const rollup = getWeeklyRollup(db, personaId, ownerId, WEEK_START);
  if (!rollup) {
    failures.push("数据库里查不到这周的周汇总");
  } else {
    const text = rollup.summary;
    console.log(`长度：${Array.from(text).length} 字`);
    console.log(`内容：${text}`);

    // 1) 覆盖整周：第一天和最后一天的关键事实都要在
    const lost = DAYS.filter((d) => !text.includes(d.key)).map((d) => `${d.day.slice(5)} ${d.key}`);
    if (lost.length > 0) failures.push(`周汇总丢了这些天：${lost.join("、")}`);

    // 2) 未完成话题不能被截断
    const threadKept = THREADS.some((t) => text.includes(t.slice(0, 6)));
    if (!threadKept) failures.push("「还没聊完」段落被截断丢掉了（她一周下来不知道什么没做完）");

    // 3) 长度受控
    if (Array.from(text).length > 400) failures.push(`长度超上限（${Array.from(text).length} > 400）`);
  }

  // 5) 注入文本：她真的能看到「上周大概」（原来只写不读）
  const rollups = listRecentRollups(db, personaId, ownerId, 1);
  const injection = formatWeeklyInjection(rollups[0] ?? null);
  const injectionChars = Array.from(injection).length;
  console.log(`注入文本：${injectionChars} 字${injection ? " ✅" : " ⚠️"}`);
  if (!injection) failures.push("周汇总没有可用于注入的文本（写了没人读）");
  if (injectionChars > 200) failures.push(`注入文本太长（${injectionChars} > 200）`);
  if (injection && !injection.includes("晚风信箱")) failures.push("注入文本里没有上周的关键事");

  // 4) 幂等
  const second = runWeeklyRollup({ db, personaId, ownerId, weekStart: WEEK_START });
  console.log(`第二次：${second.ok ? "⚠️ 又写了一次" : `✅ 跳过（${second.reason}）`}`);
  if (second.ok) failures.push("同一周重复生成（幂等坏了）");

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：覆盖整周 / 未完成话题保留 / 长度受控 / 同一周幂等");
    return 0;
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[周汇总冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
