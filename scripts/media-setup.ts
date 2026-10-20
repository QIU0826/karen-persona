/**
 * 本地生图环境管理（v0.7）：安装 ComfyUI、下载模型、查看占用、一键清理。
 *
 * 用户要求「注意控制好下载位置，方便以后好清理」，所以三类东西分开放：
 *  - 程序：`vendor/comfyui/`（gitignore，删目录即卸载）
 *  - 模型：`KAREN_MODELS_DIR/comfyui/models/`（删目录即释放，占用可查）
 *  - 生成图：`KAREN_DATA_DIR/generated/`（30 天自动清理，可 purge）
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/media-setup.ts status
 *   node node_modules/tsx/dist/cli.mjs scripts/media-setup.ts install      # 装 ComfyUI + 依赖
 *   node node_modules/tsx/dist/cli.mjs scripts/media-setup.ts pull-model   # 下 SDXL-Turbo（≈5GB）
 *   node node_modules/tsx/dist/cli.mjs scripts/media-setup.ts start        # 启动 ComfyUI
 *   node node_modules/tsx/dist/cli.mjs scripts/media-setup.ts purge [--all|--models|--images] --yes
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generatedStats, purgeGenerated } from "../src/media/generated-store.js";
import { comfyBaseUrl, isImageGenEnabled } from "../src/media/comfyui.js";

const REPO_ROOT = process.cwd();
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "comfyui");
const MODELS_DIR = path.join(
  process.env.KAREN_MODELS_DIR?.trim() || path.join(process.env.HOME ?? "", "Library", "Application Support", "karen", "models"),
  "comfyui",
  "models",
);
const CHECKPOINT = process.env.KAREN_SD_CHECKPOINT ?? "sd_xl_turbo_1.0_fp16.safetensors";
const CHECKPOINT_URL =
  process.env.KAREN_SD_CHECKPOINT_URL ??
  "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors";
const COMFY_PORT = process.env.KAREN_COMFY_PORT ?? "8188";

function sh(cmd: string, args: string[], opts: { cwd?: string; inherit?: boolean } = {}): void {
  if (opts.inherit) {
    execFileSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, stdio: "inherit" });
    return;
  }
  execFileSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, stdio: "pipe", timeout: 15 * 60_000 });
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 忽略
        }
      }
    }
  };
  walk(dir);
  return total;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function uvAvailable(): boolean {
  try {
    sh("uv", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function status(): void {
  console.log("── 生图环境状态 ────────────────────────");
  console.log(`开关 KAREN_IMAGE_GEN: ${isImageGenEnabled() ? "on（会生成图片）" : "off（只用图库）"}`);
  console.log(`ComfyUI 地址: ${comfyBaseUrl()}`);
  console.log(`程序目录: ${VENDOR_DIR} ${fs.existsSync(VENDOR_DIR) ? `（${gb(dirSize(VENDOR_DIR))}）` : "（未安装）"}`);
  console.log(`模型目录: ${MODELS_DIR}`);
  const ckpt = path.join(MODELS_DIR, "checkpoints", CHECKPOINT);
  console.log(`  - 主模型 ${CHECKPOINT}: ${fs.existsSync(ckpt) ? gb(fs.statSync(ckpt).size) : "未下载"}`);
  const stats = generatedStats();
  console.log(`生成图: ${stats.files} 张 / ${gb(stats.bytes)}（${stats.days} 个日期目录，30 天自动清理）`);
  console.log(`uv 可用: ${uvAvailable() ? "是" : "否（安装 ComfyUI 需要 uv：brew install uv）"}`);
  console.log(`建议：先只跑 status/pull-model；确认磁盘再 install。`);
}

function install(): void {
  if (fs.existsSync(VENDOR_DIR)) {
    console.log(`已存在：${VENDOR_DIR}（如需重装请先 purge --all）`);
    return;
  }
  if (!uvAvailable()) {
    console.error("缺少 uv，无法创建 Python 环境。请先安装：brew install uv");
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
  console.log("1/3 克隆 ComfyUI（约 100MB）…");
  sh("git", ["clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI.git", VENDOR_DIR], { inherit: true });
  console.log("2/3 创建 Python 环境（uv）…");
  sh("uv", ["venv", "--python", "3.12", path.join(VENDOR_DIR, ".venv")], { inherit: true });
  console.log("3/3 安装依赖（torch + requirements，约 2–3GB，首次较慢）…");
  const py = path.join(VENDOR_DIR, ".venv", "bin", "python");
  sh("uv", ["pip", "install", "--python", py, "torch", "torchvision", "torchaudio"], { inherit: true });
  sh("uv", ["pip", "install", "--python", py, "-r", path.join(VENDOR_DIR, "requirements.txt")], { inherit: true });
  console.log("完成。下一步：pull-model，然后 start。");
}

function pullModel(): void {
  const dir = path.join(MODELS_DIR, "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CHECKPOINT);
  if (fs.existsSync(target)) {
    console.log(`模型已存在：${target}（${gb(fs.statSync(target).size)}）`);
    return;
  }
  console.log(`下载 ${CHECKPOINT}（≈5GB）→ ${target}`);
  console.log("（中断可重跑，curl 支持断点续传）");
  sh("curl", ["-L", "--fail", "-C", "-", "-o", target, CHECKPOINT_URL], { inherit: true });
  console.log(`完成：${gb(fs.statSync(target).size)}`);
}

function start(): void {
  if (!fs.existsSync(VENDOR_DIR)) {
    console.error("还没安装 ComfyUI：先 `install`。");
    process.exitCode = 1;
    return;
  }
  const py = path.join(VENDOR_DIR, ".venv", "bin", "python");
  const args = [path.join(VENDOR_DIR, "main.py"), "--listen", "127.0.0.1", "--port", COMFY_PORT];
  console.log(`启动 ComfyUI: ${py} ${args.join(" ")}`);
  const child = spawn(py, args, { cwd: VENDOR_DIR, stdio: "inherit" });
  child.on("exit", (code) => console.log(`ComfyUI 退出：${code ?? "?"}`));
}

function purge(args: string[], yes: boolean): void {
  const all = args.includes("--all");
  const models = all || args.includes("--models");
  const images = all || args.includes("--images");
  if (!yes) {
    console.log("预览：");
    if (models) console.log(`  将删除程序目录 ${VENDOR_DIR}（${gb(dirSize(VENDOR_DIR))}）与模型目录 ${MODELS_DIR}（${gb(dirSize(MODELS_DIR))}）`);
    if (images) console.log(`  将清空生成图 ${generatedStats().files} 张`);
    console.log("确认请加 --yes");
    return;
  }
  if (models) {
    for (const dir of [VENDOR_DIR, MODELS_DIR]) {
      if (fs.existsSync(dir)) {
        const size = dirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`已删除 ${dir}（释放 ${gb(size)}）`);
      }
    }
  }
  if (images) {
    const result = purgeGenerated();
    console.log(`已清空生成图 ${result.removedFiles} 张`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "status";
  const yes = argv.includes("--yes");
  switch (cmd) {
    case "status":
      status();
      break;
    case "install":
      install();
      break;
    case "pull-model":
      pullModel();
      break;
    case "start":
      start();
      break;
    case "purge":
      purge(argv.slice(1), yes);
      break;
    default:
      console.log("用法：status | install | pull-model | start | purge [--all|--models|--images] --yes");
  }
}

main();
