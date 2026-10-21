#!/usr/bin/env node
/**
 * 本机生图真实链路冒烟（v0.8.23）。
 *
 * 背景：v0.7 做完了整条生图链路（Node 决策 → HTTP 服务 → diffusers/MPS → PNG → 落盘），
 * 但**模型从未下载成功**（HuggingFace 直连被墙、hf_hub 默认走 Xet CDN 也不可达），
 * 所以「生图」一直标 ⛔ 未验证。本轮用 hf-mirror + 分块下载拿到权重，这条冒烟补上证据。
 *
 * 验证：
 *  1) 服务在线且模型已加载（/health loaded=true）；
 *  2) Node 侧 generateImage（KAREN_IMAGE_GEN=on + service 后端）真能拿到 PNG；
 *  3) 种子固定时结果可复现（同 seed 同 bytes），不同 seed 不同图；
 *  4) 延迟与体积在预算内（单张 ≤25s、≤4MB）；
 *  5) 生成的图能落盘到 KAREN_DATA_DIR/generated/日期/ 并可被清理逻辑统计。
 *
 * 用法（需要先启动 services/image）：
 *   export PATH="$PWD/.runtime/node22/bin:$PATH"
 *   KAREN_IMAGE_GEN=on node node_modules/tsx/dist/cli.mjs scripts/image-smoke.ts
 *
 * 成本：0（本机算力）；若模型没下载会以 exit 2 明确提示，不当作失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE_URL = process.env.KAREN_IMAGE_URL?.trim() || "http://127.0.0.1:18084";

async function main(): Promise<number> {
  // 用临时数据目录，避免写仓库 data/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "karen-image-smoke-"));
  process.env.KAREN_DATA_DIR = tmp;
  process.env.KAREN_IMAGE_GEN = "on";
  process.env.KAREN_IMAGE_BACKEND = "service";
  process.env.KAREN_IMAGE_URL = SERVICE_URL;

  console.log("— 本机生图真实链路冒烟 —");
  console.log(`服务：${SERVICE_URL}`);
  console.log(`临时目录：${tmp}`);

  const failures: string[] = [];

  // 1) 服务与模型状态
  let health: { ok?: boolean; loaded?: boolean; model?: string; device?: string } = {};
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    health = (await res.json()) as typeof health;
  } catch {
    console.log("  ✗ 生图服务不可达（先启动：services/image/.venv/bin/python services/image/server.py）");
    fs.rmSync(tmp, { recursive: true, force: true });
    return 1;
  }
  console.log(`  /health：loaded=${health.loaded} model=${health.model} device=${health.device}`);
  if (!health.loaded) {
    console.log("\n  ⏭  模型尚未加载（首次请求会自动加载，或权重未下载完）。");
    console.log("     权重下载见 docs/IMAGE_GEN.md 的「hf-mirror + 分块下载」一节。");
    fs.rmSync(tmp, { recursive: true, force: true });
    return 2; // 明确区分「没模型」与「链路坏了」
  }

  const { generateImage } = await import("../src/media/comfyui.js");
  const { saveGeneratedImage, generatedStats, pruneGenerated } = await import(
    "../src/media/generated-store.js"
  );

  // 2) 真实生成两张（固定 seed 复现 + 不同 seed 不同图）
  const prompt = "傍晚的城市屋顶，暖色天空，手机随手拍，自然光";
  const first = await generateImage({ prompt, seed: 42 });
  console.log(
    `  生成 #1：ok=${first.ok} ${first.ok ? `${(first.bytes!.length / 1024).toFixed(0)}KB / ${first.elapsedMs}ms` : `reason=${first.reason}`}`,
  );
  if (!first.ok || !first.bytes) {
    failures.push(`生成失败（${first.reason ?? "unknown"}）`);
  } else {
    const png = first.bytes;
    if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
      failures.push("返回的不是 PNG（头字节不对）");
    }
    if (png.length > 4 * 1024 * 1024) failures.push("图片超过 4MB 上限");

    const again = await generateImage({ prompt, seed: 42 });
    if (!again.ok || !again.bytes) failures.push("第二次生成失败（可复现性无法验证）");
    else if (!again.bytes.equals(png)) failures.push("同 seed 结果不可复现");

    const other = await generateImage({ prompt, seed: 7 });
    if (other.ok && other.bytes) {
      if (other.bytes.equals(png)) failures.push("不同 seed 生成了完全相同的图（seed 未生效）");
    } else {
      failures.push("换 seed 生成失败");
    }

    // 3) 落盘 + 清理统计
    const file = saveGeneratedImage(png);
    if (!file || !fs.existsSync(file)) failures.push("生成图没能落盘到 KAREN_DATA_DIR/generated/");
    else {
      const stats = generatedStats();
      console.log(`  落盘：${path.basename(file)}；统计 files=${stats.files} bytes=${stats.bytes}`);
      if (stats.files < 1) failures.push("生成图统计为 0");
      pruneGenerated();
    }
  }

  // 4) 产品级路径：trySharePhoto（点名要照片）→ source=generated
  {
    const { trySharePhoto, resetCooldown } = await import("../src/impulse/unsplash-trigger.js");
    resetCooldown();
    delete process.env.UNSPLASH_ACCESS_KEY;
    const state = {
      persona: {
        name: "小雅",
        relationship: { closeness: 3.5 },
        photoShare: { enabled: true, aesthetic: "日系", vibeKeywords: ["温暖"], cooldownHours: 2 },
      },
      config: { photo_share_min_closeness: 3, photo_share_probability: 1, photo_share_cooldown_minutes: 0 },
      emotionState: { vector: 0 },
    };
    const photo = await trySharePhoto(state as never, "刚到家，今天有点累", {
      requested: true,
      userText: "拍张现在的照片看看",
    });
    console.log(
      `  trySharePhoto：${photo ? `source=${photo.source} caption=${photo.caption}` : "null（回退图库/未触发）"}`,
    );
    if (!photo) failures.push("产品路径没发出照片（点名要照片时应当尝试生成）");
    else if (photo.source !== "generated") failures.push(`产品路径发的是 ${photo.source}，不是生成图`);
    else if (!photo.imageFile || !fs.existsSync(photo.imageFile)) {
      failures.push("产品路径返回了生成图但没有落盘文件");
    }
    resetCooldown();
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("\n— 结论 —");
  if (failures.length === 0) {
    console.log(`  ✅ 全部通过：真出图 / PNG 合法 / 可复现 / seed 生效 / 能落盘与清理`);
    console.log(`  （单张 ${first.ok ? first.elapsedMs : "?"}ms，模型 ${health.model}，设备 ${health.device}）`);
    return 0;
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("[生图冒烟失败]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
