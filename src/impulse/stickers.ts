/**
 * 本地贴纸库（M1 步骤 4：表情/贴纸系统）。
 *
 * 设计：
 * - 贴纸是本地 PNG（assets/stickers/），以 OneBot CQ image(base64) 发送；
 * - 选择由「她的当前情绪 + 时段 + 是否处于冲突」决定，带冷却与概率（调用方控制）；
 * - 冲突未化解时不发可爱贴纸（避免显得轻浮），返回 null；
 * - 资源缺失时静默降级（返回 null），不影响文字回复；
 * - 资源来源：Twitter Twemoji（CC-BY 4.0），详见 assets/stickers/README.md。
 */
import fs from "node:fs";
import path from "node:path";
import { assetDir } from "../data/paths.js";

export interface StickerDef {
  /** 稳定 id（日志用） */
  id: string;
  /** assets/stickers 下的文件名 */
  file: string;
  /** 情绪/场景标签 */
  tags: string[];
}

const STICKER_DIR = assetDir("assets/stickers");

/** 内置贴纸目录（后续可按人设扩展为 persona 级贴纸包） */
const STICKERS: StickerDef[] = [
  { id: "smile-cat", file: "1f63a.png", tags: ["happy", "cute", "cat"] },
  { id: "weary-cat", file: "1f640.png", tags: ["tired", "comfort", "awkward"] },
  { id: "dog", file: "1f436.png", tags: ["happy", "cute"] },
  { id: "heart", file: "2764.png", tags: ["love", "warm"] },
  { id: "hearts", file: "1f497.png", tags: ["love", "warm"] },
  { id: "cry", file: "1f62d.png", tags: ["sad", "comfort"] },
  { id: "angry", file: "1f621.png", tags: ["annoyed"] },
  { id: "sleepy", file: "1f634.png", tags: ["tired", "sleepy"] },
  { id: "thumbsup", file: "1f44d.png", tags: ["agree", "happy"] },
  { id: "sparkles", file: "2728.png", tags: ["happy", "excited"] },
  { id: "star", file: "1f31f.png", tags: ["happy", "excited"] },
];

const base64Cache = new Map<string, string>();

export function getStickerCatalog(): readonly StickerDef[] {
  return STICKERS;
}

function stickersByTags(tags: string[]): StickerDef[] {
  return STICKERS.filter((s) => s.tags.some((t) => tags.includes(t)));
}

export interface PickStickerInput {
  /** 她当前情绪 -1..1 */
  emotion: number;
  /** 当前小时 0-23 */
  hour: number;
  /** 未化解冲突（24h 内）时不发可爱贴纸 */
  conflictActive: boolean;
  /** 可注入随机源（测试用；返回 0..1） */
  random?: () => number;
}

/** 按情绪/时段挑选一个贴纸；不适合发时返回 null。 */
export function pickSticker(input: PickStickerInput): StickerDef | null {
  if (input.conflictActive) return null;

  let candidates: StickerDef[];
  if (input.hour >= 23 || input.hour < 7) {
    candidates = stickersByTags(["sleepy", "tired"]);
  } else if (input.emotion <= -0.3) {
    candidates = stickersByTags(["comfort", "sad", "tired"]);
  } else if (input.emotion >= 0.3) {
    candidates = stickersByTags(["happy", "love", "excited", "cute"]);
  } else {
    candidates = stickersByTags(["cute", "cat", "happy"]);
  }
  if (candidates.length === 0) return null;

  const random = input.random ?? Math.random;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}

/** 读取贴纸文件并转成 OneBot CQ image(base64) 字符串；不存在/读取失败返回 null。 */
export function toStickerCqCode(sticker: StickerDef): string | null {
  const cached = base64Cache.get(sticker.file);
  if (cached) return `[CQ:image,file=base64://${cached}]`;

  const filePath = path.join(STICKER_DIR, sticker.file);
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) return null;
    const b64 = buffer.toString("base64");
    base64Cache.set(sticker.file, b64);
    return `[CQ:image,file=base64://${b64}]`;
  } catch {
    return null;
  }
}
