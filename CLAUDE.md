# karen-persona 项目总控

> 最后更新：2026-10-20（M2 产品化与发布准备阶段）
>
> **单一事实源**：功能现状与路线图以 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) 为准；对外表述以 [README.md](README.md) 为准。
> 原则：**宁少说，不夸大**。文档里的每个功能宣称都必须能在代码中找到对应；不确定的写成「半成品 / 规划中」，绝不把设计目标写成已实现。

## 项目概述

QQ 里的 AI 虚拟人。定位是「通讯录里住进一个有自己生活、情绪、记忆和社交圈的人」，而不是一个问答助手。

当前阶段：**M2 产品化收尾 + 发布准备（2026-10）**。M0 地基已修复完成（新装可用、不丢消息、安全加固、文档真话）；M1 核心体验闭环主要项已完成（状态持久化、关系成长、演化可见化、多用户隔离、双管线对齐、检索增强）；M2-A 首次引导 2.0、M2-B 人设包 v2、M2-C 多用户只读 Web + 导出、M2-D 真实长跑工具已实施；发布检查见 [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md)（未 push/tag）。M1/M2 路线见审计报告第 5 节。

## 技术栈（如实）

- **运行时**：Node.js 22.12+（`engines: >=22.12`；better-sqlite3 13 用 N-API 预编译）、TypeScript 5.6（strict，NodeNext）、tsx 直跑 TS、vitest 4（vitest 5 暂缓）
- **对话模型**：DeepSeek V4.1 `deepseek-flash` / `deepseek-v4-pro`，按复杂度规则路由（真实主路径；`deepseek-v4-flash` 是仍可调用的旧别名）
- **图片识别**：DeepSeek Flash 多模态（真实，用同一个 DEEPSEEK_API_KEY；先下载图片转 base64，兼容 NapCat 私有 URL；`detail=high`，截图逐字转述 ≤200 字）
- **思考模式**：默认关闭（`thinking:{type:"disabled"}`）；不关闭时 reasoning 会吃掉 max_tokens 导致空回复（2026-10 实测修复）
- **语义嵌入**：Qwen `text-embedding-v3` 已接入写入/检索（双列不混比）；**需配置 Qwen Key 才启用**，无 Key 自动降级为字符 n-gram + FTS5 BM25 混合；**检索层默认加一次 DeepSeek 候选重排**（非真向量，可 `KAREN_SEMANTIC_BOOST=off` 关闭）
- **向量库**：`sqlite-vec` 已启用（`t2_vec`：cosine + persona/source/model metadata），并与 FTS5 中文 BM25 做 RRF 混合检索；JSON n-gram 作为降级路径
- **存储**：better-sqlite3 13.0.3（T1/T2 记忆，内置跨平台预编译）+ 会话 JSON + 人设 JSON/YAML
- **外部世界**：OpenWeatherMap（真实天气，可选）、时间感知（结构化标签）；网络热点是硬编码话题池
- **桥接**：NapCatQQ（Windows 已验证 v4.18.4，官方最新 v4.18.38）+ OneBot 11 反向 WebSocket；macOS 原生 NapCat / Linux Docker 方案见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md)；微信桥接 = 无依赖占位桩（不在近期路线图）
- **工程**：GitHub Actions CI（ubuntu/macOS/Windows 三平台矩阵：`npm ci` → typecheck → lint → test；Linux 额外覆盖率基线）、`npm run doctor` 环境体检、结构化日志 + `/health` + 成本统计、Dockerfile（node:22-slim/非 root）、PM2（跑 dist 需先 build）
- **不存在的**：TTS、图片生成（即梦）；语义检索需 Qwen Key；Web 控制台为只读 MVP

## 架构（十个域）与当前状态

图例：✅ 主路径可用 ｜ 🚧 半成品/有限 ｜ 🗺 规划中/未实现

| # | 域 | 状态 | 现状与证据 |
|---|---|---|---|
| 1 | 消息桥接 `src/bridge` | ✅/🚧 | QQ 私聊流式回复可用（`qq.ts`）；群聊仅 @ + 私聊过的人（半成品）；M0 已加固：默认监听 `127.0.0.1`、token/path 校验、`ALLOWED_USERS` 白名单、CQ 注入转义与超长切分、message_id 去重、延迟回复落库补发、进程级异常兜底；`scripts/mock-onebot.mjs` 支持无 QQ 端到端联调，且 CI 有 mock-OneBot 桥接 E2E（docs/QQ_E2E_TEST.md）；Windows/macOS 均已实机验证（macOS 原生 NapCat + 反向 WS）；微信仅无依赖占位 🗺 |
| 2 | 消息路由 `src/router` | 💀/🚧 | `router/classifier.ts`、`router/session.ts` 未被主路径引用（死代码）；实际合并窗口在 `bridge/qq.ts`、复杂度分级在 `ai/router.ts` |
| 3 | 响应管线 `src/pipeline` | ✅/🚧 | 双管线：`processMessage`（完整，CLI/群聊）/ `processMessageStream`（QQ 私聊）。M1 已**行为对齐**：流式路径补齐因果链闯入/漂移、叙事弧线、纠正层、L1 裁决/EMA、动态风格参考、热点、T1 快照、因果链回响、herView 更新、门控记录等；两份实现仍并存（后续可抽取共享 helper） |
| 4 | 人设引擎 `src/persona` | 🚧 | 六层 schema、校验器、Prompt 静态缓存 + 动态组装可用；未消费字段多（审计 2.3）；负债偿还、纠正层、社交分寸未闭环 |
| 5 | 演化引擎 `src/evolution` | 🚧 | 基线漂移/因果链/叙事重构/进化日志代码存在，但多数未接 QQ 主路径、状态不持久化（重启归零） |
| 6 | 冲动引擎 `src/impulse` | 🚧 | 消息门可用；延迟回复已在 M0 落库+补发；沉默弧线/tone 链/撤回仅有限生效 |
| 7 | 外部世界 `src/world` | ✅/🚧 | 天气 API（M0 已修复中英文 condition 映射与缓存）与时间感知可用；热点为硬编码话题池；信息圈层穿透是死代码 |
| 8 | AI 引擎 `src/ai` | ✅/🚧 | DeepSeek 非流式/流式、复杂度路由、Flash 多模态视觉可用；M0 已加固超时/429/5xx 指数退避重试/usage 记录；M1 关闭思考模式（修复空回复）、模型名 canonical、旁路 LLM 调用统一 thinking 参数；语义嵌入已接线（双列，需 Qwen Key 实跑）；TTS/即梦 🗺 |
| 9 | 记忆与数据 `src/data` | ✅/🚧 | SQLite 存储 + 艾宾浩斯衰减可用；M1 完成检索 P0：**n-gram + FTS5 BM25 混合检索（RRF，FTS5 用 OR+BM25 IDF）→ DeepSeek 候选重排**（默认开启，非真向量；异常/超时降级）、sqlite-vec 启用、双列 embedding、schema v2/v3 幂等迁移、用户事实层、T1 状态弧、T3 压缩（40 条/隔天兜底 + `t3_compressed` 防重复）；**语义 embedding 代码就绪但需 Qwen Key 才能实跑**（无 Key 自动降级）；延迟补发队列已持久化；**多用户隔离已实现**（owner=人设+用户+平台） |
| 10 | 质量评估 `src/eval` + 测试 | ✅/🚧 | 68 个测试文件 / 683 个用例通过（M0/M1 新增 data/pipeline/bridge/weather/relationship/state/journal/ai/记忆评测测试），`tsc --noEmit` 0 错误，CI 已接入（typecheck/lint/test/覆盖率）；**新增 mock-OneBot 桥接端到端测试**（真实 bridge 子进程 + fake NapCat/DeepSeek，覆盖披露/年龄门/私聊/图片/群聊/命令/危机/多用户隔离，见 [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md)）、可复现记忆金标集（20 条 case，`scripts/memory-eval.ts --offline`，报告 [docs/MEMORY_EVAL_REPORT.md](docs/MEMORY_EVAL_REPORT.md)）与跨轮重复 A/B（`src/eval/repetition-eval.ts`）；真实 QQ/NapCat 端到端仍需真机；历史对外指标（99/100、Recall 99.4% 等）**不可复现，禁止再引用** |

## 启动与开发命令

```bash
npm run doctor     # 环境体检（先跑绿）
npm run dev        # CLI 模式（不连 QQ）
npm run qq         # QQ 桥接模式（NapCatQQ 反向 WS，默认端口 18080）
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run setup      # 交互式配置向导
```

配置：`.env`（Key/桥接参数，从 `.env.example` 复制）、`config.yaml`（人设/称呼/位置，从 `config.yaml.example` 复制）；运行时数据在 `data/`（可被 `KAREN_DATA_DIR` 覆盖）。

## 当前进度（2026-10）

### M0 落地内容（2026-10 本阶段）

- **文档真话 pass**：README/QUICKSTART 按实际代码重写；隐私声明修正为「数据本地存储，但对话与图片会发给 DeepSeek（M1 起图片也走 DeepSeek Flash）」；删除「数据不上传」「语义嵌入主路径」「sqlite-vec 检索」「延迟回复已实现」「不同好友不同人设已生效」「133 tests」等不实/过时表述
- **许可证**：新增 MIT `LICENSE`（© 2026 QIU0826）
- **工程化**：`.github/workflows/ci.yml`（Node 22 + ubuntu/macOS/Windows 三平台矩阵 + `npm ci` + typecheck + test）、`.dockerignore`、Dockerfile 改为 node:22-slim / Asia/Shanghai / 非 root、`ecosystem.config.js` 补 `cwd` 与启动方式说明
- **开发者体验**：新增 `npm run doctor`（Node/config/Key/人设/数据目录/SQLite 六项检查 + 修复建议）；`engines` 已收紧为 `>=22.12`
- **地基修复（M0-1/2/3）**：数据目录自动创建与 embedding 列迁移、`KAREN_DATA_DIR`；`loadConfig` 返回并校验 `user_personas` / `one_bot_*` / `allowed_users`，端口统一 18080；消息门延迟消息落库与到点补发（新消息取消待补发）、连续沉默 3 次强制回复；主动消息单日上限 4 条 + 最小间隔 30 分钟；LLM 显式超时 + 仅 429/5xx 指数退避重试 + usage 记录；天气中英文映射与 30 分钟缓存；WS 默认回环 + token/path 校验 + 白名单 + CQ 转义 + 去重 + 异常兜底
- **验证**：`npm run typecheck` 0 错误；`npm run lint` 0 违规；`npm test` 68 文件 / 683 用例通过（审计基线为 11 文件 / 178 用例）

### M1 落地内容（2026-10 进行中）

- **M1-1 状态持久化**：新增 `src/data/state-store.ts`（`persona-state-<persona>.json`，原子写 + 容错归一化）。情绪/负债/基线漂移/沉默状态/因果链/叙事弧/herView/主动消息计数/天气快照/关系状态在重启后恢复；两个管线与主动消息都会落盘；端到端实测重启后亲密度/情绪/事件保持。
- **M1-2 关系成长**：新增 `src/persona/relationship.ts`。亲密度由结构性事件驱动（深度对话、连续互动、主动分享生活细节），每日上限 +0.1、只增不减、带 reason 与里程碑（开始熟络/开始在意/很亲近/重要的人）；运行时同步到 `persona.relationship.closeness`（门控/发图/herView 等立即生效）；`/stats` 展示亲密度、连续互动、关系事件与里程碑。
- **M1-3 演化可见化**：新增 `src/evolution/journal-view.ts` + CLI 命令 `/journal`（她的独白/进化日志/T3 摘要）、`/timeline`（关系事件与里程碑）、`/herview`（她眼中的你）、`/evolution`（心理阶段/漂移/情绪/关系）。数据来自持久化快照与 T2，重启后可见。
- **DeepSeek 能力落地**：思考模式默认关闭（修复「空回复/半句话」生产 bug，实测 reasoning=0）；模型名 canonical；图片识别从 Qwen-VL 切换到 DeepSeek Flash（同一个 Key、先下载转 base64 兼容 NapCat 私有 URL、`detail=low`）；旁路 LLM 调用（独白/T3/日志/herView/发图 query）统一注入 thinking 参数；prompt 缓存可命中（静态人设前缀）。
- **端到端实测（真实 Key + 真实 QQ）**：NapCat 原生 macOS → Karen → DeepSeek 全链路跑通；首 token 0.4–1.2s，prompt 缓存命中 1024–1536 tokens/轮；图片识别（DeepSeek Flash 多模态）实测成功；亲密度/情绪/独白真实运转。
- **M1-4 免打扰可配置**：`quiet_hours_start/end`（默认 23:00–07:00，支持 "23:30"；start==end 关闭），消息门按配置延迟并给出剩余时长；真机测试期间临时设为 02:00–07:00。
- **边界与修复动力学（BUG-1 修复）**：新增 `src/persona/boundary.ts`（越界内容粗筛 + 道歉识别）；关系事件增加「越界→轻微降温/记录冲突」「道歉→24h 内修复」；`buildConflictNote` 把未化解冲突注入下一轮 prompt；「分享生活」规则要求真实自我/生活信号，避免纯话题切换涨亲密。
- **BUG-2 延迟补发持久化**：新增 `src/data/pending-queue.ts`（SQLite 队列；失败 60s×attempts 退避）；桥接在 NapCat 重连后自动恢复并补发，退出只清 timer 保留记录；实测「预置 10s 后到期 → 重启桥接 → 到点补发成功」。
- **IMP-1 图片描述增强**：视觉改用 `detail:"high"`（low 下截图 OCR 失真），prompt 区分类型：截图/文字类逐字转述（≤200 字），照片/插画 40–80 字；max_tokens 600。真实中文会议截图 OCR 实测四行原文全部正确。
- **M1-7 记忆检索 P0**：`src/data/embedding.ts` 统一 embedder（Qwen text-embedding-v3 + ngram 降级，修 768 截断 bug）；`vector.ts` schema v2（embedding_model/semantic_embedding/semantic_model、FTS5 中文 BM25、sqlite-vec vec0 cosine + metadata）；`retriever.ts` RRF 混合 + 阈值/去重/source 过滤 + confidence 修正；orchestrator 仅 2 处改 async 检索。真实库 22 条记忆迁移验证通过（v2、FTS 22 行、幂等）。
- **步骤 3 可观测最小闭环（2026-10-20 凌晨）**：零新依赖新增 `src/obs/`——结构化脱敏日志（非 TTY JSON lines / TTY 可读，敏感字段 `[redacted N chars]`）、SQLite `llm_usage` 成本统计（DeepSeek 峰谷价/缓存命中/flash-pro）、`GET /health` + `/cost`（仅绑 127.0.0.1，默认 18081，可配 0=关）、PM2 改跑 `dist/bridge/qq.js`。实测 `/health` 200、`/cost` 单次调用成本 ¥0.000033 正确入账。
- **步骤 4 表情/贴纸（2026-10-20 凌晨）**：入站 face/mface 不再丢弃，转成 `[表情：微笑]`/`[表情包：...]` 交给管线；新增 `src/impulse/stickers.ts` + `assets/stickers/`（11 个 Twemoji，CC-BY 4.0）：文字回复后按情绪/时段以 22% 概率顺手发本地贴纸（收到对方表情时 55%），5 分钟冷却，冲突未化解不发；CQ 白名单仅放行内部 base64 图片；私聊生效，群聊暂不支持。
- **步骤 5 本地 Web 控制台（2026-10-20 凌晨）**：新增 `src/web/`（node:http，零新依赖）：单页只读四视图（聊天/记忆搜索+列表/关系时间线+herView/状态+健康+成本），深色移动端适配、5s 自动刷新可暂停；仅绑 127.0.0.1，默认 `web_port: 18082`，可选 `web_token`（`?token=` 或 `X-Web-Token`），CSP/no-store/HTML 转义；API：`/api/overview|session|memory|timeline|health|cost`。实测页面 200、API 正常。
- **主动发图接通 QQ（2026-10-20）**：`photoShare` 在流式路径也触发；有 `UNSPLASH_ACCESS_KEY` 走 Unsplash 搜索，无 Key 回退**本地 7 张授权图库**（`assets/photos`，Picsum/Unsplash License）；桥接下载/读文件转 base64 发送 CQ image；修掉「qqFace 后 break 导致发图 fragment 被丢弃」的 bug；测试期 config 可覆盖门槛/概率/冷却（`photo_share_*`），实测 E2E 收到配文+图片。
- **发图时间关系模型（2026-10-20）**：照片不再按小时硬过滤；每张图带场景与「今天/昨天/以前」时间关系——早上可以发「昨天的晚霞」，亲密度 ≥4 才会分享「以前的生活」（`minCloseness` 可配）；配文按时间关系生成，避免「早上 10 点说今天的晚霞」这类错乱。
- **0 号依赖升级（2026-10-20 凌晨）**：`better-sqlite3` 11.10 → **13.0.3**（改为内置 N-API 预编译，`npm install` 不再需要 C++ 构建工具，Windows/macOS 安装风险大幅下降）；`engines` 收紧 `>=22.12`；移除未使用的 `wechaty`（微信 echo 桩改为无依赖占位）与 `node-cron`（死依赖），依赖树从 ~446 个包降到 ~162 个；CI 改为 ubuntu/macOS/Windows 三平台矩阵；Node 22 下 `tsc` 0 错误、462 用例全绿、桥接/健康/Web 实测正常。**vitest 5 暂缓**（其依赖树引入 rolldown 平台包，安装解析过慢，后续单独升级）。
- **M1 治理与数据主权（2026-10-20 凌晨）**：新增 `src/commands/control.ts`（QQ/CLI 共用 `/why` 门控可解释、`/pause`/`/resume` 主动消息暂停、`/export` 记忆导出、`/stats`、`/help`）；`lastGate` 与 `proactivePaused` 写入持久化状态；心跳跳过暂停用户；新增 `src/data/user-export.ts` 导出会话+人格状态+T2 记忆为本地 JSON（600 权限）。测试 37 文件 / 471 用例全绿。
- **合规最小版（2026-10-20 上午）**：新增 `src/persona/disclosure.ts`（首次对话 AI 披露：AI 身份/数据去向/18+；`/about` 详细说明）与 `src/safety/crisis.ts`（危机信号兜底：命中后**强制回复** + prompt 安全指引 + 程序追加专业求助资源 12356/010-82951332/110/120；关键词只做安全兜底，不做情感识别）；`ai_disclosure` 配置默认开启；桥接与 CLI 均接入。E2E 实测：新用户收到披露；发送危机表达后收到关心式回复 + 求助资源。
- **多用户隔离（2026-10-20 上午）**：新增 `src/data/owner.ts`——owner = `qq:<id>` / `cli:local`；主用户（白名单第一个 QQ）与 CLI 沿用历史 session/state/T2（旧数据零迁移即归属主用户），其他用户使用 `-<ownerSlug>` 后缀的会话/状态文件、T2/T1 persona_id 带 `@ownerSlug` 后缀（检索天然隔离）；每轮处理前显式切回本 state 的存储 persona，防止多用户交替串记忆。E2E：两个测试用户各自收到披露、会话文件/人格状态/T2 记忆完全隔离。
- **双管线对齐（2026-10-20 上午）**：QQ 私聊流式主路径补齐完整管线的状态演化步骤——因果链闯入/漂移、自我叙事弧线注入、纠正层、L1 弹性裁决/EMA 内心状态、动态风格参考、热点注入、T1 人格快照、因果链回响、纠正记录、herView 异步更新、`lastGate` 门控记录；冒烟实测流式回复正常且 T1/T2/成本数据落库。两份实现仍并存，后续可抽取共享 helper。
- **宣传页（2026-10-20）**：`promo/index.html`（单文件、零构建、响应式）：首屏角色短视频 hero（桌面鼠标左右 scrub + 移动端交替自动播放，失败/减少动态时回退角色图）、黑色画廊面板（10 图错落布局、卡片随滚动缩放）＋ 白场 CTA；品牌/文案/图库/角色素材集中在 `CONFIG`，`/promo/` 由本机 Web 服务提供（含路径穿越防护）。角色素材由用户提供（AI 生成），已裁切去水印并去音轨（视频 720×840、图片 1535×2412），说明见 `promo/README.md`。测试 +1（宣传页路由/素材/穿越防护）。
- **用户事实记忆 + 去 AI 味（2026-10-20）**：新增 `src/data/user-facts.ts`——后台 LLM 抽取「对方明确说过的稳定事实」（名字/城市/工作/项目/宠物/偏好/计划），SQLite `user_facts` 按 owner 隔离，每轮注入「你确定记得的关于对方的事」，解决 T2 检索漏召/自我强化遗忘；prompt 增加反套话、反「考我/抽查」、反编造往事、限制自我分析、禁逗号结尾规则；burst/流式分条去掉尾部软标点并压缩空行，删除重复的 shortTermContext 注入；实测「5 轮前的项目」从答不出变为答对。详见 [docs/MEMORY_AI_TONE_AUDIT.md](docs/MEMORY_AI_TONE_AUDIT.md)。
- **记忆评测 + 反重复 + 检索修复（2026-10-20）**：新增 `src/eval/memory-gold.json`（20 条中文金标集）+ `src/eval/memory-eval.ts` + `scripts/memory-eval.ts`（离线 recall@k / facts 命中 / anti-forget；`--live` 真实模型验证，报告 [docs/MEMORY_EVAL_REPORT.md](docs/MEMORY_EVAL_REPORT.md)）；新增 `src/persona/anti-repetition.ts` 跨轮反重复（默认 openers 模式，A/B 脚本 `src/eval/repetition-eval.ts`；**实测回放整句反而诱发模型照抄，故默认只注入开头词**）；修复 `searchEpisodesByFts` FTS5 查询隐式 AND 导致自然问句 0 命中（改 OR + BM25 IDF，T2 recall@8 40%→85%）；补上流式（QQ 私聊）路径此前遗漏的用户事实注入；Web 控制台新增「用户事实」「记忆命中回放」两个只读面板（`/api/facts`、`/api/memory-probe`）。测试 46 文件 / 540 用例。
- **T1 状态弧 + T3 压缩调参（2026-10-20）**：新增 `src/data/t1-injection.ts`——T1 快照每轮写入但此前完全没进 prompt；现把最近 8 条压成「最近几轮的状态」（亲密度/情绪/负债趋势，不引用对话正文），reply/stream/proactive 三条路径注入；T3 压缩阈值 80→40，新增「≥20 条且距上次摘要 ≥1 天」时间兜底 + `KAREN_T3_DRY_RUN=1` 干跑；真实数据跑通一次（40 条旧片段 → 1 条摘要，线上 t3_summary 从 0 → 1）。测试 49 文件 / 560 用例。
- **检索增强：DeepSeek 候选重排（2026-10-20）**：DeepSeek 无 embeddings 接口，先用现有 Key 做文本层增强——`src/data/retrieval-boost.ts` 对初步召回的 top12 记忆做一次 Flash 相关性重排（默认开启，失败/超时/关闭开关自动降级原顺序；开关 `KAREN_SEMANTIC_BOOST=off`）。20 条金标实测 T2 recall@1/3/8 = 55%/80%/85% → **95%/95%/95%**；平均 ~664ms、~¥0.00025/轮。查询改写无额外收益反而降精度（不采用）。报告 [docs/SEMANTIC_BOOST_EVAL.md](docs/SEMANTIC_BOOST_EVAL.md)；真语义向量（Qwen/本地 embedding）仍可选。
- **记忆时间感 + 事实变更历史（2026-10-20）**：新增 `src/data/relative-time.ts`，T2 检索结果带 `createdAt/timeLabel`，RAG 注入 `- [3天前] …`（她才能自然说「你上次/三天前说」；Web 记忆命中回放同步显示时间徽标）；`user_facts` 新增 `user_fact_history`——换工作/换城市等值变化保留旧值（每 key 20 条），最近 180 天变更注入显示「（之前是：X）」；修掉评测同进程切库时 user_facts 建表缓存导致的缺表问题（缓存按 DB 路径）。测试 50 文件 / 569 用例。
- **句式复读提醒（2026-10-20）**：`anti-repetition.ts` 增加套话句式统计（是不是/要不要/有没有/我跟你说/其实/确实/哈哈/早点/别太），最近 3 条里同句式 ≥2 次就在提示里点名「换成陈述句或别的问法」。9 次真实 A/B 未测出稳定效果（小样本噪声大），仅作低成本提示保留、不算卖点；同时确认 openers 模式 9 次运行零复读对、full 模式 2/9 次出现复读，默认维持 openers。测试 50 文件 / 572 用例。
- **T3 摘要质量 + facts 上限（2026-10-20）**：T3 压缩 prompt 加固（保留具体事实/未完成话题/禁止编造片段外内容），`buildT3SummaryPrompts` 纯函数 + 单测；40 条临时数据真实压缩抽检：3 句、人名/公司/项目/宠物/偏好/未完成计划全部保留、无编造。`selectFactsForPrompt` 改为分类配额 + 时间回填（profile4/work3/pet3/relationship3/plan3/preference2/other2），29 条事实压测注入 20 行、核心分类不被挤掉。测试 50 文件 / 576 用例。
- **群聊贴纸/发图（2026-10-20）**：新增 `src/bridge/group-reply.ts` 出站计划（纯函数+单测）：群聊回复 = 文字气泡 → QQ 表情 →（可选）照片；群聊也接本地贴纸（收到表情更愿意回，按「群+人」5 分钟冷却）；生活照默认不发群，`group_photo_enabled: true` 才开（config.yaml 或 `GROUP_PHOTO=true`）；`processMessage` 新增 `skipPhoto` 开关，群聊默认跳过发图决策。测试 51 文件 / 582 用例。
- **年龄门 18+ 确认（2026-10-20）**：新增 `src/data/consent.ts`（SQLite `user_consent`，按 owner 隔离）+ `src/persona/age-gate.ts`（确认/未成年识别、动作裁决、文案）；QQ 私聊首次对话发「披露 + 18+ 确认请求」，未确认前不进入角色对话（每 5 分钟最多提醒一次），回复「我成年了」后记录并放行；明确表示未成年的用户拒绝服务；群聊里未确认用户不回复；新增 `/age` 命令查看状态；`age_gate_enabled` 默认 true（CLI 开发者模式不强制）。测试 53 文件 / 596 用例。
- **成本统计覆盖旁路 LLM（2026-10-20）**：新增 `src/ai/aux-usage.ts` 统一记账；事实抽取/内心独白（含深夜独白）/T3 摘要/herView/进化日志/叙事重构/视觉描述/配图搜索词全部写入 `llm_usage`（带 `kind`）；`/cost` 与 Web 控制台新增「按用途」拆分（对话/事实抽取/独白/长期摘要/图片识别…）。真实验证：一次事实抽取调用写入 kind=fact_extraction、prompt 234 / completion 63、¥0.000486。测试 54 文件 / 600 用例。
- **合规默认值调整（2026-10-20，用户反馈）**：用户明确不希望聊天里出现 AI 披露（体验很差）→ 聊天内 AI 披露**默认关闭**（`src/data/store.ts` 默认 false；`config.yaml.example` 同步）；setup 向导移除 AI 披露文案，只保留 18+ 确认，不再写披露确认；披露能力保留，`ai_disclosure: true` 可显式开启（公开发布/商用建议开启）。新增 3 条配置默认值测试；测试 68 文件 / 683 用例。
- **发布准备（2026-10-20）**：干净 checkout（`git archive` → 临时目录 + 软链 node_modules）复验通过：typecheck 0、683 用例全绿、doctor 在缺 config/.env 时给出可执行指引；仓库卫生检查（无 .env/config.yaml/data/coverage 入库、无真实密钥、跟踪文件 257 个约 12.6MB）；新增 [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md)（检查结果 + 发布步骤 + Release Note）与 [CHANGELOG.md](CHANGELOG.md)；用户已拍板：升级 **v0.2.0** 并 push + tag（远端 `master` 是上游旧历史，不 force push，推本地 `main` 新分支）。
- **M2-D 真实 QQ 长跑工具 + 首轮真机修复（2026-10-20）**：新增 `src/eval/qq-realrun.ts`（只读快照/回合延迟/重复空回复/成本/事实/同意 → 报告）+ `scripts/qq-longrun-watch.ts` + `npm run qq:watch`，结束写 `data/realrun-*.md`（含对话原文，600 权限）；支持 `--once --since <时间>` 随时复盘历史并标记「AI 披露未确认/空回复/重复/无成本记录」。首轮真机（3 轮）暴露并修复：①老用户 session 非空导致 AI 披露被跳过 → 改为按 `user_consent.disclosure_acked_at` 补发（`shouldSendDisclosure`），披露/`/about` 文案改用当前人设名；②消息门未把当前消息计入「5 分钟连续跟进」，18s 后的追问被随机延迟 31 分钟 → `buildGateContext` 修正并补回归测试；③第二轮真机发现「问怎么认识」时编造具体场景 → prompt 增加确定性反编造规则 + 单测。测试 68 文件 / 683 用例。
- **M2-C 单 owner 导出（2026-10-20）**：`user-export.ts` 拆出 `buildUserExportPayload`（只读组装，不落盘）+ Web API `GET /api/export?owner=`（JSON 附件下载，ASCII 安全文件名，默认仅主用户、开启 `web_all_owners` 后可导出其他 owner；非法/越权 400/403）；前端顶栏「导出当前用户」按钮（自动带 token/owner）。测试：导出新文件 3 条场景 + dashboard 断言；全仓 65 文件 / 666 用例。
- **M2-C 多租户 Web 最小版（2026-10-20）**：新增 `src/web/owner-view.ts`（owner↔storageKey/persona 映射、扫描会话/facts/consent 汇总已知 owner）+ Web API `/api/owners`；`?owner=` 支持只读切换会话/时间线/记忆/总览（默认 `web_all_owners: false` 只展示主用户，开启后允许切换；`/api/facts?owner=` 保持历史只读行为）；前端顶栏 owner 下拉（仅在 >1 用户且开启时显示）。配置 `web_all_owners`（config.yaml 或 `WEB_ALL_OWNERS`），桥接传入 primaryOwner/allOwners。新增测试 7 条（owner 映射/汇总 + 多用户 API 作用域 200/403 + 页面选择器）。测试 65 文件 / 665 用例。
- **M2-B 人设包 v2（2026-10-20）**：新增 `src/persona/pack.ts`（manifest/素材/记忆种子校验 + 安装/覆盖备份/列表）+ `src/persona/pack-cli.ts` + npm 脚本 `persona:pack:validate/install/list`。包格式：manifest.json + persona.json + 可选 assets/与 memories/seed.jsonl（3–20 条，`--with-seeds` 才写 T2）；覆盖安装备份到 `personas/.backups/`；校验只做结构与引擎兼容（版本/schema/id/素材大小与类型），不判断内容质量；暂不支持 zip。规范 [docs/PERSONA_PACK.md](docs/PERSONA_PACK.md)。测试 9 条（含子进程 CLI）。测试 63 文件 / 658 用例。
- **M2-A 首次引导 2.0（2026-10-20）**：方向已拍板（个人自用+朋友小范围，见 docs/M2_PRODUCT_PLAN.md）。新增 `src/setup/flow.ts`（纯函数：标签/端口校验、config 合并、第一段对话与事实生成、跳过判断）+ `src/setup/onboarding.ts`（把引导对话写入会话、`user_facts`（名字/城市/认识方式）、`user_consent`（披露+18+），生成 `data/onboarding.json`；主用户与 CLI 共用 legacy 会话只写一遍）。`npm run setup` 增加知情/18+ 确认步骤、`--force` 重设、已完成时直接跳过；引导完成后 CLI/QQ 首次聊天不再重复披露/年龄门。测试：flow 10 条 + onboarding 4 条 + setup 子进程 E2E 1 条（真实 CLI 驱动，含二次运行跳过）。测试 62 文件 / 649 用例。
- **延迟补发 E2E + 跨库表缓存修复（2026-10-20）**：新增延迟补发端到端场景——单独起「免打扰覆盖当前小时」的 bridge，聊天消息断言不立即回复 → `pending_replies` 落库 → 把 `due_at` 改到过去 → **重启 bridge 进程** → 恢复队列后 ~2s 补发（断言收到回复 + 队列标记 done）。顺带修掉两个真实工程问题：①`cost-tracker` 和 `pending-queue` 的建表缓存是进程级布尔，同一进程切换 `KAREN_DATA_DIR` 后第二个库缺表（全量测试出现 `no such table: llm_usage` 警告）→ 改为按 DB 路径缓存；②E2E 断言在「消息已发送、DB 尚未落库」的窗口会 flake → 增加 DB 轮询。测试 59 文件 / 634 用例。
- **多用户 prompt 隔离修复（2026-10-20）**：E2E 扩场景时发现严重隐私问题——`retrieveStyleReference` 查 `t2_episodes` 没有 `persona_id` 过滤，第二用户的 system prompt 里混入第一用户的历史对话片段（动态风格参考）。修复：查询强制 `persona_id = ?`（缺省不检索），两处调用传 `state.storagePersona`；新增单测（两人片段互不出现）+ E2E 回归断言（用户 2 prompt 不含用户 1 内容）。同时 E2E 新增白名单外私聊静默忽略、模型输出 CQ 码出站转义（`&#91;CQ:...`）两个安全场景。测试 59 文件 / 631 用例。
- **mock-OneBot 桥接端到端测试（2026-10-20）**：新增 `src/eval/bridge-e2e.test.ts` + `npm run test:e2e`——测试进程扮演 NapCat（OneBot 反向 WS 客户端），用临时 config/数据目录启动**真实 bridge 子进程**，fake DeepSeek HTTP 服务模拟文本/SSE/视觉/抽取；覆盖「新用户披露→年龄门→确认→私聊流式→图片视觉→群聊 @、/about /age 命令、危机兜底 12356、第二用户隔离 + 未确认年龄群聊拦截（含数据库级 owner/persona 断言）」。E2E 直接抓出 2 个真实 bug：①确认年龄与下一句在 400ms 合并窗口被拼成一批，确认分支提前 return 吞掉后半句 → 确认后剥离标记继续回复（`stripAgeConfirmationMarkers` + 单测）；②私聊缓冲 `processing` 竞态（新消息入队后 drain 刚好退出 → 消息卡死）→ finally 再检查积压重新排期。连续 3 次全过（约 1.6s/次）。文档 [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md)。测试 59 文件 / 629 用例。
- **修复后端到端复验（2026-10-20）**：用修复后的代码再跑 2 次 30 轮真实长跑：记忆 6/6、复读对 0、错误 0；复验暴露并修复 2 个新问题——①记忆防御话术省略「我」的变体（「才一个月 记性没那么差」）漏网 → guard 匹配整族 + harness 同步；②用户连发多条时 1.5s 节流直接丢弃后续消息，导致 `pet` 事实连续两轮缺失 → 改为**排队合并**（最多 5 条，窗口结束补抽），专项实测连发 3 条 5/5 事实全部抽到。另外 `memory-eval --live` 复验 17/20（85%）、违规 0，与历史一致；长跑 harness 新增 T3 摘要观测字段。报告 [docs/LONGRUN_REGRESSION.md](docs/LONGRUN_REGRESSION.md)。测试 58 文件 / 623 用例。
- **工程加固：lint + 覆盖率基线 + 日志正文脱敏（2026-10-20）**：①`npm run lint` = tsc `noUnusedLocals/noUnusedParameters`，修掉 47 处未使用导入/变量/参数（0 违规）并接入 CI；②`npm run test:coverage`（`@vitest/coverage-v8`）：首次基线 Statements 50.9% / Branch 47.25% / Functions 57.76% / Lines 51.91%，CI（Linux）阈值守护 + `coverage/` 不入库；③新增 `obs/safe-text.ts`：默认日志只记 `[redacted N chars]`，`LOG_CONTENT=1` 才输出 40 字预览，替换独白/日记/发图配文/主动消息/因果链等 12 处正文打印。测试 57 文件 / 619 用例。
- **30 轮真实长跑回归 + 修复（2026-10-20）**：新增 `src/eval/longrun-sim.ts`（30 轮混合场景：事实→闲聊→记忆→重复施压→新计划→再回忆）与报告 [docs/LONGRUN_REGRESSION.md](docs/LONGRUN_REGRESSION.md)。首轮结果：记忆 6/6、复读对 0、错误/空回复 0、137 次调用 ¥0.0758；暴露并修复 3 个问题——①事实抽取把角色老家人设「嘉兴」记成用户城市、职业抽成「上班族」、丢宠物细节 → prompt 加固 + `isFactGroundedInUserText` 接地校验（修复后实测 city=杭州/job=产品设计/pet=橘猫叫团子）；②模型仍说「我记性没那么差」→ `reply-guard.ts` 确定性删分句（三管线接入）；③候选 <3 条仍调检索重排 → 跳过（省调用/延迟）。测试 56 文件 / 615 用例。
- **问题记录**：真机联调问题与修复清单见 [docs/M1_BACKLOG.md](docs/M1_BACKLOG.md)。

### 已知问题（M0 之后继续修）

- 双管线行为已对齐（QQ 流式主路径补齐叙事/风格/因果链/T1/herView 等），但代码仍是两份实现，后续可抽取共享 helper 降低漂移风险
- Web 控制台默认只展示主用户数据；`web_all_owners: true` 后可只读切换其他 owner（会话/时间线/记忆按 owner 隔离），`/api/facts?owner=` 保持只读查询；单 owner JSON 导出已可用（`/api/export`）；删除/暂停等写操作与商业多租户 UI 属 M3
- 群聊与私聊共用一个用户 state（同一 QQ 用户在群/私聊的上下文共享），如需严格分开可后续加 platform 维度
- 主动消息：已加单日上限 4 条、两次最小间隔 30 分钟、连续沉默 3 次强制回复；`/pause`、`/resume` 与可配置免打扰时段（`quiet_hours_*`）已可用；仍不能按用户自定义频率
- 真语义向量检索需配置 Qwen Key（`QWEN_VL_API_KEY`）或本地 embedding 才能生效；当前无 Key 时为 n-gram + FTS5 BM25 + DeepSeek 候选重排（非真向量）；阈值待真实 Key + 标注集标定
- 记忆仍缺：语义级重复的**改写**（句式检测/提醒已有，但 9 次 A/B 未测出稳定效果）；真实长期数据的 T3 摘要质量需按周抽检；真语义向量需 Qwen Key/本地 embedding（见 docs/MEMORY_AI_TONE_AUDIT.md §6）
- 旁路 LLM 调用（事实抽取/独白/T3/herView/日志/叙事/视觉/配图搜索词）已统一经 `ai/aux-usage.ts` 计入 `llm_usage`，`/cost` 有按用途拆分
- 真实 QQ 长跑首轮已跑通（2 个完整回合、成本约 ¥0.0057）；暴露并修复「快速追问被误延迟」真机问题；AI 披露随后按用户偏好改为默认关闭（显式开启才补发）。仍需更多真实样本才算长期稳定
- 成本统计为估算：峰谷价按工作日/周末近似（节假日可能高估），provider 不返回 usage 的调用不记录（不估算）
- 日志正文默认脱敏（`[redacted N chars]`；`LOG_CONTENT=1` 输出 40 字预览），但仍有较多直接 console.log、未全部改结构化 logger
- 贴纸 11 个内置 Twemoji（私聊+群聊）；出站 mface/收藏表情未做
- 发图 7 张本地兜底（Unsplash Key 未配置）；群聊发图需 `group_photo_enabled: true`（默认关）；夜间发图由免打扰门控
- Web 控制台只读、仅本机；默认只展示主用户，`web_all_owners: true` 可只读切换其他 owner（会话/时间线/记忆按 owner 隔离）；单 owner JSON 导出已可用（`/api/export`），删除/暂停等写操作仍无；token 在 URL query 可见（后续可改 fragment）；多人设搜索仍受 getCurrentPersona 单例约束
- 语音 ASR、多实例商用托管待做
- 测试覆盖率有基线但仍偏低（行 54.2%，`npm run test:coverage` 阈值守护）；lint 是 tsc 未使用代码检查（零依赖），不是完整 ESLint 规则集
- QQ 桥接跨平台验证不完整（Windows 曾验，macOS 已实机验证；CI 现已三平台跑单测，但真实 QQ 端到端仍只在 macOS 跑过）；平台/封号风险是结构性风险
- 依赖：vitest 5 暂缓（rolldown 平台包解析慢）；`node-cron`/`wechaty` 已从依赖移除
- 合规为最小版：**AI 披露能力保留但默认关闭**（用户明确要求聊天里不出现 AI 披露；个人自用优先，公开发布/商用建议显式 `ai_disclosure: true`）；**年龄门已升级为一次性确认**（QQ 用户回复「我成年了」才进入对话，`/age` 查看，`age_gate_enabled` 可关；仍是自我声明、无身份证校验）；危机检测是关键词兜底（非临床评估，可能漏判/误判）
- QQ 桥接日志与 orchestrator/evolution 内容打印已默认脱敏（`obs/safe-text.ts`）；仍有直接 console.log 未全部改结构化 logger

### 路线图

- **M1 核心体验闭环**（1–2 周）：状态持久化、关系成长、演化可见化、主动消息治理、门控可解释、人设字段接线、语义记忆、天气/热点、可观测性、记忆数据主权
- **M2 产品化**（3–6 周）：本地 Web 控制台（**多用户只读切换已实施**）、**首次引导 2.0（A 已实施）**、**人设包 v2（B 已实施）**、多模态、群聊/多平台、质量与安全、工程化、评测闭环
- **M3 长期**（可选）：人设市场、多用户托管、主动生活流 2.0、长期关系记忆、插件系统

详见 [docs/PRODUCT_AUDIT.md 第 5 节](docs/PRODUCT_AUDIT.md)。

## 关键设计原则

- 人性在冲突过程中，不在裁决结果里
- 人设不是标签，是六层结构：硬规则 → 身份 → 说话风格 → 情感模式 → 关系行为 → 自己的世界
- L1 不是铁面法官，是会妥协的规矩（rigidity 系数 + 突破后负债）
- 负债偿还是外交不是内政：三种结局（接受/拒绝/未被注意）
- 演化的核心不是后台参数漂移，是「觉察 → 否认 → 承认」的心理弧线
- 自我叙事不存在「正确版本」，偏差引擎由 L4 决定重构方向
- 可以没有观点，但不能没有反应；可以没看过，但不能像断网了一样
- 用关键词检测情绪 = 用标签冒充理解 → 绝对禁止
- QQ/微信中不要用括号描述动作，不要写 RPG 剧本
- 动态状态不用长篇自然语言注入 prompt，用结构化标签（~15 tokens）
- 人设的「兴趣/审美」属于 persona.json，不硬编码在引擎代码中

## 设计哲学（2026-06-04 讨论共识）

核心准则：**「这是让她更完整地成为她自己，还是让她更好地服务用户？」**

明确边界：

- 不做响应评分/偏好学习（让她变成讨好者）
- 不做静态 few-shot 示例注入（固化行为，抹杀自然反应）
- 内心独白日志：不输出、写给自己看，微量情绪偏移（±0.02），不直接注入 prompt
- 动态风格参考替代 static few-shot：按内心状态标签检索自己的历史片段
- Setup 过程是她和用户的第一段对话，不是配置表单

## 开发约定（AI 协作代理必读）

1. **文档真话**：任何对外文档（README/QUICKSTART/CLAUDE）新增功能宣称前，先在代码里找到对应实现；找不到就写「半成品/规划中」。数字必须可复现（测试数取 `npm test` 输出）。禁止引用无法复现的历史指标（99/100、Recall 99.4%、63.2%、8ms、覆盖率 80%+）。
2. **隐私表述**：本地存储 ≠ 数据不出本机。对话与图片都发 DeepSeek、天气发 OpenWeatherMap、图库 query 发 Unsplash；语义嵌入若启用会发 Qwen（当前未接主路径）；不要写「数据不上传」。
3. **改动边界**：`data/`、`.env`、`config.yaml` 是运行时文件，不进仓库；不要手改 lock 文件；不提交密钥。
4. **测试**：新增逻辑配套 vitest 单测；提交前 `npm run typecheck && npm test`。测试被 tsconfig 排除，类型问题需单独跑 typecheck。
5. **不要基于死代码/未接线模块写宣称**：`router/*`、`data/state.ts`、`world/info-sphere.ts`、`impulse/trigger.ts`、`t2_vec`、`node-cron`、`downloadImageAsBase64`、`CategoryRAG`、`persona.md` 等。
6. **平台约束**：QQ 桥接 Windows/macOS 均已实机验证；微信桥接是无依赖占位桩。
7. **阶段纪律**：M0 地基已固定（新装可用/不丢消息/安全/异常兜底）；M1 优先「状态持久化 → 关系成长 → 演化可见」，M2 才做产品化与 Web 控制台。

## 相关文档

- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) — 产品审计报告：功能清单、文档差异、P0/P1 风险、M0–M3 路线图、附录 B 最小修复清单
- [docs/DEEPSEEK_CAPABILITY_AUDIT.md](docs/DEEPSEEK_CAPABILITY_AUDIT.md) — DeepSeek V4 能力审计：思考模式/视觉/缓存/价格/不支持能力/本项目配置建议
- [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md) — macOS/Windows/Linux QQ 桥接方案、原生 NapCat/Docker/SSH 隧道、安全基线
- [docs/M1_BACKLOG.md](docs/M1_BACKLOG.md) — 真机联调问题与已批准修复清单
- [docs/TECH_RADAR_AI.md](docs/TECH_RADAR_AI.md) — AI/记忆/RAG/评测技术雷达（换什么/不换什么）
- [docs/TECH_RADAR_INFRA.md](docs/TECH_RADAR_INFRA.md) — IM/多模态/前端/基础设施技术雷达
- [docs/LONGRUN_REGRESSION.md](docs/LONGRUN_REGRESSION.md) — 30 轮真实模型长跑回归（记忆/事实/AI 味/延迟/成本）
- [docs/M2_PRODUCT_PLAN.md](docs/M2_PRODUCT_PLAN.md) — M2 产品化方案（A 首次引导 2.0、B 人设包 v2、C 多用户只读 Web 已实施）
- [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md) — 发布准备：干净 checkout 复验、仓库卫生、Release Note 草案与待拍板事项
- [docs/QQ_REAL_RUN.md](docs/QQ_REAL_RUN.md) — 真实 QQ 长跑验证流程、首轮结果与修复记录
- [docs/PERSONA_PACK.md](docs/PERSONA_PACK.md) — 人设包 v2 规范（manifest/素材/记忆种子/CLI/限制）
- [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md) — mock-OneBot 桥接端到端测试（披露/年龄门/私聊/图片/群聊）
- [docs/MEMORY_AI_TONE_AUDIT.md](docs/MEMORY_AI_TONE_AUDIT.md) — 记忆与 AI 味专项审计（存储/上下文/压力测试/优化点）
- [README.md](README.md) — 对外介绍、功能状态表、隐私与安全、已知限制
- [QUICKSTART.md](QUICKSTART.md) — 5 分钟安装与故障排查
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南（注意：部分规则尚未与代码对齐，以 `npm run persona:check` 为准）
