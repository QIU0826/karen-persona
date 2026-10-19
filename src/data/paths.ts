/**
 * 运行时路径解析。
 *
 * 所有运行时数据（SQLite、会话 JSON）统一走这里，避免相对 cwd 的散落路径。
 * - 默认：<cwd>/data
 * - 可通过环境变量 KAREN_DATA_DIR 覆盖（测试、Docker、便携模式）
 */
import fs from "node:fs";
import path from "node:path";

/** 运行时数据目录（绝对路径）。每次调用都重新读取 env，便于测试。 */
export function dataDir(): string {
  const override = process.env.KAREN_DATA_DIR;
  return override ? path.resolve(override) : path.resolve("data");
}

/** 确保数据目录存在并返回。 */
export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** SQLite 主库路径。 */
export function dbPath(): string {
  return path.join(dataDir(), "memory.sqlite");
}

/** 数据目录下的某个文件路径（会自动确保目录存在）。 */
export function dataFile(name: string): string {
  ensureDataDir();
  return path.join(dataDir(), name);
}

/** 把任意 id 转成安全的文件名片段（人设名可能是中文/含特殊字符）。 */
export function safeFileStem(id: string): string {
  const cleaned = id.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "unknown";
}

/**
 * 项目资源目录（assets/...）绝对路径。
 *
 * 不依赖 cwd：优先从入口脚本（process.argv[1]，如 src/bridge/qq.ts / dist/bridge/qq.js）
 * 向上逐级查找；回退 cwd。用于贴纸、本地图库等随仓库分发的静态资源。
 */
export function assetDir(relative: string): string {
  const candidates: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    let dir = path.dirname(path.resolve(entry));
    for (let i = 0; i < 6; i++) {
      candidates.push(path.resolve(dir, relative));
      dir = path.dirname(dir);
    }
  }
  candidates.push(path.resolve(process.cwd(), relative));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
