/**
 * Qzone 自主动态「只生成不发布」预览：真实走 B 站只读 → 人设草稿 → 内容安全。
 * 使用临时数据目录，不碰 data/、不发 QQ 空间。
 * 运行：npm run qzone:preview
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-qzone-preview-"));
  process.env.KAREN_DATA_DIR = tmp;
  await import("dotenv/config");

  const { loadConfig } = await import("../src/data/store.js");
  const { loadPersona } = await import("../src/persona/loader.js");
  const { initConversation } = await import("../src/pipeline/orchestrator.js");
  const { maybeAutoPublishQzone } = await import("../src/qzone/qzone-auto.js");

  const config = loadConfig();
  const persona = await loadPersona(config.persona);
  const state = await initConversation(persona, config, "cli:local");

  const result = await maybeAutoPublishQzone(state, { lastDate: null }, new Date(), {
    random: () => 0,
    photoCandidates: () => [],
    publish: async () => ({ ok: true, tid: "preview-only" }),
  });

  console.log(JSON.stringify({
    posted_preview: result.posted,
    source: result.source,
    reason: result.reason,
    content: result.content,
    tid: result.tid,
  }, null, 2));
  if (!result.posted) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`qzone preview failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
