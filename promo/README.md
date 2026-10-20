# KAREN 宣传页（promo/）

单文件、零构建的滚动式落地页：首屏双视频（鼠标左右 scrub）→ 黑色画廊（卡片随滚动缩放）→ 白场 CTA。
所有 CSS/JS 内联在 `index.html`，不依赖 npm 安装；可直接双击打开，也可通过本机 Web 服务访问。

## 打开方式

1. **通过 Web 控制台（推荐）**：桥接启动后访问 `http://127.0.0.1:18082/promo/`
   （若配置了 `web_token`，需带 `?token=xxx`）
2. **直接双击**：用浏览器打开 `promo/index.html`
   （视频/图库是外链，需要联网；本地素材用相对路径 `assets/...` 即可）

## 素材与文案都在哪里改

打开 `promo/index.html`，在 `<script>` 开头的 `CONFIG` 对象里改：

```js
const CONFIG = {
  heroMode: "blank",          // 当前留白：不显示人物；"video" 双视频 / "character" 卡通角色图
  leftVideo: "...",           // 左视频 URL 或本地相对路径
  rightVideo: "...",          // 右视频 URL 或本地相对路径
  characterImage: "assets/character.svg",
  ctaUrl: "/",                // "体验" 按钮跳转（默认本机控制台）
  galleryLabels: [...],       // 每张图左上角编号/标题
  galleryCaptions: [...],     // 每张图右下角一句话
  gallery: [...10 张图 URL...],
};
```

另外页面里的品牌字 / 标题 / 底部信息是普通 HTML，搜索替换即可：
`KAREN`（logo SVG 文字）、`ARCHIVE COLLECTION`、`「KAREN」`、`BETA`、`体验`、`KAREN (R) 2026`。

## 把「女人」换成卡通角色（三种方案）

> 现在的首屏人物来自提示词里的两段外网 mp4（CloudFront），不是代码生成的。完全可替换。

### 方案 A：卡通角色短视频（推荐，效果最接近现在）

- 需要 **2 段 mp4**（左右各一段，可同一角色不同表情/动作），规格：
  - H.264 / MP4，**无音轨**，4–8 秒循环；
  - 竖版 1080×1440（2:3）或 1080×1920（9:16），主体居中偏下；
  - 背景尽量深色/干净（页面有 `mix-blend-mode: exclusion`，纯白背景会反色）；
  - 单段 < 8MB，首帧即主体。
- 放到 `promo/assets/hero-left.mp4`、`hero-right.mp4`，然后：
  ```js
  heroMode: "video",
  leftVideo: "assets/hero-left.mp4",
  rightVideo: "assets/hero-right.mp4",
  ```
- 制作方式：画师出角色立绘 → AI 图生视频（Kling / Runway / Pika / Hailuo / 即梦）做轻微呼吸、眨眼、回头；或 Live2D / VTube Studio 录屏导出 mp4。

### 方案 B：透明 PNG 单图（最快，先上线再迭代）

- 画一张透明背景的卡通角色立绘：PNG（带 alpha），≥1200px 高，2:3 或 9:16，主体完整。
- 放到 `promo/assets/character.png`，然后：
  ```js
  heroMode: "character",
  characterImage: "assets/character.png",
  ```
- 页面会显示角色图 + 轻微浮动动画。后面可随时升级成方案 A。

> 当前默认 `heroMode: "blank"`：人物区域留空（深色渐变 + 大字背景），等你的角色素材到位后
> 改成 `"video"` 或 `"character"` 即可，不需要改其它代码。

### 方案 C：PNG 序列 / 动画 WebP（想要更精细动作）

- 发我 **12–24 帧透明 PNG**（`001.png`…，1080×1440）或一个**动画 WebP**；
- 我来加 canvas 帧序列/视差代码，效果接近短视频、体积更小。

### 素材交付清单（发给我的时候）

- 角色设定图/立绘（透明 PNG 优先）
- 2 段短视频（如果有）或帧序列 zip
- 希望的角色动作/气质描述（比如「她抬手把头发别到耳后」）
- 品牌名 / slogan / CTA 文案最终版

## 图库替换（10 张）

- 当前默认已使用本地素材：7 张 `../assets/photos/*.jpg`（咖啡店/雪天/杯子/山/晚霞/熊等）+ 3 张
  `assets/gallery/poster-*.svg`（她有自己的生活 / 第 37 天 / 她开始记得你）；
- 改成你的产品截图/角色图：直接替换 `CONFIG.gallery` 的 10 个 URL；
- 本地图放 `promo/assets/gallery/01.jpg` 等，URL 写 `assets/gallery/01.jpg`；
- 想用仓库已有的截图/照片：`../assets/photos/xxx.jpg`（直接打开页面）或
  `http://127.0.0.1:18082/assets/photos/xxx.jpg`（经 Web 服务访问）。

## 说明

- 页面是**静态单页**（非 React 工程），无需 `npm install`；如果后续要接 React/Vite/Tailwind 工程化，可再迁移。
- 所有文字/图片/视频都通过 `CONFIG` 与 HTML 文案控制，不写死在逻辑里。
