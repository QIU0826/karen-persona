/**
 * 本地模型目录管理（v0.5 P1 骨架）。
 *
 * 为什么单独做：本地向量模型（0.6–2.2GB）和之后的 ComfyUI 模型（≈8GB）体积大，
 * 必须能一眼看清「占了多少、都在哪、怎么清」。所有模型统一放 KAREN_MODELS_DIR，
 * 仓库内绝不落模型文件。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/models.ts            # 状态（默认）
 *   node node_modules/tsx/dist/cli.mjs scripts/models.ts --list     # 已知模型清单
 *   node node_modules/tsx/dist/cli.mjs scripts/models.ts --purge bge-m3 --yes
 *   node node_modules/tsx/dist/cli.mjs scripts/models.ts --purge all --yes
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 默认模型根目录（可用 KAREN_MODELS_DIR 覆盖） */
export function resolveModelsDir(): string {
  const env = process.env.KAREN_MODELS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), "Library", "Application Support", "karen", "models");
}

interface ModelInfo {
  id: string;
  purpose: "embed" | "rerank" | "image" | "tts";
  sizeGb: number;
  note: string;
}

/** 已知模型（用于 --list 与占用预估；实际以磁盘为准） */
export const KNOWN_MODELS: ModelInfo[] = [
  { id: "bge-m3", purpose: "embed", sizeGb: 1.2, note: "中文/多语言 dense+sparse，1024 维（需重建索引）" },
  { id: "Qwen3-Embedding-0.6B", purpose: "embed", sizeGb: 0.6, note: "支持 MRL 截断到 768，零 schema 迁移" },
  { id: "bge-reranker-base", purpose: "rerank", sizeGb: 0.3, note: "本地重排，替代每轮 DeepSeek 重排" },
  { id: "flux1-schnell", purpose: "image", sizeGb: 6.5, note: "ComfyUI 生图（Apache-2.0，4 步）" },
  { id: "sdxl-turbo", purpose: "image", sizeGb: 4.5, note: "ComfyUI 生图备选" },
  { id: "indextts2", purpose: "tts", sizeGb: 3.5, note: "零样本语音克隆（v0.9）" },
];

function dirSize(dir: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function listStatus(): void {
  const dir = resolveModelsDir();
  console.log(`模型目录：${dir}`);
  console.log(`（可用 KAREN_MODELS_DIR 覆盖；仓库内不落模型）\n`);
  if (!fs.existsSync(dir)) {
    console.log("目录还不存在——第一次启动本地向量服务时会自动创建。");
    console.log("预估体积：" + KNOWN_MODELS.filter((m) => m.purpose === "embed").map((m) => `${m.id} ≈${m.sizeGb}GB`).join(" / "));
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) {
    console.log("目录是空的。");
    return;
  }
  let total = 0;
  const rows: Array<{ name: string; size: number }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const size = entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    total += size;
    rows.push({ name: entry.name, size });
  }
  rows.sort((a, b) => b.size - a.size);
  for (const row of rows) {
    const known = KNOWN_MODELS.find((m) => row.name.toLowerCase().includes(m.id.toLowerCase()));
    console.log(`- ${row.name.padEnd(40)} ${fmtGb(row.size).padStart(9)}  ${known ? known.note : ""}`);
  }
  console.log(`\n合计：${fmtGb(total)}`);
  const disk = fs.statfsSync(dir);
  console.log(`所在磁盘剩余：${fmtGb(disk.bavail * disk.bsize)}`);
}

function listKnown(): void {
  console.log("已知模型（体积为估算，实际以磁盘为准）：\n");
  for (const m of KNOWN_MODELS) {
    console.log(`- ${m.id.padEnd(26)} ${String(m.sizeGb).padStart(5)}GB  [${m.purpose}]  ${m.note}`);
  }
  const embed = KNOWN_MODELS.filter((m) => m.purpose === "embed").reduce((s, m) => s + m.sizeGb, 0);
  const image = KNOWN_MODELS.filter((m) => m.purpose === "image").reduce((s, m) => s + Math.min(m.sizeGb, 6.5), 0);
  console.log(`\n按需下载即可：向量（二选一）≤1.2GB；生图 ≈6.5GB；语音 ≈3.5GB。`);
  console.log(`全装合计约 ${(embed + image + 3.5).toFixed(1)}GB（不会自动下，都是显式触发）。`);
}

function purge(target: string, confirmed: boolean): void {
  const dir = resolveModelsDir();
  if (!fs.existsSync(dir)) {
    console.log("模型目录不存在，无需清理。");
    return;
  }
  const safeRoot = path.resolve(dir);
  const candidates: string[] =
    target === "all"
      ? fs
          .readdirSync(safeRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isFile())
          .map((e) => e.name)
      : fs
          .readdirSync(safeRoot, { withFileTypes: true })
          .filter((e) => e.name.toLowerCase().includes(target.toLowerCase()))
          .map((e) => e.name);

  if (candidates.length === 0) {
    console.log(`没找到匹配「${target}」的模型目录。`);
    return;
  }
  for (const name of candidates) {
    const full = path.resolve(safeRoot, name);
    // 安全校验：只允许删模型根目录下的直接子项
    if (!full.startsWith(safeRoot + path.sep)) {
      console.error(`跳过（路径越界）：${full}`);
      continue;
    }
    const size = dirSize(full);
    if (!confirmed) {
      console.log(`将删除 ${name}（${fmtGb(size)}）—— 确认请加 --yes`);
      continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`已删除 ${name}（释放 ${fmtGb(size)}）`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const has = (flag: string) => argv.includes(flag);
  const purgeIndex = argv.indexOf("--purge");
  if (purgeIndex >= 0) {
    const target = argv[purgeIndex + 1];
    if (!target) {
      console.error("用法：--purge <模型名片段|all> [--yes]");
      process.exitCode = 1;
      return;
    }
    purge(target, has("--yes"));
    return;
  }
  if (has("--list")) {
    listKnown();
    return;
  }
  listStatus();
}

main();
