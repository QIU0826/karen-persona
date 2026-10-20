/**
 * 历史记忆向量重嵌入（v0.5）。
 *
 * 用途：把已有 t2_episodes（semantic_embedding 为 NULL 的）用本地向量模型补上语义向量，
 * 并重建 sqlite-vec 派生索引。幂等：只处理 NULL 行，重复运行安全。
 *
 * 前置：本地向量服务已启动（`npm run embed:start`），且 `KAREN_EMBED=on`。
 * 运行：KAREN_EMBED=on node node_modules/tsx/dist/cli.mjs scripts/reembed.ts
 */
import "dotenv/config";

async function main(): Promise<void> {
  const enabled = (process.env.KAREN_EMBED ?? "").toLowerCase();
  if (!(enabled === "on" || enabled === "1" || enabled === "true" || process.env.KAREN_EMBED_URL)) {
    console.log("未开启本地向量：请设置 KAREN_EMBED=on（或 KAREN_EMBED_URL）后重跑。");
    process.exitCode = 1;
    return;
  }

  const { getConfiguredEmbeddingModel, upgradeEmbeddings } = await import("../src/data/embedding.js");
  const { rebuildVecIndex, getVectorDb } = await import("../src/data/vector.js");

  console.log(`向量模型：${getConfiguredEmbeddingModel()}`);

  const upgraded = await upgradeEmbeddings((done, total) => {
    if (done % 20 === 0 || done === total) console.log(`  进度 ${done}/${total}`);
  });
  console.log(`新回填：${upgraded} 条`);

  const rebuild = rebuildVecIndex();
  console.log(`vec 索引重建：${rebuild} 条`);

  const db = getVectorDb();
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN semantic_embedding IS NOT NULL THEN 1 ELSE 0 END) AS with_semantic,
         COUNT(DISTINCT COALESCE(semantic_model, '(none)')) AS models
       FROM t2_episodes`,
    )
    .get() as { total: number; with_semantic: number; models: number };
  const models = db
    .prepare(
      `SELECT COALESCE(semantic_model,'(none)') AS m, COUNT(*) AS c
       FROM t2_episodes GROUP BY semantic_model`,
    )
    .all() as Array<{ m: string; c: number }>;
  console.log(`库内：${stats.total} 条，其中 ${stats.with_semantic} 条有语义向量`);
  for (const row of models) console.log(`  - ${row.m}: ${row.c}`);
}

main().catch((err: unknown) => {
  console.error("[reembed 失败]", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
