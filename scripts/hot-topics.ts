#!/usr/bin/env node
/** 查看当前抓取到的热榜（百度热搜，过滤敏感新闻）。 */
import "dotenv/config";
import { fetchBaiduHotTitles, titlesToTrendingTopics } from "../src/world/trending-source.js";

async function main(): Promise<void> {
  const raw = await fetchBaiduHotTitles();
  const topics = titlesToTrendingTopics(raw);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ raw: raw.length, safe: topics.length, topics }, null, 2));
    return;
  }
  console.log(`抓到 ${raw.length} 条，过滤后 ${topics.length} 条：`);
  topics.forEach((t, i) => console.log(`${i + 1}. ${t.title}`));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "unknown");
  process.exitCode = 1;
});
