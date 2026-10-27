#!/usr/bin/env node
/**
 * Karen 角色一致性 LoRA —— 数据集生成脚本（P3 前置，不训练、不切换生产）。
 *
 * 做法：用现有 Qwen-Image-Edit 服务（GPU2，隧道 http://127.0.0.1:19110）以
 * character-{1,2,3}.jpg（服务器路径 /workspace/data/karen-ref-promo/）为参考图，
 * 生成多场景/服装/角度/光线的角色图，按 train / eval 严格分开，供后续 LoRA 训练与
 * ArcFace 评测使用。
 *
 * 产物（均不进 git）：
 *   data/character-lora/refs/                  参考图副本（含 refs.json）
 *   data/character-lora/raw/train/<scene>-<seed>.png + .json
 *   data/character-lora/raw/eval/<scene>-<seed>.png + .json
 *   data/character-lora/manifest.json          汇总清单（数量/场景/失败项/sha256）
 *
 * 用法：
 *   # 1) 准备参考图副本 + 只打印计划
 *   node .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/character-dataset.ts --prepare --dry-run
 *
 *   # 2) 生成训练集（30 张）
 *   ... scripts/character-dataset.ts --only train
 *
 *   # 3) 生成评测集（8 张）
 *   ... scripts/character-dataset.ts --only eval
 *
 *   # 4) 全部生成（可重复执行，默认跳过已有文件；--force 重生成）
 *   ... scripts/character-dataset.ts
 *
 * 说明：
 * - 每张约 20–40s（服务单卡、串行），脚本串行执行并在每张完成后立即落盘；
 * - 失败自动换 seed 重试 2 次，仍失败记入 manifest.failures，不阻塞其余图片；
 * - 参考图只使用服务器上已有的 /workspace/data/karen-ref-promo/character-{1,2,3}.jpg；
 *   如需新增参考图，先 rsync 到服务器 /mnt/data0/lwh/karen-stack/data/ 下（容器挂载为 /workspace）。
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ── 配置 ────────────────────────────────────────

const DEFAULT_ENDPOINT = "http://127.0.0.1:19110";
const SERVER_REF_DIR = "/workspace/data/karen-ref-promo";
const LOCAL_REPO = process.cwd();
let OUT_ROOT = path.resolve("data/character-lora");
let RAW_DIR = path.join(OUT_ROOT, "raw");
const REFS_DIR = path.join(OUT_ROOT, "refs");
let MANIFEST_PATH = path.join(OUT_ROOT, "manifest.json");
const DEFAULT_QC_PATH = path.join(OUT_ROOT, "qc.json");

const DEFAULT_STEPS = 10;
const DEFAULT_SEED_BASE = 20261027;
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

/** 本地参考图 → refs/ 的固定清单（任务指定）。 */
const REF_SOURCES: Array<{ name: string; source: string }> = [
  { name: "character-1.jpg", source: "promo/assets/character-1.jpg" },
  { name: "character-2.jpg", source: "promo/assets/character-2.jpg" },
  { name: "character-3.jpg", source: "promo/assets/character-3.jpg" },
  { name: "karen-selfie-cafe.jpg", source: "assets/photos/karen-selfie-cafe.jpg" },
  { name: "karen-selfie-home.jpg", source: "assets/photos/karen-selfie-home.jpg" },
  { name: "karen-selfie-night.jpg", source: "assets/photos/karen-selfie-night.jpg" },
  { name: "karen-selfie-rain.jpg", source: "assets/photos/karen-selfie-rain.jpg" },
  { name: "karen-selfie-sea.jpg", source: "assets/photos/karen-selfie-sea.jpg" },
  { name: "selfie-promo-final-20261023.png", source: "data/image-samples/selfie-promo-final-20261023.png" },
];

// ── Prompt 组件 ─────────────────────────────────

/** 身份约束：只锁脸/发色/气质，不锁衣服与场景。 */
const IDENTITY_PROMPT =
  "保持参考图同一个人：24 岁中国女性，齐肩的中蓝色短发（约 #4a6fa5；绝不能变成白色、银色、浅灰或褪色），" +
  "灰蓝色眼睛，苍白皮肤，脸型与五官必须与参考图完全一致，轻微腮红，克制的微笑；年龄、气质一致；发色必须保持参考图的中蓝色（#4a6fa5），不能变浅、变灰、变白或褪色";

/** 画风约束：与参考图（宣传页人物）一致，避免数据集风格漂移。 */
const STYLE_PROMPT =
  "身份一致性优先于画风：脸型、五官比例、眼睛形状、发色必须与参考图一致，其次才是水彩画风；" +
  "画风与参考图一致：低饱和冷灰蓝色调，细腻铅笔/墨线线条 + 淡彩水彩晕染，轻微纸纹质感，" +
  "背景简洁但有明确场景氛围，光线自然";

/** 负向约束：数据集要干净脸，先不进入手/多人/文字等高风险区域。 */
const NEGATIVE_PROMPT =
  "画面中不要出现任何文字、水印、logo、边框；不要出现第二个人；不要出现手、手指、手臂（双手不入镜或自然垂在画面外）；" +
  "不要厚涂、高饱和、油光、3D 渲染、写实照片质感；不要戴帽子或口罩遮挡脸部；不要银发、白发、浅灰发、灰白发或褪色头发；不要青色、绿色、蓝绿色发色；头发必须是参考图那种中等饱和的中蓝色（#4a6fa5）；不要纯白或空白的背景区域，背景要完整绘制；不要改变脸型、眼睛形状、年龄或五官比例";

/** 构图（角度/景别）。 */
type AngleKey = "close" | "threeQuarter" | "sideWindow" | "lookBack" | "lowAngle" | "profile";

const ANGLE_PROMPTS: Record<AngleKey, string> = {
  close: "近景特写构图，头部与肩部，正面看向镜头，脸部占画面主要位置",
  threeQuarter: "半身构图，四分之三侧脸，视线看向镜头，脸部清晰",
  sideWindow: "半身构图，侧脸看向窗外，脸部轮廓清晰",
  lookBack: "大半身构图，背对镜头回眸，脸部清晰可见",
  lowAngle: "半身构图，略低机位仰拍，正面看向镜头",
  profile: "半身构图，正侧面，鼻子与下颌轮廓清晰",
};

interface SceneSpec {
  id: string;
  split: "train" | "eval";
  /** 场景中文标签（用于 manifest / contact sheet） */
  scene: string;
  /** 场景/地点/动作描述 */
  scenePrompt: string;
  outfit: string;
  angle: AngleKey;
  light: string;
  /** 使用 character-N.jpg 作为参考图 */
  ref: 1 | 2 | 3;
}

/**
 * 数据集定义：30 张训练 + 8 张评测。
 * 评测集原则：场景、服装、角度、光线都不与训练集重复，避免「见过同款」导致基线虚高。
 */
const SCENES: SceneSpec[] = [
  // ── 训练集 30 张（10 场景 × 3 变体）──────────────
  {
    id: "train-cafe-window-a",
    split: "train",
    scene: "咖啡馆窗边",
    scenePrompt: "她坐在咖啡馆窗边，窗外是安静的街道，桌上放着一杯拿铁和一本摊开的书",
    outfit: "白色棉质短袖 T 恤",
    angle: "threeQuarter",
    light: "下午柔和的自然光",
    ref: 2,
  },
  {
    id: "train-cafe-window-b",
    split: "train",
    scene: "咖啡馆窗边",
    scenePrompt: "她坐在咖啡馆靠窗的位置，侧脸看向窗外，玻璃上有街景倒影",
    outfit: "米色针织开衫",
    angle: "sideWindow",
    light: "阴天散射光",
    ref: 1,
  },
  {
    id: "train-cafe-window-c",
    split: "train",
    scene: "咖啡馆窗边",
    scenePrompt: "她在咖啡馆里，手边没有杯子入镜，背景是木质吧台和暖色灯",
    outfit: "浅色牛仔外套",
    angle: "close",
    light: "午后侧逆光，发丝有轮廓光",
    ref: 3,
  },
  {
    id: "train-home-sofa-a",
    split: "train",
    scene: "家里沙发",
    scenePrompt: "她坐在家里旧沙发上，身后是书架和绿植，膝盖上放着一条毛毯",
    outfit: "宽松米白衬衫",
    angle: "close",
    light: "傍晚暖色台灯光",
    ref: 2,
  },
  {
    id: "train-home-sofa-b",
    split: "train",
    scene: "家里沙发",
    scenePrompt: "她蜷在沙发角落，头靠着靠垫，背景是窗外的阴雨天",
    outfit: "深灰针织长袖",
    angle: "threeQuarter",
    light: "窗外阴雨散射光",
    ref: 1,
  },
  {
    id: "train-home-sofa-c",
    split: "train",
    scene: "家里沙发",
    scenePrompt: "深夜客厅，她坐在沙发扶手上回头看向镜头方向，背景只有一盏小灯",
    outfit: "浅蓝家居服",
    angle: "lookBack",
    light: "深夜一盏暖色小灯",
    ref: 3,
  },
  {
    id: "train-night-street-a",
    split: "train",
    scene: "夜晚街头",
    scenePrompt: "夜晚城市街头，背景便利店的灯和霓虹光虚化，空气里有薄雾",
    outfit: "黑色长外套",
    angle: "close",
    light: "霓虹冷光与暖色招牌光混合",
    ref: 2,
  },
  {
    id: "train-night-street-b",
    split: "train",
    scene: "夜晚街头",
    scenePrompt: "她走在夜晚的人行道上，背对镜头回眸，远处是虚化的城市灯光",
    outfit: "深蓝牛仔外套",
    angle: "lookBack",
    light: "路灯顶光",
    ref: 1,
  },
  {
    id: "train-night-street-c",
    split: "train",
    scene: "夜晚街头",
    scenePrompt: "雨后夜晚的街角，她站在路边，湿润的路面反射着灯光",
    outfit: "灰色高领毛衣",
    angle: "threeQuarter",
    light: "雨后街道反光与冷调环境光",
    ref: 3,
  },
  {
    id: "train-rainy-window-a",
    split: "train",
    scene: "雨天窗边",
    scenePrompt: "雨天她坐在窗边，玻璃上挂着雨滴，窗外城市被雨雾模糊",
    outfit: "燕麦色针织开衫",
    angle: "sideWindow",
    light: "阴雨天冷调散射光",
    ref: 1,
  },
  {
    id: "train-rainy-window-b",
    split: "train",
    scene: "雨天窗边",
    scenePrompt: "雨天午后，她靠在窗边看向镜头，窗外是淅沥的雨",
    outfit: "白色棉质长袖",
    angle: "close",
    light: "雨云透下的柔和光线",
    ref: 2,
  },
  {
    id: "train-rainy-window-c",
    split: "train",
    scene: "雨天窗边",
    scenePrompt: "傍晚蓝调时刻，她坐在雨窗前，屋里有暖色小灯",
    outfit: "深色宽松衬衫",
    angle: "threeQuarter",
    light: "窗外冷蓝与室内暖光的对比",
    ref: 3,
  },
  {
    id: "train-seaside-dusk-a",
    split: "train",
    scene: "海边黄昏",
    scenePrompt: "海边黄昏，远处是粉紫色晚霞与平静海面，她站在沙滩边",
    outfit: "浅色亚麻连衣裙",
    angle: "threeQuarter",
    light: "日落暖橙侧光",
    ref: 2,
  },
  {
    id: "train-seaside-dusk-b",
    split: "train",
    scene: "海边黄昏",
    scenePrompt: "她沿着海岸线慢慢走，回头看向镜头，风吹起发丝",
    outfit: "白色 T 恤",
    angle: "lookBack",
    light: "晚霞逆光，发丝有轮廓光",
    ref: 1,
  },
  {
    id: "train-seaside-dusk-c",
    split: "train",
    scene: "海边黄昏",
    scenePrompt: "海边岩石旁，她坐下来看海，背景是渐暗的晚霞",
    outfit: "牛仔衬衫",
    angle: "close",
    light: "柔和黄昏光",
    ref: 3,
  },
  {
    id: "train-park-bench-a",
    split: "train",
    scene: "公园长椅",
    scenePrompt: "春天公园长椅，身后是刚发芽的树和嫩绿的草地",
    outfit: "米色风衣",
    angle: "threeQuarter",
    light: "上午通透阳光",
    ref: 2,
  },
  {
    id: "train-park-bench-b",
    split: "train",
    scene: "公园长椅",
    scenePrompt: "她坐在公园长椅上，树荫落在肩上，抬头看向镜头",
    outfit: "浅色针织开衫",
    angle: "close",
    light: "树叶间斑驳的光影",
    ref: 1,
  },
  {
    id: "train-park-bench-c",
    split: "train",
    scene: "公园长椅",
    scenePrompt: "傍晚的公园，她侧脸看向远处的湖面",
    outfit: "白色卫衣",
    angle: "sideWindow",
    light: "阴天柔光",
    ref: 3,
  },
  {
    id: "train-bookstore-a",
    split: "train",
    scene: "旧书店",
    scenePrompt: "旧书店里，她站在木质书架前，背景是成排的书和暖黄灯",
    outfit: "深棕针织开衫",
    angle: "threeQuarter",
    light: "暖色钨丝灯光",
    ref: 1,
  },
  {
    id: "train-bookstore-b",
    split: "train",
    scene: "旧书店",
    scenePrompt: "她坐在书店靠窗的椅子上看书，侧脸对着镜头",
    outfit: "白衬衫",
    angle: "profile",
    light: "窗边漫射光",
    ref: 2,
  },
  {
    id: "train-bookstore-c",
    split: "train",
    scene: "旧书店",
    scenePrompt: "她在书架之间停下脚步，抬头看向镜头，背景虚化",
    outfit: "深色大衣",
    angle: "close",
    light: "书架夹缝里的暖光",
    ref: 3,
  },
  {
    id: "train-subway-corner-a",
    split: "train",
    scene: "地铁站角落",
    scenePrompt: "傍晚地铁站角落，背景是虚化的站台灯箱与轨道，不出现可读文字",
    outfit: "藏青色大衣",
    angle: "close",
    light: "冷白荧光灯",
    ref: 2,
  },
  {
    id: "train-subway-corner-b",
    split: "train",
    scene: "地铁站角落",
    scenePrompt: "地铁站台边，她侧身站着等车，背景是虚化的站台",
    outfit: "浅灰连帽衫",
    angle: "threeQuarter",
    light: "站台暖黄灯与冷光混合",
    ref: 1,
  },
  {
    id: "train-subway-corner-c",
    split: "train",
    scene: "地铁站角落",
    scenePrompt: "她走进地铁站，回头看向镜头方向，背景是楼梯与灯光",
    outfit: "黑色皮夹克",
    angle: "lookBack",
    light: "列车进站前的风与冷光",
    ref: 3,
  },
  {
    id: "train-kitchen-morning-a",
    split: "train",
    scene: "清晨厨房",
    scenePrompt: "清晨的小厨房，她站在料理台旁，台面上有热茶和吐司（食物不挡脸）",
    outfit: "白色棉质衬衫",
    angle: "close",
    light: "早晨窗户侧光",
    ref: 2,
  },
  {
    id: "train-kitchen-morning-b",
    split: "train",
    scene: "清晨厨房",
    scenePrompt: "清晨厨房里，她侧身看向窗外，晨光落在侧脸上",
    outfit: "浅蓝条纹家居服",
    angle: "threeQuarter",
    light: "清晨冷调柔光",
    ref: 3,
  },
  {
    id: "train-kitchen-morning-c",
    split: "train",
    scene: "清晨厨房",
    scenePrompt: "她端着热茶站在厨房窗边，背景是虚化的窗和绿植",
    outfit: "米色针织开衫",
    angle: "sideWindow",
    light: "晨光逆光，发丝有轮廓光",
    ref: 1,
  },
  {
    id: "train-balcony-night-a",
    split: "train",
    scene: "深夜阳台",
    scenePrompt: "深夜公寓阳台，她靠着栏杆，远处是城市灯火",
    outfit: "深灰针织长袖",
    angle: "threeQuarter",
    light: "城市灯光冷调",
    ref: 2,
  },
  {
    id: "train-balcony-night-b",
    split: "train",
    scene: "深夜阳台",
    scenePrompt: "夜晚阳台，她坐在折叠椅上抬头看向镜头，身后有一点暖色灯",
    outfit: "白色 T 恤外搭薄外套",
    angle: "close",
    light: "阳台暖色小灯",
    ref: 3,
  },
  {
    id: "train-balcony-night-c",
    split: "train",
    scene: "深夜阳台",
    scenePrompt: "她站在阳台门口回头，远处是城市霓虹与月光",
    outfit: "黑色高领毛衣",
    angle: "lookBack",
    light: "月光与远处霓虹",
    ref: 1,
  },

  // ── 评测集 8 张（场景/服装/角度/光线均与训练集不重复）──
  {
    id: "eval-rooftop-dusk",
    split: "eval",
    scene: "城市天台黄昏",
    scenePrompt: "城市天台黄昏，远处是建筑天际线与橙粉色晚霞",
    outfit: "橄榄绿工装外套",
    angle: "lowAngle",
    light: "晚霞侧光与城市反光",
    ref: 2,
  },
  {
    id: "eval-train-window",
    split: "eval",
    scene: "高铁车窗边",
    scenePrompt: "高铁车窗边，窗外掠过模糊的田野和电线杆",
    outfit: "米色风衣",
    angle: "profile",
    light: "午后车厢顶光",
    ref: 2,
  },
  {
    id: "eval-flower-market",
    split: "eval",
    scene: "花市门口",
    scenePrompt: "花市/花店门口，周围是成桶的鲜花与绿植",
    outfit: "浅粉针织开衫",
    angle: "threeQuarter",
    light: "阴天柔和散射光",
    ref: 2,
  },
  {
    id: "eval-convenience-night",
    split: "eval",
    scene: "深夜便利店",
    scenePrompt: "深夜便利店门口，冷白灯照着货架，街道空无一人",
    outfit: "黑色羽绒服",
    angle: "close",
    light: "便利店冷白灯光",
    ref: 2,
  },
  {
    id: "eval-library-stairs",
    split: "eval",
    scene: "图书馆楼梯间",
    scenePrompt: "图书馆楼梯间，窗外光从高窗落进来，背景是栏杆与书架",
    outfit: "深色高领毛衣",
    angle: "threeQuarter",
    light: "楼梯高窗的侧光",
    ref: 2,
  },
  {
    id: "eval-beach-morning",
    split: "eval",
    scene: "清晨海边",
    scenePrompt: "清晨海边，天刚亮，海面有薄雾和微光",
    outfit: "亚麻衬衫",
    angle: "lookBack",
    light: "清晨海面反光",
    ref: 2,
  },
  {
    id: "eval-winter-street",
    split: "eval",
    scene: "冬天街道",
    scenePrompt: "冬天街道，路边有积雪，她戴着围巾，呼出的白气隐约可见",
    outfit: "灰色羊毛大衣 + 米色围巾",
    angle: "close",
    light: "阴雪天冷调光",
    ref: 2,
  },
  {
    id: "eval-record-shop",
    split: "eval",
    scene: "唱片店",
    scenePrompt: "唱片店里，她侧脸看向黑胶唱片架，背景是成排的唱片",
    outfit: "格纹衬衫",
    angle: "profile",
    light: "店内暖色射灯",
    ref: 2,
  },
];

// ── CLI ─────────────────────────────────────────

interface Options {
  endpoint: string;
  steps: number;
  seedBase: number;
  only: "all" | "train" | "eval";
  limit: number | null;
  force: boolean;
  dryRun: boolean;
  prepare: boolean;
  list: boolean;
  ids: string[] | null;
  refOverride: 1 | 2 | 3 | null;
  refList: string[] | null;
  outRoot: string | null;
  qcReport: string | null;
  qcThreshold: number;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseOptions(): Options {
  const onlyRaw = (argValue("only") ?? "all").toLowerCase();
  const only = onlyRaw === "train" || onlyRaw === "eval" ? (onlyRaw as "train" | "eval") : "all";
  const limitRaw = Number(argValue("limit") ?? "0");
  return {
    endpoint: (argValue("endpoint") ?? process.env.QWEN_IMAGE_EDIT_URL ?? DEFAULT_ENDPOINT)
      .trim()
      .replace(/\/+$/, ""),
    steps: Math.max(8, Math.min(20, Number(argValue("steps") ?? DEFAULT_STEPS) || DEFAULT_STEPS)),
    seedBase: Number(argValue("seed-base") ?? DEFAULT_SEED_BASE) || DEFAULT_SEED_BASE,
    only,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null,
    force: hasFlag("force"),
    dryRun: hasFlag("dry-run"),
    prepare: hasFlag("prepare"),
    list: hasFlag("list"),
    ids: (() => {
      const raw = (argValue("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      return raw.length > 0 ? raw : null;
    })(),
    refOverride: (() => {
      const raw = Number(argValue("ref") ?? "0");
      return raw === 1 || raw === 2 || raw === 3 ? (raw as 1 | 2 | 3) : null;
    })(),
    refList: (() => {
      const raw = (argValue("ref-list") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      return raw.length > 0 ? raw : null;
    })(),
    outRoot: argValue("out-root") ?? null,
    qcReport: argValue("qc-report") ?? null,
    qcThreshold: Number(argValue("qc-threshold") ?? "0.60") || 0.6,
  };
}

function specSeed(spec: SceneSpec, index: number, seedBase: number): number {
  const splitOffset = spec.split === "eval" ? 100_000 : 0;
  return seedBase + splitOffset + index * 97;
}

function promptFor(spec: SceneSpec): string {
  return [
    spec.scenePrompt,
    IDENTITY_PROMPT,
    `服装：${spec.outfit}`,
    ANGLE_PROMPTS[spec.angle],
    `光线：${spec.light}`,
    STYLE_PROMPT,
    NEGATIVE_PROMPT,
  ].join("；");
}

function refPath(spec: SceneSpec): string {
  return `${SERVER_REF_DIR}/character-${spec.ref}.jpg`;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── 参考图准备 ─────────────────────────────────

interface RefEntry {
  name: string;
  source: string;
  target: string;
  bytes: number;
  sha256: string;
}

async function prepareRefs(): Promise<RefEntry[]> {
  await fs.mkdir(REFS_DIR, { recursive: true });
  const entries: RefEntry[] = [];
  for (const ref of REF_SOURCES) {
    const sourcePath = path.resolve(LOCAL_REPO, ref.source);
    const targetPath = path.join(REFS_DIR, ref.name);
    const buffer = await fs.readFile(sourcePath);
    await fs.writeFile(targetPath, buffer);
    entries.push({
      name: ref.name,
      source: ref.source,
      target: targetPath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    });
    console.log(`[refs] ${ref.source} -> ${path.relative(LOCAL_REPO, targetPath)} (${(buffer.length / 1024).toFixed(0)}KB)`);
  }
  await fs.writeFile(
    path.join(REFS_DIR, "refs.json"),
    JSON.stringify({ preparedAt: new Date().toISOString(), refs: entries }, null, 2) + "\n",
    "utf-8",
  );
  return entries;
}

// ── 生成 ────────────────────────────────────────

interface GenerateOutcome {
  ok: boolean;
  png?: Buffer;
  status?: number;
  elapsedMs: number;
  error?: string;
  width?: number;
  height?: number;
}

async function generateOnce(
  endpoint: string,
  prompt: string,
  imagePaths: string[],
  seed: number,
  steps: number,
  timeoutMs: number,
): Promise<GenerateOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        simple: true,
        image_paths: imagePaths,
        num_inference_steps: steps,
        seed,
      }),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, elapsedMs, error: `http ${response.status} ${text.slice(0, 200)}` };
    }
    const png = Buffer.from(await response.arrayBuffer());
    const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    if (!isPng) return { ok: false, status: response.status, elapsedMs, error: `invalid_png bytes=${png.length}` };
    const width = Number(response.headers.get("x-image-width"));
    const height = Number(response.headers.get("x-image-height"));
    return {
      ok: true,
      png,
      status: response.status,
      elapsedMs,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    };
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, elapsedMs, error: message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

interface GeneratedRecord {
  path: string;
  split: "train" | "eval";
  scene: string;
  seed: number;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  elapsedMs: number;
}

interface FailureRecord {
  id: string;
  split: "train" | "eval";
  scene: string;
  seed: number;
  attempts: number;
  error: string;
}

async function generateAll(opts: Options): Promise<void> {
  const specs = SCENES.filter((s) => opts.only === "all" || s.split === opts.only)
    .filter((s) => {
      if (!opts.ids) return true;
      const short = s.id.replace(/^(train|eval)-/, "");
      return opts.ids.includes(s.id) || opts.ids.includes(short) || opts.ids.includes(s.id.replace(/^train-/, ""));
    })
    .slice(0, opts.limit ?? undefined);
  if (specs.length === 0) {
    console.error("没有匹配的场景（检查 --only/--limit）");
    process.exitCode = 1;
    return;
  }

  console.log(
    `[dataset] endpoint=${opts.endpoint} steps=${opts.steps} seedBase=${opts.seedBase} ` +
      `scenes=${specs.length} (train=${specs.filter((s) => s.split === "train").length}, ` +
      `eval=${specs.filter((s) => s.split === "eval").length})`,
  );

  await fs.mkdir(path.join(RAW_DIR, "train"), { recursive: true });
  await fs.mkdir(path.join(RAW_DIR, "eval"), { recursive: true });

  const records: GeneratedRecord[] = [];
  const failures: FailureRecord[] = [];
  const skipped: GeneratedRecord[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const effective: SceneSpec = opts.refOverride ? { ...spec, ref: opts.refOverride } : spec;
    const imagePaths = opts.refList ?? [refPath(effective)];
    const seed = specSeed(spec, i, opts.seedBase);
    const dir = path.join(RAW_DIR, spec.split);
    const filename = `${spec.scene.replace(/[^\p{L}\p{N}-]+/gu, "-")}-${seed}`;
    const pngPath = path.join(dir, `${filename}.png`);
    const jsonPath = path.join(dir, `${filename}.json`);
    const prefix = `[${String(i + 1).padStart(2, "0")}/${String(specs.length).padStart(2, "0")}] ${spec.split}/${spec.scene}`;

    if (!opts.force && (await fileExists(pngPath))) {
      const existing = await fs.readFile(pngPath);
      const sidecar = JSON.parse(await fs.readFile(jsonPath, "utf-8").catch(() => "{}")) as Record<string, unknown>;
      skipped.push({
        path: path.relative(LOCAL_REPO, pngPath),
        split: spec.split,
        scene: spec.scene,
        seed,
        bytes: existing.length,
        sha256: sha256(existing),
        ...(typeof sidecar.width === "number" ? { width: sidecar.width } : {}),
        ...(typeof sidecar.height === "number" ? { height: sidecar.height } : {}),
        elapsedMs: 0,
      });
      console.log(`${prefix} SKIP (exists) ${path.relative(LOCAL_REPO, pngPath)}`);
      continue;
    }

    const prompt = promptFor(effective);
    const requestedAt = new Date().toISOString();
    let outcome: GenerateOutcome | null = null;
    let attempts = 0;
    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attempts = attempt + 1;
      if (attempt > 0) {
        const retryDelay = 2000 * attempt;
        console.log(`${prefix} retry ${attempt}/${MAX_ATTEMPTS - 1} (sleep ${retryDelay}ms): ${lastError}`);
        await new Promise((r) => setTimeout(r, retryDelay));
      }
      outcome = await generateOnce(opts.endpoint, prompt, imagePaths, seed + attempt * 1000, opts.steps, REQUEST_TIMEOUT_MS);
      if (outcome.ok) break;
      lastError = outcome.error ?? "unknown";
    }

    if (!outcome?.ok || !outcome.png) {
      failures.push({ id: spec.id, split: spec.split, scene: spec.scene, seed, attempts, error: lastError });
      console.error(`${prefix} FAIL after ${attempts} attempt(s): ${lastError}`);
      continue;
    }

    await fs.writeFile(pngPath, outcome.png);
    const record: GeneratedRecord = {
      path: path.relative(LOCAL_REPO, pngPath),
      split: spec.split,
      scene: spec.scene,
      seed,
      bytes: outcome.png.length,
      sha256: sha256(outcome.png),
      elapsedMs: outcome.elapsedMs,
      ...(outcome.width ? { width: outcome.width } : {}),
      ...(outcome.height ? { height: outcome.height } : {}),
    };
    records.push(record);
    const sidecar = {
      id: spec.id,
      split: spec.split,
      scene: spec.scene,
      scenePrompt: spec.scenePrompt,
      outfit: spec.outfit,
      angle: spec.angle,
      light: spec.light,
      ref: imagePaths[0],
      refs: imagePaths,
      seed: seed + (attempts - 1) * 1000,
      steps: opts.steps,
      endpoint: opts.endpoint,
      requestedAt,
      elapsedMs: outcome.elapsedMs,
      status: outcome.status ?? 200,
      width: record.width ?? null,
      height: record.height ?? null,
      bytes: record.bytes,
      sha256: record.sha256,
      prompt,
      attempts,
    };
    await fs.writeFile(jsonPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
    console.log(
      `${prefix} seed=${sidecar.seed} -> ${record.width ?? "?"}x${record.height ?? "?"} ` +
        `${(outcome.elapsedMs / 1000).toFixed(1)}s ${(record.bytes / 1024).toFixed(0)}KB ${path.basename(pngPath)}`,
    );
  }

  // ── 汇总 manifest（合并本目录下已有 sidecar，支持分批跑）──
  const allRecords = await collectExistingRecords();
  const manifest = {
    generatedAt: new Date().toISOString(),
    endpoint: opts.endpoint,
    steps: opts.steps,
    seedBase: opts.seedBase,
    counts: {
      total: allRecords.length,
      train: allRecords.filter((r) => r.split === "train").length,
      eval: allRecords.filter((r) => r.split === "eval").length,
    },
    scenes: summarizeScenes(allRecords),
    files: allRecords.sort((a, b) => a.path.localeCompare(b.path)),
    run: {
      requested: specs.length,
      generated: records.length,
      skipped: skipped.length,
      failed: failures.length,
      failures,
    },
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(
    `\n[dataset] done: total=${manifest.counts.total} train=${manifest.counts.train} eval=${manifest.counts.eval} ` +
      `| this run: new=${records.length} skipped=${skipped.length} failed=${failures.length}`,
  );
  console.log(`[dataset] manifest -> ${path.relative(LOCAL_REPO, MANIFEST_PATH)}`);
  if (failures.length > 0) {
    console.error(`[dataset] ${failures.length} 张失败，见 manifest.run.failures；可重跑同命令补生成`);
    process.exitCode = 1;
  }
}

async function collectExistingRecords(): Promise<Array<GeneratedRecord & { file: string }>> {
  const out: Array<GeneratedRecord & { file: string }> = [];
  for (const split of ["train", "eval"] as const) {
    const dir = path.join(RAW_DIR, split);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".png")).sort()) {
      const pngPath = path.join(dir, name);
      const buffer = await fs.readFile(pngPath);
      let sidecar: Record<string, unknown> = {};
      try {
        sidecar = JSON.parse(await fs.readFile(pngPath.replace(/\.png$/, ".json"), "utf-8")) as Record<string, unknown>;
      } catch {
        // sidecar 缺失也保留文件，从文件名解析
      }
      out.push({
        path: path.relative(LOCAL_REPO, pngPath),
        file: name,
        split,
        scene: typeof sidecar.scene === "string" ? sidecar.scene : name.replace(/-\d+\.png$/, ""),
        seed: typeof sidecar.seed === "number" ? sidecar.seed : Number(name.match(/-(\d+)\.png$/)?.[1] ?? 0),
        bytes: buffer.length,
        sha256: sha256(buffer),
        elapsedMs: typeof sidecar.elapsedMs === "number" ? sidecar.elapsedMs : 0,
        ...(typeof sidecar.width === "number" ? { width: sidecar.width } : {}),
        ...(typeof sidecar.height === "number" ? { height: sidecar.height } : {}),
      });
    }
  }
  return out;
}

function summarizeScenes(records: Array<{ split: string; scene: string }>): Record<string, { train: number; eval: number }> {
  const map: Record<string, { train: number; eval: number }> = {};
  for (const r of records) {
    map[r.scene] ??= { train: 0, eval: 0 };
    if (r.split === "train") map[r.scene].train += 1;
    else map[r.scene].eval += 1;
  }
  return map;
}

// ── 数据质量报告（ArcFace 初筛 + 人工剔除合并）──────

interface QcRow {
  file: string;
  id: string;
  split: string;
  scene: string;
  seed: number;
  faces: number;
  detected: boolean;
  best_cosine: number | null;
  best_ref: string | null;
  accepted: boolean;
  source: "auto" | "manual";
  reason: string;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function statBlock(values: number[]): Record<string, number | null> {
  if (values.length === 0) return { count: 0, mean: null, std: null, min: null, max: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean: round4(mean),
    std: round4(Math.sqrt(variance)),
    min: round4(Math.min(...values)),
    max: round4(Math.max(...values)),
  };
}

async function runQcReport(opts: Options): Promise<void> {
  if (!opts.qcReport) return;
  const baselinePath = path.resolve(opts.qcReport);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf-8")) as {
    generated?: Array<Record<string, unknown>>;
  };
  const rows = baseline.generated ?? [];
  if (rows.length === 0) {
    console.error(`[qc] baseline 里没有 generated 明细：${baselinePath}`);
    process.exitCode = 1;
    return;
  }
  let overrides: { reject?: string[]; accept?: string[]; reason?: Record<string, string> } = {};
  const overridesPath = path.join(OUT_ROOT, "qc-overrides.json");
  try {
    overrides = JSON.parse(await fs.readFile(overridesPath, "utf-8")) as typeof overrides;
  } catch {
    overrides = {};
  }
  const manualReject = new Set((overrides.reject ?? []).map(String));
  const manualAccept = new Set((overrides.accept ?? []).map(String));
  const reasons = overrides.reason ?? {};

  const decisions: QcRow[] = [];
  for (const row of rows) {
    const file = String(row.file ?? "");
    const basename = path.basename(file);
    const stem = basename.replace(/\.png$/i, "");
    const split = String(row.split ?? "");
    const scene = String(row.scene ?? "");
    const seed = Number(row.seed ?? 0);
    let id = stem;
    try {
      const sidecar = JSON.parse(
        await fs.readFile(path.join(RAW_DIR, split, `${stem}.json`), "utf-8"),
      ) as { id?: string };
      if (sidecar.id) id = sidecar.id;
    } catch {
      // sidecar 可缺，退回文件名
    }
    const faces = Number(row.faces ?? 0);
    const detected = row.detected === true;
    const best = typeof row.best_cosine === "number" ? (row.best_cosine as number) : null;
    const bestRef = row.best_ref == null ? null : String(row.best_ref);
    const keys = [basename, stem, id];
    const isManualReject = keys.some((k) => manualReject.has(k));
    const isManualAccept = keys.some((k) => manualAccept.has(k));
    const manualReason = keys.map((k) => reasons[k]).find(Boolean);
    let accepted = detected && faces === 1 && best !== null && best >= opts.qcThreshold;
    let reason = !detected
      ? "no_face"
      : faces !== 1
        ? `faces=${faces}`
        : best === null
          ? "no_cosine"
          : `cosine_below_${opts.qcThreshold}`;
    if (accepted) reason = "ok";
    if (isManualReject && !isManualAccept) {
      accepted = false;
      reason = manualReason ?? "manual_reject";
    } else if (isManualAccept) {
      accepted = true;
      reason = manualReason ?? "manual_accept";
    }
    decisions.push({
      file: basename,
      id,
      split,
      scene,
      seed,
      faces,
      detected,
      best_cosine: best,
      best_ref: bestRef,
      accepted,
      source: isManualReject || isManualAccept ? "manual" : "auto",
      reason,
    });
  }

  const allCos = decisions.map((d) => d.best_cosine).filter((v): v is number => v !== null);
  const countIn = (lo: number, hi: number | null): number =>
    allCos.filter((v) => v >= lo && (hi === null || v < hi)).length;
  const accepted = decisions.filter((d) => d.accepted);
  const rejected = decisions.filter((d) => !d.accepted);
  const reasonCounts: Record<string, number> = {};
  for (const d of rejected) {
    const category = d.reason.startsWith("cosine_below")
      ? "low_cosine"
      : d.reason.startsWith("faces=")
        ? "multi_face"
        : d.reason;
    reasonCounts[category] = (reasonCounts[category] ?? 0) + 1;
  }
  const splitStats = (split: string): Record<string, unknown> => {
    const rowsForSplit = decisions.filter((d) => d.split === split);
    const cosForSplit = rowsForSplit.map((d) => d.best_cosine).filter((v): v is number => v !== null);
    return {
      total: rowsForSplit.length,
      accepted: rowsForSplit.filter((d) => d.accepted).length,
      rejected: rowsForSplit.filter((d) => !d.accepted).length,
      best_cosine: statBlock(cosForSplit),
    };
  };

  const qc = {
    generatedAt: new Date().toISOString(),
    baseline: path.relative(process.cwd(), baselinePath),
    threshold: opts.qcThreshold,
    rule: `faces==1 且 best_ref_cosine >= ${opts.qcThreshold}；人工剔除遮脸/白化发色/绿发/脸型漂移（见 qc-overrides.json）`,
    distribution: {
      best_cosine: statBlock(allCos),
      buckets: {
        ">=0.70": countIn(0.7, null),
        "0.65-0.70": countIn(0.65, 0.7),
        "0.60-0.65": countIn(0.6, 0.65),
        "0.55-0.60": countIn(0.55, 0.6),
        "<0.55": countIn(-1, 0.55),
      },
      by_split: { train: splitStats("train"), eval: splitStats("eval") },
    },
    counts: {
      total: decisions.length,
      accepted: accepted.length,
      rejected: rejected.length,
      accepted_train: accepted.filter((d) => d.split === "train").length,
      accepted_eval: accepted.filter((d) => d.split === "eval").length,
    },
    reasons: reasonCounts,
    accepted_list: accepted.map((d) => ({
      split: d.split,
      file: d.file,
      id: d.id,
      best_cosine: d.best_cosine,
      best_ref: d.best_ref,
    })),
    rejected_list: rejected.map((d) => ({
      split: d.split,
      file: d.file,
      id: d.id,
      reason: d.reason,
      source: d.source,
      faces: d.faces,
      best_cosine: d.best_cosine,
    })),
    decisions,
  };

  const qcPath = path.join(OUT_ROOT, "qc.json");
  await fs.writeFile(qcPath, JSON.stringify(qc, null, 2) + "\n", "utf-8");

  // 把 qc 结果写回 manifest（每个文件加 qc_status，顶层加 quality 汇总）
  try {
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf-8")) as Record<string, unknown>;
    const byFile = new Map(decisions.map((d) => [d.file, d]));
    const files = ((manifest.files as Array<Record<string, unknown>> | undefined) ?? []).map((file) => {
      const decision = byFile.get(path.basename(String(file.path ?? "")));
      if (!decision) return file;
      return {
        ...file,
        qc_status: decision.accepted ? "accepted" : "rejected",
        qc_reason: decision.reason,
        qc_cosine: decision.best_cosine,
      };
    });
    manifest.files = files;
    manifest.quality = {
      qcPath: path.relative(process.cwd(), qcPath),
      generatedAt: qc.generatedAt,
      threshold: opts.qcThreshold,
      counts: qc.counts,
      reasons: reasonCounts,
    };
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`[qc] manifest 已更新（quality）：${path.relative(process.cwd(), MANIFEST_PATH)}`);
  } catch (err: unknown) {
    console.warn(`[qc] manifest 更新失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[qc] total=${qc.counts.total} accepted=${qc.counts.accepted} ` +
      `(train=${qc.counts.accepted_train}, eval=${qc.counts.accepted_eval}) rejected=${qc.counts.rejected}`,
  );
  console.log(`[qc] cosine 分布：${JSON.stringify(qc.distribution.best_cosine)}`);
  console.log(`[qc] 剔除原因：${JSON.stringify(reasonCounts)}`);
  console.log(`[qc] -> ${path.relative(process.cwd(), qcPath)}`);
}

// ── 入口 ────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseOptions();
  if (opts.outRoot) {
    OUT_ROOT = path.resolve(opts.outRoot);
    RAW_DIR = path.join(OUT_ROOT, "raw");
    MANIFEST_PATH = path.join(OUT_ROOT, "manifest.json");
  }
  if (opts.qcReport) {
    await runQcReport(opts);
    return;
  }

  await fs.mkdir(OUT_ROOT, { recursive: true });
  if (opts.prepare) await prepareRefs();

  if (opts.list || opts.dryRun) {
    let index = 0;
    const rows = SCENES.filter((s) => opts.only === "all" || s.split === opts.only);
    for (const spec of rows) {
      const seed = specSeed(spec, index, opts.seedBase);
      index += 1;
      console.log(
        `${String(index).padStart(2, "0")}. [${spec.split}] ${spec.scene} seed=${seed} ref=character-${spec.ref}.jpg ` +
          `angle=${spec.angle} | ${spec.outfit} | ${spec.light}`,
      );
    }
    console.log(`\n共 ${rows.length} 张（train=${rows.filter((r) => r.split === "train").length}, eval=${rows.filter((r) => r.split === "eval").length}）`);
    if (opts.dryRun) {
      console.log(`[dry-run] 不会请求服务。示例 prompt：\n${promptFor(rows[0])}`);
      return;
    }
  }

  if (opts.list) return;
  if (opts.dryRun) return;
  await generateAll(opts);
}

main().catch((err: unknown) => {
  console.error(`[dataset] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
