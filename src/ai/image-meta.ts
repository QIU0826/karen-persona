/**
 * 图片字节元信息（v0.9.25）：从文件头解析宽高，拒绝「像素炸弹」。
 *
 * 背景：vision / 表情包下载只限制了字节大小（2–10MB），但一张 8MB 的
 * 20000×20000 PNG 解码后是 1.6GB 内存——手机/群聊发图是不可信输入，
 * 需要在解码/base64 前先按真实宽高算像素。
 *
 * 只做文件头解析，不解码像素；未知格式返回 null（调用方保持旧行为）。
 */

export const MAX_IMAGE_PIXELS = 64_000_000; // 64MP，与 qq-bridge / DSH 上限对齐

export interface ImageInfo {
  mime: "image/png" | "image/gif" | "image/jpeg" | "image/webp" | null;
  width: number;
  height: number;
  pixels: number;
}

function readU16BE(buf: Buffer, offset: number): number {
  return (buf[offset]! << 8) | buf[offset + 1]!;
}

function readU16LE(buf: Buffer, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

function readU24LE(buf: Buffer, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16);
}

function pngInfo(buf: Buffer): { width: number; height: number } | null {
  // signature 8 + chunk length 4 + "IHDR" 4 + width 4 + height 4
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.subarray(1, 4).toString("ascii") !== "PNG") return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifInfo(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  const head = buf.subarray(0, 6).toString("ascii");
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  const width = readU16LE(buf, 6);
  const height = readU16LE(buf, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegInfo(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    // 跳过 0xFF 填充
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) break;
    const marker = buf[pos]!;
    pos++;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break; // SOS 之后是压缩数据
    if (pos + 2 > buf.length) break;
    const len = readU16BE(buf, pos);
    if (len < 2 || pos + len > buf.length) break;
    // SOF0–SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // ff cN len(2) precision(1) height(2) width(2)
      if (len < 7) return null;
      const height = readU16BE(buf, pos + 3);
      const width = readU16BE(buf, pos + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += len;
  }
  return null;
}

function webpInfo(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const fourcc = buf.subarray(12, 16).toString("ascii");
  if (fourcc === "VP8X") {
    // flags(1) reserved(3) canvas-width-1(3 LE) canvas-height-1(3 LE)
    const width = readU24LE(buf, 24) + 1;
    const height = readU24LE(buf, 27) + 1;
    return { width, height };
  }
  if (fourcc === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
    // 14 bits width-1 + 14 bits height-1，从第 21 字节开始
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === "VP8 " && buf.length >= 30) {
    // frame tag(3) + start code(3) + width(2 LE, 14 bits) + height(2 LE)
    const data = 20;
    if (buf[data + 3] === 0x9d && buf[data + 4] === 0x01 && buf[data + 5] === 0x2a) {
      const width = readU16LE(buf, data + 6) & 0x3fff;
      const height = readU16LE(buf, data + 8) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

/** 从文件头解析图片宽高；未知格式返回 null。不抛异常。 */
export function inspectImageInfo(bytes: Buffer | Uint8Array): ImageInfo | null {
  if (!bytes || bytes.length < 10) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const attempts: Array<{ mime: ImageInfo["mime"]; parse: (b: Buffer) => { width: number; height: number } | null }> = [
    { mime: "image/png", parse: pngInfo },
    { mime: "image/gif", parse: gifInfo },
    { mime: "image/jpeg", parse: jpegInfo },
    { mime: "image/webp", parse: webpInfo },
  ];
  for (const attempt of attempts) {
    try {
      const dims = attempt.parse(buf);
      if (dims) {
        return {
          mime: attempt.mime,
          width: dims.width,
          height: dims.height,
          pixels: dims.width * dims.height,
        };
      }
    } catch {
      // 坏文件头继续尝试下一种
    }
  }
  return null;
}

/** 像素是否超过上限；未知尺寸时放行（保持旧行为）。 */
export function exceedsPixelLimit(bytes: Buffer | Uint8Array, maxPixels = MAX_IMAGE_PIXELS): boolean {
  const info = inspectImageInfo(bytes);
  return info !== null && info.pixels > maxPixels;
}
