import "dotenv/config";
/**
 * 单张图片质检 CLI（不生成，只检查）。
 *
 * 用法：
 *   npm run image:audit -- --image data/image-samples/foo.png \
 *     --context "她坐在咖啡馆窗边，下午阳光"
 */
import fs from "node:fs/promises";
import { auditImage } from "../src/ai/image-guard.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const image = arg("image");
  const context = arg("context");
  if (!image || !context) {
    console.error("用法: npm run image:audit -- --image <png> --context <聊天上下文> [--prompt <生图prompt>]");
    process.exitCode = 1;
    return;
  }
  const png = await fs.readFile(image);
  const audit = await auditImage(png, {
    context,
    prompt: arg("prompt"),
    requireNoHands: hasFlag("require-no-hands"),
  });
  if (!audit) {
    console.error("[image:audit] guard unavailable/parse failed -> fail-closed");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(audit, null, 2));
  process.exitCode = audit.pass ? 0 : 2;
}

main().catch((err: unknown) => {
  console.error(`[image:audit] fatal: ${err instanceof Error ? err.message : "unknown"}`);
  process.exitCode = 1;
});
