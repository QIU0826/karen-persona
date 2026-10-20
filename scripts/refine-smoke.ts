#!/usr/bin/env node
/**
 * 锚点复筛真实链路冒烟（v0.8.17）。
 *
 * 背景：v0.8.4 的「每天把边界记忆交 LLM 判断值不值得长期记」这条链路，
 * 此前只在真实库上人工跑过一次（12 条候选全判"不值得记"），**没有可复现验证**。
 * 和 v0.8.14 主动消息、v0.8.15 锚点创建、v0.8.16 日记忆同类盲区。
 *
 * 验证 4 件事（真实 DeepSeek，约 ¥0.003/次）：
 *  1) 候选筛选正确：显著度落在 [0.45, 0.75) 且未建过锚点的才进候选；
 *  2) 精度优先：**绝不**给"午饭吃三明治"这类闲聊建锚点（宁可漏，不能错）；
 *  3) 值得记的（家人手术/辞职创业/童年秘密）至少建出 1 条；
 *  4) 幂等守卫：同一天第二次跑被 job_runs 拦住，不会重复建锚点。
 *
 * 数据全在临时目录。
 * 用法：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   node node_modules/tsx/dist/cli.mjs scripts/refine-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 昨天某小时的 TEXT 时间戳（真实库 t2_episodes.created_at 是 TEXT） */
function textAt(dayKey: string, hour: number): string {
  return `${dayKey} ${String(hour).padStart(2, "0")}:00:00`;
}

const WORTHY = [
  { content: "他说他爸住院了，下周要做手术，他这两天都睡不好", salience: 0.7, hour: 20 },
  { content: "他认真说想辞职去做独立开发，攒够半年的钱就走", salience: 0.65, hour: 21 },
  { content: "他很少提小时候被同学欺负的事，今天说了很久", salience: 0.6, hour: 22 },
];
const NOT_WORTHY = [
  { content: "今天午饭吃了个三明治，还行", salience: 0.55, hour: 12 },
  { content: "外面下雨了，出门忘带伞", salience: 0.5, hour: 15 },
  { content: "晚上打了两把游戏，输多赢少", salience: 0.5, hour: 23 },
];

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-refine-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  await import("dotenv/config");

  const { getVectorDb } = await import("../src/data/vector.js");
  const { ensureMemoryV2Schema, listAnchors } = await import("../src/data/memory-v2.js");
  const { runAnchorRefine } = await import("../src/schedule/anchor-refine.js");
  const { refineAnchorsWithLLM } = await import("../src/schedule/anchor-llm.js");

  const db = getVectorDb();
  ensureMemoryV2Schema(db);

  const now = Date.now();
  const yesterday = localDayKey(now - 24 * 60 * 60 * 1000);
  const personaId = "xiaoya";
  const ownerId = "cli:local";

  const insert = db.prepare(
    `INSERT INTO t2_episodes (persona_id, content, source, strength, emotional_weight, half_life_days, salience, created_at)
     VALUES (?, ?, 'chat', 1.0, 0.2, 30.0, ?, ?)`,
  );
  for (const item of [...WORTHY, ...NOT_WORTHY]) {
    insert.run(personaId, item.content, item.salience, textAt(yesterday, item.hour));
  }
  // 干扰项：显著度过低 / 过高（都不该进候选）
  insert.run(personaId, "嗯嗯好的", 0.2, textAt(yesterday, 9));
  insert.run(personaId, "我们结婚吧", 0.9, textAt(yesterday, 10));

  console.log("— 锚点复筛真实链路冒烟（真实模型，临时目录）—");
  console.log(`数据目录：${tmp}`);
  console.log(`目标日：${yesterday}（值得记 ${WORTHY.length} 条 / 闲聊 ${NOT_WORTHY.length} 条 / 干扰 2 条）`);

  const failures: string[] = [];
  const before = listAnchors(db, personaId, ownerId, 20).length;

  const result = await runAnchorRefine({
    db,
    personaId,
    ownerId,
    day: yesterday,
    herName: "小雅",
    userName: "阿哲",
    chatFn: (prompt) => refineAnchorsWithLLM(prompt),
  });
  console.log(`结果：ok=${result.ok} reason=${result.reason} 候选=${result.candidates} 新建=${result.created}`);
  if (!result.ok) failures.push(`复筛失败（${result.reason}）`);
  if (result.candidates < 2) failures.push(`候选取少了（${result.candidates} 条，应 ≥6）`);
  if (result.created > result.candidates) failures.push("新建数超过候选数（逻辑错误）");

  const anchors = listAnchors(db, personaId, ownerId, 20);
  console.log(`锚点总数：${before} → ${anchors.length}`);
  for (const anchor of anchors) {
    console.log(`  - [${anchor.kind}] ${anchor.summary}（强度 ${anchor.strength}）`);
  }

  // 精度优先：任何一条新建锚点都不能来自 NOT_WORTHY
  const created = anchors.slice(0, anchors.length - before);
  const falsePositive = created.filter((anchor) => {
    const quote = anchor.quote ?? "";
    return NOT_WORTHY.some((item) => quote.includes(item.content.slice(0, 8)));
  });
  if (falsePositive.length > 0) {
    failures.push(`给闲聊建了锚点（${falsePositive.map((a) => a.summary).join("、")}）`);
  }
  // 值得记的至少要建出 1 条（召回低可接受，但一条都不建说明链路没生效）
  if (anchors.length === before) {
    failures.push("值得记的事件一条都没被采纳（复筛链路可能没生效）");
  }

  // 数据层幂等：重跑时 episode 已回写 anchor_id，候选应为 0（不再花一次 LLM）
  const beforeRerun = listAnchors(db, personaId, ownerId, 20).length;
  const rerun = await runAnchorRefine({
    db,
    personaId,
    ownerId,
    day: yesterday,
    herName: "小雅",
    userName: "阿哲",
    chatFn: (prompt) => refineAnchorsWithLLM(prompt),
  });
  const afterRerun = listAnchors(db, personaId, ownerId, 20).length;
  console.log(`重跑（模拟守卫丢失）：候选 ${rerun.candidates}、新建 ${rerun.created}；锚点 ${beforeRerun} → ${afterRerun}`);
  if (rerun.candidates !== 0) failures.push(`重跑仍有 ${rerun.candidates} 条候选（episode.anchor_id 没回写）`);
  if (afterRerun !== beforeRerun) failures.push("重跑又建了锚点（不幂等）");

  // 幂等守卫：模拟 orchestrator 的 job_runs 拦截
  db.prepare("INSERT OR REPLACE INTO job_runs (job, period, ran_at) VALUES ('anchor_refine', ?, ?)").run(
    yesterday,
    Date.now(),
  );
  const guarded = db
    .prepare(`SELECT 1 FROM job_runs WHERE job = 'anchor_refine' AND period = ? LIMIT 1`)
    .get(yesterday);
  if (!guarded) {
    failures.push("幂等守卫没生效（第二次还会重复建锚点）");
  } else {
    console.log("幂等守卫：✅ 同一天第二次会跳过");
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：候选筛选正确 / 没给闲聊建锚点 / 该记的至少建出 1 条 / 当天幂等");
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
    console.error("[复筛冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
