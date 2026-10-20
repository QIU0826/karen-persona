# 本地图片库（她主动分享的「随手拍」兜底）

- 用途：未配置 `UNSPLASH_ACCESS_KEY`（或 Unsplash 搜索失败）时，她仍能主动发一张本地图片。
- 数量：**15 张**，统一裁成 800×600 JPEG（单张 20–125KB）。
- 来源：
  - 早期 7 张：Lorem Picsum（`https://picsum.photos/seed/<seed>/800/600`），素材来自 Unsplash；
  - 2026-10-20 新增 8 张：Unsplash 直链（`images.unsplash.com/photo-…`）。
  - 两类素材均适用 [Unsplash License](https://unsplash.com/license)（可免费商用、无需署名；本文件作为来源记录）。
- 新增的 8 张对应照片 id（Unsplash photo id，可在 `images.unsplash.com/<id>` 找到原图）：
  `photo-1509042239860-f550ce710b93`（拿铁+绿植）、`photo-1518791841217-8f162f1e1131`（沙发上的猫）、
  `photo-1519501025264-65ba15a82390`（雨后傍晚街头）、`photo-1515694346937-94d85e41e6f0`（雨窗）、
  `photo-1414235077428-338989a2e8c0`（晚餐）、`photo-1495474472287-4d71bcdd2085`（三杯拿铁）、
  `photo-1501339847302-ac426a4a7cbb`（店内 CAFE 灯牌）、`photo-1465146344425-f00d5f5c8f07`（花田）。
- 每张图在 `src/impulse/photo-library.ts` 中有内容标签、场景（morning/day/dusk/night/indoor）与
  「今天/昨天/以前」三套配文；替换图片时请同步更新标签/配文。
- 商用前请自行复核图源许可；若替换为第三方素材，更新本文件并确认授权。
