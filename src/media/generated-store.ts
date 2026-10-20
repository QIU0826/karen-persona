/**
 * 生成图存储（v0.7）：按日期分目录落盘，自动清理 30 天前，可一键清空。
 *
 * 用户明确要求「注意控制好下载位置，方便以后好清理」——所以：
 *  - 生成物只落在 `KAREN_DATA_DIR/generated/YYYY-MM-DD/`（跟数据目录一起走，不进仓库）；
 *  - `pruneGenerated(now)` 删掉过期目录；`purgeGenerated()` 全清；
 *  - `generatedStats()` 给出条数与占用，`doctor` / `npm run media:status` 都能看到。
 */
import fs from "node:fs";
import path from "node:path";
import { dataFile, ensureDataDir } from "../data/paths.js";
import { GENERATED_DIR_NAME, GENERATED_RETENTION_DAYS } from "./comfyui.js";

/** 生成图根目录（KAREN_DATA_DIR/generated） */
export function generatedRoot(): string {
  return path.join(path.dirname(dataFile("x")), GENERATED_DIR_NAME);
}

function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 保存一张生成图，返回绝对路径；失败返回 null。 */
export function saveGeneratedImage(bytes: Buffer, options: { now?: number; ext?: string } = {}): string | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    ensureDataDir();
    const dir = path.join(generatedRoot(), dayKey(options.now));
    fs.mkdirSync(dir, { recursive: true });
    const name = `karen-${Date.now()}-${Math.floor(Math.random() * 10_000)}.${options.ext ?? "png"}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}

/**
 * 清理超过保留期的生成图（默认 30 天）。
 * 只处理形如 YYYY-MM-DD 的目录，其它文件/目录一律不动（避免误删）。
 */
export function pruneGenerated(now = Date.now()): { removedDirs: number; removedFiles: number } {
  const root = generatedRoot();
  let removedDirs = 0;
  let removedFiles = 0;
  if (!fs.existsSync(root)) return { removedDirs, removedFiles };
  const cutoff = now - GENERATED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removedDirs, removedFiles };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const [y, m, d] = entry.name.split("-").map(Number);
    const dirTime = new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0).getTime();
    if (dirTime >= cutoff) continue;
    const full = path.join(root, entry.name);
    try {
      const files = fs.readdirSync(full);
      removedFiles += files.length;
      fs.rmSync(full, { recursive: true, force: true });
      removedDirs += 1;
    } catch {
      // 单个目录失败不影响其它
    }
  }
  return { removedDirs, removedFiles };
}

/** 清空所有生成图（保留根目录）。 */
export function purgeGenerated(): { removedFiles: number } {
  const root = generatedRoot();
  let removedFiles = 0;
  if (!fs.existsSync(root)) return { removedFiles };
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        try {
          removedFiles += fs.readdirSync(full).length;
        } catch {
          // 忽略
        }
      }
      fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // 忽略
  }
  return { removedFiles };
}

export interface GeneratedStats {
  root: string;
  days: number;
  files: number;
  bytes: number;
}

/** 统计占用（doctor / media:status 用）。 */
export function generatedStats(): GeneratedStats {
  const root = generatedRoot();
  let files = 0;
  let bytes = 0;
  let days = 0;
  if (!fs.existsSync(root)) return { root, days, files, bytes };
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      days += 1;
      const dir = path.join(root, entry.name);
      for (const f of fs.readdirSync(dir)) {
        try {
          bytes += fs.statSync(path.join(dir, f)).size;
          files += 1;
        } catch {
          // 忽略
        }
      }
    }
  } catch {
    // 忽略
  }
  return { root, days, files, bytes };
}
