# karen-persona 项目总控

> 最后更新：2026-10（M1 核心体验闭环阶段）
>
> **单一事实源**：功能现状与路线图以 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) 为准；对外表述以 [README.md](README.md) 为准。
> 原则：**宁少说，不夸大**。文档里的每个功能宣称都必须能在代码中找到对应；不确定的写成「半成品 / 规划中」，绝不把设计目标写成已实现。

## 项目概述

QQ 里的 AI 虚拟人。定位是「通讯录里住进一个有自己生活、情绪、记忆和社交圈的人」，而不是一个问答助手。

当前阶段：**M1 核心体验闭环（2026-10）**。M0 地基已修复完成（新装可用、不丢消息、安全加固、文档真话）；M1 正在让「她真的会变化」成立：状态持久化、关系成长、演化可见化。M1/M2 路线见审计报告第 5 节。

## 技术栈（如实）

- **运行时**：Node.js 22+（`engines: >=22`）、TypeScript 5.6（strict，NodeNext）、tsx 直跑 TS、vitest 4
- **对话模型**：DeepSeek V4.1 `deepseek-flash` / `deepseek-v4-pro`，按复杂度规则路由（真实主路径；`deepseek-v4-flash` 是仍可调用的旧别名）
- **图片识别**：DeepSeek Flash 多模态（真实，用同一个 DEEPSEEK_API_KEY；先下载图片转 base64，兼容 NapCat 私有 URL；`detail=low`）
- **思考模式**：默认关闭（`thinking:{type:"disabled"}`）；不关闭时 reasoning 会吃掉 max_tokens 导致空回复（2026-10 实测修复）
- **语义嵌入**：Qwen `text-embedding-v3` 代码已实现，**但未接入主路径**；当前实际使用字符 n-gram 哈希（`src/data/embedding.ts`）
- **向量库**：`sqlite-vec` 已引入并建 `t2_vec` 表，**检索实际是 JS 层全量 JSON 解析 + 余弦**，未使用 sqlite-vec
- **存储**：better-sqlite3（T1/T2 记忆）+ 会话 JSON + 人设 JSON/YAML
- **外部世界**：OpenWeatherMap（真实天气，可选）、时间感知（结构化标签）；网络热点是硬编码话题池
- **桥接**：NapCatQQ（Windows 已验证 v4.18.4，官方最新 v4.18.38）+ OneBot 11 反向 WebSocket；macOS 原生 NapCat / Linux Docker 方案见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md)；微信 = wechaty echo 桩（规划中）
- **工程**：GitHub Actions CI（`npm ci` → typecheck → test）、`npm run doctor` 环境体检、Dockerfile（node:22-slim/非 root）、PM2 配置
- **不存在的**：TTS、图片生成（即梦）、真实语义向量检索、Web 控制台、多用户隔离

## 架构（十个域）与当前状态

图例：✅ 主路径可用 ｜ 🚧 半成品/有限 ｜ 🗺 规划中/未实现

| # | 域 | 状态 | 现状与证据 |
|---|---|---|---|
| 1 | 消息桥接 `src/bridge` | ✅/🚧 | QQ 私聊流式回复可用（`qq.ts`）；群聊仅 @ + 私聊过的人（半成品）；M0 已加固：默认监听 `127.0.0.1`、token/path 校验、`ALLOWED_USERS` 白名单、CQ 注入转义与超长切分、message_id 去重、延迟回复落库补发、进程级异常兜底；`scripts/mock-onebot.mjs` 支持无 QQ 端到端联调；Windows 已实机验证，macOS 原生 NapCat/Docker 方案见 docs/QQ_BRIDGE_CROSS_PLATFORM.md（未实机验证）；微信仅 echo 桩 🗺 |
| 2 | 消息路由 `src/router` | 💀/🚧 | `router/classifier.ts`、`router/session.ts` 未被主路径引用（死代码）；实际合并窗口在 `bridge/qq.ts`、复杂度分级在 `ai/router.ts` |
| 3 | 响应管线 `src/pipeline` | 🚧 | 双管线：`processMessage`（完整，CLI/群聊）/ `processMessageStream`（精简，QQ 私聊）。M0 已统一门控上下文（`buildGateContext`）与延迟消息落库/补发；记忆写入与其余演化步骤的统一在 M1 继续 |
| 4 | 人设引擎 `src/persona` | 🚧 | 六层 schema、校验器、Prompt 静态缓存 + 动态组装可用；未消费字段多（审计 2.3）；负债偿还、纠正层、社交分寸未闭环 |
| 5 | 演化引擎 `src/evolution` | 🚧 | 基线漂移/因果链/叙事重构/进化日志代码存在，但多数未接 QQ 主路径、状态不持久化（重启归零） |
| 6 | 冲动引擎 `src/impulse` | 🚧 | 消息门可用；延迟回复已在 M0 落库+补发；沉默弧线/tone 链/撤回仅有限生效 |
| 7 | 外部世界 `src/world` | ✅/🚧 | 天气 API（M0 已修复中英文 condition 映射与缓存）与时间感知可用；热点为硬编码话题池；信息圈层穿透是死代码 |
| 8 | AI 引擎 `src/ai` | ✅/🚧 | DeepSeek 非流式/流式、复杂度路由、Flash 多模态视觉可用；M0 已加固超时/429/5xx 指数退避重试/usage 记录；M1 关闭思考模式（修复空回复）、模型名 canonical、旁路 LLM 调用统一 thinking 参数；语义嵌入未接线；TTS/即梦 🗺 |
| 9 | 记忆与数据 `src/data` | 🚧 | SQLite 存储 + 艾宾浩斯衰减可用；M0 修复 data 目录自动创建、embedding 列迁移、`KAREN_DATA_DIR`；检索是 n-gram 非语义；多用户隔离未完成；T1/T3 链路不完整 |
| 10 | 质量评估 `src/eval` + 测试 | ✅/🚧 | 21 个测试文件 / 330 个用例通过（M0/M1 新增 data/pipeline/bridge/weather/relationship/state/journal/ai 测试），`tsc --noEmit` 0 错误，CI 已接入；仍缺真实 QQ 集成测试与覆盖率；eval 多为实验代码、无产品入口，历史对外指标（99/100、Recall 99.4% 等）**不可复现，禁止再引用** |

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
- **工程化**：`.github/workflows/ci.yml`（Node 22 + `npm ci` + typecheck + test）、`.dockerignore`、Dockerfile 改为 node:22-slim / Asia/Shanghai / 非 root、`ecosystem.config.js` 补 `cwd` 与启动方式说明
- **开发者体验**：新增 `npm run doctor`（Node/config/Key/人设/数据目录/SQLite 六项检查 + 修复建议）；`engines` 统一为 `>=22`
- **地基修复（M0-1/2/3）**：数据目录自动创建与 embedding 列迁移、`KAREN_DATA_DIR`；`loadConfig` 返回并校验 `user_personas` / `one_bot_*` / `allowed_users`，端口统一 18080；消息门延迟消息落库与到点补发（新消息取消待补发）、连续沉默 3 次强制回复；主动消息单日上限 4 条 + 最小间隔 30 分钟；LLM 显式超时 + 仅 429/5xx 指数退避重试 + usage 记录；天气中英文映射与 30 分钟缓存；WS 默认回环 + token/path 校验 + 白名单 + CQ 转义 + 去重 + 异常兜底
- **验证**：`npm run typecheck` 0 错误；`npm test` 21 文件 / 330 用例通过（审计基线为 11 文件 / 178 用例）

### M1 落地内容（2026-10 进行中）

- **M1-1 状态持久化**：新增 `src/data/state-store.ts`（`persona-state-<persona>.json`，原子写 + 容错归一化）。情绪/负债/基线漂移/沉默状态/因果链/叙事弧/herView/主动消息计数/天气快照/关系状态在重启后恢复；两个管线与主动消息都会落盘；端到端实测重启后亲密度/情绪/事件保持。
- **M1-2 关系成长**：新增 `src/persona/relationship.ts`。亲密度由结构性事件驱动（深度对话、连续互动、主动分享生活细节），每日上限 +0.1、只增不减、带 reason 与里程碑（开始熟络/开始在意/很亲近/重要的人）；运行时同步到 `persona.relationship.closeness`（门控/发图/herView 等立即生效）；`/stats` 展示亲密度、连续互动、关系事件与里程碑。
- **M1-3 演化可见化**：新增 `src/evolution/journal-view.ts` + CLI 命令 `/journal`（她的独白/进化日志/T3 摘要）、`/timeline`（关系事件与里程碑）、`/herview`（她眼中的你）、`/evolution`（心理阶段/漂移/情绪/关系）。数据来自持久化快照与 T2，重启后可见。
- **DeepSeek 能力落地**：思考模式默认关闭（修复「空回复/半句话」生产 bug，实测 reasoning=0）；模型名 canonical；图片识别从 Qwen-VL 切换到 DeepSeek Flash（同一个 Key、先下载转 base64 兼容 NapCat 私有 URL、`detail=low`）；旁路 LLM 调用（独白/T3/日志/herView/发图 query）统一注入 thinking 参数；prompt 缓存可命中（静态人设前缀）。
- **端到端实测（真实 Key）**：3 轮真实对话回复自然、无空回复；第 2 轮命中缓存 768 tokens；关系事件正确触发（3.00→3.05）并重启保持。成本 <¥0.1。

### 已知问题（M0 之后继续修）

- 双管线仍不对等：QQ 私信缺少部分演化/表达步骤（M0-6 部分统一，M1 继续）
- 演化模块尚未全部接入 QQ 流式主路径（herView/叙事/独白等仍只在完整管线生效）
- 多用户隔离未完成：会话/记忆按人设隔离，同一人设多好友共享（架构级）
- 主动消息：M0 已加单日上限 4 条、两次最小间隔 30 分钟、连续沉默 3 次强制回复；仍无免打扰/暂停开关（M1-4）
- 记忆检索是 n-gram，非语义；sqlite-vec 未启用（M1-7）
- 测试覆盖率低；无 lint/coverage
- QQ 桥接跨平台验证不完整（Windows 已验，macOS 方案已文档化但未实机验证）；平台/封号风险是结构性风险
- 隐私合规缺口：无 AI 披露、年龄门、危机干预；QQ 桥接日志已脱敏（只打印长度/摘要），但 orchestrator 等其他模块仍可能打印消息片段

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
6. **平台约束**：QQ 桥接 Windows 已实机验证；macOS 按 docs/QQ_BRIDGE_CROSS_PLATFORM.md 的原生 NapCat 方案推进（未实机验证）；微信桥接是桩。
7. **阶段纪律**：M0 地基已固定（新装可用/不丢消息/安全/异常兜底）；M1 优先「状态持久化 → 关系成长 → 演化可见」，M2 才做产品化与 Web 控制台。

## 相关文档

- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) — 产品审计报告：功能清单、文档差异、P0/P1 风险、M0–M3 路线图、附录 B 最小修复清单
- [docs/DEEPSEEK_CAPABILITY_AUDIT.md](docs/DEEPSEEK_CAPABILITY_AUDIT.md) — DeepSeek V4 能力审计：思考模式/视觉/缓存/价格/不支持能力/本项目配置建议
- [docs/QQ_BRIDGE_CROSS_PLATFORM.md](docs/QQ_BRIDGE_CROSS_PLATFORM.md) — macOS/Windows/Linux QQ 桥接方案、原生 NapCat/Docker/SSH 隧道、安全基线
- [README.md](README.md) — 对外介绍、功能状态表、隐私与安全、已知限制
- [QUICKSTART.md](QUICKSTART.md) — 5 分钟安装与故障排查
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南（注意：部分规则尚未与代码对齐，以 `npm run persona:check` 为准）
