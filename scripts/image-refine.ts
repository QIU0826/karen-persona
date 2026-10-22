import "dotenv/config";
/**
 * 图片生成 + 上下文/异常质检 + 自动简化重试。
 *
 * 用法：
 *   npm run image:refine -- \
 *     --context "她坐在咖啡馆窗边看书，下午阳光" \
 *     --prompt "坐在咖啡馆窗边看书，桌上有一杯咖啡，下午阳光" \
 *     --out data/image-samples/refine-cafe.png
 *
 * 每张图都会用独立视觉模型检查：
 *   - 是否符合聊天上下文
 *   - 角色是否一致
 *   - 手/手指/四肢/脸/背景是否有异常
 * 不合格会自动降级到更简单的构图重试，仍不合格则退出码 2（fail-closed）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { auditImage, type ImageAudit } from "../src/ai/image-guard.js";
import {
  generateQwenImageEdit,
  isQwenImageEditEnabled,
  qwenImageEditBaseUrl,
} from "../src/ai/qwen-image-edit.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function defaultOut(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `data/image-samples/refine-${stamp}.png`;
}

function simplify(prompt: string, attempt: number): string {
  if (attempt <= 0) return prompt;
  return `${prompt.replace(/[。；;]+$/g, "")}；画面简洁，人物胸部以上近景，背景干净，不出现手、手臂、文字、水印，自然真实`;
}

async function main(): Promise<void> {
  if (!isQwenImageEditEnabled()) {
    console.error("QWEN_IMAGE_EDIT_URL 未配置；请先在 .env 指向 127.0.0.1:19110");
    process.exitCode = 1;
    return;
  }
  const context = arg("context");
  if (!context) {
    console.error("缺少 --context（聊天上下文/期望画面）");
    process.exitCode = 1;
    return;
  }
  const basePrompt = arg("prompt", context) ?? context;
  const out = path.resolve(arg("out", defaultOut()) ?? defaultOut());
  const retries = Math.max(0, Math.min(3, Number(arg("retries", "2")) || 0));
  const steps = Math.max(8, Math.min(60, Number(arg("steps", "20")) || 20));
  const seed = Number(arg("seed", "0")) || 0;
  const simple = arg("simple", "true") !== "false";
  const skipGuard = hasFlag("no-guard");
  await fs.mkdir(path.dirname(out), { recursive: true });

  console.log(`[image:refine] endpoint=${qwenImageEditBaseUrl()} steps=${steps} simple=${simple} retries=${retries}`);
  let lastAudit: ImageAudit | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const prompt = simplify(basePrompt, attempt);
    const startedAt = Date.now();
    const generated = await generateQwenImageEdit(prompt, {
      simple,
      steps,
      seed: seed + attempt,
      timeoutMs: 300_000,
    });
    if (!generated) {
      console.error(`[image:refine] try ${attempt + 1}: generation failed`);
      continue;
    }
    const candidate = out.replace(/\.png$/i, `-try${attempt + 1}.png`);
    await fs.writeFile(candidate, generated.png);
    console.log(
      `[image:refine] try ${attempt + 1}: generated ${generated.width ?? "?"}x${generated.height ?? "?"} ` +
        `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${candidate}`,
    );

    if (skipGuard) {
      await fs.copyFile(candidate, out);
      console.log("[image:refine] guard skipped (--no-guard)");
      return;
    }

    const audit = await auditImage(generated.png, { context, prompt, requireNoHands: simple });
    if (!audit) {
      console.error(`[image:refine] try ${attempt + 1}: guard unavailable -> fail-closed`);
      lastAudit = null;
      continue;
    }
    lastAudit = audit;
    console.log(`[image:refine] try ${attempt + 1} audit: ${JSON.stringify(audit)}`);
    if (audit.pass) {
      await fs.copyFile(candidate, out);
      await fs.writeFile(out.replace(/\.png$/i, ".audit.json"), JSON.stringify(audit, null, 2));
      console.log(`[image:refine] PASS -> ${out}`);
      return;
    }
  }

  const lastCandidate = out.replace(/\.png$/i, `-try${retries + 1}.png`);
  try {
    await fs.access(lastCandidate);
    await fs.copyFile(lastCandidate, out);
  } catch {
    // no candidate
  }
  if (lastAudit) {
    await fs.writeFile(out.replace(/\.png$/i, ".audit.json"), JSON.stringify(lastAudit, null, 2));
  }
  console.error(`[image:refine] FAIL: all ${retries + 1} attempts rejected; last saved ${out}`);
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(`[image:refine] fatal: ${err instanceof Error ? err.message : "unknown"}`);
  process.exitCode = 1;
});
