#!/usr/bin/env node
/**
 * 日记忆生成真实链路冒烟（v0.8.16）。
 *
 * 为什么需要：`runDailyDigest` 是「她记得昨天发生了什么」的支点（也是周汇总/主动由头的原料），
 * 但此前只有单测（假 chatFn）。真实链路从来没验证过——和 v0.8.14 主动消息、v0.8.15 锚点同类盲区。
 *
 * 这个脚本用临时数据目录 + 真实 DeepSeek 验证 3 件事：
 *  1) 昨天的对话能生成一条日记忆（summary 非空、mood 合理）；
 *  2) **关键事实不丢**：具体的人名/项目/宠物名必须出现在 summary 或 events/open_threads 里；
 *  3) **幂等**：同一天再跑一次返回 already_done，不产生第二条。
 *
 * 成本约 ¥0.002。全部数据写临时目录，不碰 data/。
 *
 * 用法：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   node node_modules/tsx/dist/cli.mjs scripts/digest-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 造「长对话日」：早上说关键事实，之后 90 条闲聊（超过 80 条截断上限） */
function seedLongDay(dayStart: number): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
  const base = dayStart + 8 * 60 * 60 * 1000; // 早上 8 点
  const messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [
    { role: "user", content: "我下周三要去上海见客户，签那个星潮的合同", timestamp: base },
    { role: "assistant", content: "周三啊 那你要提前准备材料", timestamp: base + 8000 },
  ];
  // 后面全是无关闲聊，把早上这两条挤出最后 80 条
  for (let i = 0; i < 45; i++) {
    const t = base + (i + 1) * 10 * 60 * 1000;
    messages.push({ role: "user", content: `随便聊聊第${i}件事，今天天气还行，中午吃了点东西`, timestamp: t });
    messages.push({ role: "assistant", content: `嗯 那挺好的 第${i}件`, timestamp: t + 5000 });
  }
  return messages;
}

/** 造「昨天」的对话（含具体事实与未完成话题） */
function seedMessages(dayStart: number): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
  const base = dayStart + 20 * 60 * 60 * 1000; // 昨天 20:00
  const raw: Array<[string, string]> = [
    ["我们那个晚风信箱项目月底要上线，我现在天天改bug", "月底啊 那还有几天 别熬太晚"],
    ["我今天被老板叫去谈话了，说下半年要调整组里人手", "谈完之后呢 你还好吗"],
    ["有点慌，怕被裁", "先别自己吓自己 你把话听完再说"],
    ["我养的那只橘猫今天把我键盘踩坏了", "橘猫都这样 它叫啥来着"],
    ["团子，晚上特别疯", "团子这名字好可爱 哈哈"],
    ["周末本来想搬完家，结果房东临时变卦", "那你这周末怎么办"],
  ];
  const messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];
  raw.forEach(([user, assistant], i) => {
    messages.push({ role: "user", content: user, timestamp: base + i * 120_000 });
    messages.push({ role: "assistant", content: assistant, timestamp: base + i * 120_000 + 8_000 });
  });
  return messages;
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-digest-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  await import("dotenv/config");

  const { getVectorDb } = await import("../src/data/vector.js");
  const { ensureMemoryV2Schema, listRecentDigests } = await import("../src/data/memory-v2.js");
  const { runDailyDigest } = await import("../src/schedule/jobs.js");
  const { summarizeDayWithLLM } = await import("../src/schedule/digest-llm.js");

  const db = getVectorDb();
  ensureMemoryV2Schema(db);

  // 「昨天」
  const now = Date.now();
  const yesterdayStart = now - 24 * 60 * 60 * 1000;
  const dayKey = localDayKey(yesterdayStart);
  const messages = seedMessages(yesterdayStart);

  console.log("— 日记忆真实链路冒烟（真实模型，临时目录）—");
  console.log(`数据目录：${tmp}`);
  console.log(`目标日：${dayKey}（${messages.length} 条消息）`);

  const failures: string[] = [];

  const run = async () =>
    runDailyDigest({
      db,
      personaId: "xiaoya",
      ownerId: "cli:local",
      dayKey,
      messages,
      chatFn: async (prompt) => {
        const text = await summarizeDayWithLLM(prompt);
        if (!text) throw new Error("llm_null");
        return text;
      },
    });

  const first = await run();
  console.log(`第一次：${first.ok ? "✅ 已生成" : `❌ ${first.reason}`}`);
  if (!first.ok) failures.push(`日记忆没有生成（${first.reason}）`);

  const digests = listRecentDigests(db, "xiaoya", "cli:local", 5);
  const digest = digests.find((d) => d.day === dayKey);
  if (digest) {
    console.log(`  summary：${digest.summary}`);
    console.log(`  mood：${digest.mood ?? "（无）"}`);
    let openThreads: string[] = [];
    try {
      openThreads = JSON.parse(digest.open_threads_json ?? "[]") as string[];
    } catch {
      // 忽略
    }
    if (openThreads.length > 0) console.log(`  未完成话题：${openThreads.join(" / ")}`);

    // 关键事实不能丢：项目名、猫名必须出现（人名/公司可选）
    const haystack = `${digest.summary} ${digest.events_json ?? ""} ${digest.open_threads_json ?? ""}`;
    const mustKeep = ["晚风信箱", "团子"];
    const lost = mustKeep.filter((word) => !haystack.includes(word));
    if (lost.length > 0) {
      failures.push(`日记忆丢了关键事实：${lost.join("、")}`);
    } else {
      console.log(`  关键事实：${mustKeep.join(" / ")} 都在 ✅`);
    }
    if (!digest.summary.trim()) failures.push("summary 是空的");
  } else {
    failures.push("数据库里没有这一天的日记忆");
  }

  // 幂等
  const second = await run();
  const after = listRecentDigests(db, "xiaoya", "cli:local", 5).filter((d) => d.day === dayKey).length;
  console.log(`第二次：${second.ok ? "⚠️ 又生成了一次" : `✅ 跳过（${second.reason}）`}；当天条数 ${after}`);
  if (second.ok) failures.push("同一天重复生成（幂等坏了）");
  if (after !== 1) failures.push(`同一天应有 1 条日记忆，实际 ${after} 条`);

  // ── 对抗用例：长对话日（>80 条）时，早上说的关键事实不能被截断丢掉 ──
  const longDayStart = now - 2 * 24 * 60 * 60 * 1000;
  const longDayKey = localDayKey(longDayStart);
  const longMessages = seedLongDay(longDayStart);
  const longRun = await runDailyDigest({
    db,
    personaId: "xiaoya",
    ownerId: "cli:local",
    dayKey: longDayKey,
    messages: longMessages,
    chatFn: async (prompt) => {
      const text = await summarizeDayWithLLM(prompt);
      if (!text) throw new Error("llm_null");
      return text;
    },
  });
  console.log(`\n长对话日（${longMessages.length} 条）：${longRun.ok ? "✅ 已生成" : `❌ ${longRun.reason}`}`);
  if (!longRun.ok) {
    failures.push(`长对话日没有生成（${longRun.reason}）`);
  } else {
    const longDigest = listRecentDigests(db, "xiaoya", "cli:local", 10).find((d) => d.day === longDayKey);
    if (!longDigest) {
      failures.push("长对话日的记录查不到");
    } else {
      console.log(`  summary：${longDigest.summary}`);
      const hay = `${longDigest.summary} ${longDigest.events_json ?? ""} ${longDigest.open_threads_json ?? ""}`;
      const kept = ["上海", "星潮"].filter((w) => hay.includes(w));
      if (!hay.includes("上海") || !hay.includes("星潮")) {
        failures.push(`长对话日丢了早上的关键事实（保住：${kept.join("、") || "无"}；期望：上海、星潮）`);
      } else {
        console.log("  早上的关键事实（上海/星潮）保住了 ✅");
      }
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：生成正确 / 关键事实不丢 / 同一天幂等");
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
    console.error("[日记忆冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
