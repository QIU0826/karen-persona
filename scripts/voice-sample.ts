/**
 * 语音试听样音生成（不调模型、不连 QQ）。
 *
 * 为什么需要它：TTS 像不像真人，脚本判断不了，只能靠耳朵。
 * 这个脚本把同一句话用不同音色 / 不同语气各生成一遍，并且额外输出
 * 「SILK 编解码后」的版本——那才是 QQ 里真正听到的音质。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/voice-sample.ts
 * 产物：data/voice-samples/（已在 .gitignore 里，不会被提交）
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { decode as decodeSilk, encode as encodeSilk } from "silk-wasm";
import { buildSayText, planSpeechStyle, type SpeechStyle } from "../src/ai/tts-style.js";

const run = promisify(execFile);

const OUT_DIR = path.resolve("data/voice-samples");
const WAV_FORMAT = "--file-format=WAVE";
const WAV_DATA = "--data-format=LEI16@24000";

/** 同一句「她」会说的话：有逗号、有句号，能听出停顿和语气。 */
const SENTENCE = "刚下班，路过那家店又买了一杯，跟你说过的那个。";

/** 候选音色：系统里能用的中文女声（含两个非大陆口音做对照）。 */
const VOICES = [
  { name: "Tingting", note: "当前默认（zh_CN，最常用）" },
  { name: "Meijia", note: "zh_TW，音色更轻" },
  { name: "Sinji", note: "zh_HK，粤语区，念普通话音色偏冷" },
  { name: "Sandy (中文（中国大陆）)", note: "系统旁白类音色" },
  { name: "Flo (中文（中国大陆）)", note: "系统旁白类音色" },
];

interface SampleRow {
  file: string;
  voice: string;
  variant: string;
  durationMs: number;
  bytes: number;
  style?: string;
}

function wavHeader(pcmBytes: number, sampleRate = 24_000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

async function sayToWav(voice: string, rate: number, text: string, outFile: string): Promise<void> {
  await run("say", ["-v", voice, "-r", String(rate), "-o", outFile, WAV_FORMAT, WAV_DATA, text], {
    timeout: 30_000,
  });
}

function wavInfo(wav: Buffer): { durationMs: number; pcm: Buffer } {
  const pcm = wav.subarray(44);
  return { durationMs: Math.round((pcm.length / 2 / 24_000) * 1000), pcm };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows: SampleRow[] = [];
  const tmp = path.join(OUT_DIR, ".tmp.wav");

  for (const voice of VOICES) {
    // a) 旧行为：固定 185 语速、无停顿
    const rawFile = path.join(OUT_DIR, `${slug(voice.name)}-0-旧版.wav`);
    await sayToWav(voice.name, 185, SENTENCE, tmp);
    fs.copyFileSync(tmp, rawFile);
    const raw = wavInfo(fs.readFileSync(rawFile));
    rows.push({ file: path.basename(rawFile), voice: voice.name, variant: "旧版（185 语速，无起伏）", durationMs: raw.durationMs, bytes: fs.statSync(rawFile).size });

    // b) 新行为：按情绪/时间调语速音高 + 句中停顿
    for (const style of ["natural", "lively", "tired"] as SpeechStyle[]) {
      const plan = planSpeechStyle({
        text: SENTENCE,
        hour: style === "tired" ? 1 : 14,
        emotionVector: style === "lively" ? 0.6 : style === "tired" ? -0.1 : 0.05,
        baseRate: 180,
        fillerProbability: 0,
      });
      const styledFile = path.join(OUT_DIR, `${slug(voice.name)}-1-${style}.wav`);
      await sayToWav(voice.name, plan.rate, buildSayText(plan), styledFile);
      const info = wavInfo(fs.readFileSync(styledFile));
      rows.push({
        file: path.basename(styledFile),
        voice: voice.name,
        variant: `新版 ${style}（${plan.rate}/分，pbas ${plan.pitch}，停顿 ${plan.addedPauseMs}ms）`,
        durationMs: info.durationMs,
        bytes: fs.statSync(styledFile).size,
        style,
      });

      // c) 只有默认音色才做 SILK 往返（听 QQ 里的真实音质）
      if (voice.name === "Tingting" || voice.name === "Meijia") {
        const wavBuf = fs.readFileSync(styledFile);
        const silk = await encodeSilk(wavBuf, 0);
        const back = await decodeSilk(silk.data, 24_000);
        const pcm = Buffer.from(back.data);
        const roundFile = path.join(OUT_DIR, `${slug(voice.name)}-2-${style}-silk往返.wav`);
        fs.writeFileSync(roundFile, Buffer.concat([wavHeader(pcm.length), pcm]));
        rows.push({
          file: path.basename(roundFile),
          voice: voice.name,
          variant: `QQ 实际音质（SILK 编解码后，${style}）`,
          durationMs: Math.round(back.duration),
          bytes: fs.statSync(roundFile).size,
          style,
        });
      }
    }
  }

  fs.rmSync(tmp, { force: true });
  writeReadme(rows);
  printTable(rows);
}

function slug(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fff-]+/g, "");
}

function writeReadme(rows: SampleRow[]): void {
  const lines = [
    "# 语音试听样音",
    "",
    "同一句：「" + SENTENCE + "」",
    "",
    "每组三档：",
    "- `-0-旧版`：v0.4.0 及以前的做法（固定 185 语速、无停顿、无音高变化）",
    "- `-1-<风格>`：v0.4.1 的做法（按情绪/时间调语速音高 + 句中停顿）",
    "- `-2-<风格>-silk往返`：把新版音频编成 SILK 再解回来（≈ QQ 里真正听到的音质）",
    "",
    "## 怎么判断",
    "1. 先听 `Tingting-0-旧版`（现在的效果）→ 再听 `Tingting-1-natural`，对比「像不像在跟你说话」；",
    "2. 再听 `*-2-*-silk往返`，确认 SILK 压缩后是否还能接受；",
    "3. 换音色对比：`Meijia`（更轻）、`Sinji`（偏冷）、`Sandy/Flo`（旁白腔）。",
    "",
    "## 文件清单",
    "| 文件 | 音色 | 变体 | 时长 | 大小 |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.file} | ${r.voice} | ${r.variant} | ${(r.durationMs / 1000).toFixed(2)}s | ${(r.bytes / 1024).toFixed(0)}KB |`,
    ),
    "",
    "改音色：在 `config.yaml` 里设 `voice_tts_voice: \"Meijia\"`（或你听下来最像人的那个），改语速用 `voice_tts_rate`。",
  ];
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), lines.join("\n"), "utf8");
}

function printTable(rows: SampleRow[]): void {
  console.log(`样音目录：${OUT_DIR}\n`);
  console.log("| 文件 | 音色 | 变体 | 时长 |");
  console.log("|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.file} | ${r.voice} | ${r.variant} | ${(r.durationMs / 1000).toFixed(2)}s |`);
  }
  console.log(`\n共 ${rows.length} 个文件，说明见 ${path.join(OUT_DIR, "README.md")}`);
}

main().catch((err: unknown) => {
  console.error("[样音生成失败]", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
