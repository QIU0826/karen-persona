#!/usr/bin/env node
/**
 * 发图场景匹配 / 配文一致性评测（v0.9.12，零成本、离线、可复现）。
 *
 * 背景：用户说「拍张晚霞」，照片却是一杯咖啡、配文还写「天这样了」——
 * 图库没有对应标签时会回退到全库随机，而旧代码**只要检测到场景词就用场景配文**，
 * 于是配文声称的场景和图片内容对不上。
 *
 * 本脚本对一组典型场景话术 × 每个 200 次确定性抽样，统计：
 *   1. 场景命中率：选出来的图是否真的带用户提到的场景标签；
 *   2. 配文一致性：场景配文是否只盖在真有该场景的图上（旧逻辑 / 新逻辑对比）。
 *
 * 用法（仓库根目录）：
 *   node node_modules/tsx/dist/cli.mjs scripts/photo-scene-eval.ts [--json]
 */
import { detectPhotoSceneTags } from "../src/impulse/media-request.js";
import { buildSceneCaptionWithTag } from "../src/impulse/media-relevance.js";
import { chooseLocalPhotoShare, pickPhotoShare } from "../src/impulse/photo-library.js";

const DRAWS_PER_SCENE = 200;

/** 典型用户话术（覆盖她人设里高频场景 + 一些图库没有的场景） */
const SCENES: Array<{ phrase: string; expectContains?: string[] }> = [
  { phrase: "今天下雪了，拍张照片看看" },
  { phrase: "拍张晚霞给我看看" },
  { phrase: "来张咖啡的照片" },
  { phrase: "你那只猫呢，拍张看看" },
  { phrase: "周末去爬山了，有照片吗" },
  { phrase: "花开了没，拍一张" },
  { phrase: "外面下雨了，拍张你窗边的" },
  { phrase: "拍张你店里的样子" },
  { phrase: "晚饭吃啥了，拍张照片" },
  { phrase: "湖边那张给我看看" },
  { phrase: "早上好，拍张清晨的照片" },
  { phrase: "发张城市街头的照片" },
  { phrase: "你平时看书吗，拍张书桌" }, // 图库暂无 book 场景（除新图）
  { phrase: "海边有照片吗" },
  { phrase: "早饭吃啥了，拍一张" },
  { phrase: "半夜饿了，有夜宵照片吗" },
  { phrase: "路边买杯奶茶，拍张看看" },
];

interface SceneResult {
  phrase: string;
  tags: string[];
  libraryMatchRate: number;
  oldCaptionInconsistentRate: number;
  newCaptionInconsistentRate: number;
  scenesWithoutPhoto: boolean;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evaluate(): SceneResult[] {
  const results: SceneResult[] = [];
  for (const [index, scene] of SCENES.entries()) {
    const tags = detectPhotoSceneTags(scene.phrase);
    if (tags.length === 0) {
      results.push({
        phrase: scene.phrase,
        tags,
        libraryMatchRate: 0,
        oldCaptionInconsistentRate: 0,
        newCaptionInconsistentRate: 0,
        scenesWithoutPhoto: false,
      });
      continue;
    }
    let matched = 0;
    let oldInconsistent = 0;
    let newInconsistent = 0;
    let anyPhoto = false;
    for (let draw = 0; draw < DRAWS_PER_SCENE; draw++) {
      const random = makeRandom(index * 100000 + draw + 1);
      const choice = chooseLocalPhotoShare({
        emotion: 0,
        hour: 15,
        closeness: 5,
        tags,
        random,
      });
      if (!choice) continue;
      anyPhoto = true;
      const photoHasScene = tags.some((tag) => choice.photo.tags.includes(tag));
      if (photoHasScene) matched += 1;
      // 新逻辑：只有照片真有该场景时才可能用场景配文
      if (choice.captionSource === "scene" && !photoHasScene) newInconsistent += 1;
      // 旧逻辑：只要检测到场景词就无条件用场景配文（复现旧行为）
      const oldScene = buildSceneCaptionWithTag(tags, random);
      if (oldScene) oldInconsistent += photoHasScene && choice.photo.tags.includes(oldScene.tag) ? 0 : 1;
    }
    results.push({
      phrase: scene.phrase,
      tags,
      libraryMatchRate: anyPhoto ? matched / DRAWS_PER_SCENE : 0,
      oldCaptionInconsistentRate: anyPhoto ? oldInconsistent / DRAWS_PER_SCENE : 0,
      newCaptionInconsistentRate: anyPhoto ? newInconsistent / DRAWS_PER_SCENE : 0,
      scenesWithoutPhoto: !anyPhoto,
    });
  }
  return results;
}

function main(): void {
  const results = evaluate();
  const jsonMode = process.argv.includes("--json");
  console.log("— 发图场景匹配 / 配文一致性评测（离线，200 次/场景）—");
  console.log("");
  console.log("| 用户话术 | 检测标签 | 图库有对应图 | 场景命中率 | 旧逻辑配文不一致 | 新逻辑配文不一致 |");
  console.log("|---|---|---|---|---|---|");
  for (const result of results) {
    const tagsLabel = result.tags.length > 0 ? result.tags.join("/") : "（无场景词）";
    console.log(
      `| ${result.phrase} | ${tagsLabel} | ${result.tags.length === 0 ? "—" : result.scenesWithoutPhoto ? "❌ 无" : "✅"} | ${result.tags.length === 0 ? "—" : `${Math.round(result.libraryMatchRate * 100)}%`} | ${result.tags.length === 0 ? "—" : `${Math.round(result.oldCaptionInconsistentRate * 100)}%`} | ${result.tags.length === 0 ? "—" : `${Math.round(result.newCaptionInconsistentRate * 100)}%`} |`,
    );
  }

  const withTags = results.filter((result) => result.tags.length > 0);
  const avgMatch = withTags.reduce((sum, result) => sum + result.libraryMatchRate, 0) / withTags.length;
  const avgOld = withTags.reduce((sum, result) => sum + result.oldCaptionInconsistentRate, 0) / withTags.length;
  const avgNew = withTags.reduce((sum, result) => sum + result.newCaptionInconsistentRate, 0) / withTags.length;
  const missing = results.filter((result) => result.tags.length > 0 && result.scenesWithoutPhoto).map((r) => r.phrase);

  console.log("");
  console.log("— 汇总 —");
  console.log(`场景词覆盖率：${results.length - withTags.length === 0 ? "100%" : `${withTags.length}/${results.length}`}`);
  console.log(`平均场景命中率：${Math.round(avgMatch * 100)}%`);
  console.log(`旧逻辑配文不一致：${Math.round(avgOld * 100)}%`);
  console.log(`新逻辑配文不一致：${Math.round(avgNew * 100)}%`);
  if (missing.length > 0) console.log(`图库缺场景：${missing.join("；")}`);

  const failures: string[] = [];
  if (avgNew > 0) failures.push(`新逻辑仍有配文不一致（${Math.round(avgNew * 100)}%）`);
  if (avgMatch < 0.9) failures.push(`场景命中率偏低（${Math.round(avgMatch * 100)}% < 90%）`);
  console.log("");
  console.log("— 结论 —");
  if (failures.length === 0) {
    console.log(" ✅ 配文不再盖到无关图上；场景词命中率达标");
  } else {
    for (const failure of failures) console.log(` ✗ ${failure}`);
  }
  if (jsonMode) console.log(JSON.stringify({ results, avgMatch, avgOld, avgNew, missing }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main();
