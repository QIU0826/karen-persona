#!/usr/bin/env tsx
/**
 * Karen Persona — Setup Wizard
 *
 * 设计原则：
 * - 不是"配置聊天机器人"，是"帮助用户遇见她"
 * - 人设选择用她的自述，不是功能卡片
 * - Setup 过程本身就是你们关系的第一段对话
 * - 收集的是故事起点，不是参数
 *
 * M0-2 行为：
 * - 数字输入严格校验（非法输入有清晰提示，不会静默取错编号）
 * - 询问并写入 QQ 桥接端口 / 白名单，完成后打印安全提示
 * - 已存在 config.yaml 时保留未知/扩展字段，只更新向导负责的键
 *
 * 用法: npm run setup
 */
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { listPersonas } from "./persona/loader.js";
import {
  parseAllowedUsers,
  DEFAULT_ONE_BOT_WS_HOST,
  DEFAULT_ONE_BOT_WS_PORT,
  DEFAULT_ONE_BOT_WS_PATH,
} from "./data/store.js";
import { buildConfigPatch, normalizeTagsInput, shouldSkipSetup } from "./setup/flow.js";
import { completeOnboarding, readOnboardingRecord } from "./setup/onboarding.js";

const CONFIG_PATH = path.resolve("config.yaml");
const DOTENV_PATH = path.resolve(".env");
const DOTENV_EXAMPLE_PATH = path.resolve(".env.example");
const PERSONAS_DIR = path.resolve("personas");

// ── 工具函数 ────────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadPersonaJson(personaId: string): Record<string, unknown> | null {
  const p = path.join(PERSONAS_DIR, personaId, "persona.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/**
 * 反复询问直到解析成功；连续 3 次非法则回退默认值。
 * parse 返回 null 表示非法输入。
 */
async function askValidated<T>(
  rl: readline.Interface,
  prompt: string,
  parse: (raw: string) => T | null,
  errorMessage: string,
  fallback: T,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask(rl, prompt);
    const parsed = parse(raw);
    if (parsed !== null) return parsed;
    console.log(`❌ ${errorMessage}`);
  }
  console.log(`⚠️  连续输入无效，使用默认值: ${JSON.stringify(fallback)}`);
  return fallback;
}

interface ExistingConfig {
  data: Record<string, unknown>;
  error: string | null;
}

function loadExistingConfig(): ExistingConfig {
  if (!fs.existsSync(CONFIG_PATH)) return { data: {}, error: null };
  try {
    const parsed = parseYaml(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (parsed === null || parsed === undefined) return { data: {}, error: null };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: {}, error: "顶层不是映射（key: value）" };
    }
    return { data: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return { data: {}, error: err instanceof Error ? err.message.split("\n")[0] : "未知 YAML 错误" };
  }
}

function existingPort(data: Record<string, unknown>): number {
  const value = data.one_bot_ws_port;
  const num = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : DEFAULT_ONE_BOT_WS_PORT;
}

function existingAllowedUsers(data: Record<string, unknown>): number[] {
  try {
    return parseAllowedUsers(data.allowed_users);
  } catch {
    return [];
  }
}

function existingString(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

// ── 主流程 ──────────────────────────────────────

async function main() {
  const force = process.argv.includes("--force");
  const onboarding = readOnboardingRecord();
  if (
    shouldSkipSetup({
      hasConfig: fs.existsSync(CONFIG_PATH),
      hasOnboarding: onboarding !== null,
      force,
    })
  ) {
    console.log("✅ 已经完成过首次引导（她记得你们的第一段对话）。");
    console.log("   重新配置请运行: npm run setup -- --force");
    console.log("   直接开始聊:   npm run dev（CLI） / npm run qq（QQ）");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("╔══════════════════════════════════════╗");
  console.log("║     欢迎来到 Karen Persona          ║");
  console.log("║     让通讯录里住进一个有自己生活的人  ║");
  console.log("╚══════════════════════════════════════╝\n");

  // ── Step 1: 选择你想遇见的人 ──
  const personas = listPersonas();
  if (personas.length === 0) {
    console.log("❌ 没有找到任何人设。请先在 personas/ 目录下创建人设文件夹。");
    console.log("参考: personas/xiaoya/ (如果你从模板创建)");
    rl.close();
    return;
  }

  console.log("首先，选择你想遇见谁：\n");

  const personaCards: { id: string; name: string; intro: string }[] = [];
  for (const id of personas) {
    const json = loadPersonaJson(id);
    if (!json) continue;
    const name = (json.name as string) ?? id;
    const career = (json as Record<string, unknown>).identity
      ? ((json as Record<string, unknown>).identity as Record<string, unknown>).lifeStory
        ? (((json as Record<string, unknown>).identity as Record<string, unknown>).lifeStory as Record<string, unknown>).career ?? ""
        : ""
      : "";
    const appearance = (json as Record<string, unknown>).identity
      ? ((json as Record<string, unknown>).identity as Record<string, unknown>).appearance
        ? ((json as Record<string, unknown>).identity as Record<string, unknown>).appearance as Record<string, string>
        : null
      : null;

    const intro = career
      ? `在${appearance?.hometown ?? "某个城市"}做${career}，${appearance?.style ?? "穿着随意"}`
      : "她的故事等你来了解";

    personaCards.push({ id, name, intro });
    console.log(`  [${personaCards.length}] ${name} — ${intro}`);
  }

  console.log();
  const selected = await askValidated<{ id: string; name: string; intro: string } | null>(
    rl,
    `选一个（1-${personaCards.length}）: `,
    (raw) => {
      if (!/^\d+$/.test(raw)) return null;
      const index = Number(raw) - 1;
      return index >= 0 && index < personaCards.length ? personaCards[index] : null;
    },
    `请输入 1-${personaCards.length} 之间的数字编号。`,
    null,
  );
  if (!selected) {
    console.log("已取消。");
    rl.close();
    return;
  }

  const herName = selected.name;
  const personaId = selected.id;

  console.log(`\n✨ 你选择了 ${herName}。\n`);

  // ── Step 2: 第一段对话 ──
  console.log("现在，让她来认识你。回答她的问题就好。\n");
  await sleep(600);

  // 她的第一问
  console.log(`\x1b[36m${herName}\x1b[0m: 嘿，你是从哪知道我的？`);
  const howWeMet = await ask(rl, "你: ");
  if (!howWeMet) {
    console.log(`${herName}: ...行吧，不想说就算了。就当是偶遇吧。`);
  }
  await sleep(400);

  // 她的第二问
  const defaultYourName = "你";
  console.log(`\n\x1b[36m${herName}\x1b[0m: 哦...他们叫我${herName}。那我该叫你什么？（直接回车就是"${defaultYourName}"）`);
  const yourNameInput = await ask(rl, "你: ");
  const yourName = yourNameInput || defaultYourName;
  console.log(`\x1b[36m${herName}\x1b[0m: ${yourName}，记住了。\n`);
  await sleep(400);

  // 她的第三问
  const json = loadPersonaJson(personaId);
  const defaultLocation = "上海";
  const hometow = json
    ? ((json as Record<string, unknown>).identity as Record<string, unknown>)?.lifeStory
      ? (((json as Record<string, unknown>).identity as Record<string, unknown>).lifeStory as Record<string, unknown>)?.hometown as string ?? defaultLocation
      : defaultLocation
    : defaultLocation;

  console.log(`\x1b[36m${herName}\x1b[0m: 我现在在${hometow}，你呢？`);
  const location = await ask(rl, "你: ");
  const userCity = location.trim();
  const finalLocation = userCity || defaultLocation;
  console.log(`\x1b[36m${herName}\x1b[0m: ${finalLocation}啊，知道了。\n`);
  await sleep(400);

  // ── Step 2.5: 知情确认（AI 披露 + 18+，写入 user_consent）──
  console.log("── 知情确认（首次使用一次）──");
  console.log("  1) 她是 AI 扮演的虚拟角色，不是真人；");
  console.log("  2) 对话与图片会发送给 AI 服务（DeepSeek）用于生成回复；");
  console.log("  3) 本服务面向 18 岁以上用户，未成年人请在监护人陪同下使用。");
  const ageAnswer = await ask(rl, "你已年满 18 岁吗？(y/N): ");
  const ageConfirmed = /^(y|yes|是|确认|1)$/i.test(ageAnswer.trim());
  if (!ageConfirmed) {
    console.log("\n本服务仅面向 18 岁以上用户，已停止设置。");
    rl.close();
    return;
  }
  const disclosureAnswer = await ask(rl, "确认已阅读以上说明并继续？(y/N): ");
  const disclosureAcked = /^(y|yes|是|确认|1)$/i.test(disclosureAnswer.trim());
  if (!disclosureAcked) {
    console.log("\n未确认知情说明，已停止设置（不会写入任何配置）。");
    rl.close();
    return;
  }

  // ── Step 3: 可选标签 ──
  console.log("── 可选：她的个性标签 ──");
  console.log("可选标签: 话痨 / 嘴硬心软 / 粘人 / 独立 / 浪漫主义 / 工作狂 / 闷骚");
  console.log("（多个标签用空格分隔，直接回车跳过）");
  const tagsInput = await ask(rl, "标签: ");
  const tags = normalizeTagsInput(tagsInput);

  if (tags.length > 0) {
    console.log(`\x1b[36m${herName}\x1b[0m: （看了眼标签）...行吧。\n`);
  }

  // ── Step 4: QQ 桥接配置（端口 / 白名单）──
  // 先读取已有 config.yaml：既能给端口/白名单提供默认值，
  // 也能在合并写回时保留用户手动添加的扩展字段。
  const existing = loadExistingConfig();
  let hadExistingConfig = fs.existsSync(CONFIG_PATH);

  if (existing.error) {
    if (hadExistingConfig) {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
      console.log(`⚠️  config.yaml 已存在但无法解析（${existing.error}）。`);
      console.log("   为避免覆盖丢失你的扩展字段，已备份为 config.yaml.bak，本次不写回。");
      console.log("   请手动修复 config.yaml 后重新运行 npm run setup。");
    }
    rl.close();
    return;
  }

  const defaultPort = existingPort(existing.data);
  const defaultAllowed = existingAllowedUsers(existing.data);
  const defaultAllowedText = defaultAllowed.join(",");
  const host = existingString(existing.data, "one_bot_ws_host", DEFAULT_ONE_BOT_WS_HOST);
  const wsPath = existingString(existing.data, "one_bot_ws_path", DEFAULT_ONE_BOT_WS_PATH);

  console.log("── QQ 桥接（可选，直接回车用默认值）──");
  const port = await askValidated<number>(
    rl,
    `NapCat 反向 WS 端口（默认 ${defaultPort}）: `,
    (raw) => {
      if (raw === "") return defaultPort;
      if (!/^\d+$/.test(raw)) return null;
      const num = Number(raw);
      return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null;
    },
    "端口必须是 1-65535 的整数，请重新输入。",
    defaultPort,
  );

  const allowedText = await askValidated<string>(
    rl,
    `允许和她聊天的 QQ 号（逗号分隔；留空 = 允许所有人${defaultAllowedText ? `，默认 ${defaultAllowedText}` : ""}）: `,
    (raw) => {
      const value = raw === "" ? defaultAllowedText : raw;
      try {
        parseAllowedUsers(value);
        return value;
      } catch {
        return null;
      }
    },
    "QQ 号格式不对（应为逗号分隔的 5-12 位数字），请重新输入。",
    defaultAllowedText,
  );
  const allowedUsers = parseAllowedUsers(allowedText);

  // ── Step 5: 生成 config.yaml（保留已有扩展字段）──
  const config = buildConfigPatch(existing.data, {
    personaId,
    herName,
    howWeMet,
    yourName,
    location: userCity,
    tags,
    allowedUsers,
    oneBotPort: port,
  });

  const header = [
    "# Karen Persona — 由 Setup Wizard 生成，可随时手动编辑",
    "# 向导会保留你手动添加的扩展字段；one_bot_* / allowed_users 见下方 QQ 桥接配置",
    "",
  ].join("\n");

  if (hadExistingConfig) {
    console.log(`⚠️  config.yaml 已存在，先备份为 config.yaml.bak`);
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  }

  fs.writeFileSync(CONFIG_PATH, header + stringifyYaml(config), "utf-8");
  console.log(`✅ config.yaml 已生成（保留已有扩展字段）\n`);

  console.log("── QQ 桥接安全提示 ──");
  console.log(`  反向 WS 地址: ws://${host}:${port}${wsPath}`);
  console.log(`  NapCat 配置: 网络配置 → 新建「WebSocket 客户端」→ 填入上面的地址`);
  if (config.one_bot_token) {
    console.log("  token 校验: 已配置 one_bot_token（NapCat 侧需填同样的 access_token）");
  } else {
    console.log(`  默认只监听 ${host}；如需跨机/对外暴露，请设置 ONE_BOT_TOKEN 或 config.yaml 的 one_bot_token。`);
  }
  if (allowedUsers.length === 0) {
    console.log("⚠️  allowed_users 为空：任何 QQ 号都能和她聊天。");
    console.log("   个人使用请编辑 config.yaml，把 allowed_users 改成你自己的 QQ 号。");
  } else {
    console.log(`✅ 白名单已写入 config.yaml：${allowedUsers.length} 个 QQ 号`);
  }
  console.log("  （config.yaml 的端口/白名单优先于 .env 中的同名变量）\n");

  // ── Step 6: API Key 引导 ──
  console.log("── API Key 配置 ──");

  let hasDotEnv = fs.existsSync(DOTENV_PATH);
  if (!hasDotEnv && fs.existsSync(DOTENV_EXAMPLE_PATH)) {
    console.log("📋 从 .env.example 创建 .env ...");
    fs.copyFileSync(DOTENV_EXAMPLE_PATH, DOTENV_PATH);
    hasDotEnv = true;
  }

  if (hasDotEnv) {
    const envContent = fs.readFileSync(DOTENV_PATH, "utf-8");
    const missing: string[] = [];

    // 检查必需的 API Key
    const requiredKeys = [
      { key: "DEEPSEEK_API_KEY", desc: "DeepSeek（必需 — 文字对话核心）" },
    ];
    const optionalKeys = [
      { key: "QWEN_VL_API_KEY", desc: "通义千问（仅语义嵌入，可选；图片识别已内置 DeepSeek）" },
      { key: "OPENWEATHER_API_KEY", desc: "OpenWeatherMap（天气感知）" },
      { key: "UNSPLASH_ACCESS_KEY", desc: "Unsplash（她给你发照片）" },
    ];

    for (const { key, desc } of requiredKeys) {
      const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (!match || match[1].trim() === "" || match[1].includes("your-key-here") || match[1].includes("sk-your-key-here")) {
        missing.push(`  ❌ ${key} — ${desc}`);
      } else {
        console.log(`  ✅ ${key}`);
      }
    }

    for (const { key, desc } of optionalKeys) {
      const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (!match || match[1].trim() === "" || match[1].includes("your-key-here")) {
        missing.push(`  ⚠️  ${key} — ${desc}（可选）`);
      } else {
        console.log(`  ✅ ${key}`);
      }
    }

    if (missing.length > 0) {
      console.log(`\n需要配置以下 API Key（编辑 .env 文件）：`);
      for (const m of missing) console.log(m);
      console.log(`\n没有 DeepSeek API Key？去 https://platform.deepseek.com 注册即可。`);
      console.log(`💡 配好 DEEPSEEK_API_KEY 后运行 npm run dev 就能开始聊天（离线模式不存在，必须先有 Key）。`);
    } else {
      console.log(`\n✅ 所有 API Key 已就绪`);
    }
  }

  // ── Step 7: 把第一段对话写进她的记忆（失败不阻塞启动）──
  try {
    const record = await completeOnboarding({
      personaId,
      herName,
      howWeMet,
      yourName,
      location: userCity,
      allowedUsers,
      ageConfirmed: true,
      disclosureAcked: true,
    });
    console.log(`✅ 她记住了你们的第一段对话${record.owners.length > 1 ? "（CLI 与 QQ 主用户都已写入）" : ""}。\n`);
  } catch (err) {
    console.warn(
      `⚠️  第一段对话写入记忆失败（不影响启动）：${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // ── Step 8: 完成 ──
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║           设置完成！                ║");
  console.log("╚══════════════════════════════════════╝\n");

  console.log(`📱 会话记录、记忆和日记都存在你的电脑上（对话与图片会发送给 DeepSeek；可选 Qwen 语义嵌入）。`);
  console.log(`👤 ${herName} 是一个有独立生活的人，不是你的助手。\n`);

  console.log(`启动方式:`);
  console.log(`  npm run dev       — 命令行和她聊天`);
  console.log(`  npm run qq        — QQ 桥接（需先启动 NapCatQQ）`);
  console.log(`  npm run setup -- --force — 重新设置（会重新走引导）\n`);

  console.log(`\x1b[36m${herName}\x1b[0m: 我先去忙了，你随时找我。\n`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
