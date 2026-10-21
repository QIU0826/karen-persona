#!/usr/bin/env node
/**
 * 启动本地语音识别服务（v0.23）。
 *
 * 模型放在仓库内 `services/asr/models/faster-whisper-small`（已 gitignore，删目录即卸载）。
 * 用法：npm run asr:start
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const python = path.join(REPO_ROOT, "services", "asr", ".venv", "bin", "python");
const server = path.join(REPO_ROOT, "services", "asr", "server.py");
const modelDir =
  process.env.KAREN_ASR_MODEL?.trim() ||
  path.join(REPO_ROOT, "services", "asr", "models", "faster-whisper-small");

if (!fs.existsSync(python)) {
  console.error(`✗ 缺少 Python 环境：${python}`);
  console.error("  安装：python3 -m venv services/asr/.venv && services/asr/.venv/bin/pip install faster-whisper");
  process.exit(1);
}
if (!fs.existsSync(path.join(modelDir, "model.bin"))) {
  console.error(`✗ 模型权重不完整：${path.join(modelDir, "model.bin")}`);
  console.error("  下载见 docs/ASR.md（hf-mirror + 分块 curl）");
  process.exit(1);
}

console.log(`启动语音识别服务：${server}`);
console.log(`模型：${modelDir}`);
console.log(`端口：${process.env.KAREN_ASR_PORT ?? "18085"}（首次请求加载模型，约 1–2s）`);

const child = spawn(python, [server], {
  cwd: REPO_ROOT,
  env: { ...process.env, KAREN_ASR_MODEL: modelDir },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
