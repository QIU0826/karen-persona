#!/usr/bin/env node
/**
 * 锚点审计（P0-4）：检查现有锚点是否通过归属/证据校验。
 *
 * 用法：
 *   npm run anchor:audit            # 只读，列出可疑锚点（不打印摘要正文）
 *   npm run anchor:audit -- --show  # 同时打印摘要（你自己机器上）
 *   npm run anchor:audit -- --fix   # 软删除不可信锚点（写 valid_to，可回溯）
 *
 * 背景：真实库 4 条锚点里至少 2 条把用户的经历记成「共同经历」，
 * 注入时却写「这些是你们真实经历过的事」，会让她说出不存在的共同记忆。
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { dbPath } from "../src/data/paths.js";
import { validateAnchorVerdict } from "../src/data/anchor-validation.js";

interface AnchorAuditRow {
  id: number;
  kind: string;
  summary: string;
  quote: string | null;
  created_at: number;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const show = args.has("--show");
  const fix = args.has("--fix");

  const db = new Database(dbPath(), { fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, kind, summary, quote, created_at
         FROM memory_anchors
         WHERE valid_to IS NULL
         ORDER BY created_at ASC`,
      )
      .all() as AnchorAuditRow[];

    console.log(`锚点审计：${rows.length} 条有效锚点（${dbPath()}）`);
    if (rows.length === 0) return;

    let rejected = 0;
    for (const row of rows) {
      const result = validateAnchorVerdict(
        { content: row.quote ?? row.summary, source: "unknown" },
        { anchor: true, kind: row.kind, summary: row.summary },
      );
      if (result.ok) continue;
      rejected++;
      const summary = show ? `  ${row.summary.slice(0, 50)}` : "";
      console.log(`  #${row.id} [${row.kind}] 不可信：${result.reason}${summary}`);
    }

    if (rejected === 0) {
      console.log("✅ 全部锚点通过归属/证据校验");
      return;
    }

    console.log(`\n共 ${rejected} 条不可信锚点。`);
    if (!fix) {
      console.log("只读模式：加 --fix 会软删除这些锚点（写 valid_to，可回溯），不会物理删除。");
      return;
    }
    const now = Date.now();
    const stmt = db.prepare(
      "UPDATE memory_anchors SET valid_to = ? WHERE id = ? AND valid_to IS NULL",
    );
    let changed = 0;
    for (const row of rows) {
      const result = validateAnchorVerdict(
        { content: row.quote ?? row.summary, source: "unknown" },
        { anchor: true, kind: row.kind, summary: row.summary },
      );
      if (result.ok) continue;
      const info = stmt.run(now, row.id);
      if (info.changes > 0) changed++;
    }
    console.log(`已软删除 ${changed} 条不可信锚点（valid_to=${now}），可用 SQL 回滚。`);
  } finally {
    db.close();
  }
}

main();
