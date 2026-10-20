/**
 * CLI 对话测试 — 调用共享管线 orchestrator
 * 启动方式: npm run dev
 */
import "dotenv/config";
import { loadPersona } from "./persona/loader.js";
import { loadConfig, setLogLevel } from "./data/store.js";
import { getVectorDb, applyGlobalDecay, archiveDecayedEpisodes, closeVectorDb } from "./data/vector.js";
import {
  loadPersonaState,
  type PersistedHerView,
  type PersistedPersonaState,
} from "./data/state-store.js";
import {
  getJournalEntries,
  formatJournal,
  formatRelationshipTimeline,
  formatHerView,
  formatEvolutionSummary,
} from "./evolution/journal-view.js";
import { mockWeather, perceiveWeather } from "./world/weather.js";
import { adjustEmotion } from "./persona/emotion.js";
import { closenessLabel } from "./persona/relationship.js";
import {
  initConversation,
  processMessage,
  persistRuntimeState,
} from "./pipeline/orchestrator.js";
import { handleControlCommand } from "./commands/control.js";
import { exportUserData } from "./data/user-export.js";
import { buildFirstContactDisclosure } from "./persona/disclosure.js";
import { OWNER_CLI } from "./data/owner.js";
import readline from "node:readline";

/** 打印一轮结果（即时回复与延迟补回复共用） */
function printResult(
  personaName: string,
  result: {
    reply: string;
    logs: string[];
    imageUrl?: string;
    imageCaption?: string;
    silenced?: boolean;
    safetyMessage?: string;
  },
): void {
  for (const log of result.logs) console.log(log);

  if (!result.reply) {
    if (result.silenced) console.log("（她这次没回——也可能只是去忙别的了）");
    return;
  }

  const lines = result.reply.split("\n").filter(Boolean);
  for (const line of lines) {
    console.log(`${personaName}: ${line.trim()}`);
  }
  if (result.imageUrl) {
    console.log(`\n📷 [${personaName} 分享了一张图] ${result.imageCaption ?? ""}`);
    console.log(`   ${result.imageUrl}`);
  }
}

/** 门控判定「晚点回」：到点后用 bypassGate 补一次回复，不重复保存用户消息 */
function scheduleDelayedReply(
  state: Awaited<ReturnType<typeof initConversation>>,
  input: string,
  delayMs: number,
  personaName: string,
): void {
  const wait = Math.max(1_000, Math.min(delayMs, 12 * 60 * 60 * 1000));
  const seconds = Math.round(wait / 1000);
  console.log(`[她晚点回] 大约 ${seconds}s 后补回复（期间可以继续输入）`);
  const timer = setTimeout(async () => {
    try {
      const result = await processMessage(state, input, {
        bypassGate: true,
        skipUserPersist: true,
      });
      console.log(`\n[补回复] 距离上次消息 ${seconds}s`);
      printResult(personaName, result);
    } catch (err: unknown) {
      console.log(`[补回复失败] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, wait);
  timer.unref?.();
}

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Karen — CLI 对话测试              ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = loadConfig();
  setLogLevel(config.log_level);
  const persona = await loadPersona(config.persona);

  console.log(`[启动] ${persona.name} (${persona.identity.lifeStory.career})`);
  console.log(`[启动] 依恋: ${persona.emotions.attachmentStyle}`);
  if (config.tags.length > 0) console.log(`[启动] 标签: ${config.tags.join(", ")}`);

  // 记忆衰减
  getVectorDb();
  const decayed = applyGlobalDecay();
  const archived = archiveDecayedEpisodes();
  if (decayed > 0 || archived > 0) {
    console.log(`[记忆] 衰减: ${decayed} | 归档: ${archived}`);
  }

  // 初始化会话状态（含天气感知 + 持久化的关系/情绪状态）
  const state = await initConversation(persona, config, OWNER_CLI);
  console.log(
    `[启动] 关系: ${state.relationshipState.closeness.toFixed(2)}/10（${closenessLabel(state.relationshipState.closeness)}）` +
      ` | 连续互动 ${state.relationshipState.interactionStreak} 天`,
  );
  const wp = state.weatherPerception;
  console.log(`[天气] ${wp.raw.city}: ${wp.raw.description} ${wp.raw.temp}°C`);
  console.log(`[天气] ${wp.personalInterpretation}`);
  if (wp.socialInterpretation) console.log(`[天气] ${wp.socialInterpretation}`);

  /** 读取最近一次落盘的人格状态（重启/多进程后也能看到最新演化）；失败不影响对话 */
  function readPersistedState(): PersistedPersonaState | null {
    try {
      return loadPersonaState(
        state.persona.name,
        state.persona.relationship.closeness,
        state.storageKey,
      );
    } catch (err: unknown) {
      console.log(`[状态] 读取失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 命令可选条数参数（默认 20，限制 1-50） */
  function parseEntryLimit(input: string, fallback: number): number {
    const raw = input.trim().split(/\s+/)[1];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(50, parsed));
  }

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
  if (config.ai_disclosure) {
    console.log(buildFirstContactDisclosure());
    console.log("──────────────────────────────────────");
  }
  console.log(`  和 ${persona.name} 聊天`);
  console.log("  /quit 退出  /stats 统计  /why 解释上一轮  /pause 暂停主动消息  /resume 恢复");
  console.log("  /export 导出记忆  /mood +0.1 调节情绪  /weather 天气");
  console.log("  /journal 她的日记  /timeline 关系时间线  /herview 她眼中的你  /evolution 她的变化");
  console.log("══════════════════════════════════════\n");

  // ── 聊天主循环 ──────────────────────────
  let running = true;
  while (running) {
    const input = await new Promise<string>(resolve => {
      rl.question(`${config.your_name}: `, resolve);
    });

    if (!input) continue;
    const cmd = input.trim();
    if (!cmd) continue;

    if (cmd === "/quit") {
      console.log(`\n${persona.name}: 拜拜～`);
      console.log(`[会话] 已保存 ${state.session.messages.length} 条消息`);
      closeVectorDb();
      running = false;
      continue;
    }

    if (cmd.startsWith("/")) {
      const handled = await handleControlCommand(cmd, state, {
        reply: (text) => console.log(`\n${text}\n`),
        persist: () => persistRuntimeState(state),
        exportData: () =>
          exportUserData({
            personaName: persona.name,
            storagePersona: state.storagePersona,
            storageKey: state.storageKey,
            session: state.session,
            initialCloseness: state.persona.relationship.closeness,
          }),
      });
      if (handled) continue;
      // 未识别指令继续走下面原有命令（/mood /weather /journal…）
    }

    if (cmd.startsWith("/mood")) {
      const delta = parseFloat(cmd.split(" ")[1]) || 0;
      if (delta !== 0) {
        Object.assign(state.emotionState, adjustEmotion(state.emotionState, delta, "用户手动调节"));
      }
      console.log(`[情绪] 当前: ${state.emotionState.vector.toFixed(2)} (${state.emotionState.arousal.toFixed(2)} arousal)\n`);
      continue;
    }

    if (cmd === "/weather") {
      const w = mockWeather(config.location);
      const wp = perceiveWeather(w, state.stance.weather, state.emotionState.baseline, null);
      console.log(`\n[天气] ${w.city}: ${w.description} ${w.temp}°C 湿度${w.humidity}%`);
      console.log(`[觉察] ${wp.awarenessMoment}`);
      console.log(`[心情] ${wp.personalInterpretation}`);
      if (wp.socialInterpretation) console.log(`[社交] ${wp.socialInterpretation}`);
      console.log();
      continue;
    }

    // ── M1-3 演化可见化命令 ──────────────
    if (cmd === "/journal" || cmd.startsWith("/journal ")) {
      try {
        const entries = getJournalEntries(parseEntryLimit(cmd, 20));
        for (const line of formatJournal(entries)) console.log(line);
      } catch (err: unknown) {
        console.log(`[日记] 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
      console.log();
      continue;
    }

    if (cmd === "/timeline") {
      const persisted = readPersistedState();
      const relationship = persisted?.relationship ?? state.relationshipState;
      for (const line of formatRelationshipTimeline(relationship)) console.log(line);
      console.log();
      continue;
    }

    if (cmd === "/herview") {
      const persisted = readPersistedState();
      const fallbackView: PersistedHerView = {
        current: state.herViewOfYou ?? persona.relationship.herViewOfYou ?? null,
        previous: state.previousViewOfYou,
        lastUpdateCloseness: state.lastViewUpdateCloseness,
        lastUpdateAt: state.lastViewUpdateAt,
      };
      const view: PersistedHerView = persisted
        ? {
            current: persisted.herView.current ?? fallbackView.current,
            previous: persisted.herView.previous ?? fallbackView.previous,
            lastUpdateCloseness: persisted.herView.lastUpdateCloseness,
            lastUpdateAt: persisted.herView.lastUpdateAt,
          }
        : fallbackView;
      for (const line of formatHerView(view)) console.log(line);
      console.log();
      continue;
    }

    if (cmd === "/evolution") {
      const persisted = readPersistedState();
      for (const line of formatEvolutionSummary({
        drift: persisted?.drift ?? state.driftState,
        narrativeArc: persisted?.narrativeArc ?? state.narrativeArc,
        relationship: persisted?.relationship ?? state.relationshipState,
        emotion: persisted?.emotion ?? state.emotionState,
      })) {
        console.log(line);
      }
      console.log();
      continue;
    }

    try {
      const result = await processMessage(state, input);

      if (result.deferred) {
        printResult(persona.name, result);
        scheduleDelayedReply(state, input, result.deferred.delayMs, persona.name);
      } else {
        printResult(persona.name, result);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.log(`\n[错误] ${msg}`);
    }

    console.log();
  }

  rl.close();
  closeVectorDb();
}

process.on("SIGINT", () => {
  console.log("\n[退出] 正在清理...");
  closeVectorDb();
  process.exit(0);
});

main().catch((err) => {
  console.error("[致命错误]", err instanceof Error ? err.message : err);
  process.exit(1);
});
