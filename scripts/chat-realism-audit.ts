#!/usr/bin/env node
/**
 * 对话真人化巡检（每 5 分钟可跑一次）。
 *
 * 读取最近会话 JSON，用独立 LLM 判断：
 *  - 是否像真人聊天（不是客服/AI 总结腔）
 *  - 是否脱离上下文、认错图片/表情包、重复、答非所问
 *  - 表情包使用是否合理
 *  - 可执行的 prompt/逻辑调整建议
 *
 * 输出：data/realism-audit/latest.json + latest.md
 * 无新消息时跳过（不重复花 API 钱）。
 *
 * 用法：npm run chat:audit [-- --force --limit 40 --persona 小雅]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { loadSession } from "../src/data/history.js";

const AUDIT_DIR = path.resolve("data/realism-audit");
const STATE_PATH = path.join(AUDIT_DIR, "state.json");
const DEFAULT_PERSONA = "小雅";
const DEFAULT_LIMIT = 40;

interface AuditIssue {
  type: string;
  severity: "low" | "medium" | "high";
  evidence: string;
  fix: string;
}

interface AuditReport {
  human_likeness: number;
  summary: string;
  issues: AuditIssue[];
  keep: string[];
  prompt_fixes: string[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function compact(text: string, max = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function readState(): { hash: string; at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { hash: string; at: number };
  } catch {
    return null;
  }
}

function writeState(hash: string): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ hash, at: Date.now() }, null, 2), "utf8");
}

function lastMessageHash(messages: Array<{ role: string; content: string; timestamp: number }>): string {
  const last = messages[messages.length - 1];
  return last ? `${last.timestamp}:${last.role}:${last.content.slice(0, 80)}` : "empty";
}

function formatTranscript(messages: Array<{ role: string; content: string; timestamp: number }>, limit: number): string {
  return messages
    .slice(-limit)
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
      const who = m.role === "user" ? "他" : "她";
      return `${time} ${who}: ${m.content}`;
    })
    .join("\n");
}

async function main(): Promise<void> {
  const persona = arg("persona", DEFAULT_PERSONA) ?? DEFAULT_PERSONA;
  const limit = Math.max(10, Math.min(80, Number(arg("limit", String(DEFAULT_LIMIT))) || DEFAULT_LIMIT));
  const force = hasFlag("force");
  const session = loadSession(persona);
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const messages = session.messages;
  if (messages.length < 2) {
    console.log("[chat:audit] 会话消息不足，跳过");
    return;
  }
  const hash = lastMessageHash(messages);
  const previous = readState();
  if (!force && previous?.hash === hash) {
    console.log("[chat:audit] 无新消息，跳过");
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === "sk-your-key-here") {
    console.error("[chat:audit] DEEPSEEK_API_KEY 未配置");
    process.exitCode = 1;
    return;
  }
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    timeout: 30_000,
    maxRetries: 0,
  });
  const transcript = formatTranscript(messages, limit);
  const prompt = `你是严格的真人聊天质检员。下面是一段角色"小雅"（咖啡店店员，蓝发短发，和用户暧昧/熟悉）和用户的 QQ 聊天记录。
请判断"小雅"的回复像不像真人，重点抓：
1) 有没有 AI/客服腔：总结、说教、每条都完整句、过度解释、重复句式；
2) 有没有脱离上下文：认错图片/照片/表情包、答非所问、忘记刚说过的事、把用户发的图当成自己拍的；
3) 表情包使用是否合理：是否过度连发、是否误读表情含义、是否只会回表情包不接话；
4) 是否有真人感：短句、停顿、接话、情绪、生活细节、偶尔反问；
5) 有没有明显 OOC 或安全边界问题（不展开色情/自伤细节）。
只输出 JSON，不要 Markdown：
{"human_likeness":1-10,"summary":"一句话","issues":[{"type":"AI腔/上下文/表情包/重复/其他","severity":"low|medium|high","evidence":"原文片段","fix":"具体改法"}],"keep":["做得好的点"],"prompt_fixes":["可以直接加到系统提示/逻辑的规则"]}

聊天记录：
${transcript}`;
  try {
    const response = await client.chat.completions.create({
      model: process.env.DEEPSEEK_VISION_MODEL || "deepseek-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1200,
      temperature: 0.2,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("empty response");
    const report = JSON.parse(content) as AuditReport;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    fs.writeFileSync(path.join(AUDIT_DIR, "latest.json"), JSON.stringify({ persona, at: Date.now(), report }, null, 2), "utf8");
    fs.writeFileSync(path.join(AUDIT_DIR, `audit-${stamp}.json`), JSON.stringify({ persona, at: Date.now(), report }, null, 2), "utf8");
    const md = [
      `# 对话真人化巡检 · ${persona}`,
      ``,
      `- 时间：${new Date().toLocaleString("zh-CN")}`,
      `- 真人感：**${report.human_likeness}/10**`,
      `- 总结：${report.summary}`,
      ``,
      `## 问题`,
      ...report.issues.map((i) => `- [${i.severity}] ${i.type}：${i.evidence} → ${i.fix}`),
      ``,
      `## 保持`,
      ...report.keep.map((k) => `- ${k}`),
      ``,
      `## Prompt/逻辑建议`,
      ...report.prompt_fixes.map((p) => `- ${p}`),
    ].join("\n");
    fs.writeFileSync(path.join(AUDIT_DIR, "latest.md"), md + "\n", "utf8");
    writeState(hash);
    console.log(JSON.stringify({ human_likeness: report.human_likeness, issues: report.issues.length, summary: report.summary }, null, 2));
    console.log(`[chat:audit] -> data/realism-audit/latest.md`);
  } catch (err: unknown) {
    console.error(`[chat:audit] failed: ${err instanceof Error ? err.message : "unknown"}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`[chat:audit] fatal: ${err instanceof Error ? err.message : "unknown"}`);
  process.exitCode = 1;
});
