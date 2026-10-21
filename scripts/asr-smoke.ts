#!/usr/bin/env node
/**
 * 语音识别真实链路冒烟（v0.23）。
 *
 * 验证「她发语音的逆过程」：文本 → TTS(SILK) → silk-wasm 解码 → WAV → ASR → 文本，
 * 以及纯 WAV 路径、未启用/服务不可用时的降级。
 *
 * 用法：
 *   npm run asr:start            # 先起服务
 *   KAREN_ASR=on npm run asr:smoke
 *
 * 退出码：0=通过；1=链路坏了；2=服务/模型未就绪（明确区分）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE_URL = process.env.KAREN_ASR_URL?.trim() || "http://127.0.0.1:18085";

async function main(): Promise<number> {
  process.env.KAREN_ASR = "on";
  process.env.KAREN_ASR_URL = SERVICE_URL;

  console.log("— 语音识别真实链路冒烟 —");
  console.log(`服务：${SERVICE_URL}`);

  let health: { ok?: boolean; loaded?: boolean; model?: string } = {};
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    health = (await res.json()) as typeof health;
  } catch {
    console.log("  ✗ ASR 服务不可达（先启动：npm run asr:start）");
    return 2;
  }
  console.log(`  /health：loaded=${health.loaded} model=${health.model ?? "?"}`);
  if (!health.loaded) console.log("  （首次请求会自动加载模型）");

  const { transcribeVoice, isAsrEnabled } = await import("../src/ai/asr.js");
  const { synthesizeSpeech } = await import("../src/ai/tts.js");
  const failures: string[] = [];

  if (!isAsrEnabled()) failures.push("KAREN_ASR=on 没生效（isAsrEnabled 返回 false）");

  // 1) 文本 → TTS SILK → ASR → 文本（完整往返）
  const target = "今天天气不错，我们晚上一起去吃饭吧";
  const speech = await synthesizeSpeech(target, { styleEnabled: false });
  if (!speech) {
    failures.push("TTS 合成失败（需要 macOS say）");
  } else {
    const silkBytes = Buffer.from(speech.silkBase64, "base64");
    console.log(`  TTS：${silkBytes.length} 字节 SILK，${speech.durationMs}ms`);
    const result = await transcribeVoice(silkBytes);
    console.log(
      `  SILK→ASR：${result.ok ? `${result.elapsedMs}ms「${result.text}」` : `失败(${result.reason})`}`,
    );
    if (!result.ok) failures.push(`SILK 路径识别失败（${result.reason}）`);
    else {
      const hits = ["天气", "吃饭", "晚上"].filter((word) => result.text!.includes(word));
      if (hits.length < 2) failures.push(`识别结果偏差太大：「${result.text}」（期望含天气/晚上/吃饭）`);
    }
  }

  // 2) 纯 WAV 路径（跳过 SILK 解码）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-asr-smoke-"));
  try {
    const { execFileSync } = await import("node:child_process");
    const wav = path.join(tmp, "speech.wav");
    execFileSync("say", ["-v", "Tingting", "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", "明天下午三点开会"]);
    const wavBytes = fs.readFileSync(wav);
    const result = await transcribeVoice(wavBytes);
    console.log(`  WAV→ASR：${result.ok ? `${result.elapsedMs}ms「${result.text}」` : `失败(${result.reason})`}`);
    if (!result.ok) failures.push(`WAV 路径识别失败（${result.reason}）`);
    else if (!result.text!.includes("开会") && !result.text!.includes("三点")) {
      failures.push(`WAV 识别结果偏差：「${result.text}」`);
    }
  } catch (err) {
    failures.push(`WAV 路径准备失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3) 降级：不支持格式 → 失败但不抛异常
  const bad = await transcribeVoice(Buffer.from("not-an-audio"));
  console.log(`  不支持格式：${bad.ok ? "⚠️ 竟然成功了" : `✅ ${bad.reason}`}`);
  if (bad.ok) failures.push("垃圾字节应当识别失败");

  // 4) 关闭开关 → disabled
  process.env.KAREN_ASR = "off";
  const off = await transcribeVoice(Buffer.alloc(100));
  if (off.ok || off.reason !== "disabled") failures.push(`关闭开关后应返回 disabled（实际 ${off.reason}）`);

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log("  ✅ 全部通过：SILK→WAV→ASR 往返正确 / WAV 直通 / 垃圾输入降级 / 开关生效");
    return 0;
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[ASR 冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
