#!/usr/bin/env tsx
/**
 * 人设包 v2 CLI
 *
 * 用法：
 *   tsx src/persona/pack-cli.ts validate <pack-dir>
 *   tsx src/persona/pack-cli.ts install <pack-dir> [--force] [--with-seeds]
 *   tsx src/persona/pack-cli.ts list
 *
 * npm 快捷方式：
 *   npm run persona:pack:validate -- <pack-dir>
 *   npm run persona:pack:install -- <pack-dir> --force
 *   npm run persona:pack:list
 *
 * 退出码：0 = 成功/校验通过；1 = 校验失败或参数错误；2 = 安装失败。
 */
import { CURRENT_SCHEMA_VERSION } from "./loader.js";
import {
  currentEngineVersion,
  installPersonaPack,
  listInstalledPacks,
  validatePersonaPack,
} from "./pack.js";

const HELP = `人设包 v2 CLI

用法:
  pack-cli validate <pack-dir>                 校验人设包（不写文件）
  pack-cli install <pack-dir> [--force] [--with-seeds]
                                               安装到 personas/<id>
                                               --force 覆盖并备份旧人设
                                               --with-seeds 把记忆种子写入 T2（默认不写）
  pack-cli list                                列出已安装人设（含 legacy）
`;

function printIssues(
  issues: Array<{ level: "error" | "warning"; message: string }>,
): void {
  for (const issue of issues) {
    const icon = issue.level === "error" ? "❌" : "⚠️ ";
    console.log(`  ${icon} ${issue.message}`);
  }
}

function cmdValidate(packDir: string): number {
  if (!packDir) {
    console.error("用法: pack-cli validate <pack-dir>");
    return 1;
  }
  const result = validatePersonaPack(packDir);
  console.log(`人设包校验：${packDir}`);
  if (result.manifest) {
    const m = result.manifest;
    console.log(`  id/version: ${m.id}@${m.version}`);
    console.log(`  展示名: ${m.name ?? result.personaName ?? "(未填)"}`);
    console.log(`  persona schema: ${m.personaSchemaVersion}（当前引擎支持 ${CURRENT_SCHEMA_VERSION}）`);
    console.log(`  素材: ${result.assets.count} 个 / ${(result.assets.totalBytes / 1024).toFixed(0)}KB`);
    console.log(`  记忆种子: ${result.seeds.length} 条`);
  }
  if (result.issues.length > 0) {
    printIssues(result.issues);
  } else {
    console.log("  （无问题）");
  }
  console.log(result.ok ? "\n✅ 校验通过" : "\n❌ 校验失败（存在 error 级问题）");
  return result.ok ? 0 : 1;
}

async function cmdInstall(args: string[]): Promise<number> {
  const packDir = args.find((arg) => !arg.startsWith("--"));
  if (!packDir) {
    console.error("用法: pack-cli install <pack-dir> [--force] [--with-seeds]");
    return 1;
  }
  const force = args.includes("--force");
  const withSeeds = args.includes("--with-seeds");
  const result = validatePersonaPack(packDir);
  if (!result.ok) {
    console.log("❌ 安装前校验失败：");
    printIssues(result.issues.filter((issue) => issue.level === "error"));
    return 1;
  }
  const manifest = result.manifest!;
  console.log(
    `安装 "${manifest.name ?? manifest.id}"@${manifest.version} 到 personas/${manifest.id} ...`,
  );
  if (result.assets.count > 0) console.log(`  素材 ${result.assets.count} 个`);
  if (result.seeds.length > 0) {
    console.log(
      `  记忆种子 ${result.seeds.length} 条（${withSeeds ? "将写入 T2" : "默认不写入，加 --with-seeds 才写"}）`,
    );
  }
  try {
    const installed = await installPersonaPack(packDir, { force, withSeeds });
    console.log(`\n✅ 已安装：${installed.installedPath}`);
    if (installed.backupPath) console.log(`   旧人设备份：${installed.backupPath}`);
    if (installed.seedsApplied > 0) console.log(`   已写入记忆种子 ${installed.seedsApplied} 条`);
    console.log(
      `   使用它：config.yaml 的 persona 改为 "${manifest.id}"，或 setup 时选择它（需重启 bridge）`,
    );
    return 0;
  } catch (err) {
    console.error(`❌ 安装失败：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function cmdList(): number {
  const packs = listInstalledPacks();
  if (packs.length === 0) {
    console.log("personas/ 下没有已安装人设");
    return 0;
  }
  console.log(`已安装人设（${packs.length}）:`);
  for (const pack of packs) {
    if (pack.manifest) {
      const m = pack.manifest;
      console.log(
        `  ${m.id}@${m.version}  ${m.name ?? ""}  ${m.author ? `by ${m.author}` : ""}  ${m.license ?? ""}`.trimEnd(),
      );
    } else {
      console.log(`  ${pack.id}  (legacy：无 manifest.json)`);
    }
  }
  console.log(`\n引擎版本：${currentEngineVersion()}（persona schema ${CURRENT_SCHEMA_VERSION}）`);
  return 0;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "-h" || command === "--help") {
    console.log(HELP);
    return;
  }
  if (command === "validate") {
    process.exitCode = cmdValidate(args[0] ?? "");
    return;
  }
  if (command === "install") {
    process.exitCode = await cmdInstall(args);
    return;
  }
  if (command === "list") {
    process.exitCode = cmdList();
    return;
  }
  console.error(`未知命令: ${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("pack-cli 失败:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
