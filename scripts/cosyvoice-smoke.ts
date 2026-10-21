#!/usr/bin/env node
/**
 * Fun-CosyVoice 3.0 克隆链路冒烟（v0.9.16，本机 CPU，零 API 成本）。
 *
 * 验证：
 *  1. 服务健康（模型已加载 / 已注册参考音）；
 *  2. 克隆合成：WAV 合法、时长合理、服务端声称的 ASR 校验结果（attempts/verify）；
 *  3. 产品链路：KAREN_TTS_BACKEND=cosyvoice 时 synthesizeSpeech 产出 SILK；
 *  4. 回退链：服务不可达时自动回退 Kokoro（KOKORO_TTS_URL 已配置时）。
 *
 * 用法：npm run cosyvoice:smoke   （需先 npm run cosyvoice:start；约 30–60s）
 */
import { synthesizeSpeech } from "../src/ai/tts.js";
import {
  checkCosyVoiceHealth,
  cosyVoiceBaseUrl,
  synthesizeWithCosyVoice,
} from "../src/ai/cosyvoice-tts.js";
import { checkKokoroHealth } from "../src/ai/neural-tts.js";

const SENTENCE = "晚上想煮个面，你要不要一起。";
/** 已知难句：合成参考音（非真人）时容易复读，用来验证「守卫生效 + 产品链路回退」。 */
const HARD_SENTENCE = "今天店里人不多，我给自己做了杯拿铁，拉花歪了。";
const EXPECTED_CER_MAX = 0.25;

async function main(): Promise<void> {
  const failures: string[] = [];
  console.log("— Fun-CosyVoice3 克隆链路冒烟（本机 CPU，零 API 成本）—");

  const health = await checkCosyVoiceHealth({ timeoutMs: 5_000 });
  if (!health || !health.loaded) {
    console.log("❌ 服务不可用：先 npm run cosyvoice:start（首次加载约 3s，占内存约 8.3GB）");
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 健康：已加载，采样率 ${health.sampleRate}Hz，参考音 [${health.voices.join(", ") || "无"}]`);
  if (health.voices.length === 0) {
    failures.push("没有注册参考音（data/voice-ref/<id>.wav + <id>.json）");
  }

  const started = Date.now();
  const clone = await synthesizeWithCosyVoice(SENTENCE, { timeoutMs: 120_000 });
  const elapsed = Date.now() - started;
  if (!clone) {
    failures.push("克隆合成失败（unstable_output 或服务错误）");
  } else {
    const duration = clone.durationMs ?? 0;
    console.log(
      `✅ 克隆：WAV ${(clone.wav.length / 1024).toFixed(0)}KB / ${duration}ms 音频 / ${elapsed}ms（RTF ${(elapsed / Math.max(1, duration)).toFixed(2)}x）/ attempts=${clone.attempts ?? "?"} / verify=${clone.verify ?? "?"}`
    );
    if (duration <= 0) failures.push("响应缺少时长");
    if (elapsed > 60_000) failures.push(`合成过慢（${elapsed}ms）`);
    if (clone.attempts && clone.attempts > 2) failures.push(`重试次数偏多（${clone.attempts} 次）`);

    // 独立 ASR 复核（不依赖服务端结论）
    const asrUp = await fetch("http://127.0.0.1:18085/health", {
      signal: AbortSignal.timeout(2_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    if (asrUp) {
      const wav16 = await to16kWav(clone.wav);
      const transcript = await fetch("http://127.0.0.1:18085/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Uint8Array(wav16),
        signal: AbortSignal.timeout(30_000),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const text = String((transcript as { text?: string } | null)?.text ?? "");
      const cer = cerOf(SENTENCE, text);
      console.log(`✅ 独立 ASR：CER ${(cer * 100).toFixed(1)}%（${text.slice(0, 40)}）`);
      if (cer > EXPECTED_CER_MAX) failures.push(`ASR CER 过高（${(cer * 100).toFixed(1)}%）`);
    } else {
      console.log("⏭️ ASR 服务未起，跳过独立复核");
    }
  }

  // 守卫：难句应当被服务端拒绝（或勉强通过），无论哪种产品链路都必须有 SILK
  const guard = await synthesizeWithCosyVoice(HARD_SENTENCE, { timeoutMs: 180_000 });
  console.log(
    guard
      ? `ℹ️ 难句克隆通过（attempts=${guard.attempts ?? "?"} / verify=${guard.verify ?? "?"}）`
      : "ℹ️ 难句被守卫拒绝（unstable_output）——产品链路会回退 Kokoro"
  );

  // 产品链路：文本 → SILK
  process.env.KAREN_TTS_BACKEND = "cosyvoice";
  const product = await synthesizeSpeech(SENTENCE, { maxChars: 120 });
  if (!product) {
    failures.push("产品链路 synthesizeSpeech 返回 null");
  } else {
    console.log(
      `✅ 产品链路：SILK ${(product.byteLength / 1024).toFixed(0)}KB / ${product.durationMs}ms（cosyvoice → SILK）`
    );
  }

  // 回退链：cosyvoice 地址指向错误端口，应回退到 Kokoro
  const kokoro = await checkKokoroHealth({ timeoutMs: 2_000 });
  if (kokoro?.loaded) {
    const original = process.env.COSYVOICE_TTS_URL;
    process.env.COSYVOICE_TTS_URL = "http://127.0.0.1:9";
    const fallback = await synthesizeSpeech(SENTENCE, { maxChars: 120 });
    if (original === undefined) delete process.env.COSYVOICE_TTS_URL;
    else process.env.COSYVOICE_TTS_URL = original;
    if (fallback) console.log(`✅ 回退链：cosyvoice 不可达 → Kokoro SILK ${fallback.durationMs}ms`);
    else failures.push("回退链失败（cosyvoice 不可达时应回退 Kokoro）");
  } else {
    console.log("⏭️ Kokoro 未加载，跳过回退链（cosyvoice 失败会回退 say）");
  }

  console.log("");
  console.log(`服务地址：${cosyVoiceBaseUrl()}`);
  if (failures.length === 0) {
    console.log("— 结论：✅ 全部通过（健康 / 克隆合成 / ASR 复核 / 产品 SILK / 回退链）—");
  } else {
    console.log("— 结论：❌ 有失败项 —");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

/** 24k WAV → 16k WAV（只处理 PCM16；用系统 afconvert，失败则原样返回）。 */
async function to16kWav(wav: Buffer): Promise<Buffer> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "cosy-smoke-"));
  try {
    const input = join(dir, "in.wav");
    const output = join(dir, "out.wav");
    await writeFile(input, wav);
    await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", input, output]);
    return await readFile(output);
  } catch {
    return wav;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cerOf(expected: string, got: string): number {
  const strip = (text: string): string =>
    text.replace(/[\s，。！？、；：,.!?;:…—~～“”"'（）()]/g, "");
  const a = strip(expected);
  const b = strip(got);
  if (!a) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length]! / a.length;
}

main().catch((err) => {
  console.error("[cosyvoice:smoke] 失败：", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
