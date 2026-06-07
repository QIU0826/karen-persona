/**
 * CLI 对话测试 — 调用共享管线 orchestrator
 * 启动方式: npm run dev
 */
import "dotenv/config";
import { loadPersona } from "./persona/loader.js";
import { loadConfig, setLogLevel } from "./data/store.js";
import { getVectorDb, applyGlobalDecay, archiveDecayedEpisodes, closeVectorDb } from "./data/vector.js";
import { mockWeather, perceiveWeather } from "./world/weather.js";
import { adjustEmotion } from "./persona/emotion.js";
import {
  initConversation,
  processMessage,
  getStateSummary,
} from "./pipeline/orchestrator.js";
import readline from "node:readline";

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Karen — CLI 对话测试              ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  setLogLevel(config.log_level);
  const persona = await loadPersona(config.persona);

  console.log(`[启动] ${persona.name} (${persona.identity.lifeStory.career})`);
  console.log(`[启动] 依恋: ${persona.emotions.attachmentStyle} | 亲密度: ${persona.relationship.closeness}/10`);
  if (config.tags.length > 0) console.log(`[启动] 标签: ${config.tags.join(", ")}`);

  // 记忆衰减
  getVectorDb();
  const decayed = applyGlobalDecay();
  const archived = archiveDecayedEpisodes();
  if (decayed > 0 || archived > 0) {
    console.log(`[记忆] 衰减: ${decayed} | 归档: ${archived}`);
  }

  // 初始化会话状态（含天气感知）
  const state = await initConversation(persona, config);
  const wp = state.weatherPerception;
  console.log(`[天气] ${wp.raw.city}: ${wp.raw.description} ${wp.raw.temp}°C`);
  console.log(`[天气] ${wp.personalInterpretation}`);
  if (wp.socialInterpretation) console.log(`[天气] ${wp.socialInterpretation}`);

  // 检查 API
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === "sk-your-key-here") {
    console.log("[错误] 未设置 DEEPSEEK_API_KEY\n");
    console.log("复制 .env.example 为 .env 并填入你的 API Key");
    return;
  }

  if (!process.stdin.isTTY) {
    console.log("[提示] 当前环境不支持交互模式。请在终端中运行：");
    console.log("  cd karen-persona && npm run dev\n");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("══════════════════════════════════════");
  console.log(`  和 ${persona.name} 聊天`);
  console.log("  /quit 退出  /stats 统计  /mood +0.1 调节情绪  /weather 天气");
  console.log("══════════════════════════════════════\n");

  // ── 聊天主循环 ──────────────────────────
  let running = true;
  while (running) {
    const input = await new Promise<string>(resolve => {
      rl.question(`${config.your_name}: `, resolve);
    });

    if (!input) continue;

    if (input === "/quit") {
      console.log(`\n${persona.name}: 拜拜～`);
      console.log(`[会话] 已保存 ${state.session.messages.length} 条消息`);
      closeVectorDb();
      running = false;
      continue;
    }

    if (input === "/stats") {
      const summary = getStateSummary(state);
      console.log(`\n--- ${persona.name} 状态 ---`);
      for (const line of summary) console.log(`  ${line}`);
      console.log();
      continue;
    }

    if (input.startsWith("/mood")) {
      const delta = parseFloat(input.split(" ")[1]) || 0;
      if (delta !== 0) {
        Object.assign(state.emotionState, adjustEmotion(state.emotionState, delta, "用户手动调节"));
      }
      console.log(`[情绪] 当前: ${state.emotionState.vector.toFixed(2)} (${state.emotionState.arousal.toFixed(2)} arousal)\n`);
      continue;
    }

    if (input === "/weather") {
      const w = mockWeather(config.location);
      const wp = perceiveWeather(w, state.stance.weather, state.emotionState.baseline, null);
      console.log(`\n[天气] ${w.city}: ${w.description} ${w.temp}°C 湿度${w.humidity}%`);
      console.log(`[觉察] ${wp.awarenessMoment}`);
      console.log(`[心情] ${wp.personalInterpretation}`);
      if (wp.socialInterpretation) console.log(`[社交] ${wp.socialInterpretation}`);
      console.log();
      continue;
    }

    try {
      const result = await processMessage(state, input);

      for (const log of result.logs) console.log(log);

      if (result.reply) {
        const lines = result.reply.split("\n").filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 400 + Math.random() * 800));
          console.log(`${persona.name}: ${lines[i].trim()}`);
        }
      }

      if (result.imageUrl) {
        console.log(`\n📷 [${persona.name} 分享了一张图] ${result.imageCaption ?? ""}`);
        console.log(`   ${result.imageUrl}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.log(`\n[错误] ${msg}`);
    }

    console.log();
  }

  rl.close();
}

main().catch((err) => {
  console.error("[致命错误]", err instanceof Error ? err.message : err);
  process.exit(1);
});
