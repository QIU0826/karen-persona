#!/usr/bin/env node
/**
 * 锚点记忆真实链路冒烟（v0.8.15）。
 *
 * 为什么需要：锚点「该记的记住、不该记的别乱记」目前只有纯函数单测（scoreSalience /
 * addAnchor）覆盖，**没有一条真实管线跑通**。真机数据里锚点一直是 0 条（没遇到值得记的事），
 * 等于"接线了没"从未被真实验证过——和 v0.8.14 主动消息冒烟发现的盲区同类。
 *
 * 这个脚本用临时数据目录 + 真实 DeepSeek 跑 3 轮：
 *  1) 值得记 → 应创建 1 条锚点（kind 正确）；
 *  2) 不值得记 → 不应创建；
 *  3) 有锚点后在下一轮 prompt 里应被注入（捕获 stdout 的「注入锚点 N 条」日志）。
 *
 * 成本约 ¥0.005。全部数据写临时目录，不碰 data/。
 *
 * 用法：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   node node_modules/tsx/dist/cli.mjs scripts/anchor-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseInjectedCount(lines: string[]): number {
  for (const line of lines.reverse()) {
    const match = line.match(/注入锚点 (\d+) 条/);
    if (match) return Number(match[1]);
  }
  return 0;
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-anchor-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  delete process.env.KAREN_MEMORY_V2; // 确保记忆 v2 开着（默认开）
  await import("dotenv/config");

  const { loadConfig } = await import("../src/data/store.js");
  const { loadPersona } = await import("../src/persona/loader.js");
  const { initConversation, processMessage } = await import("../src/pipeline/orchestrator.js");
  const { getVectorDb } = await import("../src/data/vector.js");
  const { ensureMemoryV2Schema, listAnchors } = await import("../src/data/memory-v2.js");

  const config = { ...loadConfig(), persona: "xiaoya" };
  const persona = await loadPersona(config.persona);
  const state = await initConversation(persona, config, "cli:local");
  const db = getVectorDb();
  ensureMemoryV2Schema(db);

  console.log("— 锚点真实链路冒烟（真实模型，临时目录）—");
  console.log(`数据目录：${tmp}`);

  const failures: string[] = [];

  // ── 轮 1：值得记的事（失去/承诺）──
  const anchorWorthy = "我奶奶上个月走了。这件事我还没跟别人说过，晚上经常想她。";
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    captured.push(line);
    origLog(...args);
  };
  let reply1 = "";
  try {
    reply1 = (await processMessage(state, anchorWorthy, { bypassGate: true })).reply ?? "";
  } finally {
    console.log = origLog;
  }
  if (!reply1.trim()) failures.push("轮 1 没有回复");
  const anchorsAfter1 = listAnchors(db, state.storagePersona, state.owner, 10);
  const created = captured.find((line) => line.includes("新增锚点"));
  console.log(`轮 1：锚点数 ${anchorsAfter1.length}${created ? `（${created.trim()}）` : ""}`);
  if (anchorsAfter1.length === 0) {
    failures.push("值得记的事没有创建锚点（记忆 v2 的锚点路径可能没接上）");
  } else {
    const kinds = anchorsAfter1.map((a) => a.kind);
    console.log(`  锚点类型：${kinds.join(" / ")}`);
    if (!kinds.includes("loss") && !kinds.includes("secret") && !kinds.includes("shared_experience")) {
      failures.push(`锚点类型不像"失去/秘密/共同经历"，而是 ${kinds.join("/")}`);
    }
  }

  // ── 轮 2：不值得记的日常闲聊 → 不应新增 ──
  const before = listAnchors(db, state.storagePersona, state.owner, 50).length;
  await processMessage(state, "今天中午吃了碗面，还行", { bypassGate: true });
  const after = listAnchors(db, state.storagePersona, state.owner, 50).length;
  console.log(`轮 2：日常闲聊后锚点数 ${before} → ${after}（应不变）`);
  if (after > before) failures.push("日常闲聊也创建了锚点（阈值太低，会变成什么都记）");

  // ── 轮 3：有锚点后，下一轮应把它注入 prompt（捕获注入日志）──
  const cap3: string[] = [];
  const origLog3 = console.log;
  console.log = (...args: unknown[]) => {
    cap3.push(args.map((a) => String(a)).join(" "));
    origLog3(...args);
  };
  try {
    await processMessage(state, "你还记得我最近跟你说过什么难过的事吗", { bypassGate: true });
    await processMessage(state, "嗯，谢谢你听我说这些", { bypassGate: true });
  } finally {
    console.log = origLog3;
  }
  const injected = parseInjectedCount(cap3);
  console.log(`轮 3：注入锚点 ${injected} 条${injected > 0 ? " ✅" : " ⚠️"}`);
  if (injected === 0) failures.push("有锚点但下一轮没有注入（锚点注入链路没生效）");

  // 不主动 close：后台还有 embedding 升级/成本写入在跑，提前关库只会刷错误日志。
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：该记的记住了 / 日常闲聊不乱记 / 锚点会注入");
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
    console.error("[锚点冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
