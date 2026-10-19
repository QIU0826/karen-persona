import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getPhotoCatalog,
  pickPhoto,
  photoFilePath,
  pickPhotoCaption,
} from "./photo-library.js";

describe("photo-library 本地图库", () => {
  it("目录非空且每个文件都存在", () => {
    const photos = getPhotoCatalog();
    expect(photos.length).toBeGreaterThanOrEqual(5);
    for (const photo of photos) {
      expect(photoFilePath(photo)).toBeTruthy();
      expect(fs.existsSync(photoFilePath(photo)!)).toBe(true);
      expect(photo.captions.length).toBeGreaterThan(0);
    }
  });

  it("按情绪挑选图片", () => {
    const low = pickPhoto({ emotion: -0.5, hour: 14, random: () => 0 });
    expect(low).not.toBeNull();
    expect(low!.tags.some((t) => ["nature", "quiet", "calm", "mountain"].includes(t))).toBe(true);

    const high = pickPhoto({ emotion: 0.6, hour: 14, random: () => 0 });
    expect(high).not.toBeNull();
    expect(high!.tags.some((t) => ["warm", "sunset", "cafe", "animal"].includes(t))).toBe(true);
  });

  it("按标签/随机源稳定选择", () => {
    const photo = pickPhoto({ emotion: 0, hour: 14, tags: ["coffee"], random: () => 0 });
    expect(photo!.id).toBe("mug-desk");
    expect(pickPhotoCaption(photo!, () => 0)).toBe(photo!.captions[0]);
  });

  it("资源缺失时返回 null", () => {
    expect(photoFilePath({ id: "x", file: "not-exists.jpg", tags: [], captions: [] })).toBeNull();
  });
});
