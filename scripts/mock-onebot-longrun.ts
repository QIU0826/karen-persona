#!/usr/bin/env node
/**
 * 真实验证台 CLI：mock OneBot + 真实 DeepSeek 多轮长跑。
 *
 * 用法（在仓库根执行）：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/mock-onebot-longrun.ts \
 *     --scenario daily --turns 15 --gap-ms 12000 --budget-cny 0.5
 *
 * 依赖仓库根 .env 的 DEEPSEEK_API_KEY（会产生真实调用费用；不打印 Key）。
 * 隔离：临时 workdir + KAREN_DATA_DIR；WS 19180、health 19181、web_port 0；
 * 绝不占用 18080/18081/18082（用户真实 QQ 桥接），不读写仓库 data/。
 *
 * 报告默认写 docs/MOCK_VALIDATION.md（自动保留上一版人工观察段落）。
 */
import {
  LONGRUN_USAGE,
  describeRunSummary,
  maskSensitive,
  parseLongrunCliArgs,
  runLongrun,
} from "../src/eval/mock-longrun.js";

/** 收尾/评审卡住时的硬兜底（正常 15 轮远小于此值）。 */
const WATCHDOG_MS = 45 * 60 * 1000;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(LONGRUN_USAGE);
    return 0;
  }

  let options;
  try {
    options = parseLongrunCliArgs(argv);
  } catch (err) {
    console.error(`[longrun] 参数错误: ${maskSensitive(err instanceof Error ? err.message : String(err))}`);
    process.stderr.write(LONGRUN_USAGE);
    return 2;
  }

  process.stdout.write(
    `[longrun] 场景=${options.scenario} 轮数=${options.turns} gap=${options.gapMs}ms ` +
      `语音=${options.voice ? "开" : "关"} 预算=¥${options.budgetCny} 报告=${options.out}\n`,
  );

  try {
    const result = await runLongrun(options);
    process.stdout.write("\n=== 基线摘要 ===\n");
    process.stdout.write(`${describeRunSummary(result)}\n`);
    process.stdout.write(`耗时 ${Math.round(result.durationMs / 1000)}s；实跑 ${result.turnsRun}/${options.turns} 轮\n`);
    if (result.review) {
      process.stdout.write(`评审总分：真人感 ${result.review.realism}/5 / 连贯 ${result.review.coherence}/5 / 主动 ${result.review.initiative}/5 / 多媒体 ${result.review.multimedia}/5 / 记忆 ${result.review.memory}/5\n`);
      if (result.review.topIssues.length > 0) {
        process.stdout.write(`评审 top issues：${result.review.topIssues.map((issue) => maskSensitive(issue)).join("；")}\n`);
      }
    }
    for (const observation of result.autoObservations) {
      process.stdout.write(`- ${observation}\n`);
    }
    process.stdout.write(`报告：${options.out}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`[longrun] 失败: ${maskSensitive(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

const watchdog = setTimeout(() => {
  console.error("[longrun] 收尾超时（>45min），强制退出");
  process.exit(1);
}, WATCHDOG_MS);

void main()
  .then((code) => {
    clearTimeout(watchdog);
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[longrun] 未捕获错误: ${maskSensitive(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
