#!/usr/bin/env node
/**
 * 一次性服务体检 CLI（P0-2）：看桥接 /health + 探活 .env 里实际配置的依赖。
 *
 * 用法：
 *   npm run health            # 人类可读；任一依赖不可达时退出码 1
 *   npm run health -- --json  # 机器可读
 *   npm run health -- --timeout 1500
 *
 * 只探测本机/隧道地址；不打印响应正文、Key 或聊天内容。
 */
import "dotenv/config";
import {
  collectDependencies,
  formatDependencySnapshot,
  probeDependencies,
} from "../src/obs/dependency-health.js";

interface BridgeHealth {
  status?: string;
  ok?: boolean;
  uptime?: number;
  ws_connections?: number;
  db_ok?: boolean;
  degraded?: string[];
  dependencies?: unknown[];
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function readBridgeHealth(): Promise<BridgeHealth | null> {
  const port = Number(process.env.HEALTH_PORT ?? 18081);
  if (!Number.isFinite(port) || port <= 0) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return (await response.json()) as BridgeHealth;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const timeoutRaw = argValue("timeout");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || (timeoutMs ?? 0) <= 0)) {
    console.error(`--timeout 不合法：${timeoutRaw}`);
    process.exitCode = 1;
    return;
  }

  const specs = collectDependencies();
  const snapshot = await probeDependencies(specs, timeoutMs ? { timeoutMs } : {});
  const bridge = await readBridgeHealth();

  if (json) {
    console.log(JSON.stringify({ bridge, dependencies: snapshot }, null, 2));
  } else {
    console.log("== 桥接 ==");
    if (bridge) {
      const status = bridge.status ?? (bridge.ok ? "ok" : "degraded");
      const icon = status === "ok" ? "✅" : "⚠️";
      console.log(
        `${icon} status=${status}  ws=${bridge.ws_connections ?? "?"}  uptime=${bridge.uptime ?? "?"}s  db_ok=${bridge.db_ok ?? "?"}`,
      );
      if (bridge.degraded && bridge.degraded.length > 0) {
        console.log(`   降级项：${bridge.degraded.join(", ")}`);
      }
      if (!("status" in bridge)) {
        console.log("   （桥接进程仍是旧版本：重启后 /health 才会带 status/dependencies）");
      }
    } else {
      console.log("❌ http://127.0.0.1:18081/health 不可达（桥接没起 / health_port=0）");
    }
    console.log("\n== 依赖 ==");
    for (const line of formatDependencySnapshot(snapshot)) console.log(line);
    console.log(
      snapshot.degraded.length === 0
        ? "\n✅ 依赖全部可达"
        : `\n❌ ${snapshot.degraded.length} 项不可达（她会在对应能力上静默降级）`,
    );
  }

  process.exitCode = snapshot.degraded.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`体检失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
