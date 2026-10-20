#!/usr/bin/env tsx
/**
 * 人设校验 CLI
 * 用法: npx tsx src/persona/check.ts [persona-id]
 */
import { validatePersona, listPersonas, CURRENT_SCHEMA_VERSION } from "./loader.js";
import fs from "node:fs";
import path from "node:path";

const PERSONAS_DIR = path.resolve("personas");

async function main() {
  const personaId = process.argv[2];
  const checkAll = !personaId || personaId === "--all";

  if (checkAll) {
    console.log(`🔍 校验所有人设（引擎 schema v${CURRENT_SCHEMA_VERSION}）\n`);
    const ids = listPersonas();
    if (ids.length === 0) {
      console.log("  (无)  —  personas/ 目录下没有人设");
      return;
    }

    let totalErrors = 0;
    let totalWarnings = 0;

    for (const id of ids) {
      const personaPath = path.join(PERSONAS_DIR, id, "persona.json");
      const raw = JSON.parse(fs.readFileSync(personaPath, "utf-8"));
      const result = validatePersona(raw, id);

      console.log(`── ${id} ──`);
      if (result.errors.length > 0) {
        for (const e of result.errors) console.log(`  ❌ ${e}`);
      }
      for (const w of result.warnings) console.log(`  ⚠️  ${w}`);
      if (result.errors.length === 0 && result.warnings.length === 0) {
        console.log("  ✅ 通过");
      }
      console.log();
      totalErrors += result.errors.length;
      totalWarnings += result.warnings.length;
    }

    console.log(`\n汇总: ${ids.length} 个人设, ${totalErrors} 错误, ${totalWarnings} 警告`);
    if (totalErrors > 0) process.exit(1);
    return;
  }

  // 校验单个人设
  console.log(`🔍 校验 "${personaId}"（引擎 schema v${CURRENT_SCHEMA_VERSION}）\n`);

  const personaPath = path.join(PERSONAS_DIR, personaId, "persona.json");
  if (!fs.existsSync(personaPath)) {
    console.error(`❌ 人设 "${personaId}" 不存在`);
    console.log(`可用: ${listPersonas().join(", ")}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(personaPath, "utf-8"));
  const result = validatePersona(raw, personaId);

  for (const e of result.errors) console.log(`  ❌ ${e}`);
  for (const w of result.warnings) console.log(`  ⚠️  ${w}`);
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("  ✅ 通过");
  }

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("运行失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
