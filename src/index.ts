import "dotenv/config";
import { loadConfig } from "./data/store.js";
import { createBot } from "./bridge/wechaty.js";
import { loadPersona } from "./persona/loader.js";

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  微信 AI 虚拟人设聊天系统 v0.2.0    ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  console.log(`[启动] 加载人设: ${config.her_name}`);
  console.log(`[启动] 地理位置: ${config.location}`);
  console.log(`[启动] 个性标签: ${config.tags.join(", ")}`);

  const persona = await loadPersona(config.persona);
  console.log(`[启动] 人设 "${persona.name}" 加载完成`);
  console.log(`[启动] 身份: ${persona.identity.age}岁, ${persona.identity.lifeStory.career}`);
  console.log(`[启动] 依恋类型: ${persona.emotions.attachmentStyle}`);

  const bot = createBot(persona, config);
  console.log("\n[启动] 正在启动微信桥接...");
  console.log("[启动] 请扫描终端中的二维码登录微信小号\n");

  await bot.start();
}

main().catch((err) => {
  console.error("[致命错误]", err);
  process.exit(1);
});
