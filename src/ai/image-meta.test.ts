import { describe, expect, it } from "vitest";
import { MAX_IMAGE_PIXELS, exceedsPixelLimit, inspectImageInfo } from "./image-meta.js";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // SOI + SOF0 + length + precision + height + width
  Buffer.from("ffd8ffc000110801f402ee", "hex").copy(buf, 0);
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  // data at 20: flags(1) reserved(3) w-1(3 LE) h-1(3 LE)
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

describe("inspectImageInfo", () => {
  it("解析 PNG 宽高", () => {
    expect(inspectImageInfo(png(1000, 2000))).toMatchObject({
      mime: "image/png", width: 1000, height: 2000, pixels: 2_000_000,
    });
  });

  it("解析 GIF 宽高", () => {
    expect(inspectImageInfo(gif(400, 300))).toMatchObject({
      mime: "image/gif", width: 400, height: 300, pixels: 120_000,
    });
  });

  it("解析 JPEG SOF0 宽高", () => {
    expect(inspectImageInfo(jpeg(750, 500))).toMatchObject({
      mime: "image/jpeg", width: 750, height: 500, pixels: 375_000,
    });
  });

  it("解析 WebP VP8X 宽高", () => {
    expect(inspectImageInfo(webpVp8x(1000, 500))).toMatchObject({
      mime: "image/webp", width: 1000, height: 500, pixels: 500_000,
    });
  });

  it("未知/截断格式返回 null，不抛异常", () => {
    expect(inspectImageInfo(Buffer.from("not-an-image"))).toBeNull();
    expect(inspectImageInfo(Buffer.alloc(0))).toBeNull();
    expect(inspectImageInfo(Buffer.from("ffd8", "hex"))).toBeNull();
  });
});

describe("exceedsPixelLimit", () => {
  it("超过 64MP 拒绝，正常图片放行", () => {
    expect(MAX_IMAGE_PIXELS).toBe(64_000_000);
    expect(exceedsPixelLimit(png(10_000, 10_000))).toBe(true);
    expect(exceedsPixelLimit(png(4000, 3000))).toBe(false);
  });

  it("未知格式放行（保持旧行为，避免误伤）", () => {
    expect(exceedsPixelLimit(Buffer.from("unknown"))).toBe(false);
  });
});
