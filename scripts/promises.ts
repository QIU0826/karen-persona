#!/usr/bin/env node
/**
 * 承诺账本查看（P1-1）。
 *
 * 用法：npm run promises
 * 只读；显示还没兑现的承诺/他的重要日程 + 下一轮 prompt 注入预览（不含聊天全文）。
 */
import "dotenv/config";
import { loadConfig } from "../src/data/store.js";
import { ownerForQq, resolveOwnerScope } from "../src/data/owner.js";
import { getPromiseInjection, listOpenPromises } from "../src/data/promise-ledger.js";

function main(): void {
  const config = loadConfig();
  const qq = config.allowed_users[0];
  if (!qq) {
    console.error("config.yaml 没有 allowed_users，无法定位主用户");
    process.exitCode = 1;
    return;
  }
  const ident = resolveOwnerScope(config.persona, ownerForQq(qq), config.allowed_users);
  const now = Date.now();
  const rows = listOpenPromises(ident.owner, ident.storagePersona, now, 10);
  console.log(`== 未兑现承诺 / 重要日程（${ident.owner} / ${ident.storagePersona}）==`);
  if (rows.length === 0) {
    console.log("（空）");
    return;
  }
  for (const row of rows) {
    const ageMin = Math.max(1, Math.round((now - row.created_at) / 60_000));
    const due = row.due_at
      ? row.due_at <= now
        ? "已到期"
        : `约 ${Math.round((row.due_at - now) / 60_000)} 分钟后`
      : "无具体时间";
    console.log(`#${row.id} [${row.kind}] ${ageMin} 分钟前  ${due}  ${row.content.slice(0, 60)}`);
  }
  const injection = getPromiseInjection(ident.owner, ident.storagePersona, now);
  if (injection) {
    console.log("\n== 下一轮注入预览 ==");
    console.log(injection.trim());
  }
}

main();
