# karen-persona 项目总控

> 最后更新：2026-10（M1 核心体验闭环阶段）
>
> **单一事实源**：功能现状与路线图以 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) 为准；对外表述以 [README.md](README.md) 为准。
> 原则：**宁少说，不夸大**。文档里的每个功能宣称都必须能在代码中找到对应；不确定的写成「半成品 / 规划中」，绝不把设计目标写成已实现。

## 项目概述

QQ 里的 AI 虚拟人。定位是「通讯录里住进一个有自己生活、情绪、记忆和社交圈的人」，而不是一个问答助手。

当前阶段：**M1 核心体验闭环（2026-10）**。M0 地基已修复完成（新装可用、不丢消息、安全加固、文档真话）；M1 正在让「她真的会变化」成立：状态持久化、关系成长、演化可见化。M1/M2 路线见审计报告第 5 节。

## 技术栈（如实）

- **运行时**：Node.js 22.12+（`engines: >=22.12`；better-sqlite3 13 用 N-API 预编译）、TypeScript 5.6（strict，NodeNext）、tsx 直跑 TS、vitest 4（vitest 5 暂缓）
- **对话模型**：DeepSeek V4.1 `deepseek-flash` / `deepseek-v4-pro`，按复杂度规则路由（真实主路径；`deepseek-v4-flash` 是仍可调用的旧别名）
- **图片识别**：DeepSeek Flash 多模态（真实，用同一个 DEEPSEEK_API_KEY；先下载图片转 base64，兼容 NapCat 私有 URL；`detail=high`，截图逐字转述 ≤200 字）
- **思考模式**：默认关闭（`thinking:{type:"disabled"}`）；不关闭时 reasoning 会吃掉 max_tokens 导致空回复（2026-10 实测修复）
- **语义嵌入**：Qwen `text-embedding-v3` 已接入写入/检索（双列不混比）；**需配置 Qwen Key 才启用**，无 Key 自动降级为字符 n-gram + FTS5 BM25 混合
- **向量库**：`sqlite-vec` 已启用（`t2_vec`：cosine + persona/source/model metadata），并与 FTS5 中文 BM25 做 RRF 混合检索；JSON n-gram 作为降级路径
- **存储**：better-sqlite3 13.0.3（T1/T2 记忆，内置跨平台预编译）+ 会话 JSON + 人设 JSON/YAML
- **外部世界**：OpenWeatherMap（真实天气，可选）、时间感知（结构化标签）；网络热点是硬编码话题池
- **桥接**：NapCatQQ（Windows 已验证 v4.18.4，官方最新 v4.18.38）+ OneBot 11 反向 WebSocket；macOS 原生 NapCat / Linux Docker 方案见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md)；微信桥接 = 无依赖占位桩（不在近期路线图）
- **工程**：GitHub Actions CI（ubuntu/macOS/Windows 三平台矩阵：`npm ci` → typecheck → test）、`npm run doctor` 环境体检、结构化日志 + `/health` + 成本统计、Dockerfile（node:22-slim/非 root）、PM2（跑 dist 需先 build）
- **不存在的**：TTS、图片生成（即梦）；语义检索需 Qwen Key；Web 控制台为只读 MVP

## 架构（十个域）与当前状态

图例：✅ 主路径可用 ｜ 🚧 半成品/有限 ｜ 🗺 规划中/未实现

| # | 域 | 状态 | 现状与证据 |
|---|---|---|---|
| 1 | 消息桥接 `src/bridge` | ✅/🚧 | QQ 私聊流式回复可用（`qq.ts`）；群聊仅 @ + 私聊过的人（半成品）；M0 已加固：默认监听 `127.0.0.1`、token/path 校验、`ALLOWED_USERS` 白名单、CQ 注入转义与超长切分、message_id 去重、延迟回复落库补发、进程级异常兜底；`scripts/mock-onebot.mjs` 支持无 QQ 端到端联调；Windows/macOS 均已实机验证（macOS 原生 NapCat + 反向 WS）；微信仅无依赖占位 🗺 |
| 2 | 消息路由 `src/router` | 💀/🚧 | `router/classifier.ts`、`router/session.ts` 未被主路径引用（死代码）；实际合并窗口在 `bridge/qq.ts`、复杂度分级在 `ai/router.ts` |
| 3 | 响应管线 `src/pipeline` | ✅/🚧 | 双管线：`processMessage`（完整，CLI/群聊）/ `processMessageStream`（QQ 私聊）。M1 已**行为对齐**：流式路径补齐因果链闯入/漂移、叙事弧线、纠正层、L1 裁决/EMA、动态风格参考、热点、T1 快照、因果链回响、herView 更新、门控记录等；两份实现仍并存（后续可抽取共享 helper） |
| 4 | 人设引擎 `src/persona` | 🚧 | 六层 schema、校验器、Prompt 静态缓存 + 动态组装可用；未消费字段多（审计 2.3）；负债偿还、纠正层、社交分寸未闭环 |
| 5 | 演化引擎 `src/evolution` | 🚧 | 基线漂移/因果链/叙事重构/进化日志代码存在，但多数未接 QQ 主路径、状态不持久化（重启归零） |
| 6 | 冲动引擎 `src/impulse` | 🚧 | 消息门可用；延迟回复已在 M0 落库+补发；沉默弧线/tone 链/撤回仅有限生效 |
| 7 | 外部世界 `src/world` | ✅/🚧 | 天气 API（M0 已修复中英文 condition 映射与缓存）与时间感知可用；热点为硬编码话题池；信息圈层穿透是死代码 |
| 8 | AI 引擎 `src/ai` | ✅/🚧 | DeepSeek 非流式/流式、复杂度路由、Flash 多模态视觉可用；M0 已加固超时/429/5xx 指数退避重试/usage 记录；M1 关闭思考模式（修复空回复）、模型名 canonical、旁路 LLM 调用统一 thinking 参数；语义嵌入已接线（双列，需 Qwen Key 实跑）；TTS/即梦 🗺 |
| 9 | 记忆与数据 `src/data` | ✅/🚧 | SQLite 存储 + 艾宾浩斯衰减可用；M1 完成检索 P0：**n-gram + FTS5 BM25 混合检索（RRF）**、sqlite-vec 真正启用（cosine + metadata 过滤）、双列 embedding（ngram / semantic 不混比）、schema v2 幂等迁移；**语义 embedding 代码就绪但需 Qwen Key 才能实跑**（无 Key 自动降级）；延迟补发队列已持久化；**多用户隔离已实现**（owner=人设+用户+平台：主用户沿用历史文件/记忆，其他用户会话/状态按后缀隔离、T2 persona_id 带 `@owner` 后缀） |
| 10 | 质量评估 `src/eval` + 测试 | ✅/🚧 | 46 个测试文件 / 540 个用例通过（M0/M1 新增 data/pipeline/bridge/weather/relationship/state/journal/ai/记忆评测测试），`tsc --noEmit` 0 错误，CI 已接入；**新增可复现记忆金标集**（20 条 case，`scripts/memory-eval.ts --offline`，报告 [docs/MEMORY_EVAL_REPORT.md](docs/MEMORY_EVAL_REPORT.md)）与跨轮重复 A/B 脚本（`src/eval/repetition-eval.ts`）；仍缺真实 QQ 集成测试与覆盖率；历史对外指标（99/100、Recall 99.4% 等）**不可复现，禁止再引用** |

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
- **验证**：`npm run typecheck` 0 错误；`npm test` 46 文件 / 540 用例通过（审计基线为 11 文件 / 178 用例）

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
- **问题记录**：真机联调问题与修复清单见 [docs/M1_BACKLOG.md](docs/M1_BACKLOG.md)。

### 已知问题（M0 之后继续修）

- 双管线行为已对齐（QQ 流式主路径补齐叙事/风格/因果链/T1/herView 等），但代码仍是两份实现，后续可抽取共享 helper 降低漂移风险
- Web 控制台默认只展示主用户数据；`/api/facts?owner=` 可只读查看其他 owner，但页面本身仍按主用户（本地控制台为单机运维工具，商业多租户 UI 属 M3）
- 群聊与私聊共用一个用户 state（同一 QQ 用户在群/私聊的上下文共享），如需严格分开可后续加 platform 维度
- 主动消息：M0 已加单日上限 4 条、两次最小间隔 30 分钟、连续沉默 3 次强制回复；仍无免打扰/暂停开关（M1-4）
- 语义检索需配置 Qwen Key（`QWEN_VL_API_KEY`）才能生效；无 Key 时为 n-gram + FTS5 BM25 混合；阈值待真实 Key + 标注集标定
- 记忆仍缺：T1 快照注入、T3 压缩（线上 0 条）、事实冲突消解、记忆召回时间感、语义级重复检测（词法反重复已做）；语义检索需 Qwen Key（见 docs/MEMORY_AI_TONE_AUDIT.md §6）
- 用户事实抽取是旁路 LLM 调用，未计入成本统计（`cost_today` 为下限）
- 主动消息/夜间补发仍需真机长跑验证
- 成本统计仅覆盖 chat/chatStream 主路径；旁路 LLM（独白/T3/视觉等）未计入，`cost_today` 是下限
- 结构化日志只覆盖 qq/chat 关键链路，orchestrator/evolution 等仍有 console.log（可能含派生文本）
- 节假日按工作日近似计算峰谷价，可能高估成本
- 贴纸仅 11 个内置 Twemoji、仅私聊；出站 mface/收藏表情未做
- 发图仅私聊、仅 7 张本地兜底图（Unsplash Key 未配置）；群聊发图未接；夜间发图不再单独限制（由免打扰门控）
- Web 控制台只读、仅本机；token 在 URL query 可见（后续可改 fragment）；多人设搜索仍受 getCurrentPersona 单例约束
- 语音 ASR、多实例商用托管、年龄门（当前为提示级）待做
- 测试覆盖率低；无 lint/coverage
- QQ 桥接跨平台验证不完整（Windows 曾验，macOS 已实机验证；CI 现已三平台跑单测，但真实 QQ 端到端仍只在 macOS 跑过）；平台/封号风险是结构性风险
- 依赖：vitest 5 暂缓（rolldown 平台包解析慢）；`node-cron`/`wechaty` 已从依赖移除
- 合规为最小版：AI 披露已做（可用 `ai_disclosure: false` 关闭，公开发布应保持开启）；年龄门是提示级（无出生日期校验）；危机检测是关键词兜底（非临床评估，可能漏判/误判）
- QQ 桥接日志已脱敏（只打印长度/摘要），但 orchestrator 等其他模块仍可能打印消息片段

### 路线图

- **M1 核心体验闭环**（1–2 周）：状态持久化、关系成长、演化可见化、主动消息治理、门控可解释、人设字段接线、语义记忆、天气/热点、可观测性、记忆数据主权
- **M2 产品化**（3–6 周）：本地 Web 控制台、首次引导 2.0、人设包 v2、多模态、群聊/多平台、质量与安全、工程化、评测闭环
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
- [docs/MEMORY_AI_TONE_AUDIT.md](docs/MEMORY_AI_TONE_AUDIT.md) — 记忆与 AI 味专项审计（存储/上下文/压力测试/优化点）
- [README.md](README.md) — 对外介绍、功能状态表、隐私与安全、已知限制
- [QUICKSTART.md](QUICKSTART.md) — 5 分钟安装与故障排查
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南（注意：部分规则尚未与代码对齐，以 `npm run persona:check` 为准）
