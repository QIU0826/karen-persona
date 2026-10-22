#!/usr/bin/env node
/**
 * 生成一张 Karen 自拍缓存，强制使用 karen-selfie-cafe.jpg 的统一画风。
 *
 * 用法：
 *   npm run image:selfie -- \
 *     --name spring-park \
 *     --context "她在春天的公园长椅上自拍，穿浅色开衫，阳光很好" \
 *     --prompt "春天公园长椅自拍，浅色开衫，阳光很好" \
 *     --seed 91
 *
 * 产物：assets/photos/karen-selfie-<name>.png + .audit.json
 * 注意：入库前用 sips 转 jpg，并在 photo-library.ts 加 PhotoDef。
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { auditImage } from "../src/ai/image-guard.js";
import { generateQwenImageEdit } from "../src/ai/qwen-image-edit.js";
import { SELFIE_STYLE_REF, buildSelfiePrompt } from "../src/media/selfie-style.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

async function main(): Promise<void> {
  const name = arg("name");
  const context = arg("context");
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error("缺少合法 --name（小写字母/数字/连字符）");
    process.exitCode = 1;
    return;
  }
  if (!context) {
    console.error("缺少 --context（聊天上下文/场景）");
    process.exitCode = 1;
    return;
  }
  const scenePrompt = arg("prompt", context) ?? context;
  const prompt = buildSelfiePrompt(scenePrompt);
  const out = path.resolve(arg("out", `assets/photos/karen-selfie-${name}.png`) ?? "");
  const seed = Number(arg("seed", "0")) || 0;
  const steps = Math.max(8, Math.min(60, Number(arg("steps", "20")) || 20));

  console.log(`[image:selfie] style=cafe prompt=${prompt}`);
  const generated = await generateQwenImageEdit(prompt, {
    simple: true,
    steps,
    seed,
    imagePaths: [SELFIE_STYLE_REF],
    timeoutMs: 300_000,
  });
  if (!generated) {
    console.error("[image:selfie] generation failed");
    process.exitCode = 1;
    return;
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, generated.png);
  console.log(`[image:selfie] candidate -> ${out} (${generated.width}x${generated.height}, ${(generated.elapsedMs / 1000).toFixed(1)}s)`);

  const audit = await auditImage(generated.png, {
    context,
    prompt,
    requireNoHands: true,
    expectCharacter: true,
  });
  if (!audit) {
    console.error("[image:selfie] guard unavailable -> fail-closed");
    process.exitCode = 1;
    return;
  }
  await fs.writeFile(out.replace(/\.png$/i, ".audit.json"), JSON.stringify(audit, null, 2));
  console.log(`[image:selfie] audit=${JSON.stringify(audit)}`);
  if (!audit.pass) {
    console.error("[image:selfie] REJECTED; 不加入缓存");
    process.exitCode = 2;
    return;
  }
  console.log(`[image:selfie] PASS。下一步：`);
  console.log(`  sips -s format jpeg -s formatOptions 88 ${out} --out ${out.replace(/\.png$/i, ".jpg")}`);
  console.log(`  在 src/impulse/photo-library.ts 加 selfie 标签 PhotoDef，并同步图库数量断言。`);
}

main().catch((err: unknown) => {
  console.error(`[image:selfie] fatal: ${err instanceof Error ? err.message : "unknown"}`);
  process.exitCode = 1;
});
