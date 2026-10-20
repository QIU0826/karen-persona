#!/usr/bin/env node
/**
 * 意图式主动性离线模拟 CLI（v0.8.13）。
 *
 * 用法（仓库根执行）：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/initiative-sim.ts
 *
 * 零成本：不调用任何模型。核心逻辑在 src/eval/initiative-sim.ts（有 vitest 守护）。
 * 退出码：0 = 产品红线全过；1 = 有红线违规（可直接进 CI）。
 */
import {
  DEFAULT_PROFILES,
  SIM_BEAT_INTERVAL_MINUTES,
  SIM_QUIET_HOURS,
  checkRedlines,
  simulateDay,
} from "../src/eval/initiative-sim.js";

function formatMinute(minuteOfDay: number): string {
  const h = String(Math.floor(minuteOfDay / 60) % 24).padStart(2, "0");
  const m = String(minuteOfDay % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function main(): number {
  console.log(
    `意图式主动 · 离线模拟（一天 24h，每 ${SIM_BEAT_INTERVAL_MINUTES} 分钟心跳一次，` +
      `免打扰 ${String(SIM_QUIET_HOURS.start).padStart(2, "0")}:00–${String(SIM_QUIET_HOURS.end).padStart(2, "0")}:00）\n`,
  );

  const results = DEFAULT_PROFILES.map(simulateDay);
  for (const r of results) {
    console.log(`【${r.profile}】日上限 ${r.cap}（${r.capReason}）→ 实际发出 ${r.sent.length} 条`);
    if (r.sent.length === 0) {
      console.log("  （一条都没发）");
    } else {
      for (const item of r.sent) {
        console.log(`  ${formatMinute(item.minuteOfDay)}  ${item.topic}`);
      }
    }
  }

  console.log("\n— 发不出原因（各档合计）—");
  const total: Record<string, number> = {};
  for (const r of results) {
    for (const [reason, count] of Object.entries(r.skipReasons)) {
      total[reason] = (total[reason] ?? 0) + count;
    }
  }
  for (const [reason, count] of Object.entries(total).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }

  console.log("\n— 产品红线 —");
  const failures = checkRedlines(results);
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：不超上限 / 免打扰不发 / 间隔 ≥30 分钟 / 由头不重复 / 冷淡档收敛 / 生疏档不撒娇");
    return 0;
  }
  for (const failure of failures) console.log(`  ✗ [${failure.profile}] ${failure.message}`);
  return 1;
}

process.exitCode = main();
