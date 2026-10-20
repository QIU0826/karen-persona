/**
 * 真实 QQ 长跑观察（M2-D 验证工具）。
 *
 * 用途：用户真实发 QQ 消息时，观察桥接的端到端表现，并产出一份可复现的本地报告：
 * - 每轮回复延迟（用户消息 → 她回复的时间差）；
 * - 空回复 / 重复回复；
 * - 成本与调用类型；
 * - 事实/同意是否写入。
 *
 * 设计约束：
 * - **只读**：直接以 readonly 打开 SQLite，不经过 getVectorDb（避免建表/迁移写库）；
 * - 不联网、不依赖桥接进程；可独立跑，也可以边跑桥接边观察；
 * - 报告只写 data/ 目录（含对话原文，权限由调用方控制）。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDir, safeFileStem } from "../data/paths.js";

export interface RunMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface RunUsageRow {
  kind: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_cny: number;
  created_at: number;
  latency_ms: number;
}

export interface RunFact {
  ownerId: string;
  key: string;
  value: string;
}

export interface RunConsent {
  ownerId: string;
  ageConfirmedAt: number | null;
  disclosureAckedAt: number | null;
}

export interface RealRunSnapshot {
  capturedAt: number;
  personaName: string;
  storageKey: string;
  messages: RunMessage[];
  usage: RunUsageRow[];
  facts: RunFact[];
  consent: RunConsent | null;
}

export interface RealRunTurn {
  user: string;
  assistant: string;
  userAt: number;
  assistantAt: number;
  latencyMs: number | null;
}

export interface RealRunReport {
  generatedAt: string;
  capturedAt: string;
  personaName: string;
  windowStart: string | null;
  messageCount: number;
  turnCount: number;
  turns: RealRunTurn[];
  latency: { avgMs: number; p95Ms: number; maxMs: number; samples: number } | null;
  cost: {
    totalCny: number;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    byKind: Array<{ kind: string; calls: number; costCny: number }>;
  };
  quality: { duplicateReplies: number; emptyReplies: number; assistantChars: number };
  memory: {
    facts: number;
    hasConsent: boolean;
    ageConfirmed: boolean;
    disclosureAcked: boolean;
  };
  flags: string[];
}

interface SessionFile {
  personaName: string;
  storageKey: string;
  messages: RunMessage[];
  lastActiveAt: number;
}

function normalizeMessage(raw: unknown): RunMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.role !== "user" && record.role !== "assistant") return null;
  if (typeof record.content !== "string") return null;
  const timestamp =
    typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : 0;
  return { role: record.role, content: record.content, timestamp };
}

/** 读取指定数据目录下最近活跃的会话文件（默认主用户 legacy 文件）。 */
export function readLatestSession(
  dir: string = dataDir(),
  wantedPersona?: string,
): SessionFile | null {
  if (!fs.existsSync(dir)) return null;
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith("-session.json")) continue;
    if (wantedPersona && name !== `${safeFileStem(wantedPersona)}-session.json`) continue;
    try {
      candidates.push({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs });
    } catch {
      // 忽略
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate.file, "utf-8")) as Record<string, unknown>;
      const messages = Array.isArray(raw.messages)
        ? raw.messages.map(normalizeMessage).filter((item): item is RunMessage => item !== null)
        : [];
      return {
        personaName: typeof raw.personaId === "string" ? raw.personaId : "unknown",
        storageKey: typeof raw.storageKey === "string" ? raw.storageKey : "",
        messages,
        lastActiveAt:
          typeof raw.lastActiveAt === "number" && Number.isFinite(raw.lastActiveAt)
            ? raw.lastActiveAt
            : 0,
      };
    } catch {
      // 损坏文件跳过
    }
  }
  return null;
}

type SqliteDb = InstanceType<typeof Database>;

function openReadonlyDb(dir: string): SqliteDb | null {
  const file = path.join(dir, "memory.sqlite");
  if (!fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function safeQuery<T>(db: SqliteDb | null, sql: string, params: unknown[] = []): T[] {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

/**
 * 采集一份只读快照。
 * @param options.sinceMs 只取该时间之后的 llm_usage（消息全部读取，回合按 since 过滤）
 */
export function collectRealRunSnapshot(options: {
  sinceMs?: number;
  personaName?: string;
  dataDirOverride?: string;
} = {}): RealRunSnapshot {
  const dir = options.dataDirOverride ?? dataDir();
  const session = readLatestSession(dir, options.personaName);
  const since = options.sinceMs ?? 0;
  const db = openReadonlyDb(dir);
  try {
    const usage = safeQuery<RunUsageRow>(
      db,
      `SELECT kind, model, prompt_tokens, completion_tokens, cached_tokens, cost_cny, created_at, latency_ms
       FROM llm_usage WHERE created_at >= ? ORDER BY id ASC`,
      [since],
    ).map((row) => ({
      kind: typeof row.kind === "string" ? row.kind : "chat",
      model: typeof row.model === "string" ? row.model : "unknown",
      prompt_tokens: Number(row.prompt_tokens) || 0,
      completion_tokens: Number(row.completion_tokens) || 0,
      cached_tokens: Number(row.cached_tokens) || 0,
      cost_cny: Number(row.cost_cny) || 0,
      created_at: Number(row.created_at) || 0,
      latency_ms: Number(row.latency_ms) || 0,
    }));
    const facts = safeQuery<{ owner_id: string; fact_key: string; fact_value: string }>(
      db,
      "SELECT owner_id, fact_key, fact_value FROM user_facts",
    ).map((row) => ({
      ownerId: String(row.owner_id),
      key: String(row.fact_key),
      value: String(row.fact_value),
    }));
    const consentRows = safeQuery<{
      owner_id: string;
      age_confirmed_at: number | null;
      disclosure_acked_at: number | null;
    }>(db, "SELECT owner_id, age_confirmed_at, disclosure_acked_at FROM user_consent ORDER BY owner_id LIMIT 1");
    const consent =
      consentRows.length > 0
        ? {
            ownerId: String(consentRows[0].owner_id),
            ageConfirmedAt:
              typeof consentRows[0].age_confirmed_at === "number" ? consentRows[0].age_confirmed_at : null,
            disclosureAckedAt:
              typeof consentRows[0].disclosure_acked_at === "number"
                ? consentRows[0].disclosure_acked_at
                : null,
          }
        : null;

    return {
      capturedAt: Date.now(),
      personaName: session?.personaName ?? options.personaName ?? "unknown",
      storageKey: session?.storageKey ?? "",
      messages: (session?.messages ?? []).filter((message) => message.timestamp >= since),
      usage,
      facts,
      consent,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

/** 生成可读报告（纯函数）。 */
export function buildRealRunReport(
  snapshot: RealRunSnapshot,
  options: { sinceMs?: number; now?: number } = {},
): RealRunReport {
  const sinceMs = options.sinceMs ?? 0;
  const now = options.now ?? snapshot.capturedAt;
  const messages = snapshot.messages.filter((message) => message.timestamp >= sinceMs);

  const turns: RealRunTurn[] = [];
  let pendingUser: RunMessage | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    if (!pendingUser) continue;
    turns.push({
      user: pendingUser.content,
      assistant: message.content,
      userAt: pendingUser.timestamp,
      assistantAt: message.timestamp,
      latencyMs:
        message.timestamp > 0 && pendingUser.timestamp > 0
          ? Math.max(0, message.timestamp - pendingUser.timestamp)
          : null,
    });
    pendingUser = null;
  }

  const latencies = turns
    .map((turn) => turn.latencyMs)
    .filter((latency): latency is number => latency !== null)
    .sort((a, b) => a - b);
  const latency = latencies.length
    ? {
        avgMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies[latencies.length - 1],
        samples: latencies.length,
      }
    : null;

  const costByKind = new Map<string, { calls: number; costCny: number }>();
  let totalCny = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  for (const row of snapshot.usage) {
    if (row.created_at < sinceMs) continue;
    totalCny += row.cost_cny;
    promptTokens += row.prompt_tokens;
    completionTokens += row.completion_tokens;
    cachedTokens += row.cached_tokens;
    const bucket = costByKind.get(row.kind) ?? { calls: 0, costCny: 0 };
    bucket.calls += 1;
    bucket.costCny += row.cost_cny;
    costByKind.set(row.kind, bucket);
  }

  const seen = new Set<string>();
  let duplicateReplies = 0;
  let emptyReplies = 0;
  let assistantChars = 0;
  for (const turn of turns) {
    const text = turn.assistant.trim();
    if (!text) {
      emptyReplies += 1;
      continue;
    }
    assistantChars += text.length;
    if (seen.has(text)) duplicateReplies += 1;
    seen.add(text);
  }

  const flags: string[] = [];
  if (emptyReplies > 0) flags.push(`有 ${emptyReplies} 条空回复`);
  if (duplicateReplies > 0) flags.push(`有 ${duplicateReplies} 条重复回复`);
  if (latency && latency.avgMs > 5000) flags.push(`平均响应 ${latency.avgMs}ms（>5s）`);
  if (turns.length > 0 && !snapshot.consent?.ageConfirmedAt) {
    flags.push("有对话但用户未完成 18+ 确认（检查年龄门是否异常放行）");
  }
  if (turns.length > 0 && !snapshot.usage.some((row) => row.created_at >= sinceMs)) {
    flags.push("有对话但没有成本记录（usage 未落库）");
  }
  if (turns.length >= 3 && snapshot.facts.length === 0) {
    flags.push("多轮对话但未抽取到用户事实");
  }

  return {
    generatedAt: new Date(now).toISOString(),
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    personaName: snapshot.personaName,
    windowStart: sinceMs > 0 ? new Date(sinceMs).toISOString() : null,
    messageCount: messages.length,
    turnCount: turns.length,
    turns,
    latency,
    cost: {
      totalCny,
      calls: snapshot.usage.filter((row) => row.created_at >= sinceMs).length,
      promptTokens,
      completionTokens,
      cachedTokens,
      byKind: [...costByKind.entries()]
        .map(([kind, bucket]) => ({ kind, calls: bucket.calls, costCny: bucket.costCny }))
        .sort((a, b) => b.costCny - a.costCny),
    },
    quality: { duplicateReplies, emptyReplies, assistantChars },
    memory: {
      facts: snapshot.facts.length,
      hasConsent: snapshot.consent !== null,
      ageConfirmed: snapshot.consent?.ageConfirmedAt !== null && snapshot.consent?.ageConfirmedAt !== undefined,
      disclosureAcked:
        snapshot.consent?.disclosureAckedAt !== null && snapshot.consent?.disclosureAckedAt !== undefined,
    },
    flags,
  };
}

/** 报告 → Markdown（写 data/ 目录，便于直接打开查看）。 */
export function formatRealRunReportMarkdown(report: RealRunReport): string {
  const lines: string[] = [];
  lines.push(`# 真实 QQ 长跑观察报告`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 人设：${report.personaName}`);
  lines.push(`- 观察窗口起点：${report.windowStart ?? "（全部历史）"}`);
  lines.push(`- 消息 / 回合：${report.messageCount} / ${report.turnCount}`);
  lines.push("");
  lines.push(`## 响应延迟`);
  if (report.latency) {
    lines.push(
      `平均 ${report.latency.avgMs}ms · P95 ${report.latency.p95Ms}ms · 最大 ${report.latency.maxMs}ms（${report.latency.samples} 个样本）`,
    );
  } else {
    lines.push("（没有可计算的样本）");
  }
  lines.push("");
  lines.push(`## 成本`);
  lines.push(
    `合计 ¥${report.cost.totalCny.toFixed(6)} · ${report.cost.calls} 次调用 · prompt ${report.cost.promptTokens} / completion ${report.cost.completionTokens} / 缓存命中 ${report.cost.cachedTokens}`,
  );
  for (const bucket of report.cost.byKind) {
    lines.push(`- ${bucket.kind}: ¥${bucket.costCny.toFixed(6)}（${bucket.calls} 次）`);
  }
  lines.push("");
  lines.push(`## 质量`);
  lines.push(
    `空回复 ${report.quality.emptyReplies} · 重复回复 ${report.quality.duplicateReplies} · 回复总字数 ${report.quality.assistantChars}`,
  );
  lines.push("");
  lines.push(`## 记忆`);
  lines.push(
    `事实 ${report.memory.facts} 条 · 同意记录 ${report.memory.hasConsent ? "有" : "无"} · 18+ ${report.memory.ageConfirmed ? "已确认" : "未确认"} · AI 披露 ${report.memory.disclosureAcked ? "已确认" : "未确认"}`,
  );
  lines.push("");
  lines.push(`## 标记`);
  if (report.flags.length === 0) {
    lines.push("无");
  } else {
    for (const flag of report.flags) lines.push(`- ⚠️ ${flag}`);
  }
  lines.push("");
  lines.push(`## 最近回合`);
  for (const turn of report.turns.slice(-10)) {
    const latency = turn.latencyMs === null ? "?" : `${turn.latencyMs}ms`;
    lines.push(`- [${latency}] 用户：${turn.user.replace(/\n/g, " ").slice(0, 100)}`);
    lines.push(`  她：${turn.assistant.replace(/\n/g, " ").slice(0, 150)}`);
  }
  lines.push("");
  return lines.join("\n");
}
