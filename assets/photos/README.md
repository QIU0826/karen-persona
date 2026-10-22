# 本地图片库（她主动分享的「随手拍」兜底）

- 用途：未配置 `UNSPLASH_ACCESS_KEY`（或 Unsplash 搜索失败）时，她仍能主动发一张本地图片。
- 数量：**29 张**；其中 24 张统一裁成 800×600 JPEG（单张 20–160KB），另有 5 张 Karen 自拍缓存 832×921 JPEG（`karen-selfie-cafe/rain/home/sea/night`）。
- 来源：
  - 早期 7 张：Lorem Picsum（`https://picsum.photos/seed/<seed>/800/600`），素材来自 Unsplash；
  - 2026-10-20 新增 8 张：Unsplash 直链（`images.unsplash.com/photo-…`）。
  - 两类素材均适用 [Unsplash License](https://unsplash.com/license)（可免费商用、无需署名；本文件作为来源记录）。
  - **2026-10-21 新增 5 张：本机 SDXL-Turbo 生成**（`services/image`，800×600，seed 42，prompt 记录在
    `docs/IMAGE_GEN.md` §7）：`latte-tulip.jpg`（拉花特写）、`cafe-quiet.jpg`（空店）、
    `cat-sunbeam.jpg`（猫晒太阳）、`rainy-street.jpg`（雨夜街头）、`book-iced-coffee.jpg`（书+冰咖啡）。
    生成内容无人物/文字/水印，版权归本项目；如不喜欢可删文件并同步 `photo-library.ts`。
  - **2026-10-21（v0.9.13）再补 4 张**（本机生成，seed 42）：`seaside.jpg`（海边）、`breakfast.jpg`（早餐）、
    `late-night-noodles.jpg`（夜宵面）、`bubble-tea.jpg`（奶茶），补齐此前图库没有的场景。
- 新增的 8 张对应照片 id（Unsplash photo id，可在 `images.unsplash.com/<id>` 找到原图）：
  `photo-1509042239860-f550ce710b93`（拿铁+绿植）、`photo-1518791841217-8f162f1e1131`（沙发上的猫）、
  `photo-1519501025264-65ba15a82390`（雨后傍晚街头）、`photo-1515694346937-94d85e41e6f0`（雨窗）、
  `photo-1414235077428-338989a2e8c0`（晚餐）、`photo-1495474472287-4d71bcdd2085`（三杯拿铁）、
  `photo-1501339847302-ac426a4a7cbb`（店内 CAFE 灯牌）、`photo-1465146344425-f00d5f5c8f07`（花田）。
- 每张图在 `src/impulse/photo-library.ts` 中有内容标签、场景（morning/day/dusk/night/indoor）与
  「今天/昨天/以前」三套配文；替换图片时请同步更新标签/配文。
- 商用前请自行复核图源许可；若替换为第三方素材，更新本文件并确认授权。

## Karen 自拍缓存（2026-10-22）

`karen-selfie-cafe.jpg` 由 GPU2 的 Qwen-Image-Edit-2511 生成，参考图为项目内 `character-1/2`，
已通过 `image:audit`（角色一致、无手部、场景/服装无明显异常）。它不是 Unsplash 图；
用于用户明确说“发张你的自拍/看看你”时兜底，避免 Z-Image 场景模型生成一个不是 Karen 的人。
