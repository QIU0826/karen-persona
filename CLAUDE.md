# karen-persona 项目总控

> 最后更新：2026-10-21（v0.8.23：本机生图跑通）
>
> **单一事实源**：功能现状与路线图以 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) 为准；对外表述以 [README.md](README.md) 为准。
> 原则：**宁少说，不夸大**。文档里的每个功能宣称都必须能在代码中找到对应；不确定的写成「半成品 / 规划中」，绝不把设计目标写成已实现。

## 项目概述

QQ 里的 AI 虚拟人。定位是「通讯录里住进一个有自己生活、情绪、记忆和社交圈的人」，而不是一个问答助手。

当前阶段：**v0.8.23 已发布（2026-10-21）——**本机生图真正跑通**：HF 直连/Xet 都不通，改用「hf-mirror 小文件 + unet 分块并发 curl」把 sdxl-turbo fp16 本地化；热态 **2.1–2.2s/张**（832×1216，MPS），`npm run image:smoke` 全过，mock 长跑里真的发出 2 张生成图；顺手修「打错字撤回改数字」和「生成图配文连续重复」两个真实长跑评审 bug；v0.8.22 ——**文档数字↔代码事实自动核对**（17 条）：资产数量/金标规模/阈值常量/端口/免打扰/env 名/文档新鲜度全部进测试；当场抓到 README 状态块停在 v0.8.6、CLAUDE 日期停在 10-20 两处漂移并修正；顺手修掉 v0.8.19 贴纸 E2E 在全量并行下的两次假失败（轮询起点不对）；v0.8.21 ——**能力×单测×真实链路三层核对**：新增自动护栏 `coverage-audit.test.ts`（标 ✅ 必须有单测）+ [docs/COVERAGE_AUDIT.md](COVERAGE_AUDIT.md)（含诚实「未验证/不存在」清单）；当场补上 4 个缺口（混合检索/计划序列化/生成图治理/金标集自身校验）；v0.8.20 ——新增 **[docs/VERIFICATION_PLAYBOOK.md](docs/VERIFICATION_PLAYBOOK.md) 验证手册**（六层验证/Bug 目录/清 单/踩坑），并用文档一致性测试锁住手册里的工具必须真实存在（当场抓到缺失别名）；修掉自写 E2E 的贴纸断言 flake（子进程随机数不受 mock）；v0.8.19 ——**表情包链路真实 E2E**（入站图片 → 本地库 → 点名时从库里发出去，均已真实 bridge 验证）；顺带修「点名要表情包时收集库只有 22% 概率」的 bug（抽成纯函数 + 3 条单测）；v0.8.18 ——**周汇总真实链路冒烟**抓出两处：①「还没聊完」整段被 400 字硬截断丢掉（改为先留尾预算再按天均分，7 天全覆盖）；②周汇总**写了却从没人读**（新增读取函数 + ≤140 字注入两条回复管线）；v0.8.17 ——**锚点复筛真实链路冒烟**（`npm run refine:smoke`）：候选 6 条、新建 3 条、闲聊 0 误建、重跑候选 0（完全幂等）；顺带补 3 个幂等缺口（回写 episode.anchor_id / created 计数只算新建 / 被否候选打 -1 哨兵）；v0.8.16 ——**日记忆真实链路冒烟**（`npm run digest:smoke`）抓出「一天 >80 条消息时早上的话被整段丢掉」（`slice(-80)` → 保头保尾 + 省略提示）；复验 summary 正确保留早上关键事实，且同一天幂等；v0.8.15 ——**锚点真实链路冒烟**（`npm run anchor:smoke`，真实模型）抓出「至亲离世记不住」的权重 bug（失去 0.25→0.4，同时收紧词表防「我先走了」误伤）；实测该记的记住 / 闲聊不乱记 / 锚点会注入；v0.8.14 ——真实模型冒烟抽检「主动说出的话」，抓出 **3 个主动性 bug**：①全新关系回复率 0→日上限 0 的死锁；②今日由头被 v0.4 链路顶掉；③由头被随机概率吞掉（约 45%）；修复后真实冒烟：她说「对了，今天下午被老周叫去谈话了，到现在还有点闷」；v0.8.13 ——补上**主动消息（心跳）决策时序的可复现验证**：`npm run initiative:sim` 离线模拟「一天×四种关系热度」，断言免打扰/上限/间隔/由头不重复/冷淡收敛/生疏不撒娇（7 条单测 + CI 步骤）；v0.8.12 ——**真机数据复盘**（58 轮真实 QQ 对话）：修掉 30 轮间距的全历史逐字重复（新增全历史精确比对）、修掉观察工具的事实抽取假警报（用户没自述时不该报警）；真机质量：空回复 0 / AI 措辞 0 / 括号动作 0 / 平均 13 字；v0.8.11 ——主动性接进**正常回复**（每日由头懒加载 + 保守注入，解决"只在心跳里才有由头"）+ 3 个回归暴露的 bug（凌晨不生成计划、问"现在"却发昨天的图、连发两条语音）；**主动性评分仍是 3/5、未测出提升（如实记录）**；v0.8.10 ——多媒体相关性（评审 **2/5→4/5**，两轮复现：只在点名/场景命中/她刚分享生活时发图 + 场景配文池）+ **长程复读检测**（窗口 3→10，补静态"别复述上次答案"规则，验证台新增长程复读指标）；v0.8.9 ——v0.5–v0.8 全链路回归（21 轮真实模型）：修掉 **P0 编造「咖啡店」**（场景词表漏场所名，复验已改口「记不清了」）；验证台新增**新机制运行时状态**采集（锚点/日记忆/主动计划/五维/反思/表情包）；延迟 5.1s 经核实是 v0.6 打字节奏的设计结果（深夜 395ms/字），非性能退化；v0.8.8 ——新增 **能力与实测总表** [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)（能力→代码→实测数字→弱项，7 分节），并修正过期数字（覆盖率实测 **59.21%** 而非 56.0%；测试 98 文件 / 1177 用例）；v0.8.7 ——README 文档真话 pass（修掉"亲密度不会被修改""真语义向量未开启"等过期宣称，命令表/测试数/隐私表全部对齐）+ 文档一致性测试（README 的 npm 脚本与斜杠命令必须真实存在）；v0.8.6 ——**评测进 CI**：`npm run eval:offline` 真跑 40 条记忆金标 + 30 条锚点金标并卡阈值（facts≥95% / recall@8≥90% / 合并≥95% / anti-forget PASS），补上"指标掉但单测全绿"的缺口；守门自带 10 条单测验证"该失败时会失败"；v0.8.5 ——锚点复筛回归护栏：30 条人工金标（该记 17 / 不该记 13），四次独立跑 **精确率 100%**（从不误建）、召回 82–100%、kind 79–94%；v0.8.4 ——锚点二次筛选（每天把边界记忆交 LLM 判断值不值得长期记，幂等、候选<2 跳过、失败不影响其它任务）；真实库实测 12 条候选全判"不值得记"、0 误建，建锚点路径由单测覆盖；v0.8.3 ——表述层修复：让她说到记得的事时**说出具体实体**（「晚风信箱月底上线」而不是「月底上线」），40 条金标 live 从 85–92.5% 提到 **95–100%**（每版三次）；v0.8.2 ——记忆金标集扩到 40 条（离线 facts 100% / recall@8 97.5% / 合并 100%）；v0.8.1 ——**反思循环**（觉察→否认→承认→整合：察觉需 2 次信号、被点破 1 次即察觉、嘴硬撑 6 小时、被戳 2 次才承认、承认后真的改一次）接进持久化与两条管线，`/reflect` 可看；v0.8.0 ——主动性与关系接进主流程：五维关系（亲密/信任/张力/互惠/依赖，持久化+注入+`/relations`）+ 意图式主动性（每日由头计划→到点挑选→按回复率校准频率，`KAREN_INITIATIVE=off` 可关）；v0.7.0 ——本机生图链路（diffusers+MPS 服务、提示词构造、30 天自动清理、失败回退图库、约 20% 照片生成）；**模型下载被 HF 网络阻塞，开关默认 off**；v0.6.0 ——拟人化交互：打字节奏模拟器（人设×情绪×深夜×忙碌）、消息意图族（打错字/说重了/重发/犹豫）、表情包持续收集（从聊天里自动攒库，出站可选优先用）、以及「她主动了解你」（解决事实层没原料）；v0.5.0 ——记忆重构第一阶段：本地真向量检索（Qwen3-Embedding-0.6B，768 维零迁移，127 条历史记忆重嵌入，检索 p95 ~664ms→<100ms）+ 锚点记忆 + 日记忆/周汇总调度 + 状态卡 + 事实状态机与冲突质疑（`/fact`）；本地向量启用时默认关掉每轮 LLM 重排（金标 16→17–18/20）；v0.4.1 ——针对「语音太 AI」加了语气润色（按情绪/作息调语速音高、分句语调轮廓、句中停顿、偶尔语气词）、音色可配、试听脚本与 [docs/VOICE_QUALITY.md](docs/VOICE_QUALITY.md)（含微软 Edge 神经语音 403 的实测结论）；v0.4.0 ——把「她主动找你」从一条链路拆成四条（生活流分享 / 没人接话补一句 / 冷场开话题 / 沉默保温），每次心跳记录「为什么发/为什么不发」并可 `/why` 查看；新增连推收手、深夜打字变慢、`proactive_channels` 链路开关与离线模拟脚本（docs/PROACTIVE_CHANNELS.md）；另做了一次 Prompt 预算审计（docs/PROMPT_BUDGET.md，实测对话轮 prompt p50 2241 tokens、系统提示词 3591 字符）。**历史：v0.3.3——「说话动作」提示（A/B 未测出收益）+ 气泡/重复/照片治理 + 同类项目调研；历史：v0.3.2——v0.3.0「更像真人」（语音消息、打错字撤回、打字节奏、被点名要媒体会真给、宣传页重做）+ v0.3.1 修复 15 轮真实验证暴露的 P0/P1/P2（编造相识场景、多媒体内容错位、情绪承接、嘲讽话术、图片跨轮复用）+ v0.3.2 图库扩充（7→15 张、配文池 42→约 110 条，针对「多媒体 2/5、配文重复」）**。M0 地基已修复完成（新装可用、不丢消息、安全加固、文档真话）；M1 核心体验闭环主要项已完成（状态持久化、关系成长、演化可见化、多用户隔离、双管线对齐、检索增强）；M2-A 首次引导 2.0、M2-B 人设包 v2、M2-C 多用户只读 Web + 导出、M2-D 真实长跑工具已实施；发布检查见 [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md)（已 push main + tag v0.2.0）。M1/M2 路线见审计报告第 5 节。

## 技术栈（如实）

- **运行时**：Node.js 22.12+（`engines: >=22.12`；better-sqlite3 13 用 N-API 预编译（仓库 `.npmrc ignore-scripts=true` 跳过 node-gyp））、TypeScript 5.6（strict，NodeNext）、tsx 直跑 TS、vitest 4（vitest 5 暂缓）
- **对话模型**：DeepSeek V4.1 `deepseek-flash` / `deepseek-v4-pro`，按复杂度规则路由（真实主路径；`deepseek-v4-flash` 是仍可调用的旧别名）
- **图片识别**：DeepSeek Flash 多模态（真实，用同一个 DEEPSEEK_API_KEY；先下载图片转 base64，兼容 NapCat 私有 URL；`detail=high`，截图逐字转述 ≤200 字）
- **思考模式**：默认关闭（`thinking:{type:"disabled"}`）；不关闭时 reasoning 会吃掉 max_tokens 导致空回复（2026-10 实测修复）
- **语义嵌入**：**默认本地真向量**——`services/embed`（Qwen3-Embedding-0.6B ONNX，768 维，`npm run embed:start`），历史记忆已全部重嵌入，检索 p95 <100ms；`KAREN_EMBED=on` 开启，服务不可用自动降级字符 n-gram + FTS5 BM25。云端 Qwen `text-embedding-v3` 仍可选（需 Qwen Key）。**检索层默认关掉每轮 DeepSeek 候选重排**（本地向量下实测更好且省 ~664ms，`KAREN_SEMANTIC_BOOST=on` 可强制开）
- **向量库**：`sqlite-vec` 已启用（`t2_vec`：cosine + persona/source/model metadata），并与 FTS5 中文 BM25 做 RRF 混合检索；JSON n-gram 作为降级路径
- **存储**：better-sqlite3 13.0.3（T1/T2 记忆，内置跨平台预编译）+ 会话 JSON + 人设 JSON/YAML
- **外部世界**：OpenWeatherMap（真实天气，可选）、时间感知（结构化标签）；网络热点是硬编码话题池
- **桥接**：NapCatQQ（Windows 已验证 v4.18.4，官方最新 v4.18.38）+ OneBot 11 反向 WebSocket；macOS 原生 NapCat / Linux Docker 方案见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md)；微信桥接 = 无依赖占位桩（不在近期路线图）
- **工程**：GitHub Actions CI（ubuntu/macOS/Windows 三平台矩阵：`npm ci` → typecheck → lint → test；Linux 额外覆盖率基线）、`npm run doctor` 环境体检、结构化日志 + `/health` + 成本统计、Dockerfile（node:22-slim/非 root）、PM2（跑 dist 需先 build）
- **语音（v0.3.0 新增，v0.4.1 加语气润色）**：macOS 系统 TTS（`say -v Tingting`）→ 24kHz WAV → **SILK**（`silk-wasm` 纯 wasm，无原生构建）→ OneBot `[CQ:record]` 语音条；决策层 `src/impulse/voice.ts`（概率/亲密度/免打扰/冷却/危机语境），合成层 `src/ai/tts.ts`；**仅 macOS 真正发声**，其它平台自动降级为文字
- **撤回（v0.3.0 新增）**：OneBot `delete_msg` 受控撤回（只允许本进程 15s 内发出的消息 + 全局 5s 限频），用于「打错字→撤回→改对」
- **不存在的/未完成**：语音 ASR（用户发来的语音仍是 `[语音]` 占位）、语音零样本克隆（音色仍偏 AI）、生成图的角色一致性（未接 IP-Adapter/参考图；生图本身已可用，`npm run image:start`）、微信桥接；Web 控制台为只读 MVP

## 架构（十个域）与当前状态

图例：✅ 主路径可用 ｜ 🚧 半成品/有限 ｜ 🗺 规划中/未实现

| # | 域 | 状态 | 现状与证据 |
|---|---|---|---|
| 1 | 消息桥接 `src/bridge` | ✅/🚧 | QQ 私聊流式回复可用（`qq.ts`）；群聊仅 @ + 私聊过的人（半成品）；M0 已加固：默认监听 `127.0.0.1`、token/path 校验、`ALLOWED_USERS` 白名单、CQ 注入转义与超长切分、message_id 去重、延迟回复落库补发、进程级异常兜底；`scripts/mock-onebot.mjs` 支持无 QQ 端到端联调，且 CI 有 mock-OneBot 桥接 E2E（docs/QQ_E2E_TEST.md）；Windows/macOS 均已实机验证（macOS 原生 NapCat + 反向 WS）；微信仅无依赖占位 🗺 |
| 2 | 消息路由 `src/router` | 💀/🚧 | `router/classifier.ts`、`router/session.ts` 未被主路径引用（死代码）；实际合并窗口在 `bridge/qq.ts`、复杂度分级在 `ai/router.ts` |
| 3 | 响应管线 `src/pipeline` | ✅/🚧 | 双管线：`processMessage`（完整，CLI/群聊）/ `processMessageStream`（QQ 私聊）。M1 已**行为对齐**：流式路径补齐因果链闯入/漂移、叙事弧线、纠正层、L1 裁决/EMA、动态风格参考、热点、T1 快照、因果链回响、herView 更新、门控记录等；两份实现仍并存（后续可抽取共享 helper） |
| 4 | 人设引擎 `src/persona` | 🚧 | 六层 schema、校验器、Prompt 静态缓存 + 动态组装可用；未消费字段多（审计 2.3）；负债偿还、纠正层、社交分寸未闭环 |
| 5 | 演化引擎 `src/evolution` | 🚧/✅ | **v0.8.1 反思循环已接主路径**（觉察/否认/承认/整合，状态持久化、`/reflect`、承认后真的改一次）；基线漂移/因果链/叙事重构/进化日志代码存在，多数已接流式路径但部分仍是半成品 |
| 6 | 冲动引擎 `src/impulse` | ✅/🚧 | 消息门可用；延迟回复已在 M0 落库+补发；**主动消息四条链路（v0.4.0）+ 决策留痕**；**v0.8 意图式主动（每日由头计划/到点挑选/回复率校准）+ 五维关系**；**语音 v0.4.1 语气润色**；**消息意图族 v0.6**；媒体请求识别可用；沉默弧线/tone 链仅有限生效 |
| 7 | 外部世界 `src/world` | ✅/🚧 | 天气 API（M0 已修复中英文 condition 映射与缓存）与时间感知可用；热点为硬编码话题池；信息圈层穿透是死代码 |
| 8 | AI 引擎 `src/ai` | ✅/🚧 | DeepSeek 非流式/流式、复杂度路由、Flash 多模态视觉可用；M0 已加固超时/429/5xx 指数退避重试/usage 记录；M1 关闭思考模式（修复空回复）、模型名 canonical、旁路 LLM 调用统一 thinking 参数；语义嵌入已接线（默认本地 Qwen3-Embedding-0.6B，云端可选）；**TTS 已落地**（macOS say→SILK，`src/ai/tts.ts`）、即梦 🗺 |
| 9 | 记忆与数据 `src/data` | ✅/🚧 | **v0.5 记忆 v2**：本地向量（services/embed + local-embed.ts，768 维）、锚点记忆（memory-v2.ts，**v0.8.4 起加日度 LLM 二次筛选**）、日记忆/周汇总调度（schedule/jobs.ts）、状态卡、事实状态机与冲突质疑；SQLite 存储 + 艾宾浩斯衰减可用；M1 完成检索 P0（已被 v0.5 本地向量取代）：**本地 768 维向量 + FTS5 BM25（RRF）**，DeepSeek 候选重排在本地向量下**默认关**（更准且省 ~664ms）、sqlite-vec 启用、双列 embedding、schema v2/v3 幂等迁移、用户事实层、T1 状态弧、T3 压缩（40 条/隔天兜底 + `t3_compressed` 防重复）；**语义 embedding 默认走本地 768 维向量**（`services/embed`；服务不可用自动降级）；延迟补发队列已持久化；**多用户隔离已实现**（owner=人设+用户+平台） |
| 10 | 质量评估 `src/eval` + 测试 | ✅/🚧 | 109 个测试文件 / 1298 个用例通过（M0/M1 新增 data/pipeline/bridge/weather/relationship/state/journal/ai/记忆评测测试），`tsc --noEmit` 0 错误，CI 已接入（typecheck/lint/test/覆盖率/**离线评测守门**）；**新增 mock-OneBot 桥接端到端测试**（真实 bridge 子进程 + fake NapCat/DeepSeek，覆盖披露/年龄门/私聊/图片/群聊/命令/危机/多用户隔离，见 [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md)）、可复现记忆金标集（40 条 case，`scripts/memory-eval.ts --offline`，报告 [docs/MEMORY_EVAL_REPORT.md](docs/MEMORY_EVAL_REPORT.md)）与跨轮重复 A/B（`src/eval/repetition-eval.ts`）、**锚点复筛评测**（30 条金标 + `scripts/anchor-eval.ts`，报告 docs/ANCHOR_EVAL_REPORT.md）；真实 QQ/NapCat 端到端仍需真机；历史对外指标（99/100、Recall 99.4% 等）**不可复现，禁止再引用** |

## 启动与开发命令

```bash
npm run doctor     # 环境体检（先跑绿）
npm run dev        # CLI 模式（不连 QQ）
npm run qq         # QQ 桥接模式（NapCatQQ 反向 WS，默认端口 18080）
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run setup      # 交互式配置向导
npm run eval:offline   # 离线评测守门（记忆 40 条 + 锚点 30 条，CI 同款，不联网）
npm run eval:live      # 真实模型评测（约 ¥0.02，手动跑）
npm run initiative:sim # 主动消息决策时序离线模拟（零成本，CI 跑）
npm run anchor:smoke   # 锚点真实链路冒烟（真实模型，约 ¥0.005）
npm run digest:smoke   # 日记忆真实链路冒烟（真实模型，约 ¥0.002）
npm run refine:smoke   # 锚点复筛真实链路冒烟（真实模型，约 ¥0.003）
npm run rollup:smoke   # 周汇总真实链路冒烟（零成本，不调模型）
npm run image:start    # 启动本机生图服务（热态 2.1–2.2s/张）
npm run image:smoke    # 生图真实链路冒烟（真出图/可复现/落盘/产品路径）
```

配置：`.env`（Key/桥接参数，从 `.env.example` 复制）、`config.yaml`（人设/称呼/位置，从 `config.yaml.example` 复制）；运行时数据在 `data/`（可被 `KAREN_DATA_DIR` 覆盖）。

## 当前进度（2026-10）

### M0 落地内容（2026-10 本阶段）

- **文档真话 pass**：README/QUICKSTART 按实际代码重写；隐私声明修正为「数据本地存储，但对话与图片会发给 DeepSeek（M1 起图片也走 DeepSeek Flash）」；删除「数据不上传」「语义嵌入主路径」「sqlite-vec 检索」「延迟回复已实现」「不同好友不同人设已生效」「133 tests」等不实/过时表述
- **许可证**：新增 MIT `LICENSE`（© 2026 QIU0826）
- **工程化**：`.github/workflows/ci.yml`（Node 22 + ubuntu/macOS/Windows 三平台矩阵 + `npm ci` + typecheck + test）、`.dockerignore`、Dockerfile 改为 node:22-slim / Asia/Shanghai / 非 root、`ecosystem.config.js` 补 `cwd` 与启动方式说明
- **开发者体验**：新增 `npm run doctor`（Node/config/Key/人设/数据目录/SQLite 六项检查 + 修复建议）；`engines` 已收紧为 `>=22.12`
- **地基修复（M0-1/2/3）**：数据目录自动创建与 embedding 列迁移、`KAREN_DATA_DIR`；`loadConfig` 返回并校验 `user_personas` / `one_bot_*` / `allowed_users`，端口统一 18080；消息门延迟消息落库与到点补发（新消息取消待补发）、连续沉默 3 次强制回复；主动消息单日上限 4 条 + 最小间隔 30 分钟；LLM 显式超时 + 仅 429/5xx 指数退避重试 + usage 记录；天气中英文映射与 30 分钟缓存；WS 默认回环 + token/path 校验 + 白名单 + CQ 转义 + 去重 + 异常兜底
- **验证**：`npm run typecheck` 0 错误；`npm run lint` 0 违规；`npm test` 当前 109 文件 / 1298 用例通过（M0 审计基线为 11 文件 / 178 用例）

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
- **主动发图接通 QQ（2026-10-20）**：`photoShare` 在流式路径也触发；有 `UNSPLASH_ACCESS_KEY` 走 Unsplash 搜索，无 Key 回退**本地图库**（`assets/photos`，当前 15 张，Picsum/Unsplash License）；桥接下载/读文件转 base64 发送 CQ image；修掉「qqFace 后 break 导致发图 fragment 被丢弃」的 bug；测试期 config 可覆盖门槛/概率/冷却（`photo_share_*`），实测 E2E 收到配文+图片。
- **发图时间关系模型（2026-10-20）**：照片不再按小时硬过滤；每张图带场景与「今天/昨天/以前」时间关系——早上可以发「昨天的晚霞」，亲密度 ≥4 才会分享「以前的生活」（`minCloseness` 可配）；配文按时间关系生成，避免「早上 10 点说今天的晚霞」这类错乱。
- **0 号依赖升级（2026-10-20 凌晨）**：`better-sqlite3` 11.10 → **13.0.3**（改为内置 N-API 预编译，`npm install` 不再需要 C++ 构建工具，Windows/macOS 安装风险大幅下降；npm 仍会对带 `binding.gyp` 的包自动跑 node-gyp → 仓库根 `.npmrc ignore-scripts=true` 直接使用包内 prebuilds，Windows 无需 Visual Studio）；`engines` 收紧 `>=22.12`；移除未使用的 `wechaty`（微信 echo 桩改为无依赖占位）与 `node-cron`（死依赖），依赖树从 ~446 个包降到 ~162 个；CI 改为 ubuntu/macOS/Windows 三平台矩阵；Node 22 下 `tsc` 0 错误、462 用例全绿、桥接/健康/Web 实测正常。**vitest 5 暂缓**（其依赖树引入 rolldown 平台包，安装解析过慢，后续单独升级）。
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
- **合规默认值调整（2026-10-20，用户反馈）**：用户明确不希望聊天里出现 AI 披露（体验很差）→ 聊天内 AI 披露**默认关闭**（`src/data/store.ts` 默认 false；`config.yaml.example` 同步）；setup 向导移除 AI 披露文案，只保留 18+ 确认，不再写披露确认；披露能力保留，`ai_disclosure: true` 可显式开启（公开发布/商用建议开启）。新增 3 条配置默认值测试；测试 69 文件 / 687 用例。
- **记忆修正 `/forget`（2026-10-20，真机反馈）**：新增 `/forget 关键词 [--yes]`（QQ/CLI）：先预览匹配的 T2 记忆，确认后删除（一次最多 20 条），用于清理被编造/记错的往事；只删 T2，不动会话与人格状态。新增 3 条测试（预览不删/确认删除/无匹配与用法）；测试 69 文件 / 687 用例。
- **v0.3.0「更像真人」（2026-10-20）**：
  - **语音消息**：`src/ai/tts.ts`（macOS `say` → WAV → `silk-wasm` SILK → base64）+ `src/impulse/voice.ts`（纯决策：enabled/群聊/危机/TTS 可用/免打扰/亲密度/冷却/概率/选句，10 个 reason 分支）；桥接在文字回复后按概率补一条 `[CQ:record]`，发送前按语音时长等待；单测 56 条（含 darwin-only 真实 say→silk）；真实链路实测 2.4s 语音 → SILK ≈9.3KB。
  - **打错字→撤回→改对**：`src/impulse/typo-recall.ts` + OneBot `sendPrivateMsgAsync`/`recallMessage`（15s 窗口 + 5s 全局限频）；私聊首条气泡低概率（默认 4%）先发错字版，1.5s 后撤回再发正确原文；`NODE_ENV=test` 默认关闭随机，保证 E2E 确定性；单测 26 条（含 fake-WS delete_msg 链路）。
  - **多媒体请求兑现**：`src/impulse/media-request.ts` 识别「拍张照片看看/发个表情包/发条语音听听」→ 照片跳过概率判定（亲密度/冷却仍生效）、表情/语音提高概率并跳冷却，并给模型内部提示对齐语气与动作；真实验证中「连问 3 次照片都没发」的问题由此修复。
  - **打字节奏 + 连发收敛**：气泡间隔按字数估算（80–120ms/字，封顶 3s）、首条前 0.3–0.8s；`MAX_BURST` 15→4（与 persona「2-4 条」一致，超出内容合并进最后一条）；同一轮已发照片/贴纸不再补语音。
  - **宣传页重做**：`promo/` 整页重写（单文件零构建），首屏人物 + 主张 + CTA，分区日常/消息形态/主动性/记忆/隐私，纯 HTML/CSS 聊天 mockup（照片、表情包、3″ 语音、撤回、正在输入），1440/390 双断点截图自检；隐私文案如实写「对话经模型 API 处理」。
  - **真实验证台**：`scripts/mock-onebot-longrun.ts` + `src/eval/mock-longrun.ts`（mock NapCat + 真实 DeepSeek 扮演用户 + 临时数据目录 + 指标 + LLM 评审），报告 [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md)；15 轮基线暴露并驱动了上面 3 个修复（气泡过多、照片不兑现、话题/口头禅复读）。
  - **流式气泡边界修复**：`sentReply` 之前把多条气泡无分隔拼接后写入会话/记忆，导致「多句粘成一句」；改为按 `\n` 保留边界（影响风格参考与检索质量）。
  - 测试 75 文件 / 823 用例；行覆盖 55.9%。

- **v0.3.1 真实验证驱动修复（2026-10-20）**：
  - **P0 编造相识**：新增 `src/persona/meeting-guard.ts`（`isAskingHowWeMet` / `hasMeetingGrounding` / `stripFabricatedMeeting` / `pickMeetingFallback`）——只在「用户在问相识 + 人设 howWeMet/用户事实/T2 记忆都无依据」时启用，删掉具体场景分句；全删空则用含糊回应。两条管线都接入（流式逐条过滤 + 全篇编造兜底）。
  - **P0 多媒体错位**：`detectPhotoSceneTags` 把用户说的场景映射到图库标签（sunset/snow/cafe/animal/mountain/lake…），点名要照片时按场景挑图；点名要语音时不再被「本轮已发照片/贴纸」拦截，且没有合格句子时从正文截短句兜底合成（修「说发了语音其实没发」）。
  - **P1 情绪承接**：prompt 增加「对方讲糟心事时先接情绪，不立刻转到自己」。
  - **P2**：记忆防御嘲讽变体（才说的就忘/才两句就忘/这就忘了）纳入 `reply-guard`；本地图库按 persona 记住最近 3 张、选图排除（全排除时宁可不发）。
  - 测试 76 文件 / 842 用例；行覆盖 56.0%。

- **v0.3.2 图库扩充（2026-10-20）**：本地图库 7 → 15 张（新增拿铁+绿植/沙发上的猫/雨后傍晚街头/雨窗/晚餐/三杯拿铁/店内灯牌/花田，800×600，Unsplash License），配文池 42 → 约 110 条（今天/昨天/以前 × 2-3 句）；`detectPhotoSceneTags` 补雨/花/城市街头/晚饭/猫标签；新增多样性测试。针对验证评审「多媒体 2/5、配文重复」的根因。
- **v0.3.3 说话动作 + 气泡治理 + 同类项目调研（2026-10-20）**：
  - `src/persona/talk-moves.ts`：糟心事轮 → 内部提示先接住情绪；否则 28% 概率补一句自己的近况；亲密度门槛/连续两轮不重复/危机与免打扰不触发；`KAREN_TALK_MOVES=off` 可关。
  - 桥接：**单轮文字气泡上限 4**（超出合并成一条）、**当轮去重**（`isWithinTurnDuplicate`）、情绪轮不发非点名的主动照片、贴纸最近 3 张不重复。
  - 8 轮 A/B（关 vs 开，各 ¥0.05）评审分差异在噪声内（真人感 3 vs 4、主动均 3），**未测出收益**；但 A/B 暴露了气泡/重复/照片三个真问题，已修。
  - `docs/RESEARCH_REFERENCE.md`：GitHub 同类项目调研（ai-companion-kit / qq-agent-plus / Undefined / Eridanus / qq-maid-bot / ai-bot-groupmate / kiwi-mem / awesome-ai-companion），记录可借鉴设计与后续优先级。
  - 测试 76 文件 / 856 用例（v0.3.3 当时）。
- **v0.2.1 Windows 安装与 CI 修复（2026-10-20）**：`.npmrc ignore-scripts=true` 避免 npm 对 better-sqlite3 自动跑 node-gyp（Windows 无 VS 失败）；Windows 跳过 POSIX 0600 断言；通过临时诊断 workflow + check-run annotations 定位后删除诊断分支；CI ubuntu/macOS/Windows 全绿（run 39382097271）。
- **发布准备（2026-10-20）**：干净 checkout（`git archive` → 临时目录 + 软链 node_modules）复验通过：typecheck 0、687 用例全绿、doctor 在缺 config/.env 时给出可执行指引；仓库卫生检查（无 .env/config.yaml/data/coverage 入库、无真实密钥、跟踪文件 257 个约 12.6MB）；新增 [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md)（检查结果 + 发布步骤 + Release Note）与 [CHANGELOG.md](CHANGELOG.md)；用户已拍板：升级 **v0.2.0** 并 push + tag（远端 `master` 是上游旧历史，不 force push，推本地 `main` 新分支）。
- **M2-D 真实 QQ 长跑工具 + 首轮真机修复（2026-10-20）**：新增 `src/eval/qq-realrun.ts`（只读快照/回合延迟/重复空回复/成本/事实/同意 → 报告）+ `scripts/qq-longrun-watch.ts` + `npm run qq:watch`，结束写 `data/realrun-*.md`（含对话原文，600 权限）；支持 `--once --since <时间>` 随时复盘历史并标记「AI 披露未确认/空回复/重复/无成本记录」。首轮真机（3 轮）暴露并修复：①老用户 session 非空导致 AI 披露被跳过 → 改为按 `user_consent.disclosure_acked_at` 补发（`shouldSendDisclosure`），披露/`/about` 文案改用当前人设名；②消息门未把当前消息计入「5 分钟连续跟进」，18s 后的追问被随机延迟 31 分钟 → `buildGateContext` 修正并补回归测试；③第二轮真机发现「问怎么认识」时编造具体场景 → prompt 增加确定性反编造规则 + 单测。测试 69 文件 / 687 用例。
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
- 主动消息：四条链路 + 单日上限 4 条 + 间隔 30 分钟 + 连推 2 条收手；`/pause`/`/resume`、免打扰时段、`/why` 决策原因已可用；**深夜被消息门延迟的主动冲动不会在早上重发**；仍不能按用户自定义频率
- 语义检索：**v0.5 已默认本地向量**（Qwen3-Embedding-0.6B，`KAREN_EMBED=on`，服务见 `services/embed/`）；服务不可用时自动降级 n-gram + 仍可选的 DeepSeek 重排。遥测：检索 p95 <100ms；金标（40 条）live 加表述规则后 95–100%（无规则 85–92.5%），离线 recall@8 97.5%；**同代码单次波动可达 7+ 个点，只报区间**
- 记忆 v2 待补：静态 prompt 精简（**已评估：当前 2298 字符≈1400 tokens，且静态块有缓存，压缩收益 <5%，判定不做**）；锚点复筛的"该记而漏记"率需真实数据积累后回看
- 记忆仍缺：语义级重复的**改写**（句式检测/提醒已有，但 9 次 A/B 未测出稳定效果）；真实长期数据的 T3 摘要质量需按周抽检；本地向量已默认启用；剩余改进见 docs/MEMORY_AI_TONE_AUDIT.md §6
- 旁路 LLM 调用（事实抽取/独白/T3/herView/日志/叙事/视觉/配图搜索词）已统一经 `ai/aux-usage.ts` 计入 `llm_usage`，`/cost` 有按用途拆分
- 真实 QQ 长跑首轮已跑通（2 个完整回合、成本约 ¥0.0057）；另用本地模拟用户 + 真实模型跑过 30 轮（记忆 6/6、复读对 0、错误 0、平均延迟 2047ms、成本 ¥0.147）。已修复「快速追问被误延迟」；AI 披露按用户偏好默认关闭（显式开启才补发）。仍需更多**真实 QQ**样本才算长期稳定
- 成本统计为估算：峰谷价按工作日/周末近似（节假日可能高估），provider 不返回 usage 的调用不记录（不估算）
- 日志正文默认脱敏（`[redacted N chars]`；`LOG_CONTENT=1` 输出 40 字预览），但仍有较多直接 console.log、未全部改结构化 logger
- 贴纸 11 个内置 Twemoji（私聊+群聊）；出站 mface/收藏表情未做
- 发图 15 张本地兜底 + 约 110 条配文（Unsplash Key 未配置）；仍有「同类场景」重复感；群聊发图需 `group_photo_enabled: true`（默认关）；夜间发图由免打扰门控
- Web 控制台只读、仅本机；默认只展示主用户，`web_all_owners: true` 可只读切换其他 owner（会话/时间线/记忆按 owner 隔离）；单 owner JSON 导出已可用（`/api/export`），删除/暂停等写操作仍无；token 在 URL query 可见（后续可改 fragment）；多人设搜索仍受 getCurrentPersona 单例约束
- 语音：只有 TTS（她发语音），**没有 ASR**（用户发来的语音只当 `[语音]` 占位）；TTS 依赖 macOS `say`（Linux/Windows 自动降级为文字）；群聊语音未接线（`voice_group_enabled` 目前只影响决策层，私聊才真正发送）；QQ 真实语音条（SILK）只在真实 QQ 上验证过一次手工链路，mock OneBot 已覆盖协议形态
- 打错字撤回：依赖 NapCat 对 `send_private_msg` 的 echo（拿 message_id）；echo 丢失/旧版本可能降级为「错字+更正」并存；群聊未接线
- 多实例商用托管待做
- 测试覆盖率有基线但仍偏低（行 59.21%，`npm run test:coverage` 阈值守护）；lint 是 tsc 未使用代码检查（零依赖），不是完整 ESLint 规则集
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
2. **隐私表述**：本地存储 ≠ 数据不出本机。对话与图片都发 DeepSeek、天气发 OpenWeatherMap、图库 query 发 Unsplash；语义嵌入默认本机（不出网），仅显式配 Qwen Key 才上云；不要写「数据不上传」。
3. **改动边界**：`data/`、`.env`、`config.yaml` 是运行时文件，不进仓库；不要手改 lock 文件；不提交密钥。
4. **测试**：新增逻辑配套 vitest 单测；提交前 `npm run typecheck && npm test`。测试被 tsconfig 排除，类型问题需单独跑 typecheck。
5. **不要基于死代码/未接线模块写宣称**：`router/*`、`data/state.ts`、`world/info-sphere.ts`、`impulse/trigger.ts`、`t2_vec`、`node-cron`、`downloadImageAsBase64`、`CategoryRAG`、`persona.md` 等。
6. **平台约束**：QQ 桥接 Windows/macOS 均已实机验证；微信桥接是无依赖占位桩。
7. **阶段纪律**：M0 地基已固定（新装可用/不丢消息/安全/异常兜底）；M1 优先「状态持久化 → 关系成长 → 演化可见」，M2 才做产品化与 Web 控制台。

## 相关文档

- [docs/COVERAGE_AUDIT.md](docs/COVERAGE_AUDIT.md) — **能力覆盖审计**：宣称/单测/真实链路三层核对 + 诚实的未验证清单
- [docs/VERIFICATION_PLAYBOOK.md](docs/VERIFICATION_PLAYBOOK.md) — **验证手册**：六层验证、真实链路冒烟模板与断言原则、新增功能验证清单、10 个真实 bug 目录、踩坑记录
- [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) — **能力与实测总表**（每个能力 → 代码位置 → 实测数字 → 已知弱项；v0.5–v0.8 全部能力）
- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) — 产品审计报告：功能清单、文档差异、P0/P1 风险、M0–M3 路线图、附录 B 最小修复清单
- [docs/DEEPSEEK_CAPABILITY_AUDIT.md](docs/DEEPSEEK_CAPABILITY_AUDIT.md) — DeepSeek V4 能力审计：思考模式/视觉/缓存/价格/不支持能力/本项目配置建议
- [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md) — macOS/Windows/Linux QQ 桥接方案、原生 NapCat/Docker/SSH 隧道、安全基线
- [docs/M1_BACKLOG.md](docs/M1_BACKLOG.md) — 真机联调问题与已批准修复清单
- [docs/TECH_RADAR_AI.md](docs/TECH_RADAR_AI.md) — AI/记忆/RAG/评测技术雷达（换什么/不换什么）
- [docs/TECH_RADAR_INFRA.md](docs/TECH_RADAR_INFRA.md) — IM/多模态/前端/基础设施技术雷达
- [docs/LONGRUN_REGRESSION.md](docs/LONGRUN_REGRESSION.md) — 30 轮真实模型长跑回归（记忆/事实/AI 味/延迟/成本）
- [docs/LONGRUN_V08_ANALYSIS.md](docs/LONGRUN_V08_ANALYSIS.md) — **v0.5–v0.8 全链路回归分析**（21 轮×3 对照：P0 编造修复、多媒体 2/5→4/5、长程复读、延迟归因）
- [docs/M2_PRODUCT_PLAN.md](docs/M2_PRODUCT_PLAN.md) — M2 产品化方案（A 首次引导 2.0、B 人设包 v2、C 多用户只读 Web 已实施）
- [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md) — 发布准备：干净 checkout 复验、仓库卫生、Release Note 草案与待拍板事项
- [docs/QQ_REAL_RUN.md](docs/QQ_REAL_RUN.md) — 真实 QQ 长跑验证流程、首轮结果与修复记录
- [docs/PERSONA_PACK.md](docs/PERSONA_PACK.md) — 人设包 v2 规范（manifest/素材/记忆种子/CLI/限制）
- [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md) — mock-OneBot 桥接端到端测试（披露/年龄门/私聊/图片/群聊）
- [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md) — 真实验证台（mock OneBot + 真实 DeepSeek + 临时目录）：多轮指标、真人感问题与优化记录
- [docs/PROACTIVE_CHANNELS.md](docs/PROACTIVE_CHANNELS.md) — 主动消息四条链路、护栏、配置、`/why` 输出与离线模拟结果
- [docs/VOICE_QUALITY.md](docs/VOICE_QUALITY.md) — 语音「像 AI」的三条根因、语气润色的实测数据、试听与换音色、神经 TTS 路线评估
- [docs/ANCHOR_EVAL_REPORT.md](docs/ANCHOR_EVAL_REPORT.md) — 锚点复筛评测（30 条金标、四次运行、误判明细与结论）
- [docs/IMAGE_GEN.md](docs/IMAGE_GEN.md) — 本机生图（diffusers 服务/目录治理/开关/**hf-mirror+Xet 禁用+分块下载**实测方案）
- [docs/MEMORY_V2_PLAN.md](docs/MEMORY_V2_PLAN.md) — 记忆与拟人化重构方案（v0.5 已落地部分 + 下一阶段待办）
- [docs/PROMPT_BUDGET.md](docs/PROMPT_BUDGET.md) — Prompt 预算离线审计：真实 `llm_usage` 分位（对话轮 p50 2241 / p95 2864 tokens）、系统提示词分段占比、6 条优化建议
- [docs/RESEARCH_REFERENCE.md](docs/RESEARCH_REFERENCE.md) — 同类项目调研（GitHub AI 伴侣 / QQ Bot 可借鉴设计）
- [docs/MEMORY_AI_TONE_AUDIT.md](docs/MEMORY_AI_TONE_AUDIT.md) — 记忆与 AI 味专项审计（存储/上下文/压力测试/优化点）
- [README.md](README.md) — 对外介绍、功能状态表、隐私与安全、已知限制
- [QUICKSTART.md](QUICKSTART.md) — 5 分钟安装与故障排查
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南（注意：部分规则尚未与代码对齐，以 `npm run persona:check` 为准）
