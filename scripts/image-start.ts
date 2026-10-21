#!/usr/bin/env node
/**
 * 启动本机生图服务（v0.8.23）。
 *
 * 为什么单独一个脚本：模型现在放在**本地目录**（不是 HF 缓存），
 * 需要显式传 `KAREN_IMAGE_MODEL=<dir>` 并设 `HF_HUB_OFFLINE=1`
 * （否则 diffusers 会去连 HuggingFace，本机直连会卡住）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/image-start.ts
 *   npm run image:start
 *
 * 默认：
 *   - 服务端口 18084（KAREN_IMAGE_PORT 可覆盖）
 *   - 模型目录 ~/Library/Application Support/karen/models/sdxl-turbo
 *   - Python: services/image/.venv/bin/python
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = process.cwd();
const modelsRoot =
  process.env.KAREN_MODELS_DIR?.trim() ||
  path.join(os.homedir(), "Library", "Application Support", "karen", "models");
const modelDir = process.env.KAREN_IMAGE_MODEL?.trim() || path.join(modelsRoot, "sdxl-turbo");
const python = path.join(REPO_ROOT, "services", "image", ".venv", "bin", "python");
const server = path.join(REPO_ROOT, "services", "image", "server.py");

if (!fs.existsSync(python)) {
  console.error(`✗ 缺少 Python 环境：${python}`);
  console.error("  先安装：services/image/ 下的 uv/venv 环境（见 docs/IMAGE_GEN.md）");
  process.exit(1);
}
const unet = path.join(modelDir, "unet", "diffusion_pytorch_model.fp16.safetensors");
if (!fs.existsSync(unet)) {
  console.error(`✗ 模型权重不完整：${unet}`);
  console.error("  下载方法见 docs/IMAGE_GEN.md §5（hf-mirror + 分块下载）");
  process.exit(1);
}

const env = {
  ...process.env,
  KAREN_IMAGE_MODEL: modelDir,
  KAREN_MODELS_DIR: modelsRoot,
  // 模型已在本地：禁止回源 HuggingFace（直连不通，会卡住加载）
  HF_HUB_OFFLINE: "1",
};

console.log(`启动生图服务：${server}`);
console.log(`模型目录：${modelDir}`);
console.log(`端口：${env.KAREN_IMAGE_PORT ?? "18084"}（首次请求会加载模型，约 10s）`);

const child = spawn(python, [server], { cwd: REPO_ROOT, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
