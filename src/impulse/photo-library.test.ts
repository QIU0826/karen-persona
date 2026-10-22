import fs from "node:fs";
import { chooseLocalPhotoShare } from "./photo-library.js";
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

    // 高亲密度：可以分享以前拍的照片（限定标签，避免随机到没有 past 的新图）
    const high = pickPhotoShare({ emotion: 0, hour: 14, closeness: 5, tags: ["mountain"], random: () => 0.99 });
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

  it("图库有 27 张，连续 12 次选择就有明显多样性（修复「配文重复」）", () => {
    expect(getPhotoCatalog().length).toBe(27);
    let n = 0;
    const random = () => ((n++ * 37) % 100) / 100;
    const photos = new Set<string>();
    const captions = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const choice = pickPhotoShare({ emotion: 0, hour: 20, closeness: 5, random });
      expect(choice).not.toBeNull();
      photos.add(choice!.photo.id);
      captions.add(choice!.caption);
    }
    expect(photos.size).toBeGreaterThanOrEqual(6);
    expect(captions.size).toBeGreaterThanOrEqual(8);
  });

  it("excludeIds 排除最近发过的图（跨轮去重）", () => {
    // 先取一张，拿到它的 id
    const first = pickPhotoShare({ emotion: 0, hour: 20, closeness: 5, random: () => 0.1 });
    expect(first).not.toBeNull();
    const id = first!.photo.id;
    // 排除后再选，应该拿到别的图
    const second = pickPhotoShare({
      emotion: 0,
      hour: 20,
      closeness: 5,
      random: () => 0.1,
      excludeIds: [id],
    });
    expect(second).not.toBeNull();
    expect(second!.photo.id).not.toBe(id);
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

  it("v0.9.11 新增 5 张后：200 次选择能覆盖绝大多数图，配文也足够分散", () => {
    // 用确定性 LCG（避免简单取模造成的伪模式）
    let state = 12345;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const photos = new Set<string>();
    const captions = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const choice = pickPhotoShare({ emotion: 0, hour: 20, closeness: 5, random });
      expect(choice).not.toBeNull();
      photos.add(choice!.photo.id);
      captions.add(choice!.caption);
    }
    expect(photos.size).toBeGreaterThanOrEqual(22);
    expect(captions.size).toBeGreaterThanOrEqual(50);
  });

  it("新增的图都在图库目录里且有对应文件", () => {
    const ids = [
      "latte-tulip",
      "cafe-quiet",
      "cat-sunbeam",
      "rainy-street",
      "book-iced-coffee",
      "seaside",
      "breakfast",
      "late-night-noodles",
      "bubble-tea",
    ];
    const catalog = getPhotoCatalog();
    for (const id of ids) {
      const photo = catalog.find((item) => item.id === id);
      expect(photo, `缺少 ${id}`).toBeTruthy();
      expect(photoFilePath(photo!)).toBeTruthy();
      expect(fs.existsSync(photoFilePath(photo!)!)).toBe(true);
    }
  });

describe("chooseLocalPhotoShare：配文不盖到无关图上（v0.9.12）", () => {
  const makeRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  };

  it("场景配文只在图真有该场景时使用", () => {
    let sceneCaptions = 0;
    for (let i = 0; i < 200; i++) {
      const choice = chooseLocalPhotoShare({
        emotion: 0,
        hour: 15,
        closeness: 5,
        tags: ["coffee"],
        random: makeRandom(i + 1),
      });
      expect(choice).not.toBeNull();
      if (choice!.captionSource !== "scene") continue;
      sceneCaptions += 1;
      // 用了场景配文 → 图必须带请求标签之一
      expect(choice!.photo.tags.some((tag) => ["coffee"].includes(tag))).toBe(true);
    }
    expect(sceneCaptions).toBeGreaterThan(0);
  });

  it("没有场景标签时用照片自带配文", () => {
    const choice = chooseLocalPhotoShare({ emotion: 0, hour: 15, closeness: 5, random: makeRandom(7) });
    expect(choice).not.toBeNull();
    expect(choice!.captionSource).toBe("photo");
  });

  it("场景标签在图库中没有对应图时，回退照片自带配文（不硬套场景配文）", () => {
    const choice = chooseLocalPhotoShare({
      emotion: 0,
      hour: 15,
      closeness: 5,
      tags: ["travel", "sky"],
      random: makeRandom(11),
    });
    expect(choice).not.toBeNull();
    expect(choice!.captionSource).toBe("photo");
  });

  it("偏好时间关系与排除列表仍然生效", () => {
    const first = chooseLocalPhotoShare({ emotion: 0, hour: 15, closeness: 5, random: makeRandom(3) });
    expect(first).not.toBeNull();
    const second = chooseLocalPhotoShare({
      emotion: 0,
      hour: 15,
      closeness: 5,
      excludeIds: [first!.photo.id],
      random: makeRandom(3),
    });
    expect(second).not.toBeNull();
    expect(second!.photo.id).not.toBe(first!.photo.id);

    const past = chooseLocalPhotoShare({
      emotion: 0,
      hour: 15,
      closeness: 5,
      tags: ["mountain"],
      preferEra: "past",
      random: makeRandom(5),
    });
    expect(past?.era).toBe("past");
  });
});
});
