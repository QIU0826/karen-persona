import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_MIN_CLOSENESS,
  allowedEras,
  getPhotoCatalog,
  pickPhotoShare,
  photoFilePath,
  sceneMatchesHour,
} from "./photo-library.js";

describe("photo-library 时间关系模型", () => {
  it("目录非空且每个文件都存在，配文按时间关系分组", () => {
    const photos = getPhotoCatalog();
    expect(photos.length).toBeGreaterThanOrEqual(5);
    for (const photo of photos) {
      expect(photoFilePath(photo)).toBeTruthy();
      expect(fs.existsSync(photoFilePath(photo)!)).toBe(true);
      const captions = Object.values(photo.captions).flat();
      expect(captions.length).toBeGreaterThan(0);
    }
  });

  it("场景与当前时段匹配（决定今天是否能拍）", () => {
    expect(sceneMatchesHour("morning", 8)).toBe(true);
    expect(sceneMatchesHour("morning", 14)).toBe(false);
    expect(sceneMatchesHour("dusk", 10)).toBe(false);
    expect(sceneMatchesHour("dusk", 19)).toBe(true);
    expect(sceneMatchesHour("indoor", 3)).toBe(true);
  });

  it("早上可以发「昨天的晚霞」：晚霞图在上午保留 yesterday/past，不冒充 today", () => {
    const sunset = getPhotoCatalog().find((p) => p.id === "sunset-pier")!;
    const eras = allowedEras(sunset, 10, 5);
    expect(eras).not.toContain("today");
    expect(eras).toContain("yesterday");
    expect(eras).toContain("past");

    // 上午 10 点分享晚霞 → 只能以「昨天/以前」的口吻
    const choice = pickPhotoShare({
      emotion: 0,
      hour: 10,
      closeness: 5,
      tags: ["sunset"],
      random: () => 0,
    });
    expect(choice).not.toBeNull();
    expect(choice!.era).not.toBe("today");
    expect(choice!.caption).toContain("昨天");
    expect(choice!.caption).not.toContain("今天的晚霞");
  });

  it("傍晚可以发「今天的晚霞」", () => {
    const sunset = getPhotoCatalog().find((p) => p.id === "sunset-pier")!;
    expect(allowedEras(sunset, 19, 5)).toContain("today");

    const choice = pickPhotoShare({
      emotion: 0,
      hour: 19,
      closeness: 5,
      tags: ["sunset"],
      random: () => 0,
    });
    expect(choice!.era).toBe("today");
    expect(choice!.caption.length).toBeGreaterThan(0);
  });

  it("「以前的生活」需要亲密度达标，够了才会分享旧照片", () => {
    const mountain = getPhotoCatalog().find((p) => p.id === "mountain")!;
    expect(allowedEras(mountain, 14, DEFAULT_MEMORY_MIN_CLOSENESS - 1)).not.toContain("past");
    expect(allowedEras(mountain, 14, DEFAULT_MEMORY_MIN_CLOSENESS)).toContain("past");

    // 低亲密度：即使随机压到 past 区间也不会返回 past
    const low = pickPhotoShare({ emotion: 0, hour: 14, closeness: 3, random: () => 0.99 });
    expect(low!.era).not.toBe("past");

    // 高亲密度：可以分享以前拍的照片
    const high = pickPhotoShare({ emotion: 0, hour: 14, closeness: 5, random: () => 0.99 });
    expect(high!.era).toBe("past");
    expect(high!.caption).toMatch(/以前|好几年前/);
  });

  it("按情绪挑选图片并带配文", () => {
    const low = pickPhotoShare({ emotion: -0.5, hour: 14, closeness: 3, random: () => 0 });
    expect(low).not.toBeNull();
    expect(low!.photo.tags.some((t) => ["nature", "quiet", "calm", "mountain"].includes(t))).toBe(
      true,
    );
    expect(low!.caption.length).toBeGreaterThan(0);
  });

  it("资源缺失时返回 null", () => {
    expect(
      photoFilePath({
        id: "x",
        file: "not-exists.jpg",
        tags: [],
        scene: "any",
        eras: ["today"],
        captions: { today: [], yesterday: [], past: [] },
      }),
    ).toBeNull();
  });
});
