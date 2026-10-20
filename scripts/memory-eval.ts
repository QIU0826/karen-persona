/**
 * 记忆评测 thin CLI。
 *
 * 用法：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/memory-eval.ts            # 默认 offline
 *   ... scripts/memory-eval.ts --offline
 *   ... scripts/memory-eval.ts --live        # 真实调 DeepSeek（消耗 token，≤20 条）
 *   ... scripts/memory-eval.ts --json        # 只输出 JSON（便于 CI/对比）
 *   ... scripts/memory-eval.ts --limit=10    # live 采样上限（硬上限 20）
 *   ... scripts/memory-eval.ts --keep-data   # 保留临时数据目录（调试）
 *
 * 安全：live 的 Key 只由 dotenv 从仓库 .env 读取，绝不打印；所有数据写入
 * KAREN_DATA_DIR 临时目录，跑完删除，不触碰真实 data/。
 */
import "dotenv/config";

import { configureLogger } from "../src/obs/logger.js";
import {
  evaluateLive,
  evaluateOffline,
  formatLiveMarkdown,
  formatLiveSummary,
  formatOfflineMarkdown,
  formatOfflineSummary,
} from "../src/eval/memory-eval.js";

interface CliOptions {
  mode: "offline" | "live";
  json: boolean;
  keepData: boolean;
  verbose: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "offline",
    json: false,
    keepData: false,
    verbose: false,
  };
  for (const arg of argv) {
    if (arg === "--offline") options.mode = "offline";
    else if (arg === "--live") options.mode = "live";
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep-data") options.keepData = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--limit 必须是正整数，收到: ${arg}`);
      }
      options.limit = Math.floor(value);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法: tsx scripts/memory-eval.ts [--offline|--live] [--json] [--limit=N] [--keep-data] [--verbose]",
          "",
          "  --offline    离线记忆评测（默认；不联网）",
          "  --live       真实调用 DeepSeek 生成回答（≤20 条，消耗 token）",
          "  --json       只输出 JSON",
          "  --limit=N    live 采样条数上限（最大 20）",
          "  --keep-data  保留临时数据目录（调试）",
          "  --verbose    保留业务 info 日志（默认只保留 warn/error，避免污染表格）",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // 业务模块的 info 日志（如 llm.usage JSON lines）会污染 markdown/JSON 输出。
  if (!options.verbose) configureLogger({ level: "error" });

  if (options.mode === "live") {
    const result = await evaluateLive({
      limit: options.limit,
      keepData: options.keepData,
    });
    if (options.json) {
      const { dataDir: _dataDir, ...rest } = result;
      console.log(JSON.stringify(rest, null, 2));
      return;
    }
    console.log("# 记忆评测（live）\n");
    console.log(formatLiveMarkdown(result));
    console.log("");
    console.log(formatLiveSummary(result));
    if (options.keepData) {
      console.log(`（临时数据目录已保留：${result.dataDir}）`);
    }
    return;
  }

  const result = evaluateOffline({ keepData: options.keepData });
  if (options.json) {
    const { dataDir: _dataDir, seeded, ...rest } = result;
    console.log(
      JSON.stringify(
        { ...rest, seeded: { facts: seeded.facts, episodes: seeded.episodes } },
        null,
        2
      )
    );
    return;
  }
  console.log("# 记忆评测（offline）\n");
  console.log(formatOfflineMarkdown(result));
  console.log("");
  console.log(formatOfflineSummary(result));
  if (options.keepData) {
    console.log(`（临时数据目录已保留：${result.dataDir}）`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[memory-eval] 失败：${message}`);
  process.exitCode = 1;
});
