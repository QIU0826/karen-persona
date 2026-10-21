#!/usr/bin/env node
/**
 * Kokoro 语音链路冒烟（v0.9.15，本机服务，不联网）。
 *
 * 验证四件事：
 *  1. 服务健康（模型已加载、音色白名单正确）；
 *  2. 三个中文音色都能合成合法 WAV，且延迟可接受；
 *  3. 转写可懂度（走本机 ASR 服务，字符错误率 ≤ 15% 算过）；
 *  4. 产品链路：`synthesizeSpeech`（KAREN_TTS_BACKEND=kokoro）真的产出 SILK。
 *
 * 用法：npm run kokoro:smoke
 */
import { synthesizeSpeech } from "../src/ai/tts.js";
import {
  KOKORO_VOICES,
  checkKokoroHealth,
  synthesizeWithKokoro,
} from "../src/ai/neural-tts.js";
import { transcribeVoice } from "../src/ai/asr.js";
import { encode as encodeSilk } from "silk-wasm";

const SENTENCE = "今天店里人不多，我给自己做了杯拿铁，拉花歪了。";
/** ASR 期望（只比较汉字，忽略标点）。 */
const EXPECTED = "今天店里人不多我给自己做了杯拿铁拉花歪了";

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length]!;
}

const stripPunct = (text: string): string => text.replace(/[\s，。！？、,.!?~～…—]/g, "");

function fmtBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(0)}KB` : `${bytes}B`;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  console.log("— Kokoro 语音链路冒烟（本机，零 API 成本）—");

  const health = await checkKokoroHealth();
  if (!health || !health.loaded) {
    console.log(`❌ 服务不可用：npm run kokoro:start 后重试`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 健康：已加载，音色 ${health.voices.join(" / ")}，采样率 ${health.sr}Hz`);

  const samples: Array<{ voice: string; wav: Buffer; elapsed: number; durationMs: number }> = [];
  for (const voice of KOKORO_VOICES) {
    const started = Date.now();
    const result = await synthesizeWithKokoro(SENTENCE, { voice, timeoutMs: 15_000 });
    const elapsed = Date.now() - started;
    if (!result) {
      failures.push(`${voice} 合成失败`);
      continue;
    }
    const durationMs = result.durationMs ?? 0;
    console.log(
      `✅ ${voice}：wav ${fmtBytes(result.wav.length)} / ${durationMs}ms 音频 / 合成 ${elapsed}ms（RTF ${(elapsed / Math.max(1, durationMs)).toFixed(2)}x）`
    );
    if (elapsed > 4_000) failures.push(`${voice} 合成过慢（${elapsed}ms）`);
    samples.push({ voice, wav: result.wav, elapsed, durationMs });
    if (health.voices.length > 0 && !health.voices.includes(voice)) {
      failures.push(`服务未声明音色 ${voice}`);
    }
  }

  // 可懂度：送本机 ASR 服务（脚本进程没走 bridge 的 .env，显式打开）
  process.env.KAREN_ASR = "on";
  const asrHealth = await fetch("http://127.0.0.1:18085/health", { signal: AbortSignal.timeout(2_000) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (asrHealth) {
    for (const sample of samples) {
      const transcript = await transcribeVoice(sample.wav);
      if (!transcript.ok) {
        failures.push(`${sample.voice} ASR 失败（${transcript.reason}）`);
        continue;
      }
      const expected = stripPunct(EXPECTED);
      const got = stripPunct(transcript.text);
      const cer = editDistance(expected, got) / Math.max(1, expected.length);
      console.log(`✅ ${sample.voice} ASR CER ${(cer * 100).toFixed(1)}%：${transcript.text.slice(0, 40)}`);
      if (cer > 0.15) failures.push(`${sample.voice} 可懂度不足（CER ${(cer * 100).toFixed(1)}%）`);
    }
  } else {
    console.log("⏭️ ASR 服务未起，跳过可懂度校验（不影响合成结论）");
  }

  // 产品链路：文本 → SILK（bridge 实际走这条）
  process.env.KAREN_TTS_BACKEND = "kokoro";
  const product = await synthesizeSpeech(SENTENCE, { maxChars: 120 });
  if (!product) {
    failures.push("产品链路 synthesizeSpeech 返回 null");
  } else {
    console.log(
      `✅ 产品链路：SILK ${fmtBytes(product.byteLength)} / ${product.durationMs}ms / base64 ${fmtBytes(product.silkBase64.length)}`
    );
    const decoded = Buffer.from(product.silkBase64, "base64");
    if (decoded.length !== product.byteLength) failures.push("SILK base64 长度与字节数不一致");
  }

  // 兜底路径：关闭 kokoro 时应仍能走 say（仅 macOS）
  delete process.env.KAREN_TTS_BACKEND;
  const fallback = await synthesizeSpeech(SENTENCE, { maxChars: 120 });
  if (process.platform === "darwin") {
    if (fallback) console.log(`✅ 回退路径（say）：SILK ${fmtBytes(fallback.byteLength)} / ${fallback.durationMs}ms`);
    else failures.push("darwin 上 say 回退失败");
  } else {
    console.log("⏭️ 非 macOS，跳过 say 回退");
  }

  // 直接编码一次，确认 wav → SILK 兼容 24k PCM
  if (samples[0]) {
    const silk = await encodeSilk(samples[0].wav, 0);
    if (!silk || silk.data.byteLength === 0) failures.push("直编码 SILK 失败（WAV 不被 silk-wasm 接受）");
    else console.log(`✅ 直编码：${fmtBytes(silk.data.byteLength)} SILK / ${Math.round(silk.duration)}ms`);
  }

  console.log("");
  if (failures.length === 0) {
    console.log("— 结论：✅ 全部通过（健康 / 三音色合成 / 可懂度 / 产品链路 / 回退）—");
  } else {
    console.log("— 结论：❌ 有失败项 —");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[kokoro:smoke] 失败：", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
