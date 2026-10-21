#!/usr/bin/env node
/**
 * 语音识别鲁棒性压测（v0.9.3）。
 *
 * 为什么做：ASR 上线后用的一直是「Tingting 正常语速的干净语音」，
 * 但真人说话有男女声/老人音、快慢语速、环境噪声。`small` 模型到底够不够？
 * 这里用 macOS 多种 TTS 音色 × 语速 × 加噪，量化**字错率 CER**，用数据决定是否升级模型。
 *
 * 零成本（本机 ASR 服务）。用法：
 *   npm run asr:start
 *   KAREN_ASR=on npm run asr:robustness
 *
 * 输出：逐条件 CER/延迟 表 + 总体结论；`--json` 打印机器可读结果。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE_URL = process.env.KAREN_ASR_URL?.trim() || "http://127.0.0.1:18085";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "karen-asr-robust-"));

/** 测试语料：覆盖聊天里最常出现的信息类型（事实/计划/情绪/人名地名） */
const SENTENCES = [
  "我叫阿哲，在上海做产品设计。",
  "我养了只橘猫叫团子，特别黏人。",
  "这个项目月底要上线，最近天天加班。",
  "下周三我要去北京见客户，签一份合同。",
  "今天被老板说了一顿，心里有点闷。",
  "周末想去看海，但是天气预报说下雨。",
  "我妈下周过生日，我还没想好送什么。",
  "最近在学吉他，手指头都磨出茧了。",
  "晚上一起吃火锅吧，我请客。",
  "我有点失眠，总是凌晨三点才睡着。",
];

interface Condition {
  id: string;
  voice: string;
  rate: number;
  /** 噪声信噪比（dB）；null = 不加噪 */
  snrDb: number | null;
}

const CONDITIONS: Condition[] = [
  // 注：`say -v ?` 列出的很多中文音色（Rocko/Grandma/Sandy…）本机未安装，合成出来是近静音；
  // 实测真正能发声的只有 Tingting（标准普通话）、Meijia（台湾腔）、Sinji（粤语口音）。
  { id: "baseline-clean", voice: "Tingting", rate: 180, snrDb: null },
  { id: "slow-clean", voice: "Tingting", rate: 140, snrDb: null },
  { id: "fast-clean", voice: "Tingting", rate: 240, snrDb: null },
  { id: "taiwan-accent", voice: "Meijia", rate: 180, snrDb: null },
  { id: "cantonese-accent", voice: "Sinji", rate: 180, snrDb: null },
  { id: "baseline-noise10", voice: "Tingting", rate: 180, snrDb: 10 },
  { id: "baseline-noise5", voice: "Tingting", rate: 180, snrDb: 5 },
  { id: "accent-noise10", voice: "Meijia", rate: 180, snrDb: 10 },
];

/** 中文 CER 归一化：只保留汉字/字母/数字（去标点与空格） */
function normalize(text: string): string {
  return text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").toLowerCase();
}

/** Levenshtein 距离（按字符） */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] ?? 0;
}

function cer(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

/** 用 macOS say 生成 16k WAV */
function synthWav(voice: string, rate: number, text: string, outPath: string): void {
  execFileSync("say", [
    "-v",
    voice,
    "-r",
    String(rate),
    "-o",
    outPath,
    "--file-format=WAVE",
    "--data-format=LEI16@16000",
    text,
  ]);
}

/** 给 WAV 加高斯白噪声（按目标 SNR），返回新文件路径 */
function addNoise(wavPath: string, snrDb: number, outPath: string): void {
  const script = `
import json, sys, wave, numpy as np
src, dst, snr = sys.argv[1], sys.argv[2], float(sys.argv[3])
with wave.open(src, "rb") as w:
    params = w.getparams()
    frames = w.readframes(w.getnframes())
data = np.frombuffer(frames, dtype=np.int16).astype(np.float64)
rms = np.sqrt(np.mean(data**2)) or 1.0
noise_rms = rms / (10 ** (snr / 20))
noise = np.random.normal(0, noise_rms, data.shape[0])
mixed = np.clip(data + noise, -32768, 32767).astype(np.int16)
with wave.open(dst, "wb") as w:
    w.setparams(params)
    w.writeframes(mixed.tobytes())
print(json.dumps({"ok": True}))
`;
  execFileSync(path.join(process.cwd(), "services", "asr", ".venv", "bin", "python"), [
    "-c",
    script,
    wavPath,
    outPath,
    String(snrDb),
  ]);
}

async function transcribe(wavPath: string): Promise<{ text: string; latencyMs: number }> {
  const body = fs.readFileSync(wavPath);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${SERVICE_URL}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`ASR 服务返回 ${res.status}`);
      const json = (await res.json()) as { text?: string };
      return { text: (json.text ?? "").trim(), latencyMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<number> {
  const jsonMode = process.argv.includes("--json");
  console.log("— 语音识别鲁棒性压测 —");
  console.log(`服务：${SERVICE_URL} ｜ 语料：${SENTENCES.length} 句 ｜ 条件：${CONDITIONS.length} 组`);

  try {
    const health = (await (await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) })).json()) as {
      loaded?: boolean;
      model?: string;
    };
    if (!health.loaded) console.log("  （首次请求会自动加载模型，稍慢）");
  } catch {
    console.log("  ✗ ASR 服务不可达（先 npm run asr:start）");
    fs.rmSync(TMP, { recursive: true, force: true });
    return 2;
  }

  const results: Array<{
    condition: string;
    voice: string;
    rate: number;
    snrDb: number | null;
    cer: number;
    avgLatencyMs: number;
    samples: Array<{ ref: string; hyp: string; cer: number }>;
  }> = [];

  for (const condition of CONDITIONS) {
    const samples: Array<{ ref: string; hyp: string; cer: number }> = [];
    let latencySum = 0;
    for (let i = 0; i < SENTENCES.length; i++) {
      const clean = path.join(TMP, `${condition.id}-${i}.wav`);
      synthWav(condition.voice, condition.rate, SENTENCES[i]!, clean);
      const input = condition.snrDb === null ? clean : path.join(TMP, `${condition.id}-${i}-n.wav`);
      if (condition.snrDb !== null) addNoise(clean, condition.snrDb, input);
      const { text, latencyMs } = await transcribe(input);
      latencySum += latencyMs;
      samples.push({ ref: SENTENCES[i]!, hyp: text, cer: cer(SENTENCES[i]!, text) });
    }
    const avgCer = samples.reduce((sum, s) => sum + s.cer, 0) / samples.length;
    results.push({
      condition: condition.id,
      voice: condition.voice,
      rate: condition.rate,
      snrDb: condition.snrDb,
      cer: avgCer,
      avgLatencyMs: Math.round(latencySum / samples.length),
      samples,
    });
    console.log(
      `  ${condition.id.padEnd(16)} CER=${(avgCer * 100).toFixed(1).padStart(5)}%  延迟=${String(Math.round(latencySum / samples.length)).padStart(4)}ms`,
    );
  }

  const cleanConditions = results.filter((r) => r.snrDb === null);
  const noisyConditions = results.filter((r) => r.snrDb !== null);
  const avg = (list: typeof results): number => list.reduce((s, r) => s + r.cer, 0) / (list.length || 1);
  const cleanAvg = avg(cleanConditions);
  const noisyAvg = avg(noisyConditions);
  const worst = [...results].sort((a, b) => b.cer - a.cer)[0]!;

  console.log("\n— 结论 —");
  console.log(`  干净语音（4 音色/语速）平均 CER：${(cleanAvg * 100).toFixed(1)}%`);
  console.log(`  加噪语音（10/5dB）平均 CER：${(noisyAvg * 100).toFixed(1)}%`);
  console.log(`  最差条件：${worst.condition} → ${(worst.cer * 100).toFixed(1)}%`);

  const failures: string[] = [];
  if (cleanAvg > 0.15) failures.push(`干净语音 CER 过高（${(cleanAvg * 100).toFixed(1)}% > 15%），small 模型可能不够`);
  if (noisyAvg > 0.35) failures.push(`噪声下 CER 过高（${(noisyAvg * 100).toFixed(1)}% > 35%），需要更强模型或降噪`);
  if (worst.cer > 0.6) failures.push(`最差条件几乎不可用（${worst.condition} ${(worst.cer * 100).toFixed(0)}%）`);
  const baselineLatency = results.find((r) => r.condition === "baseline-clean")?.avgLatencyMs ?? 0;

  if (failures.length === 0) {
    console.log(`  ✅ small 模型在测试范围内可用（基线延迟 ${baselineLatency}ms/条）`);
  } else {
    for (const failure of failures) console.log(`  ✗ ${failure}`);
  }
  console.log("\n  逐句错误示例（最差条件的前 3 条）：");
  for (const sample of worst.samples.slice(0, 3)) {
    if (sample.cer === 0) continue;
    console.log(`    原句：${sample.ref}`);
    console.log(`    识别：${sample.hyp || "（空）"}`);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ results, cleanAvg, noisyAvg, worst: worst.condition }, null, 2));
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[ASR 鲁棒性压测失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
