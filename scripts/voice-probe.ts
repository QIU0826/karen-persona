/**
 * 语音探针（人工验证用，不参与 CI）：
 *   node .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/voice-probe.ts
 *   ... --text "你好呀" --out /tmp/x.silk
 *   ... --text "你好呀" --wav /tmp/x.wav        # 额外生成 WAV 便于 afplay 试听
 *
 * 真实链路：macOS say → 24kHz WAV → silk-wasm → base64（QQ 语音消息格式）。
 * 打印：清洗后字数、语音时长、SILK 字节数、base64 长度、输出文件路径。
 * 说明：SILK 不能直接播放；要试听请用 --wav 生成 WAV 后 `afplay /tmp/x.wav`。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TTS_RATE,
  DEFAULT_TTS_VOICE,
  isSpeechAvailable,
  sanitizeSpeechText,
  synthesizeSpeech,
} from "../src/ai/tts.js";

interface ProbeArgs {
  text: string;
  out: string;
  wav: string | null;
  voice: string;
  rate: number;
  maxChars: number;
}

const DEFAULT_TEXT = "你好呀，今天过得怎么样？";
const DEFAULT_OUT = path.join(os.tmpdir(), "karen-voice-probe.silk");

function printUsage(): void {
  console.log(`语音探针：macOS say → SILK（QQ 语音消息格式）

用法:
  node .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/voice-probe.ts [选项]

选项:
  --text, -t <文本>     要合成的文本（默认 "${DEFAULT_TEXT}"）
  --out,  -o <路径>     SILK 输出路径（默认 ${DEFAULT_OUT}）
  --wav <路径>          额外生成 WAV 便于试听（afplay）
  --voice <发音人>      macOS say 发音人（默认 ${DEFAULT_TTS_VOICE}）
  --rate <语速>         say 语速（默认 ${DEFAULT_TTS_RATE}）
  --max-chars <字数>    清洗后文本上限（默认 60）
  --help, -h            显示帮助

注意：仅 macOS（say）可用；其它平台会提示不可用并非零退出。`);
}

function parseArgs(argv: string[]): ProbeArgs | null {
  const args: ProbeArgs = {
    text: DEFAULT_TEXT,
    out: DEFAULT_OUT,
    wav: null,
    voice: DEFAULT_TTS_VOICE,
    rate: DEFAULT_TTS_RATE,
    maxChars: 60,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--text":
      case "-t": {
        const value = next();
        if (value !== undefined) args.text = value;
        break;
      }
      case "--out":
      case "-o": {
        const value = next();
        if (value !== undefined) args.out = value;
        break;
      }
      case "--wav": {
        const value = next();
        if (value !== undefined) args.wav = value;
        break;
      }
      case "--voice": {
        const value = next();
        if (value !== undefined && value.trim()) args.voice = value.trim();
        break;
      }
      case "--rate": {
        const value = Number(next());
        if (Number.isFinite(value)) args.rate = value;
        break;
      }
      case "--max-chars": {
        const value = Number(next());
        if (Number.isFinite(value)) args.maxChars = value;
        break;
      }
      default:
        // 未识别参数：当作文本（方便直接 `... 你好呀`）
        if (!flag.startsWith("-")) args.text = flag;
        break;
    }
  }
  return args;
}

/** 用 say 生成一份 WAV，便于人工 afplay 试听。 */
function sayToWav(text: string, outPath: string, voice: string, rate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "say",
      [
        "-v",
        voice,
        "-r",
        String(rate),
        "-o",
        outPath,
        "--file-format=WAVE",
        "--data-format=LEI16@24000",
        text,
      ],
      { timeout: 15_000, encoding: "utf8" },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    printUsage();
    return;
  }

  console.log("语音探针：macOS say → SILK");
  const available = await isSpeechAvailable();
  if (!available) {
    console.log(`[不可用] 当前平台/环境不支持 say（platform=${process.platform}）`);
    process.exitCode = 1;
    return;
  }

  const spoken = sanitizeSpeechText(parsed.text, parsed.maxChars);
  if (!spoken) {
    console.log("[失败] 清洗后没有可朗读内容");
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const result = await synthesizeSpeech(
    parsed.text,
    {
      voice: parsed.voice,
      rate: parsed.rate,
      maxChars: parsed.maxChars,
      timeoutMs: 15_000,
    }
  );
  const elapsedMs = Date.now() - startedAt;

  if (!result) {
    console.log("[失败] synthesizeSpeech 返回 null（详见日志 reason；不打印正文）");
    process.exitCode = 1;
    return;
  }

  const outPath = path.resolve(parsed.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(result.silkBase64, "base64"));

  console.log(`[文本] ${Array.from(spoken).length} 字（已清洗，不打印正文）`);
  console.log(`[语音] 时长 ${result.durationMs} ms`);
  console.log(`[SILK] ${result.byteLength} bytes（上限 200KB）`);
  console.log(`[base64] ${result.silkBase64.length} chars`);
  console.log(`[耗时] ${elapsedMs} ms（say + silk 编码）`);
  console.log(`[输出] ${outPath}`);

  if (parsed.wav) {
    const wavPath = path.resolve(parsed.wav);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    try {
      await sayToWav(spoken, wavPath, parsed.voice, parsed.rate);
      console.log(`[试听] afplay ${wavPath}`);
    } catch (err) {
      console.log(`[提示] WAV 生成失败（${(err as { code?: string }).code ?? "unknown"}）`);
    }
  } else {
    console.log(
      `[试听] SILK 不能直接播放；加 --wav /tmp/karen-voice.wav 生成 WAV 后：afplay /tmp/karen-voice.wav`
    );
  }
}

main().catch((err: unknown) => {
  // 不打完整错误（可能包含命令行参数/正文），只打印错误码
  const code = (err as { code?: string })?.code ?? "unknown";
  console.error(`[失败] voice-probe 异常: ${code}`);
  process.exitCode = 1;
});
