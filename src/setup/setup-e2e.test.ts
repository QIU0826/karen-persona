/**
 * 首次引导 2.0 端到端测试（真实 CLI 子进程 + 临时工作区）。
 *
 * 用「等提示符出现再喂输入」的 driver 模拟人操作 `src/setup.ts`：
 * - 第一遍：选人设 → 第一段对话 → 18+/知情确认 → 标签/QQ → 生成 config/记忆/consent；
 * - 第二遍：断言「已完成引导」提示并直接退出（不重复写）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const SETUP_ENTRY = path.join(REPO_ROOT, "src/setup.ts");

interface Answer {
  /** 输出里出现的提示片段（不含换行） */
  match: string;
  answer: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 运行 setup 子进程；按提示符出现顺序喂答案，超时/提前退出都会抛错。 */
function runSetup(
  workDir: string,
  env: NodeJS.ProcessEnv,
  answers: Answer[] = [],
  timeoutMs = 60000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, SETUP_ENTRY], {
      cwd: workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let cursor = 0;
    let next = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`setup 超时（${timeoutMs}ms）\n--- 输出 ---\n${output}`));
    }, timeoutMs);

    const scan = (chunk: Buffer): void => {
      output += chunk.toString();
      while (next < answers.length) {
        const position = output.indexOf(answers[next].match, cursor);
        if (position < 0) break;
        cursor = position + answers[next].match.length;
        const answer = answers[next].answer;
        next += 1;
        setTimeout(() => {
          if (child.stdin.writable) child.stdin.write(answer + "\n");
        }, 120);
      }
    };

    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (next < answers.length) {
        reject(new Error(`setup 只回答到第 ${next}/${answers.length} 个问题就退出了（code=${code}）\n${output}`));
        return;
      }
      resolve({ code, output });
    });
  });
}

const ANSWERS: Answer[] = [
  { match: "选一个（1-", answer: "1" },
  { match: "你是从哪知道我的", answer: "小红书刷到的" },
  { match: "那我该叫你什么", answer: "林哲" },
  { match: "，你呢？", answer: "杭州" },
  { match: "你已年满 18 岁吗", answer: "y" },
  { match: "标签:", answer: "话痨" },
  { match: "NapCat 反向 WS 端口", answer: "" },
  { match: "允许和她聊天的 QQ 号", answer: "123456" },
];

describe("首次引导 2.0 端到端", () => {
  it(
    "引导完成后记住对话/事实/consent，再次运行直接跳过",
    async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-setup-e2e-"));
      const dataDir = path.join(workDir, "data");
      fs.cpSync(path.join(REPO_ROOT, "personas"), path.join(workDir, "personas"), {
        recursive: true,
      });
      fs.copyFileSync(path.join(REPO_ROOT, ".env.example"), path.join(workDir, ".env.example"));
      const env = { ...process.env, KAREN_DATA_DIR: dataDir };
      delete env.QWEN_VL_API_KEY;
      delete env.UNSPLASH_ACCESS_KEY;
      delete env.OPENWEATHER_API_KEY;

      try {
        const first = await runSetup(workDir, env, ANSWERS);
        expect(first.code).toBe(0);
        expect(first.output).toContain("设置完成");
        expect(first.output).toContain("她记住了你们的第一段对话");

        // config.yaml
        const config = parseYaml(
          fs.readFileSync(path.join(workDir, "config.yaml"), "utf-8"),
        ) as Record<string, unknown>;
        expect(typeof config.persona).toBe("string");
        expect(config.your_name).toBe("林哲");
        expect(config.location).toBe("杭州");
        expect(config.allowed_users).toEqual([123456]);

        // 引导标记
        const marker = JSON.parse(
          fs.readFileSync(path.join(dataDir, "onboarding.json"), "utf-8"),
        ) as { version: number; owners: string[] };
        expect(marker.version).toBe(1);
        expect(marker.owners).toContain("cli:local");
        expect(marker.owners).toContain("qq:123456");

        // 会话里有完整的引导对话
        const sessionFiles = fs
          .readdirSync(dataDir)
          .filter((file) => file.endsWith("-session.json"));
        expect(sessionFiles).toHaveLength(1);
        const session = JSON.parse(
          fs.readFileSync(path.join(dataDir, sessionFiles[0]), "utf-8"),
        ) as { messages: Array<{ role: string; content: string }> };
        expect(session.messages).toHaveLength(7);
        expect(session.messages[0].content).toContain("从哪知道我的");
        expect(session.messages.some((message) => message.content.includes("林哲"))).toBe(true);

        // 事实 + 同意（两个 owner）
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(path.join(dataDir, "memory.sqlite"), { readonly: true });
        try {
          const facts = db
            .prepare("SELECT owner_id, fact_key FROM user_facts ORDER BY owner_id, fact_key")
            .all() as Array<{ owner_id: string; fact_key: string }>;
          expect(facts.filter((row) => row.owner_id === "cli:local").map((row) => row.fact_key)).toEqual([
            "city",
            "how_we_met",
            "name",
          ]);
          expect(facts.some((row) => row.owner_id === "qq:123456")).toBe(true);

          const consent = db
            .prepare("SELECT owner_id FROM user_consent ORDER BY owner_id")
            .all() as Array<{ owner_id: string }>;
          expect(consent.map((row) => row.owner_id)).toEqual(["cli:local", "qq:123456"]);
        } finally {
          db.close();
        }

        // 第二遍：直接跳过，不再写
        const second = await runSetup(workDir, env);
        expect(second.code).toBe(0);
        expect(second.output).toContain("已经完成过首次引导");
        const messagesAfter = JSON.parse(
          fs.readFileSync(path.join(dataDir, sessionFiles[0]), "utf-8"),
        ) as { messages: unknown[] };
        expect(messagesAfter.messages).toHaveLength(7);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    120000,
  );
});
