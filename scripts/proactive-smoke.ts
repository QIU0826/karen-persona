/**
 * 主动消息真实链路冒烟（会真实调用 DeepSeek，约 ¥0.001–0.003 一次）。
 *
 * 做的事：造一段「她 30 分钟前说完一句、对方没回」的临时会话，
 * 跑一次真实的 `processProactive`，检查：
 *  1. 决策是否走到 follow_up（而不是跳过）；
 *  2. 真实模型是否按"补一句"的姿态说话（不催、不问"在吗"、一条就够）；
 *  3. 消息门/渲染/落库是否正常。
 *
 * 全部数据写在临时目录（KAREN_DATA_DIR），不碰 data/。
 *
 * 运行：
 *   node node_modules/tsx/dist/cli.mjs scripts/proactive-smoke.ts            # 补一句（30 分钟没回）
 *   node node_modules/tsx/dist/cli.mjs scripts/proactive-smoke.ts open_topic # 冷场 4 小时
 *   node node_modules/tsx/dist/cli.mjs scripts/proactive-smoke.ts silence    # 失联 4 天
 *   node node_modules/tsx/dist/cli.mjs scripts/proactive-smoke.ts plan       # v0.8 意图式主动（今日由头）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-proactive-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  await import("dotenv/config");

  const { loadConfig } = await import("../src/data/store.js");
  const { loadPersona } = await import("../src/persona/loader.js");
  const { addMessage, saveSessionSync } = await import("../src/data/history.js");
  const { initConversation, processProactive, persistRuntimeState } =
    await import("../src/pipeline/orchestrator.js");

  const config = loadConfig();
  const persona = await loadPersona(config.persona);
  const state = await initConversation(persona, config, "cli:local");

  // 场景：默认「补一句」（30 分钟没回），可切冷场/失联
  const scenario = process.argv[2] ?? "follow_up";
  const herGapMs =
    scenario === "open_topic"
      ? 4 * 60 * 60 * 1000
      : scenario === "silence"
        ? 4 * 24 * 60 * 60 * 1000
        : 30 * 60 * 1000;

  // 造历史：对方先走开，她在 herGapMs 前说了最后一句，之后没人回
  const now = Date.now();
  state.session.messages.length = 0;
  addMessage(state.session, "user", "我先去开个会，晚点聊");
  state.session.messages[state.session.messages.length - 1].timestamp = now - herGapMs - 10 * 60 * 1000;
  addMessage(state.session, "assistant", "去吧，开完记得喝口水");
  state.session.messages[state.session.messages.length - 1].timestamp = now - herGapMs;
  saveSessionSync(state.session);
  persistRuntimeState(state);

  // v0.8 意图式主动：写一条「今天想跟他说的事」，让它成为优先级最高的由头
  if (scenario === "plan") {
    const { ensureMemoryV2Schema, saveInitiativePlan } = await import(
      "../src/data/memory-v2.js"
    );
    const { getVectorDb } = await import("../src/data/vector.js");
    const { serializePlan } = await import("../src/schedule/initiative-llm.js");
    const { localDayKey } = await import("../src/schedule/jobs.js");
    const db = getVectorDb();
    ensureMemoryV2Schema(db);
    const hour = new Date().getHours();
    const day = localDayKey(Date.now());
    saveInitiativePlan(db, {
      personaId: state.storagePersona,
      ownerId: state.owner,
      day,
      planJson: serializePlan({
        day,
        createdAt: Date.now(),
        items: [
          {
            topic: "下午被老板叫去谈话，到现在还有点闷",
            kind: "life_event",
            windowStart: Math.max(0, hour - 1),
            windowEnd: Math.min(23, hour + 3),
            urgency: 0.7,
            used: false,
          },
        ],
      }),
    });
    console.log("  [准备] 已写入今天的主动计划（1 条由头）");
  }

  console.log(`— 冒烟开始（场景=${scenario}，真实模型，临时目录）—`);
  console.log(`数据目录：${tmp}`);

  const result = await processProactive(state);
  for (const line of result.logs) console.log(`  ${line}`);

  if (!result.sent) {
    console.log(`结果：没有发送（${result.decision.detail}）`);
  } else {
    console.log(`结果：已发送（链路=${result.channel}）`);
    console.log("—— 她说的话 ——");
    console.log(result.reply);

    // ── 「像不像念稿」的确定性检查（不调用评审模型，省成本）──
    const reply = result.reply ?? "";
    const chars = Array.from(reply).length;
    const issues: string[] = [];
    if (/在吗|在不在|有空吗/.test(reply)) issues.push("用了「在吗/有空吗」这类空话开头");
    if (/^\s*[\[【(（]/.test(reply)) issues.push("以括号/动作描写开头（产品红线）");
    if (/作为(一个)?(AI|人工智能|语言模型)/.test(reply)) issues.push("出现 AI 身份措辞");
    if (chars > 60) issues.push(`太长（${chars} 字，主动消息应更短）`);
    if (chars < 4) issues.push(`太短（${chars} 字）`);
    if ((reply.match(/[？?]/g) ?? []).length > 1) issues.push("连续多个问句（像查岗）");
    // plan 场景：应该能看出"她自己的事"，而不是只问对方
    if (scenario === "plan" && !/(老板|谈话|闷|店里|今天|下午)/.test(reply)) {
      issues.push("plan 场景：话里看不出「她自己的事」（可能只问了对方）");
    }
    console.log(issues.length === 0 ? "  检查：✅ 不像念稿（短、不催、不问在吗、有自己的事）" : `  检查：⚠️ ${issues.join("；")}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

}

main().catch((err: unknown) => {
  console.error("[冒烟失败]", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
