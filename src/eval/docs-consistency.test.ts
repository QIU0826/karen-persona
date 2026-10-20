/**
 * 文档一致性测试（v0.8.7）。
 *
 * 为什么需要：README 曾经长期宣称"亲密度不会被运行时修改""真语义向量未开启"——
 * 代码早改了，文档没人回头改。这里用最小成本锁住最容易腐坏的部分：
 *
 * 1. README 里出现的每个 `npm run xxx` 都必须真实存在于 package.json；
 * 2. README 命令表里提到的每个 `/斜杠命令` 都必须在 `src/commands/control.ts` 里实现；
 * 3. README 里引用的 docs 文件必须真实存在（避免死链）。
 *
 * 注意：不校验"功能描述是否夸大"——那需要人判断，这里只兜住机械性失配。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};
/** 聊天命令分散在两个入口：控制类命令在 control.ts，CLI 专属命令在 test-bot.ts */
const COMMAND_SOURCES = [
  fs.readFileSync(path.join(ROOT, "src", "commands", "control.ts"), "utf-8"),
  fs.readFileSync(path.join(ROOT, "src", "test-bot.ts"), "utf-8"),
];
const MATRIX_PATH = path.join(ROOT, "docs", "CAPABILITY_MATRIX.md");

/** README 里出现的 npm run 脚本名（去掉参数） */
export function extractNpmScripts(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/npm run ([a-z][\w:-]*)/gi)) {
    found.add(match[1]);
  }
  return [...found];
}

/** README 命令表里出现的斜杠命令（形如 `/why`、`/fact ok <key>` → `/fact`） */
export function extractSlashCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[\s|（(`"])\/([a-z][a-z0-9-]*)/gim)) {
    found.add(`/${match[1]}`);
  }
  return [...found];
}

describe("README 与代码保持一致", () => {
  it("README 命令表里列出的命令，代码里都能找到处理分支", () => {
    const listed = ["/why", "/fact", "/relations", "/reflect", "/forget", "/pause", "/resume", "/export", "/age", "/stats", "/help"];
    const missing = listed.filter(
      (cmd) => !COMMAND_SOURCES.some((src) => src.includes(`"${cmd}"`) || src.includes(`case "${cmd.slice(1)}"`)),
    );
    expect(missing, `README 命令表提到但代码没有：${missing.join(", ")}`).toEqual([]);
  });

  it("README 里每个 npm run 脚本都存在于 package.json", () => {
    const missing = extractNpmScripts(README).filter((name) => !(name in PKG.scripts));
    expect(missing, `README 提到但 package.json 没有：${missing.join(", ")}`).toEqual([]);
  });

  it("README 提到的斜杠命令都在 control.ts 里实现", () => {
    // README 里会提到 /api/... 之类的 HTTP 路径，不是聊天命令，排除掉
    const httpPaths = new Set(["/api", "/health", "/cost", "/promo", "/stats"]);
    const candidates = extractSlashCommands(README).filter((cmd) => !httpPaths.has(cmd));
    const missing = candidates.filter((cmd) => {
      const bare = cmd.slice(1);
      // 两种实现形态：control.ts 的 case "why":，或 test-bot.ts 的 cmd === "/journal"
      return !COMMAND_SOURCES.some(
        (src) => new RegExp(`case "${bare}"`).test(src) || src.includes(`"/${bare}"`),
      );
    });
    expect(missing, `README 提到但 control.ts 没有：${missing.join(", ")}`).toEqual([]);
  });

  it("README 引用的 docs 文件都真实存在", () => {
    const refs = new Set<string>();
    for (const match of README.matchAll(/\]\((docs\/[\w./-]+\.md)\)/g)) refs.add(match[1]);
    const missing = [...refs].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, `README 死链：${missing.join(", ")}`).toEqual([]);
  });

  it("README 的功能状态图例与表格里都用同一套符号", () => {
    expect(README).toContain("✅ 已实现且可用");
    expect(README).toContain("🚧 半成品");
    expect(README).toContain("🗺 规划中");
  });
});

describe("extractNpmScripts / extractSlashCommands（解析器自测）", () => {
  it("能从代码块与表格里提取脚本名，忽略参数", () => {
    const md = "`npm run test:coverage` 与 npm run qq:watch -- --duration 900";
    expect(extractNpmScripts(md).sort()).toEqual(["qq:watch", "test:coverage"]);
  });

  it("能提取斜杠命令且不把 /api 之类误当命令", () => {
    const md = "命令：`/why`、`/fact ok name`，接口 `/api/overview`";
    const cmds = extractSlashCommands(md);
    expect(cmds).toContain("/why");
    expect(cmds).toContain("/fact");
    expect(cmds).toContain("/api");
  });
});

describe("能力总表（docs/CAPABILITY_MATRIX.md）", () => {
  it("文件存在且分节齐全", () => {
    expect(fs.existsSync(MATRIX_PATH)).toBe(true);
    const md = fs.readFileSync(MATRIX_PATH, "utf-8");
    for (const section of ["## 1. 记忆", "## 2. 拟人化交互", "## 3. 关系、主动性与演化", "## 4. 媒体", "## 5. 语音", "## 6. 工程与评测", "## 7. 明确未做的事"]) {
      expect(md, `缺少分节：${section}`).toContain(section);
    }
  });

  it("表里引用的所有代码/脚本路径都真实存在（防「文档写了不存在的文件」）", () => {
    const md = fs.readFileSync(MATRIX_PATH, "utf-8");
    const paths = new Set<string>();
    for (const match of md.matchAll(/`((?:src|services|scripts|docs)\/[\w./-]+)`/g)) {
      paths.add(match[1]);
    }
    expect(paths.size).toBeGreaterThan(20);
    const missing = [...paths].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, `能力总表引用了不存在的路径：${missing.join(", ")}`).toEqual([]);
  });

  it("每条能力的实测列都写了数字或明确的'未测/受阻'，不写空话", () => {
    const md = fs.readFileSync(MATRIX_PATH, "utf-8");
    // 抽查几处关键实测数字必须存在（防止有人把数字删了留空）
    expect(md).toContain("97.5%"); // 记忆 recall@8
    expect(md).toContain("100%"); // 锚点精确率
    expect(md).toContain("p95");
    // 用例数会随版本变化，这里只锁「写了具体数字」而不是锁死某个数
    expect(md).toMatch(/\d{2,3} 文件 \/ \d{3,4} 用例/);
    expect(md).toContain("59.21%");
  });
});
