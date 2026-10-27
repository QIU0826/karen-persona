#!/usr/bin/env node
/**
 * Karen MOSS-Image identity LoRA —— 数据准备 / 上传 / 训练脚本生成（P3 / task-25）
 *
 * 输入（本地，均不进 git）：
 *   data/character-lora/raw/train/<scene>-<seed>.png + 同名 .json
 *   data/character-lora/raw/eval/<scene>-<seed>.png  + 同名 .json
 * 其中 .json 由 scripts/character-dataset.ts 生成，字段：id/split/scene/scenePrompt/outfit/
 * angle/light/ref/seed/...（task-24 数据集）。
 *
 * 产物（默认先写到系统临时目录，再用 rsync 上传到 GPU 服务器 /mnt/data0，训练产物/数据不落仓库）：
 *   train/<image>.png + <image>.txt        kohya 训练集（英文 caption，含触发词 karen_style）
 *   eval/<image>.png  + <image>.txt        评测集（**不参与训练**，train/eval 严格分离）
 *   dataset_train.toml                     kohya 数据集配置（bucket_reso_steps=16，resolution=1024）
 *   eval-prompts.txt                       MOSS minimal inference 批量 prompt（base / LoRA 共用）
 *   eval-prompts.meta.json                 eval prompt ↔ 图片/场景/seed 映射
 *   prepare-report.json                    数量/缺失/sha256/尺寸/翻译兜底/重复检查
 *   run_smoke.sh / run_full.sh             host 侧 podman 封装（GPU6），smoke 40 步 / full 1000 步
 *
 * 用法：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/moss-lora-prepare.ts --dry-run
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/moss-lora-prepare.ts
 *   ... --skip-upload --out /tmp/karen-lora-prepared     # 只生成本地 staging
 *   ... --remote-dir /mnt/data0/lwh/karen-stack/datasets/karen-lora
 *
 * 约束：不改 package.json / src / README；不 commit；不打印任何密钥。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ── 默认参数 ─────────────────────────────────────────

const REPO_ROOT = process.cwd();
/** 容器内挂载点：host /mnt/data0/lwh/karen-stack → container /workspace（见 run 脚本）。 */
const CONTAINER_STACK = "/workspace";
const RAW_ROOT = path.join(REPO_ROOT, "data", "character-lora", "raw");
const TRIGGER_WORD = "karen_style";

/** 身份 + 画风：与 Lead 指定口径一致；每张 caption 都带（identity LoRA 的关键锚点）。 */
const IDENTITY_EN =
  "a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), gray-blue eyes, pale skin";
const STYLE_EN =
  "soft pencil and watercolor illustration style, low-saturation cool gray-blue palette, " +
  "fine pencil and ink linework with light watercolor wash, subtle paper texture";
/**
 * v2 caption profile：降低「风格与身份耦合」。
 * MOSS 的文本编码器是 Qwen3.5（LLM），不像 CLIP 那样解析 (word:1.2) 权重语法；
 * 因此用「结构 + 顺序」提升身份词权重：
 *   - 触发词 + 身份描述放在最前、写得更具体（含体型/固定身份）；
 *   - 风格描述压缩到最后、只保留 2 个短句，避免压过身份；
 *   - 明确 "fixed character identity ... must stay the same" 的语义。
 * v1（默认）保持原样，便于复现旧实验。
 */
const IDENTITY_V2_EN =
  "the fixed character identity, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), " +
  "gray-blue eyes, pale skin, slim build; her face, hairstyle and hair color must stay exactly the same across images";
const STYLE_V2_EN = "art style: soft pencil and watercolor illustration, muted cool tones, subtle paper texture";

/** GPU 服务器 / 训练栈默认路径（与 task-23/24 对齐）。 */
const DEFAULTS = {
  sshTarget: "lwh@118.122.220.72",
  sshPort: "10236",
  sshKey: "~/.ssh/karen_gpu",
  remoteDir: "/mnt/data0/lwh/karen-stack/datasets/karen-lora",
  stack: "/mnt/data0/lwh/karen-stack",
  containerImage: "localhost/karen-qwen-image-edit:0.1",
  gpu: "6",
  smokeSteps: "40",
  fullSteps: "1200",
  saveEvery: "200",
  evalWidth: "832",
  evalHeight: "912",
  evalSteps: "50",
  resolution: "1024",
  // v2 起可覆盖：rank/alpha、输出名前缀、远端数据集目录（容器内路径自动推导）
  networkDim: "16",
  networkAlpha: "1",
  outputName: "karen_style_moss_v1",
  containerDatasetDir: "",
  captionProfile: "v1",
} as const;

// ── 场景 / 服装 / 角度 / 光线 中→英映射 ───────────────
// 数据集由 task-24 生成，字段为中文；训练 caption 以英文为主（官方推荐）。
// 映射缺失时保留原文并写入 report.untranslated，不阻塞流程。

const SCENE_EN: Record<string, string> = {
  公园长椅: "a park bench in early spring, budding trees and fresh green grass in the background",
  咖啡馆窗边: "a window seat in a cafe, warm afternoon light, a coffee cup on the table",
  地铁站角落: "a corner of a subway station, tiled walls, soft mixed fluorescent and warm light",
  夜晚街头: "a city street at night, neon signs and wet pavement reflecting the lights",
  家里沙发: "a cozy living-room sofa at home, soft indoor light",
  旧书店: "an old bookstore, tall wooden bookshelves, dusty warm light between the shelves",
  海边黄昏: "the seaside at dusk, an orange sky over calm water",
  深夜阳台: "a balcony late at night, distant city lights",
  清晨厨房: "a quiet kitchen in the early morning, bright and clean",
  雨天窗边: "by the window on a rainy day, raindrops on the glass",
  冬天街道: "a winter street with snow on the roadside; she wears a scarf and her breath fogs faintly",
  唱片店: "a record store, rows of vinyl records, warm spotlights",
  图书馆楼梯间: "a library stairwell, side light from tall windows",
  城市天台黄昏: "a city rooftop at dusk, glowing skyline behind her",
  深夜便利店: "a late-night convenience store, cold white fluorescent light",
  清晨海边: "the seaside in the early morning, light reflecting on the water",
  花市门口: "the entrance of a flower market, buckets of fresh flowers around",
  高铁车窗边: "a window seat on a high-speed train, afternoon light through the window",
};

const OUTFIT_EN: Record<string, string> = {
  米色风衣: "a beige trench coat",
  浅色针织开衫: "a light knit cardigan",
  白色卫衣: "a white hoodie",
  浅色牛仔外套: "a light denim jacket",
  "白色棉质短袖 T 恤": "a white cotton short-sleeve T-shirt",
  浅灰连帽衫: "a light gray hoodie",
  黑色皮夹克: "a black leather jacket",
  黑色长外套: "a long black coat",
  深蓝牛仔外套: "a dark blue denim jacket",
  深灰针织长袖: "a dark gray knit long-sleeve top",
  浅蓝家居服: "light blue loungewear",
  白衬衫: "a white shirt",
  深色大衣: "a dark coat",
  深棕针织开衫: "a dark brown knit cardigan",
  浅色亚麻连衣裙: "a light linen dress",
  "白色 T 恤": "a white T-shirt",
  "白色 T 恤外搭薄外套": "a white T-shirt with a light jacket over it",
  黑色高领毛衣: "a black turtleneck sweater",
  浅蓝条纹家居服: "light blue striped loungewear",
  白色棉质衬衫: "a white cotton shirt",
  米色针织开衫: "a beige knit cardigan",
  燕麦色针织开衫: "an oatmeal knit cardigan",
  白色棉质长袖: "a white cotton long-sleeve top",
  深色宽松衬衫: "a dark loose shirt",
  "灰色羊毛大衣 + 米色围巾": "a gray wool coat with a beige scarf",
  灰色高领毛衣: "a gray turtleneck sweater",
  深色高领毛衣: "a dark turtleneck sweater",
  格纹衬衫: "a plaid shirt",
  橄榄绿工装外套: "an olive green utility jacket",
  黑色羽绒服: "a black down jacket",
  亚麻衬衫: "a linen shirt",
  牛仔衬衫: "a denim shirt",
  浅粉针织开衫: "a light pink knit cardigan",
  藏青色大衣: "a navy coat",
  宽松米白衬衫: "a loose off-white shirt",
  深绿色针织衫: "a dark green knit sweater",
  米白色粗针织毛衣: "an off-white chunky knit sweater",
};

const ANGLE_EN: Record<string, string> = {
  threeQuarter: "three-quarter view, face clearly visible, looking at the camera",
  close: "close-up portrait, head and shoulders, facing the camera",
  sideWindow: "side view by the window, face turned slightly toward the camera",
  lookBack: "looking back over her shoulder at the camera",
  profile: "side profile, face clearly visible",
  lowAngle: "low-angle shot, looking up at her",
  // v2 新增取景：半身 / 四分之三身 / 全身
  halfBody: "half-body shot from the waist up, face and upper body clearly visible",
  threeQuarterBody: "three-quarter body shot with knees visible, showing both top and bottom outfits",
  fullBody: "full-body shot from head to toe, standing naturally, some space above her head",
};

const LIGHT_EN: Record<string, string> = {
  上午通透阳光: "clear morning sunlight",
  树叶间斑驳的光影: "dappled light through leaves",
  阴天柔光: "soft overcast light",
  "午后侧逆光，发丝有轮廓光": "afternoon side backlight with a rim light on her hair",
  下午柔和的自然光: "soft afternoon natural light",
  站台暖黄灯与冷光混合: "mixed warm station lamps and cool light",
  列车进站前的风与冷光: "cool light and wind before the train arrives",
  霓虹冷光与暖色招牌光混合: "mixed cool neon light and warm sign light",
  路灯顶光: "overhead street-lamp light",
  窗外阴雨散射光: "rainy daylight diffused from the window",
  深夜一盏暖色小灯: "a single warm lamp late at night",
  窗边漫射光: "diffused window light",
  书架夹缝里的暖光: "warm light between bookshelves",
  暖色钨丝灯光: "warm tungsten lamplight",
  日落暖橙侧光: "warm orange sunset side light",
  "晚霞逆光，发丝有轮廓光": "sunset backlight with a rim light on her hair",
  城市灯光冷调: "cool-toned city lights",
  阳台暖色小灯: "a warm balcony lamp",
  月光与远处霓虹: "moonlight and distant neon",
  清晨冷调柔光: "soft cool morning light",
  早晨窗户侧光: "morning side light from the window",
  "晨光逆光，发丝有轮廓光": "morning backlight with a rim light on her hair",
  阴雨天冷调散射光: "cool diffused light on a rainy day",
  雨云透下的柔和光线: "soft light filtering through rain clouds",
  窗外冷蓝与室内暖光的对比: "cool blue window light contrasting with warm interior light",
  阴雪天冷调光: "cool light on a snowy overcast day",
  店内暖色射灯: "warm spotlights in the store",
  楼梯高窗的侧光: "side light from the high stairwell window",
  晚霞侧光与城市反光: "sunset side light with city reflections",
  便利店冷白灯光: "cold white convenience-store light",
  清晨海面反光: "morning light reflecting off the sea",
  阴天柔和散射光: "soft diffused overcast light",
  午后车厢顶光: "afternoon overhead light inside the train car",
  冷白荧光灯: "cold white fluorescent light",
  傍晚暖色台灯光: "warm evening desk-lamp light",
  阴天散射光: "diffused overcast light",
  柔和黄昏光: "soft dusk light",
  雨后街道反光与冷调环境光: "reflections on a rain-washed street with cool ambient light",
};

// ── CLI 参数 ─────────────────────────────────────────

interface CliOptions {
  rawRoot: string;
  outDir: string | null;
  keep: boolean;
  dryRun: boolean;
  skipUpload: boolean;
  sshTarget: string;
  sshPort: string;
  sshKey: string;
  remoteDir: string;
  stack: string;
  containerImage: string;
  gpu: string;
  smokeSteps: string;
  fullSteps: string;
  saveEvery: string;
  evalWidth: string;
  evalHeight: string;
  evalSteps: string;
  resolution: string;
  trigger: string;
  networkDim: string;
  networkAlpha: string;
  outputName: string;
  containerDatasetDir: string;
  captionProfile: string;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    rawRoot: RAW_ROOT,
    outDir: null,
    keep: false,
    dryRun: false,
    skipUpload: false,
    sshTarget: DEFAULTS.sshTarget,
    sshPort: DEFAULTS.sshPort,
    sshKey: DEFAULTS.sshKey,
    remoteDir: DEFAULTS.remoteDir,
    stack: DEFAULTS.stack,
    containerImage: DEFAULTS.containerImage,
    gpu: DEFAULTS.gpu,
    smokeSteps: DEFAULTS.smokeSteps,
    fullSteps: DEFAULTS.fullSteps,
    saveEvery: DEFAULTS.saveEvery,
    evalWidth: DEFAULTS.evalWidth,
    evalHeight: DEFAULTS.evalHeight,
    evalSteps: DEFAULTS.evalSteps,
    resolution: DEFAULTS.resolution,
    trigger: TRIGGER_WORD,
    networkDim: DEFAULTS.networkDim,
    networkAlpha: DEFAULTS.networkAlpha,
    outputName: DEFAULTS.outputName,
    containerDatasetDir: DEFAULTS.containerDatasetDir,
    captionProfile: DEFAULTS.captionProfile,
  };
  const map: Record<string, keyof CliOptions> = {
    "--raw-root": "rawRoot",
    "--out": "outDir",
    "--ssh-target": "sshTarget",
    "--ssh-port": "sshPort",
    "--ssh-key": "sshKey",
    "--remote-dir": "remoteDir",
    "--stack": "stack",
    "--image": "containerImage",
    "--gpu": "gpu",
    "--smoke-steps": "smokeSteps",
    "--full-steps": "fullSteps",
    "--save-every": "saveEvery",
    "--eval-width": "evalWidth",
    "--eval-height": "evalHeight",
    "--eval-steps": "evalSteps",
    "--resolution": "resolution",
    "--trigger": "trigger",
    "--network-dim": "networkDim",
    "--network-alpha": "networkAlpha",
    "--output-name": "outputName",
    "--container-dataset-dir": "containerDatasetDir",
    "--caption-profile": "captionProfile",
  };
  const flags: Record<string, keyof CliOptions> = {
    "--keep": "keep",
    "--dry-run": "dryRun",
    "--skip-upload": "skipUpload",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) {
      (opts as unknown as Record<string, boolean>)[flags[arg]] = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    if (map[key]) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`参数缺少值: ${key}`);
      (opts as unknown as Record<string, string>)[map[key]] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

// ── 小工具 ───────────────────────────────────────────

interface EvalMeta {
  file: string;
  scene: string;
  seed: number;
  prompt: string;
}

interface RawItem {
  split: "train" | "eval";
  file: string;
  imagePath: string;
  jsonPath: string;
  meta: Record<string, unknown> | null;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  warnings: string[];
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 只解析 PNG IHDR 宽高（避免引入图像依赖）。非 PNG 返回 null。 */
function readPngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function translate(map: Record<string, string>, value: unknown, missing: Set<string>, fallbackPrefix: string): string | null {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return null;
  const hit = map[key];
  if (hit) return hit;
  missing.add(`${fallbackPrefix}:${key}`);
  return key; // 兜底保留原文（Qwen3.5 文本编码器可处理中文）
}

function buildCaption(item: RawItem, opts: CliOptions, untranslated: Set<string>): string {
  const meta = item.meta ?? {};
  const scene =
    translate(SCENE_EN, meta.scene, untranslated, "scene") ??
    translate(SCENE_EN, meta.scenePrompt, untranslated, "scenePrompt");
  const outfit = translate(OUTFIT_EN, meta.outfit, untranslated, "outfit");
  const angle = translate(ANGLE_EN, meta.angle, untranslated, "angle");
  const light = translate(LIGHT_EN, meta.light, untranslated, "light");

  const isV2 = opts.captionProfile === "v2";
  const parts = [
    opts.trigger,
    isV2 ? IDENTITY_V2_EN : IDENTITY_EN,
    scene ?? "a quiet everyday scene",
    outfit ? `wearing ${outfit}` : null,
    angle,
    light,
    isV2 ? STYLE_V2_EN : STYLE_EN,
    "clean background with a clear scene atmosphere, single person, no text, no watermark, no border",
  ].filter(Boolean);
  return parts.join(", ").replace(/\s+/g, " ").trim();
}

// ── 读取数据集 ───────────────────────────────────────

async function collectSplit(split: "train" | "eval", opts: CliOptions): Promise<{ items: RawItem[]; warnings: string[] }> {
  const dir = path.join(opts.rawRoot, split);
  const warnings: string[] = [];
  const items: RawItem[] = [];
  if (!fs.existsSync(dir)) {
    warnings.push(`目录不存在: ${dir}`);
    return { items, warnings };
  }
  const entries = await fsp.readdir(dir);
  const imageFiles = entries.filter((f) => /\.png$/i.test(f)).sort();
  const jsonFiles = new Set(entries.filter((f) => /\.json$/i.test(f)));

  for (const file of imageFiles) {
    const imagePath = path.join(dir, file);
    const jsonPath = imagePath.replace(/\.png$/i, ".json");
    const itemWarnings: string[] = [];
    let meta: Record<string, unknown> | null = null;
    if (jsonFiles.has(path.basename(jsonPath))) {
      try {
        meta = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
      } catch (err) {
        itemWarnings.push(`JSON 解析失败: ${(err as Error).message}`);
      }
    } else {
      itemWarnings.push("缺少同名 .json（caption 将只有通用身份/画风描述）");
    }
    const buf = await fsp.readFile(imagePath);
    const size = readPngSize(buf);
    if (!size) itemWarnings.push("不是合法 PNG（用 PIL 生成的图片应为 PNG）");
    if (size && (size.width % 16 !== 0 || size.height % 16 !== 0)) {
      itemWarnings.push(`尺寸 ${size.width}x${size.height} 不是 16 的倍数（kohya 会按 bucket 缩放/裁切）`);
    }
    items.push({
      split,
      file,
      imagePath,
      jsonPath,
      meta,
      bytes: buf.length,
      sha256: sha256(buf),
      width: size?.width ?? null,
      height: size?.height ?? null,
      warnings: itemWarnings,
    });
  }

  const orphanJson = [...jsonFiles].filter((f) => !imageFiles.includes(f.replace(/\.json$/i, ".png")));
  if (orphanJson.length > 0) warnings.push(`有 .json 但没有 .png: ${orphanJson.slice(0, 5).join(", ")}${orphanJson.length > 5 ? " …" : ""}`);
  return { items, warnings };
}

// ── kohya TOML / run 脚本 / eval prompts ─────────────

function buildDatasetToml(opts: CliOptions): string {
  return `# Karen identity LoRA dataset config (auto-generated by scripts/moss-lora-prepare.ts)
# train 集参与训练；eval 集不在此 TOML 中（严格分离）。
[general]
enable_bucket = true
bucket_reso_steps = 16
min_bucket_reso = 512
max_bucket_reso = 1536
caption_extension = ".txt"

[[datasets]]
resolution = ${opts.resolution}
batch_size = 1
caption_dropout_rate = 0.05
enable_bucket = true

[[datasets.subsets]]
image_dir = "${opts.containerDatasetDir}/train"
num_repeats = 1
caption_extension = ".txt"
`;
}

function podmanRunPrefix(opts: CliOptions): string {
  const stack = opts.stack.replace(/\/+$/, "");
  return [
    "podman run --rm \\",
    `  --device "nvidia.com/gpu=\${GPU:-${opts.gpu}}" \\`,
    `  -v "${stack}:/workspace" \\`,
    "  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e PYTHONUNBUFFERED=1 \\",
    `  --entrypoint /workspace/training/venv/bin/accelerate "${opts.containerImage}" \\`,
    "  launch --num_processes 1 --num_cpu_threads_per_process 1 --mixed_precision bf16 \\",
    "  /workspace/training/sd-scripts/moss_image_train_network.py \\",
  ].join("\n");
}

function commonTrainArgs(opts: CliOptions, outputName: string, maxSteps: string): string {
  return [
    `    --pretrained_model_name_or_path="${CONTAINER_STACK}/models/MOSS-Image-SFT/transformer/diffusion_pytorch_model-00001-of-00003.safetensors" \\`,
    `    --text_encoder="${CONTAINER_STACK}/models/MOSS-Image-SFT/text_encoder/model-00001-of-00004.safetensors" \\`,
    `    --vae="${CONTAINER_STACK}/models/MOSS-Image-SFT/vae/diffusion_pytorch_model.safetensors" \\`,
    `    --tokenizer_cache_dir="${CONTAINER_STACK}/models/MOSS-Image-SFT/tokenizer" \\`,
    `    --dataset_config="${opts.containerDatasetDir}/dataset_train.toml" \\`,
    `    --output_dir="${CONTAINER_STACK}/models/karen-moss-lora" \\`,
    `    --output_name="${outputName}" \\`,
    "    --save_model_as=safetensors \\",
    "    --network_module=networks.lora_generic \\",
    `    --network_dim=${opts.networkDim} --network_alpha=${opts.networkAlpha} \\`,
    "    --network_train_unet_only \\",
    "    --learning_rate=1e-4 \\",
    "    --optimizer_type=AdamW \\",
    '    --lr_scheduler="constant" \\',
    '    --timestep_sampling="truncated_logit_normal" \\',
    "    --logit_mean=-1.09 --logit_std=0.95 --discrete_flow_shift=1.0 \\",
    "    --mixed_precision=bf16 \\",
    "    --gradient_checkpointing \\",
    "    --cache_latents --cache_latents_to_disk \\",
    "    --cache_text_encoder_outputs --cache_text_encoder_outputs_to_disk \\",
    "    --max_data_loader_n_workers=2 --persistent_data_loader_workers \\",
    `    --max_train_steps=${maxSteps} --save_every_n_steps=${opts.saveEvery} \\`,
    "    --seed=42",
  ].join("\n");
}

function buildRunScript(opts: CliOptions, mode: "smoke" | "full"): string {
  const isSmoke = mode === "smoke";
  const outputName = isSmoke ? `${opts.outputName}_smoke` : opts.outputName;
  const maxSteps = isSmoke ? opts.smokeSteps : opts.fullSteps;
  return `#!/usr/bin/env bash
# ${isSmoke ? "Smoke 训练（20–50 步，验证 loss / LoRA 保存）" : `完整训练（${opts.fullSteps} 步，每 ${opts.saveEvery} 步存 checkpoint 供挑选）`}
# 由 scripts/moss-lora-prepare.ts 生成；GPU 默认 6（GPU7 留给 MOSS 推理服务）。
# 用法：bash run_${mode}.sh
set -euo pipefail
STACK="${opts.stack.replace(/\/+$/, "")}"

echo "[karen-lora] ${mode} start: steps=${maxSteps}, gpu=\${GPU:-${opts.gpu}}"
${podmanRunPrefix(opts)}
${commonTrainArgs(opts, outputName, maxSteps)}

echo "[karen-lora] ${mode} done: \${STACK}/models/karen-moss-lora/${outputName}.safetensors"
`;
}

function buildEvalPromptLines(items: RawItem[], opts: CliOptions): { lines: string[]; metas: EvalMeta[] } {
  const lines: string[] = [];
  const metas: EvalMeta[] = [];
  const untranslated = new Set<string>();
  items.forEach((item, index) => {
    const meta = item.meta ?? {};
    const seed = Number(meta.seed);
    const prompt = buildCaption(item, opts, untranslated);
    const safeSeed = Number.isFinite(seed) ? Math.floor(seed) : 100000 + index;
    const line = `${prompt.replace(/ --/g, " - ")} --w ${opts.evalWidth} --h ${opts.evalHeight} --s ${opts.evalSteps} --l 3.0 --fs 5.0 --d ${safeSeed}`;
    lines.push(line);
    metas.push({ file: item.file, scene: String(meta.scene ?? ""), seed: safeSeed, prompt });
  });
  return { lines, metas };
}

// ── 远程同步 ─────────────────────────────────────────

function sshArgs(opts: CliOptions): string[] {
  return ["-i", opts.sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-p", opts.sshPort];
}

function sshCmd(opts: CliOptions, remoteCommand: string): { ok: boolean; stderr: string } {
  const result = spawnSync("ssh", [...sshArgs(opts), opts.sshTarget, remoteCommand], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { ok: result.status === 0, stderr: (result.stderr || result.stdout || "").trim() };
}

function rsyncDir(opts: CliOptions, localDir: string, remoteSub: string): { ok: boolean; message: string } {
  const ssh = `ssh ${["-i", opts.sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-p", opts.sshPort].join(" ")}`;
  const result = spawnSync(
    "rsync",
    ["-az", "--delete", "-e", ssh, `${localDir}/`, `${opts.sshTarget}:${opts.remoteDir}/${remoteSub}/`],
    { encoding: "utf8", timeout: 600_000 }
  );
  return { ok: result.status === 0, message: (result.stderr || result.stdout || "").trim() };
}

function rsyncFile(opts: CliOptions, localFile: string, remoteSub: string): { ok: boolean; message: string } {
  const ssh = `ssh ${["-i", opts.sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-p", opts.sshPort].join(" ")}`;
  const result = spawnSync("rsync", ["-az", "-e", ssh, localFile, `${opts.sshTarget}:${opts.remoteDir}/${remoteSub}`], {
    encoding: "utf8",
    timeout: 300_000,
  });
  return { ok: result.status === 0, message: (result.stderr || result.stdout || "").trim() };
}

// ── 主流程 ───────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  // 容器内数据集目录：/workspace/datasets/<远端目录 basename>（默认 karen-lora；v2 用 karen-lora-v2）
  if (!opts.containerDatasetDir) {
    const base = path.basename(opts.remoteDir.replace(/\/+$/, ""));
    opts.containerDatasetDir = `${CONTAINER_STACK}/datasets/${base}`;
  }
  const startedAt = new Date();
  console.log("[prepare] raw:", opts.rawRoot);
  console.log("[prepare] network:", `dim=${opts.networkDim} alpha=${opts.networkAlpha}`, "output:", opts.outputName);
  console.log("[prepare] container dataset dir:", opts.containerDatasetDir);
  console.log("[prepare] remote:", `${opts.sshTarget}:${opts.remoteDir}`, opts.skipUpload ? "(skip-upload)" : "");

  const train = await collectSplit("train", opts);
  const evalSplit = await collectSplit("eval", opts);
  const allWarnings = [...train.warnings, ...evalSplit.warnings];
  if (train.items.length === 0) throw new Error(`训练集为空: ${path.join(opts.rawRoot, "train")}`);
  if (evalSplit.items.length === 0) allWarnings.push("评测集为空（仍可训练，但无法验证）");

  // 严格分离：同一张图（sha256）不得同时出现在 train/eval
  const trainHashes = new Map(train.items.map((i) => [i.sha256, i.file]));
  for (const item of evalSplit.items) {
    if (trainHashes.has(item.sha256)) {
      throw new Error(`train/eval 存在重复图片（sha256 相同）: ${trainHashes.get(item.sha256)} vs ${item.file}`);
    }
  }

  const staging = opts.outDir ? path.resolve(opts.outDir) : await fsp.mkdtemp(path.join(os.tmpdir(), "karen-lora-"));
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(path.join(staging, "train"), { recursive: true });
  await fsp.mkdir(path.join(staging, "eval"), { recursive: true });

  const untranslated = new Set<string>();
  const reportItems: Array<Record<string, unknown>> = [];

  for (const item of [...train.items, ...evalSplit.items]) {
    const caption = buildCaption(item, opts, untranslated);
    const base = item.file.replace(/\.png$/i, "");
    const destDir = path.join(staging, item.split);
    await fsp.copyFile(item.imagePath, path.join(destDir, item.file));
    await fsp.writeFile(path.join(destDir, `${base}.txt`), caption + "\n", "utf8");
    reportItems.push({
      split: item.split,
      file: item.file,
      bytes: item.bytes,
      sha256: item.sha256,
      width: item.width,
      height: item.height,
      scene: item.meta?.scene ?? null,
      seed: item.meta?.seed ?? null,
      caption,
      warnings: item.warnings,
    });
  }

  const datasetToml = buildDatasetToml(opts);
  await fsp.writeFile(path.join(staging, "dataset_train.toml"), datasetToml, "utf8");
  await fsp.writeFile(path.join(staging, "run_smoke.sh"), buildRunScript(opts, "smoke"), { mode: 0o755 });
  await fsp.writeFile(path.join(staging, "run_full.sh"), buildRunScript(opts, "full"), { mode: 0o755 });

  const evalPrompts = buildEvalPromptLines(evalSplit.items, opts);
  await fsp.writeFile(path.join(staging, "eval-prompts.txt"), evalPrompts.lines.join("\n") + "\n", "utf8");
  await fsp.writeFile(
    path.join(staging, "eval-prompts.meta.json"),
    JSON.stringify({ generatedAt: startedAt.toISOString(), items: evalPrompts.metas }, null, 2) + "\n",
    "utf8"
  );

  const dims = [...train.items, ...evalSplit.items].map((i) => (i.width && i.height ? `${i.width}x${i.height}` : "unknown"));
  const report = {
    generatedAt: startedAt.toISOString(),
    rawRoot: opts.rawRoot,
    trigger: opts.trigger,
    counts: { train: train.items.length, eval: evalSplit.items.length },
    imageDims: [...new Set(dims)],
    totalBytes: [...train.items, ...evalSplit.items].reduce((sum, i) => sum + i.bytes, 0),
    untranslated: [...untranslated].sort(),
    warnings: allWarnings,
    items: reportItems,
    artifacts: {
      datasetToml: "dataset_train.toml",
      evalPrompts: "eval-prompts.txt",
      runSmoke: "run_smoke.sh",
      runFull: "run_full.sh",
    },
  };
  await fsp.writeFile(path.join(staging, "prepare-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`[prepare] train=${train.items.length} eval=${evalSplit.items.length} staging=${staging}`);
  if (untranslated.size > 0) console.log(`[prepare] 未翻译（保留中文）: ${[...untranslated].join(" | ")}`);
  if (allWarnings.length > 0) {
    console.log("[prepare] warnings:");
    for (const w of allWarnings) console.log("  -", w);
  }
  console.log("[prepare] 示例 caption:", reportItems[0]?.caption);

  if (opts.dryRun) {
    console.log("[prepare] --dry-run: 不上传，保持 staging 供检查");
    return;
  }
  if (opts.skipUpload) {
    console.log("[prepare] --skip-upload: 不上传");
    return;
  }

  console.log(`[prepare] 同步到服务器（rsync）...`);
  const mk = sshCmd(opts, `mkdir -p '${opts.remoteDir}/train' '${opts.remoteDir}/eval' '${opts.remoteDir}/scripts'`);
  if (!mk.ok) throw new Error(`ssh 建目录失败: ${mk.stderr}`);
  const steps: Array<[string, () => { ok: boolean; message: string }]> = [
    ["train/", () => rsyncDir(opts, path.join(staging, "train"), "train")],
    ["eval/", () => rsyncDir(opts, path.join(staging, "eval"), "eval")],
    ["dataset_train.toml", () => rsyncFile(opts, path.join(staging, "dataset_train.toml"), "")],
    ["eval-prompts.txt", () => rsyncFile(opts, path.join(staging, "eval-prompts.txt"), "")],
    ["eval-prompts.meta.json", () => rsyncFile(opts, path.join(staging, "eval-prompts.meta.json"), "")],
    ["prepare-report.json", () => rsyncFile(opts, path.join(staging, "prepare-report.json"), "")],
    ["run_smoke.sh", () => rsyncFile(opts, path.join(staging, "run_smoke.sh"), "")],
    ["run_full.sh", () => rsyncFile(opts, path.join(staging, "run_full.sh"), "")],
  ];
  for (const [label, run] of steps) {
    const result = run();
    if (!result.ok) throw new Error(`rsync 失败 ${label}: ${result.message}`);
    console.log(`[prepare]   ✓ ${label}`);
  }
  const chmod = sshCmd(opts, `chmod +x '${opts.remoteDir}/run_smoke.sh' '${opts.remoteDir}/run_full.sh'`);
  if (!chmod.ok) console.log(`[prepare] 警告：chmod 失败: ${chmod.stderr}`);

  // 评测脚本（若仓库里存在）也一并上传，便于在服务器复现
  const evalScript = path.join(REPO_ROOT, "scripts", "moss-lora-eval.py");
  if (fs.existsSync(evalScript)) {
    const r = rsyncFile(opts, evalScript, "");
    console.log(`[prepare]   ${r.ok ? "✓" : "⚠"} moss-lora-eval.py${r.ok ? "" : ` (${r.message})`}`);
  }

  console.log(`[prepare] 完成。远端目录: ${opts.remoteDir}`);
  console.log(`[prepare] 下一步（服务器）: bash ${opts.remoteDir}/run_smoke.sh`);
  if (!opts.keep) {
    await fsp.rm(staging, { recursive: true, force: true });
  } else {
    console.log(`[prepare] staging 保留: ${staging}`);
  }
}

main().catch((err) => {
  console.error("[prepare] 失败:", (err as Error).message);
  process.exit(1);
});
