# KAREN 宣传落地页（promo/）

单文件、零构建、零外部依赖的静态宣传页。用于讲清楚 KAREN 是什么：一个住在 QQ 里、
有自己的生活、情绪和记忆的 AI 虚拟人（人设：小雅，24 岁，上海静安咖啡店员）。

- **页面**：`index.html`（HTML + 内联 CSS/JS，约 58KB）
- **版本**：v0.3.0
- **无外部依赖**：不引用 CDN、Google Fonts、统计脚本或任何外域资源，只用系统字体栈
- **只读**：纯静态页，不发起业务请求；唯一外链是 GitHub 仓库

## 本地预览

三种方式，任选其一：

1. **直接打开文件**（最快）：
   ```bash
   open promo/index.html
   ```
   或把 `promo/index.html` 拖进浏览器。所有素材都在 `promo/assets/`，file:// 下可直接用。

2. **起一个静态服务器**（推荐，避免个别浏览器对 file:// 的限制）：
   ```bash
   cd <仓库根目录>
   python3 -m http.server 8000
   # 打开 http://127.0.0.1:8000/promo/
   ```

3. **经产品自带 Web 服务**（和真实分发路径一致）：
   ```bash
   npm run qq        # 或任意会启动 Web 控制台的方式
   # 打开 http://127.0.0.1:18082/promo/
   # 若配置了 web_token，则打开 http://127.0.0.1:18082/promo/?token=xxx
   ```
   静态路由见 `src/web/server.ts`：`/promo/`、`/promo/assets/*`。

## 页面结构

| 区块 | 内容 |
|---|---|
| Hero | 角色主视觉 + 「她不是聊天机器人。」+ 两个 CTA（查看体验 / GitHub）；桌面端有双聊天气泡与轻量视频氛围（静帧缓慢缩放 / 视频淡入）；移动端人物铺上方 |
| 信号条 | 原生 QQ 私聊 / 自己的生活 / 会记得你 / 本地优先 |
| 01 她的日常 | 07:12 / 09:48 / 18:36 / 23:52 四个时刻 + 三种心情（开心 / 一般 / 闷） |
| 02 消息形态 | **纯 HTML/CSS 手画的 QQ 聊天 mockup**：文字、晚霞照片、表情包、3″ 语音条 + 转文字、撤回提示 + 改对、正在输入、输入栏；左侧 5 条能力清单 |
| 03 主动性 | 傍晚发晚霞 / 忙时晚回 / 偶尔不回 三张时间线卡片 + 她手机相册横向滑轨 |
| 04 记忆 | 「年糕今天是不是又把你键盘踩了？」示例 + 她记得的几件小事（含 `/forget` 说明） |
| 05 隐私与自部署 | 本地存储 / 单机运行 / 可控 / 开源；明确写清「对话经模型 API，不是完全离线」 |
| Outro / 页脚 | 大 CTA「去和她打个招呼。」+ 免责声明 + 版本/许可/素材署名 |

## 设计取舍

调研了 Replika、Apple 产品页、Linear/Vercel、日系角色站等参考（见下），提炼后落到本页：

1. **一句话价值主张 + 一张脸**：首屏只做一件事——「她不是聊天机器人」+ 小雅的脸（静帧缓慢缩放，桌面再淡入 6 秒氛围视频）；
   右侧角色保持清晰可见，渐变只压暗左侧文字区，不做全屏黑遮罩。
2. **分区节奏**：每节固定「编号 + 一句主张 + 一个证据」；细分割线、窄标签、大留白，
   避免模板化的堆卡片。
3. **聊天 mockup 是最重要的证据**：真实感来自细节（撤回提示、正在输入、语音条转文字、
   照片配文），不是组件库 demo；手机屏幕高度按真实比例调到刚好能在一屏看完
   照片 / 表情包 / 语音 / 撤回，不需要滚动。
4. **不虚构社会证明**：没有用户量、评分、评价；只展示产品本身与示例对话，并标注
   「示例 / 界面示意」。
5. **诚实叙事**：隐私区写「本地存储 ≠ 完全离线」；语音标注需要本机 TTS（macOS）；
   撤回标注默认低概率、可配置关闭。
6. **深色电影感**：深蓝黑底 + 冷白文字 + 晚霞暖橙点缀；低饱和、轻颗粒、卡片微光边。
7. **克制动效**：IntersectionObserver 淡入、首屏视频/浮卡缓慢漂浮、语音波形；
   `prefers-reduced-motion: reduce` 时全部降级为静态。
8. **移动端优先断点**：≤900px 首屏人物铺上方、锚点导航收起（只留 LOGO + 体验），
   ≤760px 单列布局、聊天 mockup 收窄，≤430px 字号与间距再收敛；390×844 无横向溢出。

## 素材与版权

| 文件 | 来源 / 许可 |
|---|---|
| `assets/character-1.jpg`、`character-2.jpg`、`hero-left.mp4` | 作者提供的 AI 生成角色素材（已裁掉水印、视频去音轨）；`hero-left.mp4` 仅桌面首屏氛围播放 |
| `assets/character.svg` | 早期占位插画，新页面未使用，仅保留 |
| `assets/gallery/poster-1..3.svg` | 页面自带文案海报（纯 SVG） |
| `assets/photos/*.jpg` | 从仓库 `assets/photos/` 复制，来源 Lorem Picsum → Unsplash License（可免费商用、无需署名） |
| `assets/stickers/*.png` | 从仓库 `assets/stickers/` 复制，Twitter Twemoji，CC-BY 4.0 |

素材已全部复制进 `promo/assets/`，因此把 `promo/` 目录单独部署也能正常显示。旧版的第二段首屏视频（`hero-right.mp4`，约 3.3MB）新页面已不再使用，为仓库减重已删除（git 历史里可找回）。
首屏视频只在桌面 + 未开启减少动态 + 未开启省流量时加载（静帧兜底），移动端只加载静帧。

## 截图（自检用）

`screenshots/` 由本机 Chrome 无头模式生成（本机沙箱内含 `--no-sandbox`）：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1440,900 --screenshot=promo/screenshots/hero.png \
  "file://$PWD/promo/index.html?shot=top"
```

页面内置了两个截图/调试参数，避免截长页时受 `100svh` 影响：

- `?shot=top|daily|messages|proactive|memory|privacy|start`：只显示指定区块（并停用动效）
- `?longshot=1`：首屏固定高度、停用动效，适合整页长图

当前截图：

- `hero.png`（1440×900 首屏）、`mobile.png`（390×844 首屏）
- `daily.png` / `messages.png` / `proactive.png` / `memory.png` / `privacy.png` / `outro.png`（区块）
- `full-desktop.jpg`（1440 整页）、`full-mobile.jpg`（390 整页）
- `mobile-messages.png`（390 宽消息区整段，含手机 mockup）

## 调研参考（web_search / web_fetch 实读）

- [Replika 官网](https://replika.com/)：用聊天片段当 hero 证据、按「记忆 / 关系 / 兴趣」分节、
  大主张 + 产品界面截图交替。
- [优设：Replika 背后的 12 个设计秘诀](https://www.uisdc.com/replika-ais-secret)：头像触发社会临场感、
  多通道（语音）增强真实感、在恐怖谷之前停下。
- [优设：为什么说 Apple 的设计是魔鬼（网页篇）](https://www.uisdc.com/apple-design-details-page?s)：
  滚动连续性、秩序感、视差层次、低饱和 + 留白的高级感、配图质感。
- [Blue Archive 官网](https://bluearchive.jp/)：日系角色站的蓝色调与人物居中的胶片感。
- [Linear](https://linear.app/)：字体排印、留白与克制动效。
- [Vercel](https://vercel.com/)：单色高对比、产品优先的 hero。
- [Framer「Message」AI 落地页模板](https://www.framer.com/marketplace/templates/message/)：
  模块化信息架构 + UI mockup + 清晰价值主张。

未采用：Character.AI（抓取失败）、JanitorAI（403）、Talkie.ai（同名产品是医疗客服，与本产品无关）。

## 已知限制 / 可继续打磨

- 聊天 mockup 是 HTML/CSS 示意，不是真实录屏；以后可以换成真实聊天截图（需要打码）或
  可交互的录屏，真实感会再上一个台阶。
- 语音、照片配文、心情为示例素材；撤回是真实能力（默认低概率、可配置关闭），
  语音依赖本机 TTS（macOS `say`），无 TTS 时产品会自动退回文字。
- 还没做英文版 / 多角色主题（换人设需要换文案与素材）。
- 首屏视频约 3.2MB，桌面首次加载有 1 次 6 秒循环视频；如需更轻可裁到 3 秒或换 WebP 动画。
- 宣传页目前只在本地/内网分发；如果公开发布，建议补一套社交分享图（og:image 已指向角色图）
  与更完整的无障碍检查。
