# Karen Persona 技术雷达 · B 卷：IM 桥接 / 多模态 / 前端 / 基础设施

> 调研对象：`karen-persona`（QQ 里的 AI 虚拟人，Node.js/TS，M1 阶段）
> 调研时间：**2026-10-19**（Asia/Shanghai），所有版本号/价格/发布日期均为该日查询结果
> 证据等级：**实测**（本仓库可复现）｜**官方**（官方文档/仓库/API 返回）｜**社区**（第三方文章/对比）｜**待核实**（发布/采购前必须复核）
> 写作边界：只写本文件。本文所有结论只给「建议 + 工作量」，**不含任何代码改动**；涉及代码的推荐落地由后续任务执行。

---

## 0. 一页结论

### 0.1 结论速览（按主题）

| # | 主题 | 现状 | 结论 | 工作量 | 优先级 |
|---|---|---|---|---|---|
| 1 | QQ 协议端 | NapCatQQ v4.18.38（OneBot 11 反向 WS） | **不换协议端**，锁版本 + 补健康检查 | S | — |
| 2 | QQ 生态迁移 | 曾考虑 Lagrange | **不迁**（LagrangeV2 已归档、OneBot 11 支持停维护） | — | 否决 |
| 3 | 桥接抽象 | `qq.ts` 与 OneBot 事件模型耦合 | **小改**：先抽 `PlatformAdapter` 接口，暂只实现 Web/Telegram | S（接口）+ M（Telegram） | 中 |
| 4 | 官方 IM Bot API | 未接 | Telegram 官方 Bot API 2026 已支持流式草稿，**性价比高于接第二个非官方 QQ** | M | 中 |
| 5 | TTS | 无（Fish Audio Key 空占位） | **暂不做本地 TTS**；要做先用云 TTS 流式（阿里 cosyvoice-v3-flash） | M–L | 低 |
| 6 | ASR | 无（语音消息只落 `[语音]` 占位） | **值得做**（SILK 解码 + FunASR/faster-whisper） | M | 中 |
| 7 | 表情/贴纸 | 入站 face/mface **直接丢弃**；出站仅 qqFace | **值得做**（本地贴纸库 + mface/CQ image） | S–M | 高 |
| 8 | 文生图 | 即梦仅空壳函数；Unsplash 只在 CLI/群聊生效 | **不做**（自拍一致性差、成本/维护高） | — | 否决 |
| 9 | Web UI | 无 | **值得做**：Hono + HTMX 只读控制台 MVP，宣传页分离 | M | 高 |
| 10 | 数据层 | better-sqlite3 11.10 裸 SQL；Drizzle 0.45 仍 pre-1.0 | **小改**：升级 better-sqlite3 13.x，不迁 ORM | S | 前置必修 |
| 11 | 延迟/定时任务 | `setTimeout` 内存 timer（**重启即丢**） | **小改**：SQLite 持久任务表 + 启动扫描；不引 Redis/PG | S–M | 高 |
| 12 | 进程守护 | PM2（跑 tsx 源码、无健康检查） | **小改**：PM2 改跑 dist + macOS launchd/systemd；不换框架 | S | 前置必修 |
| 13 | 可观测 | 338 处 `console.log`，无 /health、无成本汇总 | **值得换**：pino + /health + 每日成本 | S | 最高 |
| 14 | 打包分发 | 无安装包 | Node SEA 仍 1.1 开发中、pkg 已停更 → **不追**；Homebrew/zip/Docker 够用 | S（Homebrew） | 低 |
| 15 | 测试 | vitest 4，330 用例；无集成/契约测试 | **小改**：升 vitest 5 + 复用 mock-onebot 做集成/契约 | S–M | 中 |

### 0.2 如果只做 3 件事（按收益/成本排序）

> 另有 **0 号必修**（不算 3 件事，但必须最先做）：`better-sqlite3` 11.10 → 13.0.3、`vitest` 4 → 5 的依赖升级，并在 macOS + Windows 双端各跑一遍 `typecheck + test + 一次 QQ 冒烟`。理由见 §7.2。

| 排序 | 做什么 | 为什么是它 | 不做什么 | 工作量 | 验收标准 |
|---|---|---|---|---|---|
| **1** | **可观测性最小闭环**：pino 结构化日志（默认脱敏）+ `GET /health`（127.0.0.1）+ 每日 token/成本汇总 + PM2 改跑 `dist/` | 现在 338 处 `console.log`、无健康检查、成本不可见；所有后续功能（Web/语音/多平台）都依赖「出问题能定位」。这是唯一一个「不做则后面全部打折」的地基项 | 不接 OpenTelemetry / Sentry、不搭 Prometheus | **S（1–2 天）** | 一条消息可从日志还原「收到→LLM→发送」耗时与 token；`curl 127.0.0.1:18081/health` 返回 db/ws/last_error；`/cost` 能看到当日估算费用；进程被杀后 `pm2 start` 用编译产物 1s 内恢复 |
| **2** | **本地 Web 控制台 MVP**：`karen serve` 起 Hono（127.0.0.1:18081），token 鉴权，HTMX 只读四视图：聊天 / 记忆 / 关系时间线 / 健康与成本；宣传页静态分离 | 项目已有状态持久化（state-store）、关系成长、`/journal /timeline /herview` CLI 命令——**东西做完了但看不见**。Web 是「让用户感知她会变化」+「可截图宣传」的最低成本载体，且能顺手解决安装门槛 | 不做 Next.js/RSC、不做桌面壳、不做写操作（第一期） | **M（5–10 天）** | 手机浏览器经 Tailscale 可打开；无 token 一律 401；页面无 XSS（LLM 输出转义）；断网时其它功能不受影响 |
| **3** | **表情/贴纸系统**：出站 qqFace + mface（收藏表情）+ 本地贴纸库（情绪/场景标签）；入站 face/mface 不再丢弃，转成情感信号 | 「像真人」的最高性价比：成本≈0、延迟≈0、可立即感知；而现在入站表情直接 `continue` 丢弃、出站只有 qqFace，是聊天观感最明显的缺口。比 TTS/文生图便宜一个数量级 | 不接 GIPHY（QQ 内 100 req/h 限额 + 内容西方化）、不做文生图 | **S–M（2–4 天）** | 她能在合适语境发对应表情/贴纸；贴纸资源本地化、无外网依赖；失败静默降级不影响文字回复 |

### 0.3 不推荐跟风（本轮明确否决）

| 项目 | 为什么不做 | 什么条件下才重新考虑 |
|---|---|---|
| 迁移到 Lagrange.Core / LagrangeV2 | LagrangeV2 已归档（2026-07-23），官方明确 V2 **不再支持 OneBot 11**、V1 的 OneBot 11 实现**不再维护**，改推 Milky 协议；迁移等于同时换协议+换生态 | Milky 出现成熟的 OneBot 11 兼容层，且 NapCat 停更 |
| 自研/切换 OneBot 12 | OneBot 规范仓库最后提交停在 **2023-07**，生态页最后更新 2021–2024；OneBot 12 生态事实上停滞 | 不计划 |
| 本地文生图（Flux/SDXL/ComfyUI）做「自拍」 | 同一张脸的一致性需要 LoRA/参考图工程，出图延迟/显存/维护成本高，翻车会直接破坏「像真人」；与项目「文本+表情+照片分享」的轻量人设不匹配 | Web UI 有富媒体展示场景、且愿意维护 GPU/云端生图流水线 |
| Prisma / 重型 ORM 重写 | Drizzle 最新仍 0.45.4（pre-1.0）；Prisma 7.10.1 稳定、8.0 RC，引擎重、冷启动与打包体积大；当前 SQLite 裸 SQL 只有 337 行、WAL 已调优 | 记忆表结构复杂化到需要 relation/migration 工具，且愿意接受 ORM 学习成本 |
| Redis + BullMQ / Postgres + pg-boss | 单机个人项目引入第二个数据存储，运维成本 > 收益；BullMQ 6.x 依赖 Redis，pg-boss 12.x 依赖 Postgres，二者都不解决「SQLite 单文件」的诉求 | 多用户托管/多实例部署（M3 之后） |
| Electron / Tauri 桌面壳 | 浏览器 + 本地 Web 已覆盖 95% 场景；Electron 44.9 体积/内存重，Tauri 需 Rust 工具链；打包是分发问题不是产品问题 | 需要托盘常驻 + 系统级通知 + 离线分发给非技术用户，且 Web 版已验证 |
| Node SEA / pkg 单文件打包 | Node SEA 官方仍标 **Stability 1.1 - Active development**；`pkg` 最后版本 5.8.1（2023-03）已停更；Bun `--compile` 需要换运行时 | SEA 转 Stable 且团队愿意做双运行时验证 |
| 微信桥接（wechaty/gewechat） | 现仓库只是 echo 桩；协议风险/封号风险比 QQ 更高，收益（触达）已被 Web/QQ 覆盖 | 不计划 |
| OpenTelemetry 全家桶 / 云端 APM / Sentry | 单机 1 进程，OTel JS 的 `sdk-node` 仍是 0.223.0（experimental 版本线）；Sentry 会把含隐私的 trace 发到云，与本项目「本地存储」叙事冲突 | 多用户托管、需要跨机排障时，再考虑自托管 collector |

---

## 1. 调研口径

### 1.1 证据等级

| 等级 | 含义 | 本文中的典型用法 |
|---|---|---|
| **实测** | 本仓库代码/脚本可复现（如 `scripts/mock-onebot.mjs` 全链路、`tsc/test` 数字） | 现状盘点、代码事实 |
| **官方** | 官方仓库 Release/README、官方文档、官方 API 返回（GitHub API / npm registry / 官方价格页） | 版本号、发布日期、协议能力、计费 |
| **社区** | 第三方对比文章、迁移公告解读（会标注来源） | Telegram Bot API 10.x 时间线等 |
| **待核实** | 发布/采购/上线前必须自己复核的事实 | 价格档位、GPU 延迟、macOS 能力冲突、镜像 tag |

### 1.2 工作量定义

| 标记 | 含义 |
|---|---|
| **S** | ≤ 1 人日（熟悉本仓库的 1 名工程师） |
| **M** | 2–5 人日 |
| **L** | > 5 人日，或需要真机/跨端验证 |

### 1.3 结论标签

- **值得换**：现有实现有明显缺陷，替代方案成熟且收益 > 成本，建议排期。
- **小改**：大方向对，补关键短板即可，不引入新框架/新服务。
- **不换 / 不做**：现方案够用，或替代方案的复杂度/风险不匹配当前阶段。

### 1.4 调研方法

1. 精读本仓库相关代码与文档（`src/bridge/*`、`src/impulse/unsplash-trigger.ts`、`src/ai/vision.ts`、`src/data/*`、`package.json`、`Dockerfile`、`ecosystem.config.js`、`deploy/*`、`scripts/mock-onebot.mjs`）。
2. 官方源查询（2026-10-19）：GitHub Releases API / npm registry（`registry.npmjs.org/<pkg>/latest`，版本 + `time` 发布日期）、NapCat 官方文档、Lagrange 官方文档、Milky 官方文档、Telegram Bot API 变更记录（经社区汇总）、QQ 机器人官方文档、阿里云百炼文档、ElevenLabs 价格页、GIPHY 定价资料、Node.js 官方文档。
3. 对无法直接验证的能力/价格打 **待核实**，并在 §12.3 单列清单。

---

## 2. 现状基线（as-is，均已核对代码）

### 2.1 技术栈（`package.json`，2026-10-19）

| 层 | 现状 | 备注 |
|---|---|---|
| 运行时 | Node.js `engines >=22`；本仓库历史审计/实测记录为 Node 24.21 | 当前 LTS 为 Node 24.22.0（2026-10-14 发布） |
| 语言/执行 | TypeScript 5.6 strict、NodeNext；开发态 `tsx` 直跑；`npm run build` → `dist/` | 生产应跑 `dist/`，仓库 PM2 默认仍跑 tsx 源码 |
| 依赖（9 运行时） | `axios`、`better-sqlite3 ^11.10`、`dotenv`、`node-cron ^3`（**0 引用**）、`openai ^4.70`、`sqlite-vec ^0.1.9`（**只建表不读写**）、`wechaty ^1.20`（**echo 桩**）、`ws ^8.18`、`yaml ^2.6` | 冗余依赖见 §7.2 |
| 开发依赖 | `@types/*`、`tsx ^4.19`、`typescript ^5.6`、`vitest ^4.1.8` | vitest 最新 5.0.5（见 §9.2） |
| 测试 | 21 文件 / 330 用例（CLAUDE.md 记录），CI = Node 22 + `npm ci` + typecheck + test | 无覆盖率、无集成测试 |
| 存储 | `data/memory.sqlite`（WAL）+ `data/<persona>-session.json`（≤200 条）+ `data/persona-state-<persona>.json`（M1） | 路径统一走 `src/data/paths.ts`，支持 `KAREN_DATA_DIR` |
| 外部 API | DeepSeek（聊天/视觉）、OpenWeatherMap、Unsplash；可选 Qwen 嵌入（未接主路径） | 无 TTS/ASR/生图真实调用 |

### 2.2 消息链路与桥接实现（`src/bridge/qq.ts` 1014 行 + `onebot.ts` 810 行）

- **方向**：NapCat 作 WebSocket **客户端**反向连 Karen（`ws://127.0.0.1:18080/onebot/v11/ws`），Karen 是 WS 服务端。
- **已加固（M0）**：默认绑 `127.0.0.1`、path+token 校验（query 或 Bearer）、`allowed_users` 白名单、出站 CQ 转义 + 仅放行受控 `qqFace`、`message_id` LRU 去重、群聊 handler await+catch、进程级异常兜底、日志只打长度。
- **定时器（23 处 setTimeout/setInterval）**：
  - 400ms 消息合并窗；60s WS ping/状态；**15min 生活流心跳**（主动消息）；
  - 消息门「晚点回」用 `setTimeout`（`scheduleDeferredPrivateReply`），**只存在内存 Map**：进程重启后待补发的回复直接丢失（用户消息本身已落会话 JSON）。这与「延迟回复已修复/落库」的表述有差距——**消息不丢，但承诺的回复会丢**。
- **媒体**：入站 `image` → DeepSeek Flash 视觉（下载转 base64，10s/10MB，`detail:low`）；入站 `face`/`mface` → **`continue` 直接跳过**；入站 `record` → 仅合成 `[语音]` 占位，无下载/无 ASR；出站只有文本与 `qqFace`，**`imageUrl` 在 QQ 路径被丢弃**（orchestrator 返回但 `qq.ts` 未消费）。
- **群聊**：仅「@ + 与机器人私聊过的人」才回；与私聊共享 `ConversationState`（多用户隔离未做）。
- **数据**：会话文件按 **persona** 命名（`<persona>-session.json`），不是按 user——同一人设多好友共享聊天记录（架构级，见 §11 风险 3）。

### 2.3 部署资产现状

| 资产 | 现状 | 缺口 |
|---|---|---|
| `Dockerfile` | node:22-slim 多阶段、非 root uid 1000、TZ、`HEALTHCHECK` 用 TCP 端口探活 | 无 HTTP `/health`（探活只测端口，进程假活测不出） |
| `ecosystem.config.js` | PM2：`autorestart`、`max_restarts 10`、`max_memory_restart 512M`、`kill_timeout 5000`、日志到 `data/logs/*.log` | 默认 `script: src/bridge/qq.ts` + `--import tsx`（依赖 devDependencies）；无 healthcheck、无 logrotate |
| `.github/workflows/ci.yml` | Node 22 + typecheck + test | 单 Node 版本；无 lint/coverage/集成测试 |
| `deploy/napcat-macos` | docker-compose 固定 `mlikiowa/napcat-docker:v4.18.38`、WebUI 仅绑回环、日志轮转 | 镜像 tag 是否存在待核实；真机未验证 |
| `deploy/napcat-windows` | 文档 + `scripts/*.bat/.ps1` | 硬编码路径历史问题（审计已记录） |
| `scripts/mock-onebot.mjs` | 414 行零依赖 mock 反向 WS 客户端，退出码 0/1/2/3/4 齐全 | 是后续集成/契约测试的最佳资产（§9.3） |
| Web 服务 | **不存在**（无 express/fastify/hono/node:http server） | 需要新增 |

### 2.4 明确不存在的（本雷达的「空位」）

TTS/ASR、真实文生图、Web UI、ORM、任务队列、结构化日志、`/health`、metrics、Sentry/OTel、安装包/Homebrew、E2E/契约测试、多用户隔离、官方 IM Bot 接入。

---

## 3. QQ / IM 桥接

### 3.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| QQ 协议端 | NapCatQQ v4.18.38（OneBot 11 反向 WS） | 无同等级替代；Lagrange 退 OneBot 11、LLOneBot 并存 | **高**（NapCat 仍在高频发版，2026-10-12 最新） | 收益 0（已在用）；风险=非官方协议封号/随 QQ 升级失效 | **不换** | — |
| 迁移 Lagrange | 曾列为候选 | LagrangeV2（Milky）/ Lagrange.Core（C#） | 低（OneBot 11 支持已停维护；V2 仓库已归档） | 迁移成本 M–L，换来的只是「另一个非官方协议」 | **不换**（否决） | — |
| LLOneBot | 未用 | LLOneBot/LuckyLilliaBot（3.7k star，支持 OneBot 11 + Satori + Milky） | 中高（2026-10-19 仍活跃） | 可作为 NapCat 失败时的备用协议端；需 LiteLoaderQQNT 环境 | **备用方案** | S（已知备用） |
| OneBot 11 规范 | 事实标准 | OneBot 12（停滞）/ Milky（新） | 低（规范仓库 2023-07 后无提交） | 保持现状即可；不要为「标准化」重构 | **不换** | — |
| 桥接抽象 | `qq.ts` 直连 OneBot 事件模型 | `PlatformAdapter` 接口 + Web/Telegram 适配器 | 中（接口层自研，成本可控） | 收益：多平台/多入口；风险：过早抽象放大状态串扰 | **小改**（先抽接口，Web 先行） | S（接口）+ M（Telegram） |
| 官方 IM Bot | 未接 | Telegram 官方 Bot API 10.3 / Discord 官方 API v10 / QQ 官方机器人 API v2 | 高（官方、版本化、ToS 安全） | 收益：零封号风险 + 完整流式能力；成本：功能受限（主动消息/好友关系） | **值得接 Telegram**（第二入口） | M |

### 3.2 协议端对比（截至 2026-10-19 官方/仓库数据）

| 方案 | 形态 | 最新版本/活跃度 | 协议能力 | 平台 | 结论 |
|---|---|---|---|---|---|
| **NapCatQQ（当前）** | 注入 QQ NT 的 OneBot 11 协议端（Shell/Installer/Docker/Termux/AppImage） | **v4.18.38，2026-10-12 发布**；文档页 2 天前更新（≈2026-10-17）；Mac 安装器 2026-10-10 有更新 | OneBot 11：私聊/群聊/图片/语音段/引用/合并转发/CQ 码；WebUI + 反向 WS | Windows / Linux / **macOS 12+（Intel+AS）** / Docker(amd64+arm64) | **当前最优，保持** |
| **Lagrange.Core** | 纯 C# NTQQ 协议实现 | v? 未查到 Release；仓库 2,993 star，最后 push **2026-09-07** | LagrangeV2 起**不再支持 OneBot 11**；改 Milky 协议；V1 的 OneBot 11 实现**不再维护** | 跨平台（.NET） | 不迁移。若研究协议层可选，但需自建 OneBot 适配 |
| **LagrangeV2** | V2 协议实现 | **仓库已归档（archived=true），最后 push 2026-07-23**；配套 [Lagrange.Milky](https://lagrangedev.github.io/Lagrange.Milky.Document) | Milky | 跨平台 | 不迁移 |
| **LLOneBot / LuckyLilliaBot** | LiteLoaderQQNT 插件式 OneBot 11 | 仓库更名后 **3,675 star，最后 push 2026-10-19**；描述「支持 OneBot 11、Satori 和 Milky 协议」 | OneBot 11 + Satori + Milky 三协议 | 依赖 QQNT 客户端 | **备用**（NapCat 出问题时的第二选择） |
| **OneBot 11 规范** | 标准 | [botuniverse/onebot](https://github.com/botuniverse/onebot) 2,069 star，**最后 push 2023-07-06**；[生态页](https://onebot.dev/ecosystem) 版权止于 2024 | 事实标准 | — | 规范已停止演进，**不要为「标准化」重构** |
| **Milky 协议** | 新一代 QQ 机器人协议（SaltifyDev） | **v1.3.0，2026-08-07**；NapCat/LLOneBot/Lagrange 均已支持或转向 | 更结构化的消息段/事件（含收藏表情 API `get_custom_face_url_list`） | 跨平台 | **观察**（不是现在迁移，但决定未来 12 个月方向） |

**判断依据（官方原文）**：Lagrange 官方文档明确写「由于 OneBot 11 协议的各种历史遗留问题，LagrangeV2 不再支持 OneBot 11 协议，V1 的 OneBot 11 协议实现也一并不再维护」，并指向 Milky（[Lagrange.Doc v2](https://lagrangedev.github.io/Lagrange.Doc/v2/)，访问 2026-10-19）。Milky 1.3 更新日志列于 [milky.ntqqrev.org/changelog](https://milky.ntqqrev.org/changelog)（1.3.0 Released on 2026-08-07）。

### 3.3 macOS 原生 vs Docker（NapCat）

| 路径 | 结论 | 依据 | 风险 |
|---|---|---|---|
| **macOS 原生 NapCat（推荐，当前方案）** | 保持 | 官方 Shell 文档 macOS 章节：支持 **macOS 12+、Intel 与 Apple Silicon**；Mac 安装器仓库 2026-10-10 仍更新；[Shell 文档](https://doc.napneko.icu/guide/boot/Shell)（访问 2026-10-19，页面「最后编辑于 2 天前」） | 修改 QQ 入口、QQ 升级可能失效、封号风险 |
| **Docker（备选）** | 保留为隔离方案 | 官方 compose 示例（`mlikiowa/napcat-docker:latest`，amd64/arm64）；仓库 `deploy/napcat-macos` 已固定 `v4.18.38` | macOS 容器→宿主机回环需 `host.docker.internal`；镜像 tag 是否存在**待核实**；QQ 登录仍需人工扫码 |
| **Linux 常开机 / systemd / Docker** | 长期可选 | 官方安装器支持 apt/dnf、Termux、AppImage；systemd 开机启动有官方文档 | 多一台机器维护；收益是「常在线」 |
| **远程 Windows + SSH 隧道** | 可选 | 本仓库 `QQ_BRIDGE_CROSS_PLATFORM.md` 已给方案 | 隧道断线；远程机即账号环境 |

> **本次调研发现的文档冲突（待核实）**：NapCat [Shell 文档 macOS 章节](https://doc.napneko.icu/guide/boot/Shell)（2026-10-17 更新）写「FFmpeg 已随 NapCat 提供，无需另装」；而仓库 `docs/QQ_BRIDGE_CROSS_PLATFORM.md` 引用 NapCat [高级配置文档](https://doc.napneko.icu/config/advanced)（页面约 6 个月未更新）写「macOS 因沙盒无法运行外部程序，FFmpeg 相关音视频处理暂不支持」。**发/收语音、图片转码前必须在 macOS 真机实测**，不要仅依据文档做语音功能承诺。

### 3.4 官方 Bot API vs 非官方协议：风险差异

| 维度 | 非官方 QQ 协议（NapCat/LLOneBot/Lagrange） | 官方 Bot API（Telegram / Discord / QQ 开放平台） |
|---|---|---|
| 协议合法性 | **违反平台用户协议**，封号风险自担 | ToS 允许，账号安全 |
| 能力完整性 | 接近真人客户端：好友私聊、群、引用、语音、表情、撤回 | 受平台约束：Telegram 需用户先 `/start`；Discord 需在服务器内；QQ 官方机器人需审核、主动消息限频、用户身份只有 `openid` |
| 稳定性 | 随 QQ 客户端升级/协议端适配失效（结构性风险） | 版本化 API（Telegram 2026 已到 **10.3**，Discord 稳定 v10），弃用有公告 |
| 身份 | 真实 QQ 号 | 平台内 Bot 身份（更易被识破「不是真人」，与项目「像真人」目标冲突） |
| 流式 | 自己控制（逐条发） | Telegram **10.1 起原生支持流式草稿**（`sendRichMessageDraft`，2026-06-11）；Discord 可用打字指示 + 编辑消息 |
| 结论 | **保 QQ 用非官方**（体验优先，接受风险） | **新增 Telegram 用官方**（安全 + 流式），QQ 官方 Bot API 仅作合规备胎 |

**Telegram 关键事实（社区汇总 + 官方 changelog 引用）**：Bot API 10.0（2026-05-08）guest mode；**10.1（2026-06-11）rich messages + 流式草稿**；10.2（2026-07-14）ephemeral messages + Communities；10.3（2026-08-24）rich message 按钮/可停止生成。来源：[Conferbot 汇总（2026-10-06，文末「Last verified October 2026」）](https://www.conferbot.com/blog/telegram-bot-api-10)，原始变更以 [core.telegram.org/bots/api-changelog](https://core.telegram.org/bots/api-changelog) 为准（本机网络无法直连 Telegram 官方站，**版本细节待核实**）。

**QQ 官方机器人 API v2（合规备胎）**：[官方文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)（页面更新 2026-09-17）——`https://api.bot.qq.com`，`Authorization: QQBot <token>`；支持单聊/群聊/频道消息；身份是 `user_openid/group_openid`，拿不到 QQ 号；错误码明确存在「私信主动消息数限频（304049）/主动消息总量限频（304050）」。→ **不能替代 NapCat 的「好友私聊 + 主动找你」体验，只作合规备胎**。

### 3.5 PlatformAdapter 的性价比（要不要抽象）

**现状**：`qq.ts`（1014 行）同时承担 WS 生命周期、事件解析、合并窗口、限流、媒体处理、回复发送、主动心跳；`onebot.ts` 已把 CQ 编码/解析/发送/白名单/去重抽得较干净（810 行）。**OneBot 事件模型（`PrivateMessageEvent`/`GroupMessageEvent`）已经是一层隐式适配层**。

**建议接口（最小可用，别做全家桶）**：

```ts
// 只抽「收发 + 打字状态 + 健康」，不要一开始就抽象用户/群/权限
interface PlatformAdapter {
  readonly name: "onebot" | "web" | "telegram" | "discord";
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): { connected: boolean; lastMessageAt: number | null };
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  send(msg: OutboundMessage): Promise<SendResult>;
}
// InboundMessage: { platform, channelId, userId, text, images?, voice?, replyTo?, raw }
// OutboundMessage: { channelId, text, imagePath?, qqFace?, replyTo? }
```

**性价比评估**：

| 目标平台 | 适配成本 | 收益 | 风险 | 建议 |
|---|---|---|---|---|
| **Web（自有 UI）** | **S**（复用的现成 orchestrator，只需 HTTP/SSE 层） | 零平台风险、可截图的宣传面、开发调试最快 | 无 | **先做**（与控制台 MVP 合并） |
| **Telegram** | **M**（webhook 或 long polling + 消息分段 4096 字符上限 + 速率限制 + 白名单） | 官方 API 稳定、原生流式草稿、海外可用、零封号 | Bot 身份显式，需用户先启动 bot；部分消息类型限制 | **值得做**（第二个入口） |
| **Discord** | **M**（Gateway v10 + intents + 2000 字符 + 分片/速率限制） | 社区展示（Discord 服务器/频道），适合作品集传播 | 需要服务器语境；用户身份是 Discord 账号；2000 字符限制 | 可选，排 Telegram 之后 |
| **QQ 官方 Bot API v2** | **M–L**（AppID 申请/审核 + openid 映射 + 主动消息限额） | 合规、不封号 | 主动消息受限、身份不透明、体验与「好友」不一致 | 观察，不做 |

**核心风险（很重要）**：多平台会**放大**已有的「多用户隔离缺失」问题——`ConversationState` 按 userId 存但会话文件按 persona 存、全局 `setCurrentPersona` 单例。**必须先做 owner（persona+user+platform）隔离，再开第二个平台入口**，否则 Web/Telegram 的消息会串进 QQ 的记忆。顺序：`owner 隔离（M）` → `Web 入口（S）` → `Telegram 适配（M）`。

### 3.6 本节行动清单

1. **不换协议端**；NapCat 固定具体版本（当前 v4.18.38），升级顺序：先确认 NapCat 支持新 QQ → 再升 NapCat → 最后升 QQ。
2. 给 `qq.ts` 抽 `PlatformAdapter` 接口（只抽收发/健康/打字），**先只实现 OneBot 与 Web**，Telegram 等 owner 隔离完成后再做。
3. 保持 `scripts/mock-onebot.mjs` 作为 CI 可跑的集成测试（§9.3）。
4. 若未来 6–12 个月 OneBot 11 生态进一步萎缩：评估 **Milky 协议 + NapCat/LLOneBot 的 Milky 实现**（2026-08-07 v1.3.0），而不是回溯 Lagrange。

---

## 4. 语音（TTS / ASR）

### 4.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| **ASR（收语音）** | `record` 段只合成 `[语音]` 占位，无下载/解码/识别 | 本地 FunASR/SenseVoice、faster-whisper；云 ASR | 高（模型成熟、中文效果好） | 收益：让「她听得见你」成立；成本：SILK 解码链路 + 推理进程；风险：隐私（语音给第三方）、延迟 | **值得做**（第二阶段） | M |
| **TTS（发语音）** | 无（`FISH_AUDIO_API_KEY` 空占位，0 消费） | 云：阿里 cosyvoice-v3-flash 流式、Fish Audio(Kitta)、ElevenLabs、火山；本地：GPT-SoVITS、CosyVoice 开源、IndexTTS | 高（云）/中（本地部署） | 收益：拟人感显著提升；成本：新增云费用 + 延迟 1.5–5s + 语音一致性工程；风险：QQ 语音发送格式/平台限制 | **暂不做本地；要做先云流式** | M–L |
| 语音消息发送（QQ） | 无 | NapCat `record` 段（file/URL/base64） | 中（macOS 能力有两处文档冲突） | 需要 SILK/转码；QQ 对语音时长/大小有限制 | **待核实后做** | S–M |

### 4.2 TTS 选型对比（2026-10 官方数据）

| 方案 | 类型 | 最新事实（2026-10-19） | 中文/克隆 | 流式 | 成本（验证级） | 部署/维护 | 结论 |
|---|---|---|---|---|---|---|---|
| **阿里云百炼 cosyvoice-v3-flash** | 云 API | 文档更新 **2026-10-11**：支持**实时流式合成**；5–20s 参考音频克隆；RPM 180 | ✅ 强 | ✅ 实时流式 | **$0.14335 / 万字符（北京）**；20 字短句 ≈ $0.0003 ≈ 可忽略 | 零部署，Key 即可 | **首选（若做 TTS）** |
| **Fish Audio（已更名 Kitta Audio）** | 云 API | [docs.fishaudio.org](https://docs.fishaudio.org/) 显示品牌为 **Kitta Audio**；模型 `s2.1-pro / s2.1-pro-flash / s2`；提供 **Realtime TTS v3 WebSocket** 与 OpenAI 兼容端点 | ✅（S2 情绪指令） | ✅ WebSocket 实时 | 价格页 JS 渲染，**具体单价待核实** | 零部署 | 备选（有情绪控制） |
| **ElevenLabs** | 云 API | 价格页（2026-10-19 抓取）显示 **$0.08 / 1K characters**（另有 $0.04、$0.08/min 等档位，**对应模型待核实**）；主推 **Eleven v4** | ✅ 多语种 | ✅ | 20 字 ≈ $0.0016 ≈ ¥0.012/条；100 条/天 ≈ ¥1.2/天 ≈ **¥36/月**（是 DeepSeek 文本成本 ¥3–5/月的 10 倍量级） | 零部署 | 不推荐作为高频聊天默认 |
| **火山引擎 豆包语音** | 云 API | 计费页更新时间 **2026-09-29**；具体单价页面 JS 渲染，**待核实** | ✅ | ✅ | **待核实** | 零部署 | 备选（国内低延迟） |
| **GPT-SoVITS** | 开源自托管 | **63,192 star**；仓库 2026-10-19 仍有 push；最新 Release `20250606v2pro`（**2025-06-06**，发版节奏慢但代码活跃） | ✅ 强（few-shot 克隆） | 需自建（有第三方低延迟 runtime） | 电费/GPU 时间；无 API 费 | **重**：Python 环境、模型权重、GPU/MPS、显存/内存 | 有 GPU 且追求音色唯一性时再考虑 |
| **CosyVoice 开源** | 开源自托管 | 仓库已迁至 [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice)（24,050 star，最后 push **2026-05-25**）；v3 能力以云 API 为主 | ✅ 强 | 视推理栈（vLLM 加速有社区方案） | 同上 | 重 | 与云端二选一，个人项目优先云 |
| **IndexTTS** | 开源自托管 | **v2.5.0（2026-08-13）**；24,584 star；IndexTTS2 论文（AAAI-40，DOI 10.1609/aaai.v40i41.40820）强调**情绪表达 + 时长控制**；有「Faster IndexTTS-2 / 流式 GPU」研究（arXiv 2607.21042） | ✅ 强（情绪） | 研究中/需 GPU | 同上 | 重 | 研究价值高，工程成本高 |

> **成本对比提醒**：文本聊天当前约 **¥3–5/月**（DeepSeek 审计）。TTS 一旦默认开启，按 ElevenLabs 档位会到 **¥30+/月**；云 CosyVoice 档位 ≈ **¥1–3/月**（按每天 100 条、20 字/条估算，仅语音合成费用，**待核实**具体计费口径）。**TTS 应做成「按需/低频」而不是每条都语音。**

### 4.3 ASR：QQ 语音消息接 QQ 的可行性（技术链路）

```
QQ 语音消息 → OneBot record 段（NapCat 给 file 标识/path/URL，可能是 SILK/AMR）
  → Karen 下载文件（需鉴权/临时 URL，参考 vision.ts 的下载+超时模式）
  → 解码为 WAV（QQ 语音多为 SILK 编码；Node 侧可用 silk-wasm 3.7.1 解码/编码）
  → ASR（二选一）：
     A. 本地：FunASR v1.4.16（2026-09-18）/ SenseVoiceSmall / faster-whisper v1.2.1
     B. 云：任一家语音识别 API（成本低，但语音数据出境）
  → 文本进入现有 pipeline（与图片同一注入点：[语音：识别文本]）
```

**关键事实/风险**：

- **SILK 是硬门槛**：QQ 语音不是 mp3/wav，Node 需要 WASM/原生解码器（`silk-wasm` 3.7.1 可用，npm 2026-10 在维护）；解码失败/时长异常要有降级（回退 `[语音]` 占位，不阻塞聊天）。
- **macOS 转码能力冲突**（见 §3.3「待核实」）：语音收发依赖 FFmpeg/SILK 处理，NapCat 两处官方文档口径不一致，**必须真机验证**。
- **本地 ASR 的进程形态**：FunASR/faster-whisper 是 Python，不建议塞进 Node 主进程；推荐「独立 sidecar 进程 + HTTP 调用（127.0.0.1）+ 失败降级」，或直接用云 ASR 避免 Python 运行时。
- **隐私口径**：语音比文字更敏感；若走云 ASR，README/隐私声明必须如实更新（当前口径是「对话与图片发 DeepSeek」）。
- **延迟预算（估算，待实测）**：下载 0.2–1s + SILK 解码 <0.2s + 本地 ASR（5–10s 语音）1–3s（**待核实**，取决于模型/CPU/M 系列性能）≈ **2–4s**。聊天场景可接受（用户发语音本就预期等待）。

### 4.4 TTS 延迟预算（决定「值不值得做」）

| 环节 | 估算 | 依据/说明 |
|---|---|---|
| LLM 首 token | 0.5–0.7s | 本仓库 DeepSeek 审计实测：流式首 token 533–668ms |
| TTS 首包（云流式） | 0.3–1s | 各家流式首包指标不同，**待实测**；cosyvoice-v3-flash 支持实时流式 |
| SILK 编码 + 上传（QQ） | 0.5–2s | 取决于 NapCat/网络/时长，**待实测** |
| 合计（第一条语音） | **1.5–4s** | 文字消息已经先发出，语音作为「补充」体验更自然，避免让用户干等 |

> **建议的产品形态**：文字先回（现有 burst 流式），语音**异步后补**（「她发来一条语音」），而不是「等语音生成完再发」。这样 TTS 延迟不进入主体验关键路径，失败也不影响文字。

### 4.5 本节行动清单

1. **先 ASR、后 TTS**；ASR 用「silk-wasm 解码 + 云/本地二选一」，先做 macOS 真机可行性验证（S，1 天）。
2. TTS 若做：**先接阿里 cosyvoice-v3-flash 流式**做 20–30 条/天的小流量灰度；不做本地 GPT-SoVITS（除非有 GPU 且确定音色是核心卖点）。
3. 语音回复默认关闭（配置项），并在 UI/日志里可关闭、可删除音频文件。
4. 隐私声明同步更新（语音会发往云 ASR/TTS 厂商）。

---

## 5. 表情包 / 贴纸与文生图

### 5.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| 入站表情 | `face`/`mface` 被**直接丢弃**（`continue`） | 识别为「情绪信号」+ 可选贴纸回应 | 高 | 收益：拟人感 + 上下文理解；成本几乎为 0 | **值得做** | S |
| 出站表情 | 仅受控 `qqFace`（QQ 系统表情） | + `mface`（收藏表情/商城表情）+ 表情包图片 | 中（mface CQ 格式需核实） | 收益高、成本低；风险：CQ 字段兼容性 | **值得做** | S–M |
| 本地贴纸库 | 无 | `assets/stickers/` + JSON 标签（情绪/场景/亲密度） | 高（纯本地） | 无外网依赖、无成本、可控 | **首选** | S |
| GIPHY API | 无 | GIPHY Beta key：免费 **100 请求/小时、50 结果/次**；Production key 需审核且**价格不公开** | 中 | 内容偏西方 meme，QQ 内发送 GIF 还有格式/大小问题；对「像真人」帮助有限 | **暂不接**（Web 端可选） | — |
| 文生图（自拍/生活照） | 即梦仅空壳；Unsplash 只在 CLI/群聊生效 | FLUX.2 / FLUX 3（open weights 预告）/ Seedream 5.0 Pro / 本地 ComfyUI | 高（画质） | **一致性差**（同一张脸需 LoRA/参考图工程）、延迟/成本/维护高；翻车直接破坏人设 | **不做** | — |
| Unsplash 真实照片 | 已有实现但 QQ 路径不发 | 接回 QQ 出站图片（CQ image） | 高 | 成本低、真实感强（风景/生活照），比 AI 自拍安全 | **小改接回** | S |

### 5.2 三条路线的性价比（针对「像真人」）

| 路线 | 真人不真实 | 边际成本 | 延迟 | 维护 | 风险 | 优先级 |
|---|---|---|---|---|---|---|
| **A. 本地贴纸库 + QQ 表情/mface** | 高（真人微信也这么聊） | ≈0 | ≈0 | 低（换图即生效） | CQ 格式兼容、个别表情平台不支持 | **P0** |
| **B. 真实照片分享（Unsplash/Pexels/本地相册）** | 中高（生活照可信） | ≈0（免费 API；Unsplash demo 50 次/h） | 0.5–2s | 低 | 图不对语境、版权（Unsplash 许可需核对） | **P1** |
| **C. 文生图（Flux/SDXL/即梦）** | 低–中（容易出现「AI 脸」和不一致） | 云 $0.01–0.1/张（**待核实**）；本地需 GPU/电费 | 3–15s | 高（模型/工作流/审核） | 一致性、审核、成本、伦理（虚拟人自拍） | **不推荐** |

### 5.3 落地建议（A 路线的具体做法）

1. **入站处理**：`handlePrivateBatch` 里 `face`/`mface` 不再 `continue`，而是提取 `face id`/`mface summary` → 在当轮消息文本后追加轻量标签（如 `[表情]`），并更新情绪/语气状态（不要用关键词硬判情绪，符合项目设计禁令）。
2. **出站处理**：在 `renderer.ts` 的 qqFace 之外增加 `sticker` 类型；`onebot.ts` 的出站白名单从「仅 qqFace」扩为「qqFace + mface + 本地 image（base64/file）」；保持 CQ 转义不变，新增类型必须走白名单。
3. **贴纸库结构**（示例）：
   `assets/stickers/index.json` → `[{ "id": "happy_01", "file": "happy_01.gif", "tags": ["开心", "同意"], "minCloseness": 3, "personas": ["小雅"] }]`
   选择逻辑：先按 `emotionState` + 语境标签过滤，再按亲密度/冷却随机；失败静默跳过。
4. **QQ 内发送图片**：优先 base64（避免 NapCat 私有 URL 问题），限制单图 ≤ 2–5MB（**待核实** NapCat/QQ 实际上限），并做失败降级（不发图，只发文字）。
5. **宣传页/Web**：贴纸可复用为 Web 端 emoji/GIF（无平台限制），是 Web UI 的低成本亮点。

### 5.4 关于 GIPHY 与文生图的补充依据

- GIPHY：Beta key 免费但限 **100 请求/小时、50 结果/请求**；Production key 需申请审核且定价私下协商（来源：API Evangelist 的 [GIPHY 计划资料](https://raw.githubusercontent.com/api-evangelist/giphy/refs/heads/main/plans/giphy-plans-pricing.yml)，文件自述「generated / unverified」，**以 GIPHY 官方开发者页为准，待核实**）。
- 文生图现状（官方）：FLUX 系列文档已有 **[FLUX.2](https://docs.bfl.ml/flux_2/flux2_overview)**（访问 2026-10-19），导航同时出现 **FLUX 3 Image Klein（open weights）** 入口；字节 Seedream 5.0 Pro 已发布（[36kr 实测](https://36kr.com/p/3887236673485574)，2026）。结论不变：**画质不是瓶颈，一致性/成本/维护才是**。

---

## 6. Web UI / 前端

### 6.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| 控制台（聊天/记忆/关系/健康） | 无 | **Hono 4.13.13 + HTMX 2.0.11**（同语言、零前端构建） | 高 | 收益：可见性 + 可分享 + 排障；成本低；风险：鉴权/XSS | **值得做（MVP）** | M |
| 若要做重前端/公开站 | 无 | Next.js 16.4.2（RSC、SEO 好）或 SvelteKit 3.1.0 | 高 | 重构建/重依赖；对单机控制台过度 | **不换**（控制台不用） | — |
| 宣传页 | 无 | 静态 HTML / Astro 静态导出 | 高 | 与运行时解耦，可放 GitHub Pages | **值得做（小）** | S |
| 桌面壳 | 无 | Tauri 2.12.3 / Electron 44.9.0 | 高 | 浏览器已覆盖；桌面壳增加签名/更新/体积负担 | **不做** | — |
| 局域网访问 | 无 | 回环 + token +（Tailscale/SSH 隧道） | 高 | 直接绑 0.0.0.0 = 攻击面扩大 | **必须按安全清单做** | S |

### 6.2 框架对比（面向「聊天展示 + 人设/记忆/关系时间线 + 宣传页」）

| 维度 | Hono 4 + HTMX 2 | Next.js 16 | SvelteKit 3 | Tauri 2 | Electron 44 |
|---|---|---|---|---|---|
| 最新版本（2026-10-19） | hono 4.13.13；htmx 2.0.11；@hono/node-server 2.1.5 | next 16.4.2（2026-10-15） | @sveltejs/kit 3.1.0 | @tauri-apps/cli 2.12.3（Tauri 3 处于 alpha） | 44.9.0（需 Node ≥22.12 构建） |
| 语言/心智负担 | TS 一把梭，无客户端构建 | React + RSC（学习曲线最陡） | Svelte 5（轻，但要学） | 前端 + Rust 工具链 | 前端 + 主进程/签名 |
| 本地控制台适配 | **最佳**（服务端渲染、SSE 简单） | 好但重 | 好 | 过重 | 过重 |
| 宣传页/SEO | 静态页另做 | **最佳（内置）** | 好 | 不适用 | 不适用 |
| 安装/分发体积 | 小 | 中 | 中 | 小（但需 Rust 构建） | 大（~100MB+） |
| 安全面 | 小（无大量前端依赖；注意 XSS/CSRF） | 中（SSR + server actions 的 CSRF/SSRF 注意） | 中 | 桌面权限模型 | 桌面 + Node 集成面 |
| 结论 | **控制台首选** | 只做公开站时再用 | 备选 | 不做 | 不做 |

> 版本依据：npm registry 查询（2026-10-19）；Next.js release `v16.4.2` 发布于 2026-10-15（GitHub Releases API）。

### 6.3 推荐架构（最小可用）

```
karen serve（新增命令，独立进程或与 qq 同进程 fork）
  ├─ Hono (node-server) 监听 127.0.0.1:18081
  ├─ 鉴权：启动时生成/读取 config 中的 web_token（≥32 字节），控制台输入一次存 sessionStorage；所有 /api/* 校验 Authorization: Bearer
  ├─ 只读 API：/api/state /api/memory /api/timeline /api/health /api/cost
  ├─ HTMX 页面：/chat（最近会话） /memory（T2 检索/浏览/删除） /timeline（关系事件） /health（成本/延迟/连接）
  └─ 不提供写操作（第一期）；第二期再加「暂停主动消息 / 删除记忆 / 导出」（写操作必须 CSRF 防护）

宣传页：独立的静态页（纯 HTML 或 Astro 静态导出），放 GitHub Pages/对象存储，与本地服务零耦合。
```

**为什么先做「只读」**：只读页面没有 CSRF/写入权限风险，能把 M1 已完成的「状态持久化/关系成长/演化可见化」立刻变成可分享的产品界面；写操作等安全设计完成后再上。

### 6.4 单机本地 vs 局域网访问：安全要点（必须逐条落地）

| 风险 | 正确做法 | 反例（禁止） |
|---|---|---|
| 端口暴露到局域网 | **默认绑 `127.0.0.1`**；需要手机访问时用 **Tailscale / SSH 隧道**，或显式配置 + token + TLS | `0.0.0.0:18081` 无鉴权、路由器端口转发 |
| 鉴权 | 强随机 token（≥32 字节），启动打印一次（类似 NapCat WebUI 的做法）；可轮换；失败限流 | 默认密码、token 写进 URL 并被日志/Referer 泄露 |
| CSRF（若用 Cookie 会话） | Cookie 用 `HttpOnly` + `SameSite=Strict`（TLS 时 `Secure`）+ 双提交 CSRF token + 校验 `Origin`；状态变更只接受 POST（[OWASP CSRF 防护速查表](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)） | 只用 Cookie 无 CSRF 防护、GET 执行写操作 |
| XSS（LLM 输出直出） | 模板默认转义；Markdown 渲染 `html:false` 或 DOMPurify；CSP 禁止内联脚本；不把用户内容拼进 HTML | `innerHTML = llmReply` |
| 越权读数据 | 所有数据接口统一鉴权；`data/` 目录不经 HTTP 暴露；导出/删除需二次确认 | 静态目录直接映射 `data/` |
| CORS | 默认不开 CORS；如需跨端只允许白名单 Origin | `Access-Control-Allow-Origin: *` + 携带凭据 |
| 日志泄露 | 日志脱敏（只打长度/摘要，现有桥接已这样做，扩展到 Web 日志） | 打印 token、完整消息、QQ 号 |
| 供应链 | Web 依赖尽量少（Hono+HTMX 正好符合）；锁版本 | 引入大量前端依赖且不锁版本 |

### 6.5 本节行动清单

1. 新增 `npm run serve`（Hono + HTMX），**默认 127.0.0.1:18081**，token 必填，只读视图 4 个。
2. 宣传页静态化，单独仓库/目录，GitHub Pages 部署，不接运行时。
3. 手机访问先用 Tailscale，文档写清；**不**开放公网。
4. 第二期写操作前，先补 CSRF/Origin/XSS 测试用例。

---

## 7. 数据与任务

### 7.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| SQLite 驱动 | better-sqlite3 **11.10**（Node 24 无预编译记录的旧版） | better-sqlite3 **13.0.3**（2026-08-05 发布，`engines: node >=22`） | 高 | 修复 Node 24 加载/编译风险；改动小 | **值得换（前置必修）** | S |
| ORM | 裸 SQL（`vector.ts` 337 行等） | Drizzle 0.45.4（仍 pre-1.0）/ Prisma 7.10.1（8 RC） | 中 | 类型安全收益有限；迁移/学习/构建成本高 | **不换**（观察 Drizzle 1.0） | — |
| 延迟/定时任务 | `setTimeout` 23 处；延迟回复仅内存 timer | SQLite 任务表 + 启动扫描（自研）；croner 10.0.1 补 cron | 中 | 修复「重启丢补发」；零新服务 | **小改** | S–M |
| 队列框架 | 无 | BullMQ 6.3.17（需 Redis）/ pg-boss 12.38.0（需 Postgres） | 高（但依赖重） | 单机引入第二个数据库不划算 | **不换** | — |
| 进程守护 | PM2 7.0.4（跑 tsx 源码） | PM2 7 + launchd/systemd/Docker Compose | 高 | 修复生产启动方式 + 开机自启 | **小改** | S |

### 7.2 数据层：better-sqlite3 vs Drizzle vs Prisma

| 方案 | 版本/发布（2026-10-19 npm） | 适配本项目 | 迁移成本 | 判断 |
|---|---|---|---|---|
| **better-sqlite3（现状）** | 项目 `^11.10`；最新 **13.0.3**（2026-08-05） | 同步 API、WAL、prepared statements，已用得很顺；13.x `engines` 要求 **node >=22**，与项目一致 | **S**：升级依赖 + 双端验证（Node 24/22、Windows 编译链） | **升级，不替换** |
| **Drizzle ORM** | **0.45.4**（仍未到 1.0） | SQLite dialect 支持好，类型安全强 | M：schema 重写 + 查询重写 + drizzle-kit 构建链 | **不换**；等 1.0 稳定后可作为「新表」试点 |
| **Prisma** | `@prisma/client` **7.10.1**；`prisma` **8.0.0-rc.23** | 引擎重、冷启动/打包体积大；SQLite 支持但不是其主场景 | L | **不换** |

**结论**：维持裸 SQL + 保持 `PRAGMA user_version` 迁移机制；只做两件事——升级驱动、把「重复查询」收敛成轻量 repository 函数（为未来 Web/多用户做准备）。**不要为了「现代」而迁 ORM。**

### 7.3 延迟/定时任务：不引 Redis 的方案

**现状问题（已核对代码）**：

- 消息门「晚点回」：`scheduleDeferredPrivateReply` 用 `setTimeout` 存在 `userDeferredTimers` Map；**进程重启即丢**（用户消息已落会话文件，但承诺的补发不会发生）。
- 生活流心跳：`setInterval(15min)`；主动消息无重入锁（审计已记录）。
- `node-cron ^3`：依赖存在但 **0 引用**。

**方案对比**：

| 方案 | 依赖 | 持久化 | 适用场景 | 结论 |
|---|---|---|---|---|
| `setTimeout`（现状） | 无 | ❌ | 秒级~分钟级、可容忍丢失 | 保留用于短抖动，但**不能承载「晚点回」** |
| **SQLite 任务表 + 1s tick + 启动扫描**（自研，推荐） | 无（复用现有 SQLite） | ✅ | 单机、低吞吐（< 1k 任务/天）、跨重启 | **推荐** |
| croner 10.0.1 | 无 | ❌（进程内） | 纯 cron 表达式（如每日汇总） | 可选（比 node-cron 轻、API 更好） |
| BullMQ 6.3.17 | **Redis** | ✅ | 多实例、高吞吐、重试/延迟队列 | 不换（单机不引 Redis） |
| pg-boss 12.38.0 | **Postgres** | ✅ | 已有 PG 的多服务 | 不换 |
| node-cron 4.6.0 | 无 | ❌ | 现有依赖升级 | 可直接移除（0 引用） |

**推荐实现（SQLite 任务表，可直接照做）**：

```sql
CREATE TABLE IF NOT EXISTS pending_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'deferred_reply' | 'proactive' | 'daily_rollup'
  user_id INTEGER,                 -- 目标用户（可空）
  payload TEXT NOT NULL,           -- JSON（消息文本/上下文快照）
  run_at TEXT NOT NULL,            -- ISO 时间
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON pending_jobs(status, run_at);
```

- 启动时：`SELECT ... WHERE status='pending' AND run_at <= now` → 补发或标记过期。
- 运行中：1s tick 取到期任务，单条 `UPDATE ... WHERE status='pending'` 抢占（SQLite 单写者，天然互斥）；失败指数退避、上限后 `failed`。
- 心跳/每日汇总也可以用 `run_at` 实现，不再依赖 `setInterval` 重入。
- 迁移成本：**S–M**；删除 `node-cron` 依赖顺带清理。

### 7.4 进程守护：PM2 vs launchd/systemd/Docker Compose（macOS/Windows 双端）

| 方案 | macOS | Windows | 开机自启 | 日志轮转 | 健康检查 | 结论 |
|---|---|---|---|---|---|---|
| **PM2 7.0.4**（现状） | ✅ | ✅ | `pm2 startup`/`pm2 save` | ❌（需 pm2-logrotate） | ❌（需外部） | **保留**，但改为跑 `dist/` + 加 logrotate |
| launchd（macOS 原生） | ✅ 最稳（KeepAlive/ThrottleInterval/StandardOutPath） | ❌ | ✅ | 通过 `newsyslog`/文件大小 | 需外部脚本 | **macOS 长期推荐** |
| systemd（Linux 常开主机） | — | — | ✅ `enable --now` | journald | `ExecStartPost`/watchdog | Linux 长期推荐 |
| Docker Compose | ✅ Docker Desktop/OrbStack | ✅ Docker Desktop | `restart: unless-stopped` | `logging` driver 限大小 | `healthcheck`（[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)） | **可选**（把 Karen 也容器化；QQ 登录仍需人工） |
| Windows 任务计划/NSSM | — | ✅ | ✅ | 差 | ❌ | Windows 可用 PM2 替代 |

**推荐组合**：

- **macOS（当前主力）**：PM2 跑 `dist/bridge/qq.js`（`NODE_ENV=production`，`kill_timeout 5000` 保留）；再加 launchd plist 作为「开机自启 + 崩溃拉起」的兜底（或直接用 launchd 取代 PM2，二选一，避免双守护互相抢进程）。
- **Windows**：继续 PM2（`ecosystem.config.js`）+ 任务计划程序做开机自启；或 NSSM（**待核实** win 版本兼容性）。
- **Linux 常开主机**：systemd unit + `Restart=always`；如需隔离可 Docker Compose（官方 NapCat compose + Karen 镜像）。
- **不要为了守护再引入 Docker Desktop（macOS）**：NapCat 的 Docker 是「隔离/跨平台」需求，Karen 本身直接跑更简单。

### 7.5 本节行动清单

1. 升级 better-sqlite3 → 13.0.3（双端验证）、删除 `node-cron`、升级 vitest → 5。
2. 新增 `pending_jobs` 表 + 启动扫描，替换延迟回复的内存 timer；升级 PM2 脚本为 `dist/`。
3. macOS 增加 launchd plist（或明确只用 PM2）；Windows 维持 PM2 + 任务计划；文档补「日志轮转」。
4. 不做 ORM、不引 Redis/Postgres。

---

## 8. 可观测、部署与打包

### 8.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| 日志 | 338 处 `console.log` + 44 处 `console.error/warn`；无级别/无请求 ID/无脱敏统一 | **pino 10.4.0**（2026-10-02） | 高 | 排障效率质变；成本低；需统一脱敏规则 | **值得换** | S–M |
| 健康检查 | 无（Dockerfile 只能用 TCP 探活） | `GET /health`（node:http 或 Hono） | 高 | 假活可发现；PM2/Docker 可用 | **值得加** | S |
| 指标/成本 | 无；usage 只打日志 | 每日 JSONL/SQLite 汇总 + `/cost` | 高 | 成本可见、可限额 | **值得加** | S |
| OpenTelemetry | 无 | `@opentelemetry/sdk-trace-node` 2.12.0；`sdk-node` **0.223.0（experimental 版本线）** | 中（API 稳定、SDK 部分仍 experimental） | 单机收益小、接入复杂 | **不换** | — |
| Sentry | 无 | `@sentry/node` 11.8.0 | 高 | 崩溃可见，但数据出云、隐私冲突 | **不换**（可选自托管/仅 error） | — |
| 打包分发 | 无安装包 | Homebrew / zip + bat / Docker；Node SEA 1.1、pkg 停更 | 中 | 目标用户会 `npm i` 的话分发不是瓶颈 | **小改**（Homebrew/Docker） | S |

### 8.2 日志：pino 迁移要点

- 结构化字段（统一）：`ts, level, module, event, turn_id, user_hash（QQ 号哈希，不落明文）, latency_ms, prompt_tokens, completion_tokens, cache_hit, cost_est, error_code`。
- **默认脱敏**：消息正文只打长度/摘要（保持桥接现有习惯）；`pino` 的 `redact` 配置 token/key/Authorization。
- 双输出：开发 `pino-pretty 13.2.0`；生产 JSON → 文件（配 logrotate/PM2 logrotate）+ 可选 stdout。
- 成本：`chat.ts` 已记录 usage（含 reasoning/cache_hit），只需汇总；每日 rollup 写 `data/metrics-YYYY-MM-DD.jsonl` 或 SQLite 表。
- 迁移方式：先包装 `logger`，把 `console.log` 分批替换（桥接/LLM/主动消息优先），不必一次改完。

### 8.3 `/health` 最小设计

```json
{
  "status": "ok",
  "uptime_s": 12345,
  "version": "0.1.0+<git>",
  "ws": { "connections": 1, "last_message_at": "2026-10-19T23:00:00+08:00" },
  "db": { "ok": true, "schema_version": 1, "size_mb": 2.1 },
  "llm": { "last_error_at": null, "last_ok_at": "..." },
  "jobs": { "pending": 0, "failed": 0 },
  "cost_today_cny": 0.31
}
```

- 监听 **127.0.0.1:18081**（与 Web 控制台同一个 Hono 应用也行），无需鉴权但**只绑回环**；若 Web 需要鉴权，则 `/health` 走同 token（或保留无鉴权但仅回环 + 不含敏感字段）。
- Dockerfile 的 `HEALTHCHECK` 从 TCP 探活改为 `wget/curl /health`；PM2 没有内置 healthcheck，可用外部 cron/脚本调 `/health` 并 `pm2 restart`（或直接交给 launchd/系统级重启）。

### 8.4 为什么不急 OTel / Sentry

- 单机 1–2 进程、无分布式调用，trace 的价值主要落在「一次消息处理」的 span 上——用 pino 的 `turn_id` + 各阶段耗时就能覆盖 90%。
- OTel JS 的稳定线是 `sdk-trace-node 2.12.0`，但 `sdk-node` 仍是 **0.223.0**（0.x experimental 版本线），instrumentation 生态版本碎；接入成本 > 当前收益。
- Sentry 会外发堆栈/上下文（可能含消息片段），与「数据本地」定位冲突；若需要，选**自托管 Sentry 或仅 error-level + 关闭 PII**，并写进隐私声明。
- 结论：**pino + /health + 每日成本** 三件套足够；等 Web 控制台稳定后再评估。

### 8.5 打包分发对比

| 方案 | 现状/版本（2026-10-19） | 适配度 | 结论 |
|---|---|---|---|
| **直接分发编译产物 + `node`** | 已有 `npm run build` | 最高（用户装 Node 22+ 即可） | **默认**（面向技术用户） |
| **Homebrew tap** | [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)；macOS 主流 | 高（macOS 一键装） | **值得做**（S） |
| **Windows zip + bat + PM2** | 已有 `scripts/*.bat` | 高 | **小改**（打包脚本） |
| **Docker 镜像** | 已有 Dockerfile（node:22-slim 多阶段、非 root） | 高（Linux/常开主机） | **保留**（可选 compose 同时跑 Karen+NapCat） |
| Node SEA | 官方 **Stability 1.1 - Active development**；`--build-sea` 在 v25.5.0 才内置 | 低（跨平台/签名/体积问题） | **不追** |
| pkg（vercel） | npm 最后版本 **5.8.1（2023-03-08）**；社区分支 `@yao-pkg/pkg 6.23.0` | 低（旧版无维护） | **不换** |
| Bun `--compile` | Bun 1.4.3（npm installer 版本） | 低（换运行时，`better-sqlite3`/`ws` 兼容需验证） | **不换** |
| Electron / Tauri | Electron 44.9.0 / Tauri 2.12.3（Tauri 3 alpha） | 低（体积/工具链/签名） | **不换**（除非桌面常驻是刚需） |

### 8.6 本节行动清单

1. pino 替换关键路径日志 + 脱敏 + 每日成本 rollup（S–M）。
2. `/health` 端点 + Dockerfile/PM2/launchd 接入（S）。
3. Homebrew tap（S）+ Windows 打包脚本（S）+ Docker 镜像保留（已有）。
4. 不接 OTel/Sentry、不做 SEA/pkg/Bun compile。

---

## 9. 测试

### 9.1 结论速览

| 项 | 现状 | 现代替代 | 成熟度 | 收益/成本/风险 | 结论 | 工作量 |
|---|---|---|---|---|---|---|
| 单元测试 | vitest 4.1.8，21 文件/330 用例 | **vitest 5.0.5**（2026-10-15；`engines` 要求 Node `^22.12 \|\| ^24 \|\| >=26`） | 高 | 升级风险低；获取新特性/性能 | **值得换（小）** | S |
| 集成测试 | 无（CI 只跑纯函数） | 复用 `scripts/mock-onebot.mjs` + 临时 `KAREN_DATA_DIR` + mock LLM | 高 | 覆盖「收→处理→发」链路，防回归 | **值得做** | S–M |
| 契约测试 | 无 | 「录制 NapCat 真实事件 + schema 校验」轻量契约；不必上 Pact | 高 | 防 NapCat/协议端升级破坏解析 | **值得做（轻量）** | S |
| E2E（浏览器） | 无 | Playwright 1.64.1（`engines node >=20`） | 高 | Web UI 上线后再上 | **等 Web UI** | M |
| 覆盖率 | 无 | `vitest --coverage`（v8） | 高 | 直观看到未测模块 | **值得加** | S |

### 9.2 vitest 升级注意

- 项目 `vitest ^4.1.8` → 最新 **5.0.5**（2026-10-15）。
- **注意 engines**：vitest 5 要求 `^22.12.0 || ^24.0.0 || >=26.0.0`；项目 `engines >=22` 的声明需要同步收紧（下界 22.12），否则 Node 22.0–22.11 用户装不上。
- 升级后跑 `npm run typecheck && npm test`，重点看 mock/定时器相关测试（fake timers API 在 major 版本间有变化）。

### 9.3 集成测试（最高性价比）

复用现有资产即可，**零新依赖**：

1. `KAREN_DATA_DIR=$(mktemp -d)` 启动 `src/bridge/qq.ts`（子进程）。
2. `scripts/mock-onebot.mjs` 发一条私聊 → 断言收到 `send_private_msg`（已有退出码语义）。
3. 新增用例：token 错误 401、path 错误 404、白名单外静默、`message_id` 去重、**消息门延迟 → 重启后补发**（配合 §7.3 的任务表）、LLM 失败兜底话术。
4. LLM 用本地 mock server（openai SDK `baseURL` 可覆盖）替代真实 Key，保证 CI 零成本。

### 9.4 契约测试：轻量做法即可

- **录制**：在真机上用 NapCat 跑 10–20 条真实事件（私聊/群聊/图片/语音/引用/表情/撤回），脱敏后存 `test/fixtures/onebot/*.json`。
- **断言**：`parseEvent`/`detectMedia` 对 fixtures 不崩、字段正确；出站 CQ 编码快照对比。
- **不推荐 Pact**：Pact 面向 HTTP 微服务消费者/提供者，OneBot 是 WS 协议且「提供者」是第三方 NapCat，无法在 CI 里当 provider 验证；录制回放 + schema 校验更实在。
- 方案成熟度：高；成本：S（1 天）。

### 9.5 Playwright 的时机

- 现在没有 Web UI → 不需要。
- Web 控制台 MVP 落地后：`playwright 1.64.1` 做 3 个 E2E（登录/token 校验、聊天页加载、健康页数据），M 工作量；不建议现在预研。

---

## 10. 分阶段路线建议（与本文件结论对齐）

> 说明：这是「基础设施/平台」视角的排序，AI/记忆类工作在 A 卷。

| 阶段 | 内容 | 包含项 | 预估 |
|---|---|---|---|
| **前置（必修）** | 依赖与启动方式 | better-sqlite3 13.0.3、vitest 5、Node engines 收紧、PM2 改跑 dist、Windows/macOS 双端验证 | 1–2 天 |
| **第 1 批（地基）** | 可观测 + 任务可靠性 | pino、/health、每日成本、`pending_jobs` 表 + 启动扫描、launchd/systemd | 3–5 天 |
| **第 2 批（可见性）** | Web 控制台 MVP + 宣传页 | Hono+HTMX 只读四视图、token、Tailscale 文档、静态宣传页 | 1–2 周 |
| **第 3 批（拟人感）** | 表情/贴纸 + 图片出站 | 入站 face/mface、出站 mface/贴纸库、Unsplash 接回 QQ | 3–5 天 |
| **第 4 批（扩展，可选）** | owner 隔离 → Web 入口 → Telegram 适配 | 多用户/多平台 | 2–3 周 |
| **第 5 批（可选）** | ASR；TTS 灰度 | silk-wasm + FunASR/云 ASR；cosyvoice-v3-flash 小流量 | 各 1–2 周 |
| **观察项** | Milky 协议、Drizzle 1.0、FLUX/Seedream 一致性方案、Node SEA | 不定 | — |

---

## 11. 迁移风险与回滚（必须提前接受的风险）

| # | 风险 | 具体表现 | 缓解 | 回滚 |
|---|---|---|---|---|
| 1 | **依赖大版本升级**（better-sqlite3 11→13、vitest 4→5） | Node 22/24 预编译 ABI 差异；Windows 需 C++ 编译链；vitest major 的 fake timers/API 变化导致测试失败 | 双端各跑一遍 `typecheck+test` + 一次 QQ 冒烟；升级前备份 `data/`；`PRAGMA user_version` 迁移保持幂等 | 保留旧 `package-lock.json` 分支/`git revert`；数据目录备份恢复 |
| 2 | **非官方 QQ 协议结构性风险** | QQ 客户端升级导致 NapCat 不兼容、账号被风控/封号、协议端项目停更 | 固定 NapCat/QQ 版本（先 NapCat 后 QQ 再升 QQ）；备用小号；保留 `mock-onebot` 联调；准备 LLOneBot 备用协议端 | 回退 QQ/NapCat 旧版本；用 mock/CLI/Web 入口继续开发 |
| 3 | **多平台/Web 放大「多用户隔离缺失」** | 会话按 persona 存、全局 `setCurrentPersona` 单例 → QQ/Web/Telegram 消息与记忆串数据 | **先做 owner（persona+user+platform）隔离**，再开第二个入口；Web 只读优先 | 关闭 Web/Telegram 入口；数据按 owner 分桶后可回退 |
| 4 | **Web UI 安全面** | token 泄露、CSRF、XSS（LLM 输出）、局域网暴露 | 默认 127.0.0.1；token+限流；Cookie 时 CSRF/SameSite/Origin；模板转义 + CSP；不映射 `data/` | 一键停 `karen serve`；轮换 token；删日志 |
| 5 | **语音/文生图的数据外发与伦理** | 语音送云 ASR/TTS、生成图被识别为 AI、克隆声音授权问题 | 默认关闭 + 明确开关；隐私声明如实更新；不克隆他人声音；生成图加标记/不用 | 关闭功能；删除音频/图片缓存 |

---

## 12. 来源与版本快照

### 12.1 版本快照（2026-10-19 查询，官方源）

| 组件 | 版本/状态 | 来源 |
|---|---|---|
| NapCatQQ | **v4.18.38**（2026-10-12 发布） | GitHub Releases API |
| NapCat 文档 | 最后编辑 ≈2026-10-17（访问 2026-10-19） | https://doc.napneko.icu/guide/boot/Shell |
| NapCat-Mac-Installer | 最后 push 2026-10-10 | GitHub API |
| LagrangeV2 | **archived=true**，最后 push 2026-07-23 | GitHub API |
| Lagrange.Core | 2,993 star，最后 push 2026-09-07；OneBot 11 支持已停维护 | GitHub API + Lagrange.Doc v2 |
| LLOneBot / LuckyLilliaBot | 3,675 star，最后 push 2026-10-19；支持 OneBot 11 / Satori / Milky | GitHub API |
| OneBot 规范 | 最后 push 2023-07-06；生态页版权止于 2024 | GitHub API + onebot.dev |
| Milky 协议 | v1.3.0（2026-08-07） | milky.ntqqrev.org/changelog |
| Telegram Bot API | 10.0（2026-05-08）→ **10.3（2026-08-24）**（社区汇总，官方 changelog 待核实） | Conferbot 汇总（2026-10-06） |
| QQ 官方机器人 API v2 | 文档更新 2026-09-17；`api.bot.qq.com` | bot.q.qq.com/wiki |
| better-sqlite3 | **13.0.3**（2026-08-05；engines node>=22） | npm registry |
| drizzle-orm | **0.45.4**（未到 1.0） | npm registry |
| prisma / @prisma/client | 8.0.0-rc.23 / **7.10.1** | npm registry |
| bullmq | 6.3.17（依赖 Redis） | npm registry |
| pg-boss | 12.38.0（依赖 Postgres） | npm registry |
| croner | 10.0.1 | npm registry |
| node-cron | 4.6.0（项目 `^3` 且 0 引用） | npm registry |
| pm2 | **7.0.4**（2026-08-24） | npm registry |
| pino | **10.4.0**（2026-10-02） | npm registry |
| @sentry/node | 11.8.0 | npm registry |
| @opentelemetry/sdk-trace-node | 2.12.0（稳定线） | npm registry |
| @opentelemetry/sdk-node | 0.223.0（0.x experimental 线） | npm registry |
| vitest | **5.0.5**（2026-10-15；engines `^22.12\|\|^24\|\|>=26`） | npm registry |
| playwright | 1.64.1 | npm registry |
| next | 16.4.2（2026-10-15） | npm registry |
| @sveltejs/kit | 3.1.0 | npm registry |
| hono / @hono/node-server | 4.13.13 / 2.1.5 | npm registry |
| htmx.org | 2.0.11 | npm registry |
| @tauri-apps/cli | 2.12.3（Tauri 3 处于 alpha） | npm registry + GitHub Releases |
| electron | 44.9.0 | npm registry |
| bun | 1.4.3（npm 安装器版本） | npm registry |
| pkg (vercel) | 5.8.1（2023-03-08 后无新版） | npm registry |
| @yao-pkg/pkg | 6.23.0 | npm registry |
| silk-wasm | 3.7.1 | npm registry |
| Node.js | 24.22.0 LTS（2026-10-14）；SEA 文档标 Stability 1.1 | nodejs.org/dist/index.json + nodejs.org/api/single-executable-applications.html |
| GPT-SoVITS | 63,192 star；最新 Release `20250606v2pro`（2025-06-06）；最后 push 2026-10-19 | GitHub API |
| IndexTTS | **v2.5.0（2026-08-13）**；24,584 star | GitHub API |
| CosyVoice 开源 | 仓库迁至 QwenAudio/CosyVoice，24,050 star，最后 push 2026-05-25 | GitHub API |
| fish-speech | 33,290 star；最新 Release v1.5.1（2025-05-31）；最后 push 2026-10-14 | GitHub API |
| 阿里 cosyvoice-v3-flash | $0.14335/万字符（北京）；实时流式；5–20s 克隆；RPM 180；文档更新 2026-10-11 | alibabacloud.com 百炼文档 |
| ElevenLabs | **$0.08 / 1K characters**（价格页 2026-10-19；档位对应模型待核实） | elevenlabs.io/pricing/api |
| Fish Audio / Kitta Audio | 品牌已更名 Kitta Audio；模型 s2.1-pro / s2.1-pro-flash / s2；Realtime TTS v3 WebSocket；价格待核实 | docs.fishaudio.org |
| GIPHY | Beta key：100 req/h、50 results/req；Production key 需审核、价格不公开 | API Evangelist 资料（generated/unverified，待核实官方） |
| FunASR | v1.4.16（2026-09-18） | GitHub Releases API |
| Whisper / faster-whisper | whisper v20250625（2025-06-26）/ faster-whisper v1.2.1（2025-10-31） | GitHub Releases API |
| FLUX | FLUX.2 文档在线；FLUX 3 Image Klein（open weights）入口已出现 | docs.bfl.ml/flux_2/flux2_overview |
| ComfyUI | 发布流活跃（2026-10-18） | GitHub releases feed |

### 12.2 来源清单（按主题，全部于 2026-10-19 访问）

**QQ / IM 桥接**
- [NapCatQQ Releases（v4.18.38）](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38) — 2026-10-12
- [NapCat Shell 文档（macOS/Linux/Docker/AppImage）](https://doc.napneko.icu/guide/boot/Shell) — 页面最后编辑 ≈2026-10-17
- [NapCat 消息段文档（record/图片/CQ）](https://doc.napneko.icu/onebot/segment)
- [NapCat 高级配置（macOS FFmpeg 旧口径）](https://doc.napneko.icu/config/advanced) — 约 6 个月未更新
- [NapCat-Docker README](https://github.com/NapNeko/NapCat-Docker)
- [Lagrange.Doc v2（OneBot 11 停止维护 → Milky）](https://lagrangedev.github.io/Lagrange.Doc/v2/)
- [Milky 协议 changelog（1.3.0，2026-08-07）](https://milky.ntqqrev.org/changelog)
- [OneBot 生态页](https://onebot.dev/ecosystem)
- [Telegram Bot API 10 汇总（Conferbot，2026-10-06）](https://www.conferbot.com/blog/telegram-bot-api-10)（官方 changelog：[core.telegram.org/bots/api-changelog](https://core.telegram.org/bots/api-changelog)，待核实）
- [QQ 官方机器人 API v2 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html) — 文档更新 2026-09-17

**语音 / 多模态**
- [阿里云百炼 cosyvoice-v3-flash](https://www.alibabacloud.com/help/zh/model-studio/cosyvoice-v3-flash) — 文档更新 2026-10-11
- [ElevenLabs API 定价](https://elevenlabs.io/pricing/api)
- [Fish Audio（Kitta Audio）文档](https://docs.fishaudio.org/)
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
- [IndexTTS](https://github.com/index-tts/index-tts)；IndexTTS2 论文 [AAAI-40](https://ojs.aaai.org/index.php/AAAI/article/view/40820)
- [CosyVoice（QwenAudio）](https://github.com/QwenAudio/CosyVoice)
- [FunASR](https://github.com/modelscope/FunASR)；[faster-whisper](https://github.com/SYSTRAN/faster-whisper)；[Whisper](https://github.com/openai/whisper)
- [silk-wasm（npm）](https://www.npmjs.com/package/silk-wasm)
- [FLUX.2 文档](https://docs.bfl.ml/flux_2/flux2_overview)；[ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [Seedream 5.0 Pro 实测（36kr，2026）](https://36kr.com/p/3887236673485574)
- GIPHY：https://developers.giphy.com/ ；价格资料（未核实）https://raw.githubusercontent.com/api-evangelist/giphy/refs/heads/main/plans/giphy-plans-pricing.yml

**前端 / 数据 / 基础设施 / 测试**
- Next.js / SvelteKit / Hono / HTMX / Tauri / Electron 版本：npm registry（2026-10-19）
- [Tauri Security](https://v2.tauri.app/security/)
- [OWASP CSRF 防护速查表](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Docker Compose 启动顺序/健康检查](https://docs.docker.com/compose/how-tos/startup-order/)
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Node.js SEA 文档（Stability 1.1）](https://nodejs.org/api/single-executable-applications.html)
- [PM2 应用声明文档](https://pm2.keymetrics.io/docs/usage/application-declaration/)
- systemd：https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html ；launchd：`man launchd.plist`
- npm registry：`registry.npmjs.org/<pkg>/latest`（版本 + `time` 发布日期）

### 12.3 待核实清单（发布/采购/上线前必须复核）

1. **macOS 语音能力**：NapCat 两处官方文档对「macOS 是否支持 FFmpeg 音视频处理」口径冲突（Shell 新文档 vs 高级配置旧文档）→ 真机发/收语音实测后再承诺 TTS/ASR。
2. **NapCat Docker 镜像 tag**：`mlikiowa/napcat-docker:v4.18.38` 是否已推送（`docker manifest inspect`）；不要长期用 `latest`。
3. **Telegram Bot API 最新版本细节**：官方 changelog 直连失败，10.3 来自社区汇总；上线前以官方 changelog 为准（尤其 `sendRichMessageDraft` 的可用性/限频）。
4. **Discord API 版本**：v10/Gateway v10 为当前稳定线，2026 年变更多为行为调整；接入前查官方 changelog。
5. **火山引擎/豆包语音价格**：计费页 2026-09-29 更新但页面 JS 渲染，具体单价需登录控制台确认。
6. **Fish Audio(Kitta) 价格与中文能力**：价格页 JS 渲染；S2 中文效果需试听验证。
7. **ElevenLabs 档位对应关系**：$0.08/1K chars 对应哪个模型（v4/Flash/Turbo）需在控制台确认。
8. **本地 TTS/ASR 在 Apple Silicon 的实际延迟**：GPT-SoVITS/IndexTTS/FunASR 在 M 系列的 RTF、内存占用需实测（本文延迟均为估算）。
9. **NapCat `mface`（收藏表情）CQ 字段与发送限制**：QQ 商城表情/收藏表情的发送格式在不同版本存在差异。
10. **QQ 图片/语音大小上限**：NapCat/QQ 对单图/语音时长/大小的实际限制需真机验证。
11. **better-sqlite3 13.x 的 Windows 预编译与 Node 24 ABI**：升级前在 Windows 机器上验证 `npm ci` 是否走预编译（避免要求用户装 VS Build Tools）。
12. **`SQLite 任务表 + tick` 在高负载下的写锁**：单机低吞吐无问题；若未来多进程访问同一 DB，需要改为 WAL + busy_timeout 验证（当前已有 `busy_timeout=5000`）。
13. **GPT-SoVITS / IndexTTS / CosyVoice 的模型与权重许可证**：用于虚拟人语音（尤其公开发布/演示）前核对 license（代码/权重可能不同条款）。
14. **Node 22 的 EOL 与 engines 下界**：若升级 vitest 5，`engines` 需收紧到 `>=22.12`；Node 22 维护期与 Node 24 LTS 时间表以官方 release schedule 为准。

---

## 附录 A：本文件与仓库其它文档的关系

| 文档 | 关系 |
|---|---|
| `docs/PRODUCT_AUDIT.md` | 功能/质量现状的单一事实源；本文不重复其逐项清单，只给技术选型 |
| `docs/QQ_BRIDGE_CROSS_PLATFORM.md` | QQ 桥接部署细节（macOS/Windows/Linux、SSH 隧道、mock 联调）；本文在其基础上补 2026 生态变化与迁移判断 |
| `docs/DEEPSEEK_CAPABILITY_AUDIT.md` | LLM/视觉/缓存/成本基线；本文的 TTS/ASR 成本对比以其文本成本为参照 |
| `CLAUDE.md` | 阶段纪律（M0 已固化、M1 核心体验、M2 产品化）；本文建议的排期与 M2 的 Web/多模态/工程化对应，但**基础设施项建议提前** |

## 附录 B：一句话结论

> **桥接不动、生态别追；先补可观测与任务可靠性，再做 Web 可见性，最后才是语音与多平台。** 2026 年真正变了的不是「要不要换 QQ 协议端」，而是「官方 IM Bot（Telegram）已经足够好到可以当第二入口」——但对单人项目，先把自有 Web 入口和贴纸/表情做出「像人」的感知，收益远高于追新协议或上本地大模型语音。
