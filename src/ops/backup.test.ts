import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_DB_NAME,
  MANIFEST_NAME,
  dayKey,
  listBackupDays,
  pruneBackups,
  runBackup,
  verifyBackupDir,
} from "./backup.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "karen-backup-test-"));
  tempRoots.push(root);
  return root;
}

async function makeDataDir(root: string): Promise<string> {
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, BACKUP_DB_NAME));
  try {
    db.exec(`
      CREATE TABLE t2_episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
      CREATE TABLE memory_anchors (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT);
      INSERT INTO t2_episodes (content) VALUES ('hello');
      INSERT INTO t2_episodes (content) VALUES ('world');
      INSERT INTO memory_anchors (summary) VALUES ('anchor');
    `);
  } finally {
    db.close();
  }

  await fs.writeFile(path.join(dataDir, "persona-state-test.json"), '{"closeness":1}\n', "utf8");
  await fs.writeFile(path.join(dataDir, "session-test.json"), '{"messages":[]}\n', "utf8");
  await fs.mkdir(path.join(dataDir, "generated", "2026-10-23"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "generated", "2026-10-23", "a.png"), Buffer.from("png"));
  await fs.mkdir(path.join(dataDir, "voice-ref"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "voice-ref", "ref.wav"), Buffer.from("wav"));
  return dataDir;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("backup", () => {
  it("热备主库、JSON、生成图和参考音，并立刻校验通过", async () => {
    const root = await makeTempRoot();
    const dataDir = await makeDataDir(root);
    const destDir = path.join(root, "karen-backups");
    const now = new Date(2026, 9, 23, 3, 30);

    const result = await runBackup({ dataDir, destDir, now, keepDays: 14 });

    expect(result.day).toBe("2026-10-23");
    expect(result.dir).toBe(path.join(destDir, "2026-10-23"));
    expect(result.db.integrity).toBe("ok");
    expect(result.db.counts.t2_episodes).toBe(2);
    expect(result.db.counts.memory_anchors).toBe(1);
    expect(result.jsonFiles).toBe(2);
    expect(result.assetFiles).toBe(2);
    expect(result.warnings).toEqual([]);

    await expect(fs.stat(path.join(result.dir, BACKUP_DB_NAME))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.dir, "persona-state-test.json"))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.dir, "generated", "2026-10-23", "a.png")),
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.dir, "voice-ref", "ref.wav"))).resolves.toBeTruthy();

    const manifest = JSON.parse(
      await fs.readFile(path.join(result.dir, MANIFEST_NAME), "utf8"),
    ) as { schema: number; db: { counts: Record<string, number> } };
    expect(manifest.schema).toBe(1);
    expect(manifest.db.counts.t2_episodes).toBe(2);

    const verified = await verifyBackupDir(result.dir);
    expect(verified.ok).toBe(true);
    expect(verified.dbIntegrity).toBe("ok");
    expect(verified.missing).toEqual([]);
    expect(verified.counts.t2_episodes).toBe(2);
  });

  it("同一天重跑会覆盖而不是叠加，旧备份不会残留", async () => {
    const root = await makeTempRoot();
    const dataDir = await makeDataDir(root);
    const destDir = path.join(root, "karen-backups");
    const now = new Date(2026, 9, 23, 3, 30);

    const first = await runBackup({ dataDir, destDir, now });
    await fs.writeFile(path.join(dataDir, "extra.json"), "{}\n", "utf8");
    const second = await runBackup({ dataDir, destDir, now });

    expect(second.dir).toBe(first.dir);
    expect(second.jsonFiles).toBe(3);
    const days = await listBackupDays(destDir);
    expect(days).toEqual(["2026-10-23"]);
    const leftovers = (await fs.readdir(destDir)).filter((name) => name.includes(".partial-"));
    expect(leftovers).toEqual([]);
    await expect(fs.stat(path.join(second.dir, "extra.json"))).resolves.toBeTruthy();
  });

  it("按天清理过期备份，同时清理残留 partial，保留非日期目录", async () => {
    const root = await makeTempRoot();
    const dataDir = await makeDataDir(root);
    const destDir = path.join(root, "karen-backups");
    await fs.mkdir(path.join(destDir, "2026-10-10"), { recursive: true });
    await fs.mkdir(path.join(destDir, "2026-10-16"), { recursive: true });
    await fs.mkdir(path.join(destDir, "2026-10-17"), { recursive: true });
    await fs.mkdir(path.join(destDir, "not-a-date"), { recursive: true });
    await fs.mkdir(path.join(destDir, "2026-10-23.partial-999"), { recursive: true });

    const result = await runBackup({
      dataDir,
      destDir,
      now: new Date(2026, 9, 23, 3, 30),
      keepDays: 7,
    });

    expect(result.pruned).toEqual(["2026-10-10", "2026-10-16", "2026-10-23.partial-999"]);
    const names = (await fs.readdir(destDir)).sort();
    expect(names).toEqual(["2026-10-17", "2026-10-23", "not-a-date"]);

    // 独立调用：keepDays=1 只保留当天。
    const pruned = await pruneBackups(destDir, 1, new Date(2026, 9, 23, 12, 0));
    expect(pruned).toEqual(["2026-10-17"]);
  });

  it("恢复校验能发现清单内文件缺失", async () => {
    const root = await makeTempRoot();
    const dataDir = await makeDataDir(root);
    const destDir = path.join(root, "karen-backups");
    const result = await runBackup({ dataDir, destDir, now: new Date(2026, 9, 23, 3, 30) });

    await fs.rm(path.join(result.dir, "persona-state-test.json"));
    const verified = await verifyBackupDir(result.dir);
    expect(verified.ok).toBe(false);
    expect(verified.missing).toContain("persona-state-test.json");
    expect(verified.warnings.some((warning) => warning.includes("文件缺失"))).toBe(true);
  });

  it("主库不存在时直接失败，避免把错误目录当数据目录", async () => {
    const root = await makeTempRoot();
    const dataDir = path.join(root, "empty-data");
    await fs.mkdir(dataDir, { recursive: true });
    await expect(
      runBackup({ dataDir, destDir: path.join(root, "karen-backups") }),
    ).rejects.toThrow(/主库不存在/);
  });

  it("dayKey 使用本地时区", () => {
    expect(dayKey(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
    expect(dayKey(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});
