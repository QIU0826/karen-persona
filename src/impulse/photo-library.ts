/**
 * 本地图片库（她主动分享的「随手拍」兜底图源）。
 *
 * 用途：没有配置 UNSPLASH_ACCESS_KEY 或 Unsplash 搜索失败时，用本地授权图片兜底，
 * 保证「她会发图」在离线/无 Key 环境也可用、可测。
 *
 * 资源：来自 Lorem Picsum（picsum.photos，图片源自 Unsplash，Unsplash License），
 * 详见 assets/photos/README.md。资源缺失时静默降级（返回 null）。
 */
import fs from "node:fs";
import path from "node:path";
import { assetDir } from "../data/paths.js";

export interface PhotoDef {
  /** 稳定 id（日志用） */
  id: string;
  /** assets/photos 下的文件名 */
  file: string;
  /** 场景/情绪标签 */
  tags: string[];
  /** 配文候选（轻描淡写，符合人物「随手分享」的语气） */
  captions: string[];
  /** 适合发送的时段 [起始小时, 结束小时)，如晚霞图只在 17-21 点发 */
  hours: [number, number];
}

const PHOTO_DIR = assetDir("assets/photos");

const PHOTOS: PhotoDef[] = [
  {
    id: "snow-forest",
    file: "snow-forest.jpg",
    tags: ["snow", "forest", "quiet", "nature", "winter"],
    captions: ["路上拍的，雪把树都盖住了", "今天路上一个人都没有"],
    hours: [6, 19],
  },
  {
    id: "bear",
    file: "bear.jpg",
    tags: ["animal", "funny", "nature"],
    captions: ["笑死，刷到一只熊", "这熊的表情，跟我今天心情一模一样"],
    hours: [0, 24],
  },
  {
    id: "cafe",
    file: "cafe.jpg",
    tags: ["cafe", "indoor", "plants", "warm", "work"],
    captions: ["店里今天摆了几盆花", "没客人的时候就擦擦杯子"],
    hours: [7, 22],
  },
  {
    id: "mug-desk",
    file: "mug-desk.jpg",
    tags: ["coffee", "mug", "morning", "cozy", "desk"],
    captions: ["刚泡的，今天换了个杯子", "第一杯，坐窗边喝的"],
    hours: [6, 15],
  },
  {
    id: "sunset-plants",
    file: "sunset-plants.jpg",
    tags: ["sunset", "golden", "nature", "warm"],
    captions: ["下班路上看到的光", "路边这些草被照得金灿灿的"],
    hours: [17, 21],
  },
  {
    id: "mountain",
    file: "mountain.jpg",
    tags: ["mountain", "travel", "nature", "sky"],
    captions: ["翻到上次出去玩拍的照片", "远处的山和云，看着就舒服"],
    hours: [7, 19],
  },
  {
    id: "sunset-pier",
    file: "sunset-pier.jpg",
    tags: ["sunset", "lake", "pier", "sky", "calm"],
    captions: ["今天的晚霞", "湖边这个码头，站了一会儿"],
    hours: [17, 21],
  },
];

export function getPhotoCatalog(): readonly PhotoDef[] {
  return PHOTOS;
}

function photosByTags(tags: string[]): PhotoDef[] {
  return PHOTOS.filter((p) => p.tags.some((t) => tags.includes(t)));
}

export interface PickPhotoInput {
  /** 当前情绪 -1..1 */
  emotion: number;
  /** 当前小时 0-23 */
  hour: number;
  /** 额外偏好标签（如天气/话题） */
  tags?: string[];
  /** 可注入随机源（测试用；返回 0..1） */
  random?: () => number;
}

/** 按情绪/时段挑选一张本地图；不适合发时返回 null。 */
/** 图库时段过滤：晚霞/夜景图只有对应时段才允许发。 */
function inHours(hours: [number, number], hour: number): boolean {
  const [start, end] = hours;
  if (start === 0 && end === 24) return true;
  return hour >= start && hour < end;
}

function pickFrom(list: PhotoDef[], random: () => number): PhotoDef | null {
  if (list.length === 0) return null;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index];
}

export function pickPhoto(input: PickPhotoInput): PhotoDef | null {
  const hourSafe = PHOTOS.filter((p) => inHours(p.hours, input.hour));
  const random = input.random ?? Math.random;

  let category: PhotoDef[];
  if (input.tags && input.tags.length > 0) {
    category = photosByTags(input.tags);
  } else if (input.emotion <= -0.3) {
    category = photosByTags(["nature", "quiet", "calm", "mountain"]);
  } else if (input.emotion >= 0.3) {
    category = photosByTags(["warm", "sunset", "cafe", "animal"]);
  } else {
    category = PHOTOS;
  }

  // 1) 类别 ∩ 时段；2) 时段内任意图；3) 兜底全图库
  const preferred = category.filter((p) => inHours(p.hours, input.hour));
  return pickFrom(preferred, random) ?? pickFrom(hourSafe, random) ?? pickFrom(PHOTOS, random);
}

/** 返回本地图片绝对路径；文件不存在返回 null。 */
export function photoFilePath(photo: PhotoDef): string | null {
  const filePath = path.join(PHOTO_DIR, photo.file);
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 8 * 1024 * 1024) return null;
    return filePath;
  } catch {
    return null;
  }
}

/** 随机选一条配文。 */
export function pickPhotoCaption(photo: PhotoDef, random: () => number = Math.random): string {
  const index = Math.min(photo.captions.length - 1, Math.floor(random() * photo.captions.length));
  return photo.captions[index];
}
