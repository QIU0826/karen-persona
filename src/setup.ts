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
 * 用法: npm run setup
 */
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { listPersonas } from "./persona/loader.js";

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

// ── 主流程 ──────────────────────────────────────

async function main() {
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
  const choiceStr = await ask(rl, `选一个（1-${personaCards.length}）: `);
  const choiceIdx = parseInt(choiceStr, 10) - 1;
  if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= personaCards.length) {
    console.log("无效选择。");
    rl.close();
    return;
  }

  const selected = personaCards[choiceIdx];
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
  const finalLocation = location || defaultLocation;
  console.log(`\x1b[36m${herName}\x1b[0m: ${finalLocation}啊，知道了。\n`);
  await sleep(400);

  // ── Step 3: 可选标签 ──
  console.log("── 可选：她的个性标签 ──");
  console.log("可选标签: 话痨 / 嘴硬心软 / 粘人 / 独立 / 浪漫主义 / 工作狂 / 闷骚");
  console.log("（多个标签用空格分隔，直接回车跳过）");
  const tagsInput = await ask(rl, "标签: ");
  const tags = tagsInput ? tagsInput.split(/\s+/).filter(Boolean) : [];

  if (tags.length > 0) {
    console.log(`\x1b[36m${herName}\x1b[0m: （看了眼标签）...行吧。\n`);
  }

  // ── Step 4: 生成 config.yaml ──
  const configLines = [
    `# Karen Persona — 由 Setup Wizard 生成`,
    `# 可以随时手动编辑此文件`,
    ``,
    `persona: "${personaId}"`,
    `her_name: "${herName}"`,
    `your_name: "${yourName}"`,
    `location: "${finalLocation}"`,
  ];
  if (tags.length > 0) {
    configLines.push(`tags: [${tags.map((t) => `"${t}"`).join(", ")}]`);
  } else {
    configLines.push(`tags: []`);
  }

  const configContent = configLines.join("\n") + "\n";

  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`⚠️  config.yaml 已存在，备份为 config.yaml.bak`);
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  }

  fs.writeFileSync(CONFIG_PATH, configContent, "utf-8");
  console.log(`✅ config.yaml 已生成\n`);

  // ── Step 5: API Key 引导 ──
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
      { key: "QWEN_VL_API_KEY", desc: "Qwen-VL（图片识别）" },
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
      console.log(`💡 只想先聊聊看？运行 npm run setup:minimal 使用离线模式。`);
    } else {
      console.log(`\n✅ 所有 API Key 已就绪`);
    }
  }

  // ── Step 6: 完成 ──
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║           设置完成！                ║");
  console.log("╚══════════════════════════════════════╝\n");

  console.log(`📱 所有记忆和日记都存在你的电脑上，不会上传。`);
  console.log(`👤 ${herName} 是一个有独立生活的人，不是你的助手。\n`);

  console.log(`启动方式:`);
  console.log(`  npm run dev       — 命令行和她聊天`);
  console.log(`  npm run qq        — QQ 桥接（需先启动 NapCatQQ）`);
  console.log(`  npm run setup     — 重新设置\n`);

  console.log(`\x1b[36m${herName}\x1b[0m: 我先去忙了，你随时找我。\n`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
