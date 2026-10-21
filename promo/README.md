# KAREN 宣传落地页（promo/）

单文件、零构建、零外部依赖的静态宣传页。用于讲清楚 KAREN 是什么：一个住在 QQ 里、
有自己的生活、情绪和记忆的 AI 虚拟人（人设：小雅，24 岁，上海静安咖啡店员）。

- **页面**：`index.html`（HTML + 内联 CSS/JS，约 61KB）
- **版本**：v0.9.20（页面上的版本号与仓库 `package.json` 同步）
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
| Hero | 角色主视觉 + 「她不是聊天机器人。」+ 两个 CTA（查看体验 / GitHub）；桌面端有静帧缓慢缩放 + 6 秒氛围视频淡入（静音、移动端不加载）；两张无边框聊天气泡做「活人」证据 |
| 信号条 | 原生 QQ 私聊 / 自己的生活 / 会记得你 / 本地优先 |
| 01 她的日常 | 07:12 / 09:48 / 18:36 / 23:52 四个时刻 + 三种心情（开心 / 一般 / 闷） |
| 02 消息形态 | **纯 HTML/CSS 手画的 QQ 聊天 mockup**：文字、晚霞照片、表情包、3″ 语音条 + 转文字、撤回提示 + 改对、正在输入、输入栏；318px 平面聊天面板（无手机壳/状态栏），左侧 5 条能力清单 |
| 间奏 | 整幅角色插画（`character-3.jpg`）+ 「下班路上，天还没黑透。我拍给你看。」——页面里唯一一次「作品感」展示 |
| 03 主动性 | 傍晚发晚霞 / 忙时晚回 / 偶尔不回：左侧 3:2 大图 + 图注，右侧两条时间线上下叠（非对称） + 她手机相册横向滑轨 |
| 04 记忆 | 「年糕今天是不是又把你键盘踩了？」示例 + 她记得的几件小事（含 `/forget` 说明） |
| 05 隐私与自部署 | 本地存储 / 单机运行 / 可控 / 开源；明确写清「对话经模型 API，不是完全离线」 |
| Outro / 页脚 | 大 CTA「去和她打个招呼。」+ 免责声明 + 版本/许可/素材署名 |

## 设计取舍（v0.9.20 两轮重做）

用户反馈「文字边框和文字框排版有点劣质、廉价」。这一版不是换皮：第一轮把旧的「卡片系统」
整体拿掉、改成编辑式排版；第二轮补排印、图像和 mockup 的细节。对照着做的事：

1. **去卡片化**：旧版几乎每个内容块都是「1px 边框 + 22px 圆角 + 渐变底」的卡片，
   心情面板里还套着三张卡（卡片套卡片），这是廉价感的主要来源。新版**内容不再有卡片和边框**，
   层级只靠细分割线、留白、字号和对齐；只保留照片和一块 318px 平面聊天面板。
2. **排印系统**：大标题从 700 降到 **500**，配负字距与 `palt` 标点；正文 **16px / 行宽 540px / 行高 1.9**，
   hero 与 5 段导语在标点处做受控断行（移动端取消），避免「方式」「说话」被拆开；小字从 9–11.5px 提到 11–14px，
   正文灰的对比度从约 2.9:1 提到约 5:1；引语只用宋体（只出现在「她说的话」上）；英文微标签收敛为每节一个编号。
3. **两栏章节头**：每节头部固定「左窄栏（编号 + 栏目名）+ 右标题/导语」，正文与栏头严格同一网格，
   不再用居中、堆卡片、左空右满的模板布局。手机 mockup 也不再拟物：无渐变金属边框、刘海、
   假状态栏、外发光和绿色在线点，只留一块平面聊天面板。
4. **单一强调色 + 统一照片调色**：暖调近黑 + 冷白 + 一点晚霞橙；删掉旧版的蓝/玫瑰/绿多个点缀，
   QQ 蓝只保留在真实聊天气泡里（它是产品证据，不是装饰）。所有照片统一降饱和 26% + 轻暖灰 + 压高光
   （`saturate(.74) sepia(.05)`），不再像五个不同图库搜索结果的拼贴。
5. **图像只出现三次**：hero 人物、间奏整幅插画、outro 人物。旧版后半页用一条「大脸视频」
   跟着滚动当背景，既抢文字又像壁纸站，这一版删掉（同时省 666KB）；照片去掉边框和圆角，主图统一 3:2、相册 4:5。
6. **主动区非对称**：左侧 3:2 大图 + 图注，右侧两条时间线上下叠；不再在等宽三栏里混一张高图，
   消掉原来 180px 的基线错位。隐私区删掉 A/B/C/D 幻灯片字母，正文 14.5px，GitHub 入口改成 13px ghost button，
   让结尾像一句结论而不是功能清单。
7. **克制动效 + 移动端**：滚动淡入、首屏视频淡入、聊天气泡轻浮；去掉卡片 hover 位移、毛玻璃浮卡和漂浮小卡。
   390×844 实测 `scrollWidth = 390`，无横向溢出；时间轴 / 胶片条本身可横滑，但不会撑宽页面；
   `prefers-reduced-motion` 时动效全部降级。
8. **诚实**：页面版本号、语音现状（Kokoro，可换 CosyVoice 克隆）、`界面示意` 标注全部与
   v0.9.20 代码一致；隐私区继续写明「本地存储 ≠ 完全离线」。

## 素材与版权

| 文件 | 来源 / 许可 |
|---|---|
| `assets/character-1.jpg`、`character-2.jpg`、`character-3.jpg` | 作者提供的 AI 生成角色素材（已裁掉右下角「豆包 AI 生成」水印；`character-3` 由最新一张裁切+缩放，1200×1926 / 约 224KB） |
| `assets/hero-left.mp4` | 首屏氛围视频（桌面）；已去音轨、720×840、约 3.2MB，进视口才加载 |
| `assets/character.svg` | 早期占位插画，新页面未使用，仅保留（Web 路由测试用它断言静态素材） |
| `assets/gallery/poster-1..3.svg` | 页面自带文案海报（纯 SVG） |
| `assets/photos/*.jpg` | 从仓库 `assets/photos/` 复制，来源 Lorem Picsum → Unsplash License（可免费商用、无需署名） |
| `assets/stickers/1f63a.png` | 从仓库 `assets/stickers/` 复制，Twitter Twemoji，CC-BY 4.0 |

素材已全部复制进 `promo/assets/`，因此把 `promo/` 目录单独部署也能正常显示。
旧版的第二段首屏视频（`hero-right.mp4`）与后半页氛围视频（`ambient-loop.mp4`）新页面已不再使用，
为仓库减重已删除（git 历史里可找回）。

首屏视频只在桌面 + 未开启减少动态 + 未开启省流量时加载（静帧兜底），移动端只加载静帧。

## 截图（自检用）

`screenshots/` 由 `promo/scripts/shoot.mjs` 生成（Chrome DevTools Protocol，零依赖）：

> 为什么不用 `chrome --screenshot`：macOS 的 Chrome 无头模式**最小窗口宽 500px**，`--window-size=390,844` 实际按 500 布局再裁成 390，移动端截图右侧会被切掉（看起来像溢出，其实是截图方式的问题）。`shoot.mjs` 用 `Emulation.setDeviceMetricsOverride` 把视口真正设成 390。

```bash
export PATH="$PWD/.runtime/node22/bin:$PATH"
node promo/scripts/shoot.mjs \
  --url "file://$PWD/promo/index.html?shot=top" \
  --width 1440 --height 900 --out promo/screenshots/hero.png

# 移动端 / 整页
node promo/scripts/shoot.mjs --url "file://$PWD/promo/index.html?shot=messages" \
  --width 390 --height 844 --full --out promo/screenshots/mobile-messages.png
node promo/scripts/shoot.mjs --url "file://$PWD/promo/index.html?longshot=1" \
  --width 1440 --height 900 --full --out promo/screenshots/full-desktop.png
```

页面内置了两个截图/调试参数，避免截长页时受 `100svh` 和固定导航影响：

- `?shot=top|daily|messages|proactive|memory|privacy|start`：只显示指定区块（并停用动效、隐藏导航）
- `?longshot=1`：导航改为随页面滚动（不会在长图中间被截成一条），首屏固定高度，停用动效

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
  语音由本机开源 TTS 合成（Kokoro，可换 CosyVoice 做音色克隆），服务不可用时退回文字。
- 还没做英文版 / 多角色主题（换人设需要换文案与素材）。
- 首屏视频约 3.2MB，桌面首次加载有 1 次 6 秒循环视频；如需更轻可裁到 3 秒或换 WebP 动画。
- 页面的「间奏」整幅插画使用 `character-3.jpg`，在超宽屏（>1920）下裁切会更多；
  如需更稳可以给角色图单独准备宽幅版本。
- 宣传页目前只在本地/内网分发；如果公开发布，建议补一套社交分享图（og:image 已指向角色图）
  与更完整的无障碍检查。
