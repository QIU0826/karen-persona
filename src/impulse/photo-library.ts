/**
 * 本地图片库（她主动分享的「随手拍」/「以前的生活」兜底图源）。
 *
 * 核心模型（不是简单按时间过滤）：
 * - 每张图有「故事」：场景（早晨/白天/傍晚/夜晚/室内）+ 允许分享的时间关系
 *   （今天拍的 / 昨天的 / 以前的）；
 * - 「今天拍的」只在场景与当前时段匹配时成立（傍晚的晚霞不会在早上说成"今天"），
 *   但同一张图可以在早上以「昨天的晚霞」分享——人本来就会翻旧图；
 * - 「以前的照片」受亲密度门槛限制（默认 >= 4.0 才会分享旧生活），
 *   亲密度越高越愿意讲以前的事；
 * - 配文按「时间关系」生成，避免时间错乱（不会早上说"今天的晚霞"）。
 *
 * 资源：来自 Lorem Picsum（picsum.photos，图片源自 Unsplash，Unsplash License），
 * 详见 assets/photos/README.md。资源缺失时静默降级（返回 null）。
 */
import fs from "node:fs";
import path from "node:path";
import { assetDir } from "../data/paths.js";

export type PhotoScene = "morning" | "day" | "dusk" | "night" | "indoor" | "any";
export type PhotoEra = "today" | "yesterday" | "past";

export interface PhotoDef {
  /** 稳定 id（日志用） */
  id: string;
  /** assets/photos 下的文件名 */
  file: string;
  /** 场景/情绪标签 */
  tags: string[];
  /** 拍摄场景（决定"今天拍的"是否成立） */
  scene: PhotoScene;
  /** 可接受的时间关系 */
  eras: PhotoEra[];
  /** 分享「以前的生活」所需的最低亲密度（默认 4.0；仅对 past 生效） */
  minCloseness?: number;
  /** 各时间关系下的配文（口语化、轻描淡写） */
  captions: Record<PhotoEra, string[]>;
}

/** 默认「以前的生活」亲密度门槛：4.0（开始熟络之后才愿意讲过去） */
export const DEFAULT_MEMORY_MIN_CLOSENESS = 4.0;

const PHOTO_DIR = assetDir("assets/photos");

const PHOTOS: PhotoDef[] = [
  {
    id: "snow-forest",
    file: "snow-forest.jpg",
    tags: ["snow", "forest", "quiet", "nature", "winter"],
    scene: "day",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["路上拍的，雪还没化", "今天路上一个人都没有"],
      yesterday: ["昨天拍的，雪还没化", "昨天路上一个人都没有"],
      past: ["翻到以前下雪的照片", "好几年前也下过这么厚的雪"],
    },
  },
  {
    id: "bear",
    file: "bear.jpg",
    tags: ["animal", "funny", "nature"],
    scene: "any",
    eras: ["today", "yesterday"],
    captions: {
      today: ["笑死，刷到一只熊", "这熊的表情，跟我今天心情一模一样"],
      yesterday: ["昨天刷到一只熊，还是很好笑"],
      past: [],
    },
  },
  {
    id: "cafe",
    file: "cafe.jpg",
    tags: ["cafe", "indoor", "plants", "warm", "work"],
    scene: "indoor",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["店里今天摆了几盆花", "没客人的时候就擦擦杯子"],
      yesterday: ["昨天店里摆的花，今天还开着"],
      past: ["以前店里也养过一盆，后来死了", "翻到以前店里的照片"],
    },
  },
  {
    id: "mug-desk",
    file: "mug-desk.jpg",
    tags: ["coffee", "mug", "morning", "cozy", "desk"],
    scene: "morning",
    eras: ["today", "yesterday"],
    captions: {
      today: ["刚泡的，今天换了个杯子", "第一杯，坐窗边喝的"],
      yesterday: ["昨天也用的这个杯子"],
      past: [],
    },
  },
  {
    id: "sunset-plants",
    file: "sunset-plants.jpg",
    tags: ["sunset", "golden", "nature", "warm"],
    scene: "dusk",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["下班路上看到的光", "这些草被照得金灿灿的"],
      yesterday: ["昨天的光，今天翻到又看了一遍"],
      past: ["以前也拍过这样的傍晚", "翻到以前的照片，光还是这样"],
    },
  },
  {
    id: "mountain",
    file: "mountain.jpg",
    tags: ["mountain", "travel", "nature", "sky"],
    scene: "day",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["今天天气好，想起远处的山", "远处的山和云"],
      yesterday: ["昨天翻到之前爬山拍的"],
      past: ["翻到以前出去玩拍的照片", "好几年前去的，山和云还是那样"],
    },
  },
  {
    id: "sunset-pier",
    file: "sunset-pier.jpg",
    tags: ["sunset", "lake", "pier", "sky", "calm"],
    scene: "dusk",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["今天的晚霞", "湖边这个码头，站了一会儿"],
      yesterday: ["昨天的晚霞", "昨天在湖边站了一会儿"],
      past: ["翻到以前在湖边拍的", "好几年前也看过这样的晚霞"],
    },
  },
  {
    id: "latte-plants",
    file: "latte-plants.jpg",
    tags: ["coffee", "cafe", "plants", "warm", "morning"],
    scene: "morning",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["早上第一杯，拉花勉强能看", "桌上绿萝又长疯了", "开门前先给自己做一杯"],
      yesterday: ["昨天早上拍的，阳光刚好", "昨天的拉花比今天好看", "店里早上就是这样，安安静静的"],
      past: ["翻到刚学拉花那会儿", "以前拍的吧台，杯子还没换"],
    },
  },
  {
    id: "cat-sofa",
    file: "cat-sofa.jpg",
    tags: ["animal", "indoor", "cozy", "warm", "cat"],
    scene: "indoor",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["它又占了我的位置", "刚睡醒，一脸不高兴", "今天一步都不肯挪"],
      yesterday: ["昨天拍的，趴了一下午", "昨天它也这样，谁叫都不理", "昨天下班回来它就这样"],
      past: ["翻到它刚来的时候，好小一只", "以前拍的，现在胖了一圈", "好久以前的照片了，那时候还怕人"],
    },
  },
  {
    id: "city-dusk",
    file: "city-dusk.jpg",
    tags: ["city", "dusk", "street", "night", "travel"],
    scene: "dusk",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["下班路上，刚下过雨", "傍晚的街，灯全亮了", "今天走到这儿抬头看了一眼"],
      yesterday: ["昨天路过拍的", "昨天的天比今天好看", "昨天走到这，正好赶上灯亮"],
      past: ["以前下班也走这条路", "翻到刚来上海那会儿拍的", "好几年前了，那会儿还觉得新鲜"],
    },
  },
  {
    id: "rain-window",
    file: "rain-window.jpg",
    tags: ["rain", "window", "night", "quiet", "mood"],
    scene: "night",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["下雨了，玻璃上全是水", "外面在下雨，店里没什么人", "今天这雨下得没完没了"],
      yesterday: ["昨天也下了，拍到水珠", "昨天的雨比今天大", "昨天下班时拍的，伞都忘了带"],
      past: ["翻到以前下雨拍的", "以前的雨季，好像也没这么烦", "好几年前的照片了"],
    },
  },
  {
    id: "dinner-table",
    file: "dinner-table.jpg",
    tags: ["food", "dinner", "indoor", "warm", "night"],
    scene: "night",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["今天难得好好吃一顿", "下班晚了，随便找家店", "今天这顿算犒劳自己"],
      yesterday: ["昨天和朋友吃的", "昨天的饭，比今天讲究", "昨天吃到一半才想起来拍"],
      past: ["以前也来过这家", "翻到以前的照片，那会儿还挺能吃", "好几年前了"],
    },
  },
  {
    id: "three-lattes",
    file: "three-lattes.jpg",
    tags: ["coffee", "cafe", "hands", "work", "warm"],
    scene: "day",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["一下做三杯，手都忙不过来", "今天客人点的，摆一起还挺好看", "忙起来就是这种时候"],
      yesterday: ["昨天忙的时候拍的", "昨天也是三杯一起", "昨天下午那一波"],
      past: ["翻到以前忙的时候", "以前也这样，一杯一杯地做", "好久前的班了"],
    },
  },
  {
    id: "cafe-sign",
    file: "cafe-sign.jpg",
    tags: ["cafe", "indoor", "evening", "warm", "work"],
    scene: "dusk",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["打完烊拍的，灯还亮着", "今天收拾完抬头看了一眼", "这就是我每天待的地方"],
      yesterday: ["昨天关门时拍的", "昨天走得晚，灯忘了关一半", "昨天的店里，就这个样子"],
      past: ["翻到刚来店里那会儿", "以前拍的，牌子后来换过", "好几年前了"],
    },
  },
  {
    id: "poppy-field",
    file: "poppy-field.jpg",
    tags: ["flowers", "nature", "warm", "sunset", "golden"],
    scene: "dusk",
    eras: ["today", "yesterday", "past"],
    captions: {
      today: ["路过一片花，停下来看了会儿", "今天的风把花吹得乱七八糟", "回家路上顺手拍的"],
      yesterday: ["昨天路过拍的", "昨天的光更好看", "昨天在这儿站了一会儿"],
      past: ["翻到以前路过拍的", "以前也见过这么大一片", "好几年前了，那会儿还拍了照"],
    },
  },
];

/** 图库里是否有匹配这些场景标签的照片（用于发图前的相关性判定）。 */
export function hasPhotosForTags(tags: string[] | undefined): boolean {
  return photosByTags(tags ?? []).length > 0;
}

export function getPhotoCatalog(): readonly PhotoDef[] {
  return PHOTOS;
}

function photosByTags(tags: string[]): PhotoDef[] {
  return PHOTOS.filter((p) => p.tags.some((t) => tags.includes(t)));
}

/** 场景与当前时段是否匹配（决定"今天拍的"是否成立） */
export function sceneMatchesHour(scene: PhotoScene, hour: number): boolean {
  switch (scene) {
    case "morning":
      return hour >= 5 && hour < 11;
    case "day":
      return hour >= 9 && hour < 18;
    case "dusk":
      return hour >= 17 && hour < 22;
    case "night":
      return hour >= 21 || hour < 5;
    case "indoor":
    case "any":
    default:
      return true;
  }
}

/**
 * 计算某张图在当前时段/亲密度下可用的时间关系。
 * - today：场景与当前时段匹配才成立（傍晚的图不会在早上叫"今天"）
 * - yesterday：一直可用（人会翻昨天的图）
 * - past：亲密度达到门槛才可用（以前的生活）
 */
export function allowedEras(photo: PhotoDef, hour: number, closeness: number): PhotoEra[] {
  return photo.eras.filter((era) => {
    if (era === "today") return sceneMatchesHour(photo.scene, hour);
    if (era === "past") return closeness >= (photo.minCloseness ?? DEFAULT_MEMORY_MIN_CLOSENESS);
    return true;
  });
}

function pickOne<T>(list: T[], random: () => number): T {
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index];
}

export interface PickPhotoInput {
  /** 当前情绪 -1..1 */
  emotion: number;
  /** 当前小时 0-23 */
  hour: number;
  /** 当前亲密度（决定能否分享「以前的生活」） */
  closeness: number;
  /** 额外偏好标签（如天气/话题） */
  tags?: string[];
  /** 最近已经发过的图片 id（避免同一张图连着复用；全被排除时返回 null，宁可不发） */
  excludeIds?: string[];
  /** 最近已经用过的配文（避免「今天下班路上拍的」这类句子反复出现） */
  excludeCaptions?: string[];
  /** 可注入随机源（测试用；返回 0..1） */
  random?: () => number;
}

export interface PhotoShareChoice {
  photo: PhotoDef;
  era: PhotoEra;
  caption: string;
}

/**
 * 选择一张图 + 时间关系 + 配文。
 * 选择逻辑：先按情绪/标签挑候选，再按当前时段/亲密度计算可用 era，
 * era 偏好 today > yesterday > past（亲密度高时 past 权重提高）。
 */
export function pickPhotoShare(input: PickPhotoInput): PhotoShareChoice | null {
  const random = input.random ?? Math.random;

  let candidates: PhotoDef[];
  if (input.tags && input.tags.length > 0) {
    candidates = photosByTags(input.tags);
  } else if (input.emotion <= -0.3) {
    candidates = photosByTags(["nature", "quiet", "calm", "mountain"]);
  } else if (input.emotion >= 0.3) {
    candidates = photosByTags(["warm", "sunset", "cafe", "animal"]);
  } else {
    candidates = PHOTOS;
  }

  // 过滤出在当前条件下有可用 era 的图；若类别内全不可用则回退全图库
  const usable = candidates
    .map((photo) => ({ photo, eras: allowedEras(photo, input.hour, input.closeness) }))
    .filter((item) => item.eras.length > 0);
  const pool = usable.length > 0
    ? usable
    : PHOTOS
        .map((photo) => ({ photo, eras: allowedEras(photo, input.hour, input.closeness) }))
        .filter((item) => item.eras.length > 0);
  if (pool.length === 0) return null;

  // 跨轮去重：最近发过的图优先排除；如果排除后没有可用图，就退回完整池（宁可不发也不重复）
  const exclude = new Set(input.excludeIds ?? []);
  const deduped = exclude.size > 0 ? pool.filter((item) => !exclude.has(item.photo.id)) : pool;
  if (deduped.length === 0) return null;
  const chosen = pickOne(deduped, random);
  const eras = chosen.eras;

  // era 偏好：优先 today；否则 yesterday；past 只在可分享「以前」时按概率出现
  let era: PhotoEra;
  const roll = random();
  if (eras.includes("today") && roll < 0.55) {
    era = "today";
  } else if (eras.includes("yesterday") && roll < 0.9) {
    era = "yesterday";
  } else if (eras.includes("past")) {
    era = "past";
  } else {
    era = eras[0];
  }

  const captionsForEra = chosen.photo.captions[era];
  const captions = captionsForEra.length > 0 ? captionsForEra : chosen.photo.captions.yesterday;
  // 配文去重：最近说过的句子优先排除；全被排除时退回原池（宁可重复也别空着）
  const usedCaptions = new Set(input.excludeCaptions ?? []);
  const freshCaptions = captions.filter((c) => !usedCaptions.has(c));
  const caption = pickOne(freshCaptions.length > 0 ? freshCaptions : captions, random);
  return { photo: chosen.photo, era, caption };
}

/** 兼容旧接口：只要图（配文时间关系请用 pickPhotoShare）。 */
export function pickPhoto(input: PickPhotoInput): PhotoDef | null {
  return pickPhotoShare(input)?.photo ?? null;
}

/** 读取本地图片绝对路径；文件不存在返回 null。 */
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
