#!/usr/bin/env tsx
/**
 * Karen Persona — 环境体检（doctor）
 *
 * 用法:
 *   npm run doctor
 *   # 或
 *   npx tsx src/doctor.ts
 *
 * 检查项（6 项）:
 *   1. Node.js 版本（要求 >= 22）
 *   2. config.yaml 是否存在且可解析
 *   3. DEEPSEEK_API_KEY 是否配置（以及可选 API 的配置情况）
 *   4. personas/ 及 config.yaml 指定的人设能否加载
 *   5. 数据目录是否可读写（尊重 KAREN_DATA_DIR）
 *   6. SQLite 数据库能否打开（T1/T2 表与 schema 是否正常）
 *
 * 输出 ✅ 通过 / ⚠️ 警告 / ❌ 失败 清单与修复建议；有失败项时进程退出码为 1。
 * 本脚本只做本机环境检查，不会调用任何模型 API。
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "./data/store.js";
import { listPersonas, loadPersona } from "./persona/loader.js";
import { dataDir, ensureDataDir, dbPath } from "./data/paths.js";

const REQUIRED_NODE_MAJOR = 22;
const TOTAL_CHECKS = 6;

type Status = "ok" | "warn" | "fail" | "skip";

interface CheckItem {
  status: Status;
  message: string;
  /** 修复建议（只对 warn / fail 有意义） */
  suggestions: string[];
}

const results: CheckItem[] = [];

const ICONS: Record<Status, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  skip: "➖",
};

function ok(message: string): CheckItem {
  return { status: "ok", message, suggestions: [] };
}

function warn(message: string, suggestions: string[] = []): CheckItem {
  return { status: "warn", message, suggestions };
}

function fail(message: string, suggestions: string[] = []): CheckItem {
  return { status: "fail", message, suggestions };
}

function printCheck(
  step: number,
  title: string,
  item: CheckItem,
  detailLines: string[] = []
): void {
  results.push(item);
  console.log(`[${step}/${TOTAL_CHECKS}] ${title}`);
  console.log(`  ${ICONS[item.status]} ${item.message}`);
  for (const suggestion of item.suggestions) {
    console.log(`     → 修复：${suggestion}`);
  }
  for (const line of detailLines) {
    console.log(`     ℹ️ ${line}`);
  }
  console.log();
}

/** 密钥脱敏：sk-abcdef...wxyz → sk-****wxyz */
function maskKey(key: string): string {
  const prefix = key.startsWith("sk-") ? "sk-" : key.slice(0, 2);
  const tail = key.slice(-4);
  return `${prefix}****${tail}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 1. Node.js 版本 */
function checkNode(): CheckItem {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);

  if (Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR) {
    return ok(`Node.js v${version}（要求 >= ${REQUIRED_NODE_MAJOR}）`);
  }

  return fail(`Node.js v${version} 版本过低（要求 >= ${REQUIRED_NODE_MAJOR}）`, [
    `升级到 Node.js ${REQUIRED_NODE_MAJOR} LTS：https://nodejs.org/`,
    "升级后删除 node_modules，重新执行 npm install",
  ]);
}

/** 2. config.yaml 是否存在且可解析 */
function checkConfig(): { item: CheckItem; config: AppConfig | null } {
  const configPath = path.resolve("config.yaml");

  if (!fs.existsSync(configPath)) {
    return {
      config: null,
      item: fail(`未找到 config.yaml（期望路径：${configPath}）`, [
        "cp config.yaml.example config.yaml",
        "按需修改 persona / your_name / location 字段",
        "重新运行 npm run doctor",
      ]),
    };
  }

  try {
    const config = loadConfig();
    return {
      config,
      item: ok(`config.yaml 可解析（默认人设：${config.persona}）`),
    };
  } catch (err) {
    return {
      config: null,
      item: fail(`config.yaml 解析失败：${errorMessage(err)}`, [
        "对照 config.yaml.example 检查 YAML 缩进与字段名",
        "确认没有使用 Tab 缩进（YAML 只允许空格）",
        "修复后重新运行 npm run doctor",
      ]),
    };
  }
}

/** 3. DEEPSEEK_API_KEY（以及可选 API Key 的配置情况） */
function checkApiKey(): CheckItem {
  const envPath = path.resolve(".env");
  const envExists = fs.existsSync(envPath);
  const key = process.env.DEEPSEEK_API_KEY?.trim();

  if (!key) {
    const suggestions: string[] = [];
    if (!envExists) suggestions.push("cp .env.example .env");
    suggestions.push(
      "在 .env 中填写 DEEPSEEK_API_KEY=sk-...（platform.deepseek.com → API Keys）",
      "如果使用自定义模型服务，同时确认 DEEPSEEK_BASE_URL 正确",
      "填好后重新运行 npm run doctor"
    );
    return fail(
      `未配置 DEEPSEEK_API_KEY${envExists ? "" : "（.env 文件也不存在）"}`,
      suggestions
    );
  }

  if (key === "sk-your-key-here" || key.includes("your-key")) {
    return fail("DEEPSEEK_API_KEY 仍是示例占位值，请替换为真实 Key", [
      "编辑 .env，把 DEEPSEEK_API_KEY 改成 platform.deepseek.com 申请的真实 Key",
      "填好后重新运行 npm run doctor",
    ]);
  }

  const source = envExists ? ".env 已加载" : "未找到 .env，使用系统环境变量";
  if (!key.startsWith("sk-")) {
    return warn(`已配置 DEEPSEEK_API_KEY（${maskKey(key)}，${source}；不以 sk- 开头）`, [
      "DeepSeek 官方 Key 通常以 sk- 开头；如果你配置了自定义 DEEPSEEK_BASE_URL，可忽略这条警告",
    ]);
  }

  return ok(`已配置 DEEPSEEK_API_KEY（${maskKey(key)}，${source}）`);
}

/** 3 的补充信息：可选 API 配置情况（不影响通过/失败，仅提示） */
function optionalKeysLine(): string {
  const optional: Array<[string, string]> = [
    ["QWEN_VL_API_KEY", "语义嵌入（可选）"],
    ["OPENWEATHER_API_KEY", "天气感知"],
    ["UNSPLASH_ACCESS_KEY", "主动发图"],
  ];

  const parts = optional.map(([envKey, label]) => {
    const configured = Boolean(process.env[envKey]?.trim());
    return `${label}${configured ? "已配置" : "未配置（功能关闭）"}`;
  });
  return `可选 API：${parts.join("；")}`;
}

/** 4. personas 与人设加载 */
async function checkPersonas(config: AppConfig | null): Promise<CheckItem> {
  const personasRoot = path.resolve("personas");

  if (!fs.existsSync(personasRoot)) {
    return fail(`personas/ 目录不存在（期望路径：${personasRoot}）`, [
      "从仓库重新获取 personas/ 目录（内置 xiaoya / suchi / qiuyao 三个人设）",
      "或运行 npm run setup 创建配置与人设",
    ]);
  }

  let personaIds: string[];
  try {
    personaIds = listPersonas();
  } catch (err) {
    return fail(`读取 personas/ 目录失败：${errorMessage(err)}`, [
      "检查 personas/ 目录权限",
    ]);
  }

  if (personaIds.length === 0) {
    return fail("personas/ 目录下没有任何人设", [
      "确认 personas/xiaoya、personas/suchi、personas/qiuyao 存在",
      "或运行 npm run persona:create 创建自定义人设",
    ]);
  }

  if (!config) {
    return warn(`跳过人设加载：config.yaml 未就绪（可用人设：${personaIds.join(", ")}）`, [
      "先修复 config.yaml 检查项，再确认 config.yaml 的 persona 字段是上面列出的人设之一",
    ]);
  }

  try {
    const persona = await loadPersona(config.persona);
    return ok(
      `人设加载成功：${persona.name}（${config.persona}）｜可用人设：${personaIds.join(", ")}`
    );
  } catch (err) {
    return fail(`人设 "${config.persona}" 加载失败：${errorMessage(err)}`, [
      `把 config.yaml 的 persona 字段改成可用人设之一：${personaIds.join(", ")}`,
      "如果是自建人设，运行 npm run persona:check <人设ID> 查看具体校验错误",
      "确认 personas/<人设ID>/persona.json 存在且是合法 JSON",
    ]);
  }
}

/** 5. 数据目录是否可读写 */
function checkDataDir(): CheckItem {
  const dir = dataDir();
  const overridden = Boolean(process.env.KAREN_DATA_DIR?.trim());
  const suffix = overridden ? "（来自 KAREN_DATA_DIR）" : "";

  try {
    ensureDataDir();
    const probe = path.join(dir, `.doctor-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return ok(`数据目录可读写：${dir}${suffix}`);
  } catch (err) {
    return fail(`数据目录不可用：${dir}${suffix} —— ${errorMessage(err)}`, [
      "检查目录权限：运行 Karen 的用户需要对 data/ 有读写权限",
      "可设置 KAREN_DATA_DIR 指向其他可写目录，例如 KAREN_DATA_DIR=/tmp/karen-data",
      "Windows 下不要把项目放在 Program Files 等受保护目录",
    ]);
  }
}

/** 6. SQLite 数据库能否打开、schema 是否正常 */
async function checkSqlite(): Promise<CheckItem> {
  const file = dbPath();

  try {
    // 动态导入：即使原生模块在当前 Node 版本下加载失败，也能给出友好提示而不是崩溃
    const { getVectorDb, closeVectorDb } = await import("./data/vector.js");
    const db = getVectorDb();

    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));
      const missing = ["t1_snapshots", "t2_episodes"].filter(
        (t) => !tableNames.has(t)
      );

      if (missing.length > 0) {
        return fail(`SQLite 已打开但缺少数据表：${missing.join(", ")}`, [
          "先备份 data/ 目录",
          "停止程序后删除 data/memory.sqlite（历史记忆会丢失），重新运行 doctor 会自动重建",
        ]);
      }

      const columns = db
        .prepare("PRAGMA table_info(t2_episodes)")
        .all() as Array<{ name: string }>;
      const hasEmbedding = columns.some((c) => c.name === "embedding");
      const schemaVersion =
        Number(db.pragma("user_version", { simple: true })) || 0;

      if (!hasEmbedding) {
        return fail(
          "数据库 schema 过旧：t2_episodes 缺少 embedding 列（旧版本遗留库）",
          [
            "先备份 data/ 目录（至少备份 data/memory.sqlite）",
            "升级到最新代码后重新运行 doctor，启动时会自动补列",
            "若仍失败：停止程序 → 备份后删除 data/memory.sqlite → 重新启动（历史记忆会丢失）",
          ]
        );
      }

      return ok(
        `SQLite 可打开且 schema 正常：${file}（user_version=${schemaVersion}，T1/T2 表与 embedding 列就绪）`
      );
    } finally {
      closeVectorDb();
    }
  } catch (err) {
    return fail(`SQLite 打开失败：${errorMessage(err)}`, [
      "确认 Node.js >= 22（better-sqlite3 的预编译包需要匹配 Node ABI）",
      "若提示 Cannot open database：先通过上面的「数据目录」检查项",
      "若提示原生模块加载失败：删除 node_modules 后重新执行 npm install",
      "若数据库文件损坏：备份 data/ 后删除 data/memory.sqlite 再重试（历史记忆会丢失）",
    ]);
  }
}

async function main(): Promise<void> {
  console.log("Karen Persona · 环境体检（doctor）");
  console.log("════════════════════════════════════════════");
  console.log(`工作目录：${process.cwd()}`);
  console.log(`运行时：Node.js v${process.versions.node}（${process.platform}/${process.arch}）`);
  console.log("────────────────────────────────────────────");
  console.log();

  printCheck(1, "Node.js 版本", checkNode());

  const configResult = checkConfig();
  printCheck(2, "配置文件 config.yaml", configResult.item);

  printCheck(3, "DeepSeek API Key", checkApiKey(), [optionalKeysLine()]);

  printCheck(4, "人设加载", await checkPersonas(configResult.config));

  printCheck(5, "数据目录", checkDataDir());

  printCheck(6, "SQLite 数据库", await checkSqlite());

  const passed = results.filter((r) => r.status === "ok").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  console.log("────────────────────────────────────────────");
  if (failed === 0) {
    console.log(
      `结果：✅ ${passed} 项通过` +
        (warnings > 0 ? `，⚠️ ${warnings} 项警告` : "") +
        "，❌ 0 项失败"
    );
    console.log("可以开始聊天了：npm run dev（CLI）或 npm run qq（QQ 桥接）");
  } else {
    console.log(
      `结果：❌ ${failed} 项失败（✅ ${passed} 项通过，⚠️ ${warnings} 项警告）`
    );
    console.log("请按上面的修复建议处理后重新运行：npm run doctor");
  }
  console.log("说明：doctor 只检查本机环境，不会调用任何模型 API。");

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("[doctor] 体检脚本异常退出：", errorMessage(err));
  process.exit(1);
});
