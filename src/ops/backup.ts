/**
 * 数据热备份与恢复校验（P0-1）。
 *
 * 背景：`data/memory.sqlite` 是关系、记忆、会话的唯一来源，之前只有两份手工
 * `.bak`，没有自动备份，也没有恢复演练。本模块提供：
 * - **在线热备**：用 SQLite 官方 backup API（better-sqlite3 `db.backup()`），
 *   自动包含 WAL 里尚未 checkpoint 的最新对话，不直接 cp 主库；
 * - **一起备份**：`data/*.json`（persona-state / session / archive）+ 生成图
 *   `data/generated` + 参考音 `data/voice-ref`；
 * - **可校验**：备份后立刻对副本做 `PRAGMA integrity_check` 并统计关键表行数；
 * - **保留策略**：按天目录 `YYYY-MM-DD`，默认保留 14 天，过期目录自动清理；
 * - **原子落盘**：先写 `*.partial-<pid>`，成功后再 rename，避免半份备份被当成可用备份。
 *
 * CLI 见 `scripts/backup.ts`；定时任务见 `scripts/backup-install-launchd.sh`。
 * 恢复方法：停止桥接 → 确认目标日期目录 → 用 `--verify` 校验 → 把
 * `memory.sqlite` 与 `data/*.json` 拷回 `data/` → 启动桥接。
 */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

/** 默认保留天数（含当天）。 */
export const DEFAULT_KEEP_DAYS = 14;

/** 主库文件名。 */
export const BACKUP_DB_NAME = "memory.sqlite";

/** 备份清单文件名。 */
export const MANIFEST_NAME = "manifest.json";

/** 关键表：备份后统计行数，恢复时用来判断数据是否完整。 */
const COUNTED_TABLES = [
  "t2_episodes",
  "memory_anchors",
  "daily_digests",
  "daily_life",
  "user_facts",
  "working_memory",
  "t1_snapshots",
  "llm_usage",
] as const;

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARTIAL_MARKER = ".partial-";

export interface BackupOptions {
  /** 数据目录，默认 `<cwd>/data`。 */
  dataDir?: string;
  /** 备份根目录，默认 `<dataDir>/../../karen-backups`（不放在仓库里）。 */
  destDir?: string;
  /** 时间注入（测试用）。 */
  now?: Date;
  /** 保留天数（含当天），默认 14。 */
  keepDays?: number;
  /** 是否备份 `data/generated`（默认 true）。 */
  includeGenerated?: boolean;
  /** 是否备份 `data/voice-ref`（默认 true）。 */
  includeVoiceRef?: boolean;
}

export type BackupCounts = Record<string, number>;

export interface BackupDbInfo {
  file: string;
  bytes: number;
  integrity: "ok" | "failed";
  counts: BackupCounts;
}

export interface BackupManifestFile {
  path: string;
  bytes: number;
}

export interface BackupManifest {
  schema: 1;
  day: string;
  createdAt: string;
  db: BackupDbInfo;
  files: BackupManifestFile[];
  totalBytes: number;
}

export interface BackupResult {
  /** 本次备份最终目录。 */
  dir: string;
  day: string;
  durationMs: number;
  db: BackupDbInfo;
  /** 备份的 data/*.json 个数。 */
  jsonFiles: number;
  /** 备份的图片/参考音文件个数（不含 sqlite/json/manifest）。 */
  assetFiles: number;
  totalBytes: number;
  /** 本次清理掉的旧备份目录名（含残留 partial）。 */
  pruned: string[];
  warnings: string[];
}

export interface VerifyResult {
  ok: boolean;
  dir: string;
  day: string;
  dbIntegrity: string;
  counts: BackupCounts;
  files: number;
  missing: string[];
  warnings: string[];
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 本地时区的 `YYYY-MM-DD`。 */
export function dayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 默认备份根目录：仓库同级的 `karen-backups/`，不会进 git。 */
export function defaultDestination(dataDir: string): string {
  return path.resolve(dataDir, "..", "..", "karen-backups");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出目录内所有文件（相对路径 + 字节数）。 */
export async function listFiles(root: string): Promise<BackupManifestFile[]> {
  const out: BackupManifestFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        out.push({ path: rel, bytes: stat.size });
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 拷贝目录并返回文件数（源目录不存在返回 0）。 */
async function copyDir(src: string, dest: string): Promise<number> {
  if (!(await pathExists(src))) return 0;
  await fs.cp(src, dest, { recursive: true });
  return (await listFiles(dest)).length;
}

async function countRows(db: Database.Database): Promise<BackupCounts> {
  const counts: BackupCounts = {};
  for (const table of COUNTED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
      counts[table] = Number(row?.n ?? 0);
    } catch {
      // 表不存在（旧库/精简库）不算失败，只是不统计。
    }
  }
  return counts;
}

/**
 * 用 SQLite Online Backup API 热备主库。
 * 会自动把 WAL 中已提交但未 checkpoint 的最新数据包含进去。
 */
export async function backupDatabase(source: string, dest: string): Promise<BackupDbInfo> {
  const src = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }

  const copy = new Database(dest, { readonly: true, fileMustExist: true });
  try {
    const raw = copy.pragma("integrity_check", { simple: true });
    const integrity =
      String(Array.isArray(raw) ? raw[0] : raw).toLowerCase() === "ok" ? "ok" : "failed";
    const counts = await countRows(copy);
    const stat = await fs.stat(dest);
    return { file: BACKUP_DB_NAME, bytes: stat.size, integrity, counts };
  } finally {
    copy.close();
  }
}

/**
 * 清理过期备份：只删 `YYYY-MM-DD` 目录里早于保留窗口的，以及残留的 partial 目录。
 * 返回被删目录名。`keepDays=14` 表示保留「今天 + 前 13 天」。
 */
export async function pruneBackups(
  destDir: string,
  keepDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const entries = await fs.readdir(destDir, { withFileTypes: true }).catch(() => []);
  const keep = clampInt(keepDays, 1, 3650);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - (keep - 1));
  const cutoffKey = dayKey(cutoff);

  const pruned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isPartial = entry.name.includes(PARTIAL_MARKER);
    const isExpiredDay = DAY_DIR_RE.test(entry.name) && entry.name < cutoffKey;
    if (!isPartial && !isExpiredDay) continue;
    await fs.rm(path.join(destDir, entry.name), { recursive: true, force: true });
    pruned.push(entry.name);
  }
  return pruned.sort();
}

/** 读取备份目录里的清单；不存在返回 null。 */
export async function readManifest(dir: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(raw) as BackupManifest;
    if (!parsed || parsed.schema !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 执行一次热备。DB 不存在时直接抛错（避免把错误目录当数据目录备份）。
 */
export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const startedAt = Date.now();
  const dataDir = path.resolve(options.dataDir ?? "data");
  const destDir = path.resolve(options.destDir ?? defaultDestination(dataDir));
  const now = options.now ?? new Date();
  const day = dayKey(now);
  const keepDays = clampInt(options.keepDays ?? DEFAULT_KEEP_DAYS, 1, 3650);
  const dbSource = path.join(dataDir, BACKUP_DB_NAME);

  if (!(await pathExists(dbSource))) {
    throw new Error(`主库不存在：${dbSource}（确认 dataDir 是否正确）`);
  }

  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 只对新建目录生效；已存在的目录显式收紧（备份里有聊天/记忆）。
  await fs.chmod(destDir, 0o700).catch(() => undefined);
  const dayDir = path.join(destDir, day);
  const tmpDir = path.join(destDir, `${day}${PARTIAL_MARKER}${process.pid}`);
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const warnings: string[] = [];
  let db: BackupDbInfo;
  try {
    db = await backupDatabase(dbSource, path.join(tmpDir, BACKUP_DB_NAME));
    // 主库含全部聊天/记忆，备份件仅本人可读。
    await fs.chmod(path.join(tmpDir, BACKUP_DB_NAME), 0o600).catch(() => undefined);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  if (db.integrity !== "ok") warnings.push("备份库 integrity_check 未通过");

  // data 根目录下的 JSON（会话/人格状态/空间状态/归档等）。
  let jsonFiles = 0;
  for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const dest = path.join(tmpDir, entry.name);
    await fs.copyFile(path.join(dataDir, entry.name), dest);
    // 会话/人格状态含聊天原文，备份件保持仅本人可读。
    await fs.chmod(dest, 0o600).catch(() => undefined);
    jsonFiles++;
  }

  let assetFiles = 0;
  if (options.includeGenerated !== false) {
    assetFiles += await copyDir(path.join(dataDir, "generated"), path.join(tmpDir, "generated"));
  }
  if (options.includeVoiceRef !== false) {
    assetFiles += await copyDir(path.join(dataDir, "voice-ref"), path.join(tmpDir, "voice-ref"));
  }

  // 备份 API 可能留下空的 -wal/-shm sidecar；空的直接删掉，非空则保留并告警。
  const walPath = path.join(tmpDir, `${BACKUP_DB_NAME}-wal`);
  const shmPath = path.join(tmpDir, `${BACKUP_DB_NAME}-shm`);
  const walBytes = (await pathExists(walPath)) ? (await fs.stat(walPath)).size : 0;
  if (walBytes > 0) {
    warnings.push(`备份库仍有 ${walBytes} 字节 WAL，已保留 sidecar（恢复时需一起拷回）`);
  } else {
    await fs.rm(walPath, { force: true });
    await fs.rm(shmPath, { force: true });
  }

  const files = await listFiles(tmpDir);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifest: BackupManifest = {
    schema: 1,
    day,
    createdAt: now.toISOString(),
    db,
    files,
    totalBytes,
  };
  await fs.writeFile(path.join(tmpDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.chmod(path.join(tmpDir, MANIFEST_NAME), 0o600).catch(() => undefined);

  // 原子替换当天目录（支持同一天重跑）；先把旧目录挪开，避免删除后 rename 失败丢上一份。
  const trashDir = path.join(destDir, `${day}${PARTIAL_MARKER}old-${process.pid}`);
  if (await pathExists(dayDir)) {
    await fs.rm(trashDir, { recursive: true, force: true });
    await fs.rename(dayDir, trashDir);
  }
  try {
    await fs.rename(tmpDir, dayDir);
  } catch (err) {
    // rename 失败时尽量恢复旧备份。
    if (await pathExists(trashDir)) await fs.rename(trashDir, dayDir).catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  await fs.rm(trashDir, { recursive: true, force: true });
  await fs.chmod(dayDir, 0o700).catch(() => undefined);
  const pruned = await pruneBackups(destDir, keepDays, now);

  return {
    dir: dayDir,
    day,
    durationMs: Date.now() - startedAt,
    db,
    jsonFiles,
    assetFiles,
    totalBytes,
    pruned,
    warnings,
  };
}

/**
 * 校验一个备份目录：清单、文件存在性、副本 integrity_check、行数是否对得上。
 * 恢复前应先跑这个。
 */
export async function verifyBackupDir(dir: string): Promise<VerifyResult> {
  const target = path.resolve(dir);
  const manifest = await readManifest(target);
  const warnings: string[] = [];
  const missing: string[] = [];
  const dbPath = path.join(target, BACKUP_DB_NAME);

  if (!manifest) warnings.push(`缺少或无法解析 ${MANIFEST_NAME}`);
  if (!(await pathExists(dbPath))) {
    throw new Error(`备份主库不存在：${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let dbIntegrity = "failed";
  let counts: BackupCounts = {};
  try {
    const raw = db.pragma("integrity_check", { simple: true });
    dbIntegrity = String(Array.isArray(raw) ? raw[0] : raw).toLowerCase() === "ok" ? "ok" : "failed";
    counts = await countRows(db);
  } finally {
    db.close();
  }

  if (manifest) {
    for (const file of manifest.files) {
      if (!(await pathExists(path.join(target, file.path)))) missing.push(file.path);
    }
    for (const [table, expected] of Object.entries(manifest.db.counts ?? {})) {
      const actual = counts[table];
      if (actual !== undefined && actual !== expected) {
        warnings.push(`表 ${table} 行数不一致：清单 ${expected} / 实际 ${actual}`);
      }
    }
  }
  if (dbIntegrity !== "ok") warnings.push("副本 integrity_check 未通过");
  if (missing.length > 0) warnings.push(`清单内 ${missing.length} 个文件缺失`);

  return {
    ok: dbIntegrity === "ok" && missing.length === 0 && warnings.length === 0,
    dir: target,
    day: manifest?.day ?? path.basename(target),
    dbIntegrity,
    counts,
    files: manifest?.files.length ?? 0,
    missing,
    warnings,
  };
}

/** 把备份结果压成适合 CLI 打印的几行（不含任何聊天内容）。 */
export function formatBackupSummary(result: BackupResult): string[] {
  const counts = Object.entries(result.db.counts)
    .map(([table, n]) => `${table}=${n}`)
    .join(" ");
  const lines = [
    `备份目录：${result.dir}`,
    `耗时：${result.durationMs}ms  总大小：${(result.totalBytes / 1024 / 1024).toFixed(2)}MB`,
    `主库：${(result.db.bytes / 1024 / 1024).toFixed(2)}MB  integrity=${result.db.integrity}`,
    counts ? `行数：${counts}` : "行数：（无关键表）",
    `JSON：${result.jsonFiles} 个  图片/参考音：${result.assetFiles} 个`,
  ];
  if (result.pruned.length > 0) lines.push(`清理旧备份：${result.pruned.join(", ")}`);
  for (const warning of result.warnings) lines.push(`⚠️ ${warning}`);
  return lines;
}

/** 当前备份目录列表（按日期倒序，供 CLI/doctor 展示）。 */
export async function listBackupDays(destDir: string): Promise<string[]> {
  const entries = await fs.readdir(destDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && DAY_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}
