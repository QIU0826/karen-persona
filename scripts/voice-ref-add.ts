#!/usr/bin/env node
/**
 * 参考音导入工具（v0.9.17）：把任意格式的录音变成 Fun-CosyVoice 可用的参考音。
 *
 * 支持 mp3 / m4a / aac / wav / aiff（macOS 自带 afconvert 转码），流程：
 *   1. 转成 24kHz PCM16 单声道 WAV；
 *   2. 解析时长；超过 10s 自动从开头截断到 10s（建议录 8–10s 一句连续话）；
 *   3. 调本机 ASR 自动识别参考文本（也可 --text 手动给，更准）；
 *   4. 写入 data/voice-ref/<id>.wav + <id>.json（来源/授权/时长/sha256）。
 *
 * 用法：
 *   npm run voice:ref:add -- --input ~/Downloads/my-voice.m4a --id xiaoya
 *   npm run voice:ref:add -- --input voice.mp3 --id xiaoya --text "参考音里说的话"
 *
 * 隐私：文件只在本机处理；data/voice-ref/ 已在 .gitignore（不会提交）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VOICE_DIR = join(REPO, "data", "voice-ref");
const ASR_URL = (process.env.KAREN_ASR_URL ?? "http://127.0.0.1:18085").replace(/\/+$/, "");
const SAMPLE_RATE = 24_000;
const MIN_SECONDS = 3;
const MAX_SECONDS = 10;

interface Args {
  input: string;
  id: string;
  text?: string;
  source?: string;
  license?: string;
  skipAsr?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (key === "skip-asr") {
      args[key] = true;
      continue;
    }
    args[key] = argv[i + 1] ?? "";
    i += 1;
  }
  const input = String(args.input ?? "");
  const id = String(args.id ?? "default");
  if (!input) {
    console.error("用法：npm run voice:ref:add -- --input <录音文件> [--id xiaoya] [--text 参考文本]");
    process.exit(2);
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
    console.error("❌ --id 只能包含字母/数字/下划线/短横线（≤32 字符）");
    process.exit(2);
  }
  return {
    input,
    id,
    ...(args.text ? { text: String(args.text) } : {}),
    ...(args.source ? { source: String(args.source) } : {}),
    ...(args.license ? { license: String(args.license) } : {}),
    ...(args["skip-asr"] ? { skipAsr: true } : {}),
  };
}

interface WavParts {
  sampleRate: number;
  channels: number;
  bits: number;
  data: Buffer;
  /** 原始 fmt 块（16 字节） */
  fmt: Buffer;
}

/** 解析任意带附加块（LIST/FLLR 等）的 WAV，定位 fmt/data。 */
function parseWav(buffer: Buffer): WavParts {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("不是合法 WAV");
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("不是 WAVE");
  let offset = 12;
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && fmt === null) fmt = buffer.subarray(body, body + Math.min(size, 16));
    if (id === "data" && data === null) data = buffer.subarray(body, body + size);
    offset = body + size + (size % 2 === 1 ? 1 : 0);
    if (data && fmt) break;
  }
  if (!fmt || !data) throw new Error("WAV 缺少 fmt/data 块");
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (bits !== 16) throw new Error(`只支持 PCM16，当前 ${bits}bit`);
  return { sampleRate, channels, bits, data, fmt };
}

function wavInfo(buffer: Buffer): { duration: number; channels: number; sampleRate: number } {
  const parts = parseWav(buffer);
  const duration = parts.data.length / (parts.sampleRate * parts.channels * 2);
  return { duration, channels: parts.channels, sampleRate: parts.sampleRate };
}

/** 截断到 maxSeconds 并重建标准 44 字节头（去掉 FLLR/LIST 等附加块）。 */
function trimWav(buffer: Buffer, maxSeconds: number): Buffer {
  const parts = parseWav(buffer);
  const info = wavInfo(buffer);
  const bytesPerSecond = info.sampleRate * info.channels * 2;
  const keepBytes =
    info.duration <= maxSeconds
      ? parts.data.length
      : Math.min(parts.data.length, Math.floor(maxSeconds * bytesPerSecond));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + keepBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  parts.fmt.copy(header, 20, 0, 16);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(keepBytes, 40);
  return Buffer.concat([header, parts.data.subarray(0, keepBytes)]);
}

async function convertToWav(input: string, dir: string): Promise<Buffer> {
  const wavPath = join(dir, "converted.wav");
  try {
    await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, input, wavPath], {
      timeout: 60_000,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`转码失败（macOS afconvert）：${detail.slice(0, 200)}`);
  }
  return readFile(wavPath);
}

async function transcribe(wav: Buffer): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await transcribeOnce(wav);
    if (result) return result;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  return null;
}

async function transcribeOnce(wav: Buffer): Promise<string | null> {
  try {
    const response = await fetch(`${ASR_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`ASR 服务返回 ${response.status}：${(await response.text()).slice(0, 120)}`);
      return null;
    }
    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim() || null;
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? ` cause=${String((err as { cause?: unknown }).cause)}` : "";
    console.warn(
      `ASR 请求失败（${ASR_URL}）：${err instanceof Error ? err.name + " " + err.message : String(err)}${cause}`
    );
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  let raw: Buffer;
  try {
    raw = await readFile(inputPath);
  } catch {
    console.error(`❌ 找不到文件：${inputPath}`);
    process.exit(2);
    return;
  }
  console.log(`输入：${inputPath}（${(raw.length / 1024).toFixed(0)}KB）`);

  const dir = await mkdtemp(join(tmpdir(), "voice-ref-"));
  try {
    let wav = await convertToWav(inputPath, dir);
    const before = wavInfo(wav).duration;
    wav = trimWav(wav, MAX_SECONDS);
    const after = wavInfo(wav).duration;
    console.log(
      `转码：24kHz PCM16 单声道，${before.toFixed(2)}s${after < before ? ` → 截断到 ${after.toFixed(2)}s` : ""}`
    );
    if (after < MIN_SECONDS) {
      console.error(`❌ 有效语音 ${after.toFixed(2)}s，太短（至少 ${MIN_SECONDS}s，建议 8–10s 一句连续话）`);
      process.exit(1);
      return;
    }
    if (after < 8) {
      console.warn(`⚠️ 只有 ${after.toFixed(2)}s，建议 8–10s（3–7s 在合成参考音上会不稳，真人参考音可稍短）`);
    }

    let refText = args.text ?? "";
    if (!refText && !args.skipAsr) {
      const asr = await transcribe(wav);
      if (asr) {
        refText = asr;
        console.log(`ASR 识别：${refText}`);
      } else {
        console.warn("⚠️ ASR 不可用，稍后请用 --text 补上参考文本（必须与录音内容一致）");
      }
    }
    if (!refText) {
      console.error("❌ 缺少参考文本：请加 --text \"录音里说的话\"（与音频逐字一致）");
      process.exit(1);
      return;
    }

    await mkdir(VOICE_DIR, { recursive: true });
    const wavOut = join(VOICE_DIR, `${args.id}.wav`);
    const jsonOut = join(VOICE_DIR, `${args.id}.json`);
    await writeFile(wavOut, wav);
    const meta = {
      id: args.id,
      ref_text: refText,
      source: args.source ?? "用户提供的录音",
      license: args.license ?? "用户提供，仅本项目自用",
      duration_s: Number(after.toFixed(2)),
      sha256: createHash("sha256").update(wav).digest("hex"),
      created_at: new Date().toISOString().slice(0, 10),
    };
    await writeFile(jsonOut, `${JSON.stringify(meta, null, 2)}\n`);
    console.log("");
    console.log(`✅ 已注册参考音：${args.id}`);
    console.log(`   ${wavOut}`);
    console.log(`   ${jsonOut}`);
    console.log(`   时长 ${meta.duration_s}s ｜ 文本「${refText.slice(0, 40)}」`);
    console.log("");
    console.log("下一步：");
    console.log(`  1) 用克隆音色冒烟：COSYVOICE_VOICE_ID=${args.id} npm run cosyvoice:smoke`);
    console.log(`  2) 或直接告诉 AI「用 ${args.id} 参考音，切到 cosyvoice 试试」，由 AI 完成验证与切换。`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[voice:ref:add] 失败：", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
