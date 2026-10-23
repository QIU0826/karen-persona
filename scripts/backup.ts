#!/usr/bin/env node
/**
 * 数据热备份 CLI（P0-1）。
 *
 * 用法：
 *   npm run backup                         # 热备到 ../karen-backups/YYYY-MM-DD/
 *   npm run backup -- --dest /path         # 指定备份根目录
 *   npm run backup -- --keep-days 30       # 保留 30 天（含当天）
 *   npm run backup -- --no-images          # 不备份 data/generated
 *   npm run backup -- --json               # 机器可读输出
 *   npm run backup:verify -- <备份日期目录> # 恢复前校验
 *   npm run backup:list                    # 列出已有备份
 *
 * 只读源库、不打印任何聊天内容；失败退出码 1。
 */
import "dotenv/config";
import path from "node:path";
import {
  DEFAULT_KEEP_DAYS,
  defaultDestination,
  formatBackupSummary,
  listBackupDays,
  runBackup,
  verifyBackupDir,
} from "../src/ops/backup.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function usage(): void {
  console.log(
    [
      "用法：",
      "  npm run backup [-- --dest <目录>] [--keep-days N] [--no-images] [--json]",
      "  npm run backup:verify -- <备份日期目录>",
      "  npm run backup:list",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const dataDir = path.resolve(argValue("data") ?? process.env.KAREN_DATA_DIR ?? "data");
  const destDir = path.resolve(
    argValue("dest") ?? process.env.KAREN_BACKUP_DIR ?? defaultDestination(dataDir),
  );

  if (process.argv.includes("--list")) {
    const days = await listBackupDays(destDir);
    if (days.length === 0) {
      console.log(`还没有备份：${destDir}`);
      return;
    }
    console.log(`备份目录：${destDir}`);
    for (const day of days) console.log(`  ${day}`);
    return;
  }

  const verifyIndex = process.argv.indexOf("--verify");
  if (verifyIndex >= 0) {
    const target = process.argv[verifyIndex + 1];
    if (!target || target.startsWith("--")) {
      console.error("缺少要校验的备份目录");
      usage();
      process.exitCode = 1;
      return;
    }
    const result = await verifyBackupDir(target);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const counts = Object.entries(result.counts)
        .map(([table, n]) => `${table}=${n}`)
        .join(" ");
      console.log(`备份目录：${result.dir}`);
      console.log(`日期：${result.day}  integrity=${result.dbIntegrity}  文件=${result.files}`);
      if (counts) console.log(`行数：${counts}`);
      for (const missing of result.missing) console.log(`缺失：${missing}`);
      for (const warning of result.warnings) console.log(`⚠️ ${warning}`);
      console.log(result.ok ? "校验通过，可以用于恢复。" : "校验未通过，不要用于恢复。");
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const keepDaysRaw = argValue("keep-days") ?? process.env.KAREN_BACKUP_KEEP_DAYS;
  const keepDays = keepDaysRaw ? Number(keepDaysRaw) : DEFAULT_KEEP_DAYS;
  if (!Number.isFinite(keepDays) || keepDays < 1) {
    console.error(`--keep-days 不合法：${keepDaysRaw}`);
    process.exitCode = 1;
    return;
  }

  const result = await runBackup({
    dataDir,
    destDir,
    keepDays,
    includeGenerated: !process.argv.includes("--no-images"),
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatBackupSummary(result)) console.log(line);
  }
  if (result.db.integrity !== "ok") process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`备份失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
