/**
 * 人设包 v2 单测：manifest/素材/记忆种子校验 + 安装/覆盖备份/列表 + CLI。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  currentEngineVersion,
  installPersonaPack,
  listInstalledPacks,
  validatePersonaPack,
  type PackManifest,
} from "./pack.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const PACK_CLI = path.join(REPO_ROOT, "src/persona/pack-cli.ts");
const TEMPLATE_PERSONA = path.join(REPO_ROOT, "personas/xiaoya");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-pack-"));
});

afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const validManifest: PackManifest = {
  id: "test-pack",
  version: "1.0.0",
  name: "测试人设",
  personaSchemaVersion: 1,
};

function makePack(
  packDir: string,
  manifest: Record<string, unknown> | null = validManifest as unknown as Record<string, unknown>,
): void {
  fs.mkdirSync(packDir, { recursive: true });
  fs.copyFileSync(path.join(TEMPLATE_PERSONA, "persona.json"), path.join(packDir, "persona.json"));
  fs.copyFileSync(path.join(TEMPLATE_PERSONA, "SKILL.md"), path.join(packDir, "SKILL.md"));
  if (manifest) {
    fs.writeFileSync(path.join(packDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }
}

function writeSeeds(packDir: string, lines: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(packDir, "memories"), { recursive: true });
  fs.writeFileSync(
    path.join(packDir, "memories/seed.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf-8",
  );
}

describe("validatePersonaPack", () => {
  it("合法包通过校验，并读出 manifest/人设名", () => {
    const packDir = path.join(dir, "my-persona");
    makePack(packDir);
    const result = validatePersonaPack(packDir);
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe("test-pack");
    expect(result.personaName).toBe("小雅");
    expect(result.assets).toEqual({ count: 0, totalBytes: 0 });
    expect(result.seeds).toEqual([]);
  });

  it("缺少 manifest / persona.json 报错", () => {
    const noManifest = path.join(dir, "no-manifest");
    makePack(noManifest, null);
    expect(validatePersonaPack(noManifest).ok).toBe(false);
    expect(validatePersonaPack(noManifest).issues[0].message).toContain("manifest.json");

    const noPersona = path.join(dir, "no-persona");
    fs.mkdirSync(noPersona, { recursive: true });
    fs.writeFileSync(path.join(noPersona, "manifest.json"), JSON.stringify(validManifest), "utf-8");
    const result = validatePersonaPack(noPersona);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("persona.json"))).toBe(true);
  });

  it("id 非法 / schema 不匹配 / 引擎版本过低都报 error", () => {
    const badId = path.join(dir, "bad-id");
    makePack(badId, { ...validManifest, id: "Bad ID!" });
    expect(validatePersonaPack(badId).ok).toBe(false);
    expect(validatePersonaPack(badId).issues.some((issue) => issue.message.includes("id 不合法"))).toBe(
      true,
    );

    const badSchema = path.join(dir, "bad-schema");
    makePack(badSchema, { ...validManifest, personaSchemaVersion: 99 });
    expect(validatePersonaPack(badSchema).issues.some((issue) => issue.message.includes("personaSchemaVersion"))).toBe(
      true,
    );

    const needEngine = path.join(dir, "need-engine");
    makePack(needEngine, { ...validManifest, minEngineVersion: "99.0.0" });
    expect(validatePersonaPack(needEngine).issues.some((issue) => issue.message.includes("升级"))).toBe(true);
  });

  it("素材类型/大小限制", () => {
    const packDir = path.join(dir, "assets-pack");
    makePack(packDir);
    fs.mkdirSync(path.join(packDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(packDir, "assets/a.png"), Buffer.alloc(20));
    fs.writeFileSync(path.join(packDir, "assets/readme.txt"), "hi");
    const loose = validatePersonaPack(packDir);
    expect(loose.assets.count).toBe(2);
    expect(loose.issues.some((issue) => issue.level === "warning" && issue.message.includes("不支持"))).toBe(true);

    const strict = validatePersonaPack(packDir, { maxAssetBytes: 10 });
    expect(strict.ok).toBe(false);
    expect(strict.issues.some((issue) => issue.message.includes("素材过大"))).toBe(true);
  });

  it("记忆种子：合法 3 条 / 非法行 / 超过上限", () => {
    const okDir = path.join(dir, "seed-ok");
    makePack(okDir);
    writeSeeds(okDir, [
      { content: "用户说他叫林哲", source: "chat", emotionalWeight: 0.2 },
      { content: "用户养了一只橘猫叫团子" },
      { content: "用户最近在做的项目是咖啡包装", source: "event" },
    ]);
    const ok = validatePersonaPack(okDir);
    expect(ok.ok).toBe(true);
    expect(ok.seeds).toHaveLength(3);
    expect(ok.seeds[2].source).toBe("event");

    const badDir = path.join(dir, "seed-bad");
    makePack(badDir);
    fs.mkdirSync(path.join(badDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(badDir, "memories/seed.jsonl"), "{not json}\n", "utf-8");
    expect(validatePersonaPack(badDir).ok).toBe(false);

    const manyDir = path.join(dir, "seed-many");
    makePack(manyDir);
    writeSeeds(
      manyDir,
      Array.from({ length: 5 }, (_, i) => ({ content: `种子${i}` })),
    );
    expect(validatePersonaPack(manyDir, { maxSeedCount: 4 }).ok).toBe(false);
  });
});

describe("installPersonaPack / listInstalledPacks", () => {
  it("安装成功；重复安装拒绝；--force 备份旧目录；list 标出 legacy", async () => {
    const personaDir = path.join(dir, "personas");
    const packDir = path.join(dir, "pack-src");
    makePack(packDir);

    const first = await installPersonaPack(packDir, { personasDir: personaDir });
    expect(fs.existsSync(path.join(first.installedPath, "persona.json"))).toBe(true);
    expect(fs.existsSync(path.join(first.installedPath, "manifest.json"))).toBe(true);

    await expect(installPersonaPack(packDir, { personasDir: personaDir })).rejects.toThrow("已存在");

    const forced = await installPersonaPack(packDir, { personasDir: personaDir, force: true });
    expect(forced.backupPath).toBeTruthy();
    expect(fs.existsSync(forced.backupPath!)).toBe(true);

    // legacy 人设（无 manifest）也能被 list
    const legacyDir = path.join(personaDir, "legacy-persona");
    fs.cpSync(TEMPLATE_PERSONA, legacyDir, { recursive: true });
    const installed = listInstalledPacks(personaDir);
    expect(installed.map((item) => item.id)).toEqual(["legacy-persona", "test-pack"]);
    expect(installed.find((item) => item.id === "legacy-persona")?.legacy).toBe(true);
    expect(installed.find((item) => item.id === "test-pack")?.manifest?.version).toBe("1.0.0");
  });

  it("--with-seeds 才写入 T2 记忆", async () => {
    process.env.KAREN_DATA_DIR = path.join(dir, "data");
    const personaDir = path.join(dir, "personas");
    const packDir = path.join(dir, "seed-pack");
    makePack(packDir);
    writeSeeds(packDir, [
      { content: "用户说他叫林哲", source: "chat" },
      { content: "用户养了一只橘猫叫团子", source: "chat" },
      { content: "用户最近在做的项目是咖啡包装", source: "chat" },
    ]);

    // 默认不写
    await installPersonaPack(packDir, { personasDir: personaDir });
    const vector = await import("../data/vector.js");
    const db = vector.getVectorDb();
    const before = db.prepare("SELECT COUNT(*) c FROM t2_episodes WHERE persona_id = 'test-pack'").get() as {
      c: number;
    };
    expect(before.c).toBe(0);

    const withSeeds = await installPersonaPack(packDir, {
      personasDir: personaDir,
      force: true,
      withSeeds: true,
    });
    expect(withSeeds.seedsApplied).toBe(3);
    const after = db.prepare("SELECT COUNT(*) c FROM t2_episodes WHERE persona_id = 'test-pack'").get() as {
      c: number;
    };
    expect(after.c).toBe(3);
  });
});

describe("版本比较", () => {
  it("compareVersions / 引擎版本读取", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(/^\d+\.\d+\.\d+/.test(currentEngineVersion())).toBe(true);
  });
});

/** 运行 pack-cli 子进程；返回退出码与输出。 */
function runPackCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, PACK_CLI, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

describe("pack-cli", () => {
  it("validate 合法包 0、非法包 1；list 正常输出", async () => {
    const packDir = path.join(dir, "cli-pack");
    makePack(packDir);
    const ok = await runPackCli(["validate", packDir]);
    expect(ok.code).toBe(0);
    expect(ok.output).toContain("校验通过");
    expect(ok.output).toContain("test-pack@1.0.0");

    const badDir = path.join(dir, "cli-bad");
    fs.mkdirSync(badDir, { recursive: true });
    const bad = await runPackCli(["validate", badDir]);
    expect(bad.code).toBe(1);
    expect(bad.output).toContain("校验失败");

    const list = await runPackCli(["list"]);
    expect(list.code).toBe(0);
    expect(list.output).toContain("已安装人设");
  }, 30000);
});
