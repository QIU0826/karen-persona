#!/usr/bin/env node
/**
 * 真实会话一致性回放（P1-5）。
 *
 * 用法：npm run consistency:eval [-- --json] [-- --window 30]
 * 读取当前主用户的 session JSON，扫描她 30 分钟内「忙/闲、在店/在家」的硬矛盾，
 * 并列出未兑现承诺数量；不修改任何数据。
 */
import "dotenv/config";
import { loadConfig } from "../src/data/store.js";
import { loadPersona } from "../src/persona/loader.js";
import { loadSession } from "../src/data/history.js";
import { ownerForQq, resolveOwnerScope } from "../src/data/owner.js";
import { evaluateConsistency } from "../src/eval/chat-consistency.js";
import { listOpenPromises } from "../src/data/promise-ledger.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const qq = config.allowed_users[0];
  if (!qq) {
    console.error("config.yaml 没有 allowed_users");
    process.exitCode = 1;
    return;
  }
  const scope = resolveOwnerScope(config.persona, ownerForQq(qq), config.allowed_users);
  const persona = await loadPersona(config.persona);
  const session = loadSession(persona.name, scope.storageKey);
  const windowMinutes = Number(argValue("window") ?? 30);
  const report = evaluateConsistency(session.messages, {
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : 30,
  });
  const openPromises = listOpenPromises(scope.owner, scope.storagePersona, Date.now(), 20);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ report, open_promises: openPromises.length }, null, 2));
    return;
  }

  console.log(`== 一致性回放（${scope.owner} / ${scope.storagePersona}）==`);
  console.log(`检查她最近 ${report.checkedMessages} 条消息，硬矛盾 ${report.issues.length} 个，评分 ${report.score}/100`);
  for (const issue of report.issues) {
    const at = new Date(issue.at).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const label = issue.kind === "busy_idle" ? "忙/闲矛盾" : "在店/在家矛盾";
    console.log(`- ${at}  ${label}（相隔 ${issue.gapMinutes} 分钟）`);
  }
  console.log(`未兑现承诺：${openPromises.length} 条（npm run promises 查看）`);
  if (report.issues.length === 0) console.log("✅ 没发现可确定判定的前后矛盾");
}

main().catch((err: unknown) => {
  console.error(`一致性回放失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
