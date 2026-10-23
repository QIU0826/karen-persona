#!/usr/bin/env node
/**
 * 长期记忆审计（P1-6）。
 *
 * 检查 t2_episodes 里的长期摘要/日志是否有：
 * - 系统标记泄漏（[stream]/[T3]/[对话]/[独白]/[进化日志]）；
 * - 用她的人设名指代用户（角色混淆的强信号）；
 * - 旧承诺反复出现（"答应…语音/照片"）却没有兑现记录。
 *
 * 默认只读；--show 打印摘要；--quarantine 把高置信问题行 strength 设为 0.05
 * （检索过滤 >0.05，可从库中恢复，不物理删除）。
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { dbPath } from "../src/data/paths.js";
import { loadConfig } from "../src/data/store.js";

interface Row {
  id: number;
  persona_id: string;
  source: string;
  content: string;
  strength: number;
}

const LEAK_RE = /\[(?:stream|T3记忆|T3)\]/i;
const STALE_PROMISE_RE = /(答应|说好|等会|忙完)[^。！？\n]{0,16}(语音|照片|录|拍)/;

function main(): void {
  const args = new Set(process.argv.slice(2));
  const show = args.has("--show");
  const quarantine = args.has("--quarantine");
  const config = loadConfig();
  const personaName = config.persona;

  const db = new Database(dbPath(), { fileMustExist: true, readonly: !quarantine });
  try {
    const rows = db
      .prepare(
        `SELECT id, persona_id, source, content, strength FROM t2_episodes
         WHERE strength > 0.05 AND source IN ('t3_summary','persona_journal','chat')
         ORDER BY id ASC`,
      )
      .all() as Row[];

    let flagged = 0;
    const fixIds: number[] = [];
    for (const row of rows) {
      const flags: string[] = [];
      // chat 的 [对话] 前缀是正常存储格式，只有 [stream]/[T3] 才是泄漏。
      if (LEAK_RE.test(row.content)) flags.push("系统标记泄漏");
      if (row.source !== "chat" && new RegExp(personaName).test(row.content)) {
        flags.push("用人设名指代用户/角色混淆");
      }
      if (row.source !== "chat" && STALE_PROMISE_RE.test(row.content)) {
        flags.push("旧承诺反复出现");
      }
      if (row.source !== "chat" && /她/.test(row.content)) {
        flags.push("摘要含第三人称她（待人工确认）");
      }
      if (flags.length === 0) continue;
      flagged++;
      // 自动隔离只处理高置信问题：旧承诺循环，或 T3 摘要里第三人称她（角色说混）。
      // 单纯的 [T3记忆]/[进化日志] 前缀是正常格式，注入前会清洗，不自动隔离。
      if (
        quarantine &&
        (flags.includes("旧承诺反复出现") ||
          (row.source === "t3_summary" && flags.includes("摘要含第三人称她（待人工确认）")))
      ) {
        fixIds.push(row.id);
      }
      const summary = show ? `  ${row.content.slice(0, 50)}` : "";
      console.log(`#${row.id} [${row.source}] ${flags.join("、")}${summary}`);
    }

    console.log(`\n共扫 ${rows.length} 条，${flagged} 条需关注。`);
    if (quarantine && fixIds.length > 0) {
      const stmt = db.prepare("UPDATE t2_episodes SET strength = 0.05, salience = 0 WHERE id = ?");
      let changed = 0;
      for (const id of fixIds) changed += stmt.run(id).changes;
      console.log(`已隔离 ${changed} 条高置信问题记忆（strength=0.05，可恢复）。`);
    } else if (!quarantine && flagged > 0) {
      console.log("只读模式；确认后加 --quarantine 隔离高置信问题行。");
    }
  } finally {
    db.close();
  }
}

main();
