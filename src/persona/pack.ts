/**
 * 人设包 v2（M2-B）：可安装/可校验/可分发的「她」。
 *
 * 包格式（目录，暂不支持 zip——避免引入解压依赖）：
 * ```
 * my-persona/
 * ├─ manifest.json        # 包元信息（id/version/personaSchemaVersion/...）
 * ├─ persona.json         # 六层人设（必需）
 * ├─ SKILL.md             # 可选：她的自述
 * ├─ persona.md           # 可选：历史格式说明
 * ├─ assets/              # 可选：头像/贴纸/生活照（png/jpg/webp/gif/mp4）
 * └─ memories/seed.jsonl  # 可选：记忆种子（3–20 条，安装时 --with-seeds 写入 T2）
 * ```
 *
 * 设计原则：
 * - 校验只做「结构与引擎兼容性」，不判断内容好坏；分发前的质量/版权审核在 M3；
 * - 安装默认不覆盖已有人设（需 --force，旧目录会备份）；
 * - 记忆种子默认不写（--with-seeds 才写），避免安装一个人设就污染你的记忆库。
 */
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION, validatePersona } from "./loader.js";

export const PACK_FORMAT_VERSION = 1;
export const MAX_ASSET_BYTES_PER_FILE = 10 * 1024 * 1024;
export const MAX_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_ASSET_COUNT = 30;
export const MAX_SEED_COUNT = 20;
export const MIN_SEED_COUNT = 3;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALLOWED_ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"]);
const ALLOWED_SEED_SOURCES = new Set([
  "chat",
  "event",
  "causal_chain",
  "user_trace",
  "internal_monologue",
]);

export interface PackManifest {
  /** 人设 id（安装目录名），小写字母/数字/下划线/短横线，≤64 */
  id: string;
  /** 包版本（语义化版本，例如 1.0.0） */
  version: string;
  /** 展示名 */
  name?: string;
  /** persona.json 的 schemaVersion，必须与当前引擎一致 */
  personaSchemaVersion: number;
  /** 最低引擎版本（可选，例如 0.1.0） */
  minEngineVersion?: string;
  author?: string;
  license?: string;
  description?: string;
}

export interface PackIssue {
  level: "error" | "warning";
  message: string;
}

export interface SeedEntry {
  content: string;
  source: string;
  emotionalWeight: number;
}

export interface PackValidationResult {
  ok: boolean;
  manifest: PackManifest | null;
  issues: PackIssue[];
  assets: { count: number; totalBytes: number };
  seeds: SeedEntry[];
  /** 便于 CLI 打印 */
  personaName: string | null;
}

export interface ValidateOptions {
  /** 覆盖单文件大小限制（测试用） */
  maxAssetBytes?: number;
  /** 覆盖总大小限制（测试用） */
  maxAssetTotalBytes?: number;
  /** 覆盖记忆种子上限（测试用） */
  maxSeedCount?: number;
  /** 覆盖引擎版本（测试用） */
  engineVersion?: string;
}

let cachedEngineVersion: string | null = null;

/** 当前引擎版本（读仓库 package.json；读不到时回退 0.0.0，不影响校验）。 */
export function currentEngineVersion(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  try {
    const raw = fs.readFileSync(path.resolve("package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedEngineVersion = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cachedEngineVersion = "0.0.0";
  }
  return cachedEngineVersion;
}

/** 简单 semver 比较：a<b 返回负数，相等 0，a>b 正数；非数字段按字符串比较。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function validateManifestShape(raw: unknown): { manifest: PackManifest | null; issues: PackIssue[] } {
  const issues: PackIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, issues: [{ level: "error", message: "manifest.json 必须是 JSON 对象" }] };
  }
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id) {
    issues.push({ level: "error", message: "manifest.id 缺失" });
  } else if (!ID_PATTERN.test(id)) {
    issues.push({
      level: "error",
      message: `manifest.id 不合法（${id}）：需小写字母/数字/下划线/短横线，≤64 字符`,
    });
  }
  const version = typeof m.version === "string" ? m.version.trim() : "";
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    issues.push({ level: "error", message: "manifest.version 需为语义化版本（如 1.0.0）" });
  }
  if (typeof m.personaSchemaVersion !== "number") {
    issues.push({ level: "error", message: "manifest.personaSchemaVersion 缺失（应为数字）" });
  }
  const manifest: PackManifest | null = id
    ? {
        id,
        version,
        name: typeof m.name === "string" ? m.name : undefined,
        personaSchemaVersion: typeof m.personaSchemaVersion === "number" ? m.personaSchemaVersion : 0,
        minEngineVersion: typeof m.minEngineVersion === "string" ? m.minEngineVersion : undefined,
        author: typeof m.author === "string" ? m.author : undefined,
        license: typeof m.license === "string" ? m.license : undefined,
        description: typeof m.description === "string" ? m.description : undefined,
      }
    : null;
  return { manifest, issues };
}

function scanAssets(
  packDir: string,
  options: ValidateOptions,
): { issues: PackIssue[]; assets: { count: number; totalBytes: number } } {
  const issues: PackIssue[] = [];
  const assetsDir = path.join(packDir, "assets");
  const maxPerFile = options.maxAssetBytes ?? MAX_ASSET_BYTES_PER_FILE;
  const maxTotal = options.maxAssetTotalBytes ?? MAX_ASSET_TOTAL_BYTES;
  if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
    return { issues, assets: { count: 0, totalBytes: 0 } };
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(assetsDir);
  let totalBytes = 0;
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (!ALLOWED_ASSET_EXT.has(ext)) {
      issues.push({
        level: "warning",
        message: `assets 中有不支持的文件类型（${path.relative(packDir, file)}），安装后不会自动使用`,
      });
    }
    if (size > maxPerFile) {
      issues.push({
        level: "error",
        message: `素材过大：${path.relative(packDir, file)} ${(size / 1024 / 1024).toFixed(1)}MB > ${(maxPerFile / 1024 / 1024).toFixed(1)}MB`,
      });
    }
  }
  if (files.length > MAX_ASSET_COUNT) {
    issues.push({ level: "error", message: `素材文件过多：${files.length} > ${MAX_ASSET_COUNT}` });
  }
  if (totalBytes > maxTotal) {
    issues.push({
      level: "error",
      message: `素材总大小超限：${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(maxTotal / 1024 / 1024).toFixed(1)}MB`,
    });
  }
  return { issues, assets: { count: files.length, totalBytes } };
}

function parseSeedFile(packDir: string, options: ValidateOptions): { issues: PackIssue[]; seeds: SeedEntry[] } {
  const issues: PackIssue[] = [];
  const seedFile = path.join(packDir, "memories", "seed.jsonl");
  if (!fs.existsSync(seedFile)) return { issues, seeds: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(seedFile, "utf-8");
  } catch (err) {
    return {
      issues: [{ level: "error", message: `memories/seed.jsonl 读取失败：${err instanceof Error ? err.message : String(err)}` }],
      seeds: [],
    };
  }
  const seedEntries: SeedEntry[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      issues.push({ level: "error", message: `seed.jsonl 第 ${index + 1} 行不是合法 JSON` });
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { content?: unknown }).content !== "string") {
      issues.push({ level: "error", message: `seed.jsonl 第 ${index + 1} 行缺少 content 字符串` });
      return;
    }
    const record = parsed as { content: string; source?: unknown; emotionalWeight?: unknown };
    const content = record.content.trim();
    if (!content) {
      issues.push({ level: "error", message: `seed.jsonl 第 ${index + 1} 行 content 为空` });
      return;
    }
    const source = typeof record.source === "string" ? record.source : "chat";
    if (!ALLOWED_SEED_SOURCES.has(source)) {
      issues.push({
        level: "warning",
        message: `seed.jsonl 第 ${index + 1} 行 source=${source} 不在白名单，按 chat 处理`,
      });
    }
    const emotionalWeight =
      typeof record.emotionalWeight === "number" && Number.isFinite(record.emotionalWeight)
        ? Math.min(1, Math.max(0, record.emotionalWeight))
        : 0;
    seedEntries.push({
      content: content.slice(0, 500),
      source: ALLOWED_SEED_SOURCES.has(source) ? source : "chat",
      emotionalWeight,
    });
  });
  const maxSeeds = options.maxSeedCount ?? MAX_SEED_COUNT;
  if (seedEntries.length > maxSeeds) {
    issues.push({ level: "error", message: `记忆种子过多：${seedEntries.length} > ${maxSeeds}` });
  } else if (seedEntries.length > 0 && seedEntries.length < MIN_SEED_COUNT) {
    issues.push({
      level: "warning",
      message: `记忆种子只有 ${seedEntries.length} 条（建议 ${MIN_SEED_COUNT}–${MAX_SEED_COUNT} 条，太少意义不大）`,
    });
  }
  return { issues, seeds: seedEntries };
}

/**
 * 校验一个人设包目录（不写任何东西）。
 * ok = 没有 error 级问题（warning 不影响安装）。
 */
export function validatePersonaPack(packDir: string, options: ValidateOptions = {}): PackValidationResult {
  const issues: PackIssue[] = [];
  const empty = { count: 0, totalBytes: 0 };
  if (!fs.existsSync(packDir) || !fs.statSync(packDir).isDirectory()) {
    return {
      ok: false,
      manifest: null,
      issues: [{ level: "error", message: `目录不存在：${packDir}` }],
      assets: empty,
      seeds: [],
      personaName: null,
    };
  }

  const manifestFile = path.join(packDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    return {
      ok: false,
      manifest: null,
      issues: [{ level: "error", message: "缺少 manifest.json" }],
      assets: empty,
      seeds: [],
      personaName: null,
    };
  }
  const rawManifest = readJson(manifestFile);
  if (!rawManifest.ok) {
    return {
      ok: false,
      manifest: null,
      issues: [{ level: "error", message: `manifest.json 解析失败：${rawManifest.message}` }],
      assets: empty,
      seeds: [],
      personaName: null,
    };
  }
  const { manifest, issues: manifestIssues } = validateManifestShape(rawManifest.value);
  issues.push(...manifestIssues);

  const engineVersion = options.engineVersion ?? currentEngineVersion();
  if (manifest?.minEngineVersion && compareVersions(engineVersion, manifest.minEngineVersion) < 0) {
    issues.push({
      level: "error",
      message: `需要引擎版本 ≥ ${manifest.minEngineVersion}（当前 ${engineVersion}），请先升级 Karen`,
    });
  }
  if (manifest && manifest.personaSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    issues.push({
      level: "error",
      message: `personaSchemaVersion=${manifest.personaSchemaVersion}，当前引擎只支持 ${CURRENT_SCHEMA_VERSION}；请使用迁移后的包`,
    });
  }

  let personaName: string | null = null;
  const personaFile = path.join(packDir, "persona.json");
  if (!fs.existsSync(personaFile)) {
    issues.push({ level: "error", message: "缺少 persona.json" });
  } else {
    const rawPersona = readJson(personaFile);
    if (!rawPersona.ok) {
      issues.push({ level: "error", message: `persona.json 解析失败：${rawPersona.message}` });
    } else {
      const personaCheck = validatePersona(rawPersona.value, manifest?.id ?? path.basename(packDir));
      for (const error of personaCheck.errors) {
        issues.push({ level: "error", message: `persona.json：${error}` });
      }
      for (const warning of personaCheck.warnings) {
        issues.push({ level: "warning", message: `persona.json：${warning}` });
      }
      const name = (rawPersona.value as { name?: unknown }).name;
      personaName = typeof name === "string" ? name : null;
    }
  }

  const assetCheck = scanAssets(packDir, options);
  issues.push(...assetCheck.issues);
  const seedCheck = parseSeedFile(packDir, options);
  issues.push(...seedCheck.issues);

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    manifest,
    issues,
    assets: assetCheck.assets,
    seeds: seedCheck.seeds,
    personaName,
  };
}

export interface InstallOptions {
  /** 安装目标目录（默认 cwd/personas） */
  personasDir?: string;
  /** 覆盖已存在的人设（旧目录会备份为 <id>.bak-<时间戳>） */
  force?: boolean;
  /** 是否把 memories/seed.jsonl 写入 T2 记忆（默认不写） */
  withSeeds?: boolean;
}

export interface InstallResult {
  installedPath: string;
  backupPath: string | null;
  seedsApplied: number;
}

/** 安装一个人设包目录。校验失败抛错；成功返回安装路径/备份/种子数。 */
export async function installPersonaPack(
  sourceDir: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const validation = validatePersonaPack(sourceDir);
  if (!validation.ok || !validation.manifest) {
    const errorText = validation.issues
      .filter((issue) => issue.level === "error")
      .map((issue) => `- ${issue.message}`)
      .join("\n");
    throw new Error(`人设包校验失败：\n${errorText}`);
  }
  const manifest = validation.manifest;
  const personasDir = options.personasDir ?? path.resolve("personas");
  fs.mkdirSync(personasDir, { recursive: true });
  const target = path.join(personasDir, manifest.id);

  let backupPath: string | null = null;
  if (fs.existsSync(target)) {
    if (!options.force) {
      throw new Error(
        `人设 "${manifest.id}" 已存在（${target}）。确认要覆盖请加 --force（旧目录会备份）。`,
      );
    }
    // 备份放到 personas/.backups/（隐藏目录），避免被 setup/listPersonas 当成一个新人设
    const backupDir = path.join(personasDir, ".backups");
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `${manifest.id}-${Date.now()}`);
    fs.renameSync(target, backupPath);
  }

  fs.cpSync(sourceDir, target, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".DS_Store",
  });

  let seedsApplied = 0;
  if (options.withSeeds && validation.seeds.length > 0) {
    const { insertEpisode, setCurrentPersona } = await import("../data/vector.js");
    setCurrentPersona(manifest.id);
    for (const seed of validation.seeds) {
      insertEpisode(seed.content, seed.source, seed.emotionalWeight);
      seedsApplied++;
    }
  }

  return { installedPath: target, backupPath, seedsApplied };
}

export interface InstalledPackInfo {
  id: string;
  dir: string;
  manifest: PackManifest | null;
  /** 没有 manifest 的历史人设 */
  legacy: boolean;
}

/** 列出已安装人设（有 manifest 的为 v2 包，没有的标 legacy）。 */
export function listInstalledPacks(personasDir: string = path.resolve("personas")): InstalledPackInfo[] {
  if (!fs.existsSync(personasDir)) return [];
  return fs
    .readdirSync(personasDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const dir = path.join(personasDir, entry.name);
      const manifestFile = path.join(dir, "manifest.json");
      let manifest: PackManifest | null = null;
      if (fs.existsSync(manifestFile)) {
        const raw = readJson(manifestFile);
        if (raw.ok) {
          manifest = validateManifestShape(raw.value).manifest;
        }
      }
      return { id: entry.name, dir, manifest, legacy: manifest === null };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
