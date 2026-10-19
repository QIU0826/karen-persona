# karen-persona 项目总控

> 最后更新：2026-10（M0 地基修复阶段）
>
> **单一事实源**：功能现状与路线图以 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) 为准；对外表述以 [README.md](README.md) 为准。
> 原则：**宁少说，不夸大**。文档里的每个功能宣称都必须能在代码中找到对应；不确定的写成「半成品 / 规划中」，绝不把设计目标写成已实现。

## 项目概述

QQ 里的 AI 虚拟人。定位是「通讯录里住进一个有自己生活、情绪、记忆和社交圈的人」，而不是一个问答助手。

当前阶段：**M0 地基修复（2026-10）**。目标是把「新装 → 能聊 → 不丢数据」跑通，并把文档改成真话；**M0 完成前不加新功能**。M0 之后的 M1/M2 路线见审计报告第 5 节。

## 技术栈（如实）

- **运行时**：Node.js 22+（`engines: >=22`）、TypeScript 5.6（strict，NodeNext）、tsx 直跑 TS、vitest 4
- **对话模型**：DeepSeek V4 `deepseek-v4-flash` / `deepseek-v4-pro`，按复杂度规则路由（真实主路径）
- **图片识别**：Qwen-VL Max（真实，需 `QWEN_VL_API_KEY` + NapCat 提供公网图片 URL）
- **语义嵌入**：Qwen `text-embedding-v3` 代码已实现，**但未接入主路径**；当前实际使用字符 n-gram 哈希（`src/data/embedding.ts`）
- **向量库**：`sqlite-vec` 已引入并建 `t2_vec` 表，**检索实际是 JS 层全量 JSON 解析 + 余弦**，未使用 sqlite-vec
- **存储**：better-sqlite3（T1/T2 记忆）+ 会话 JSON + 人设 JSON/YAML
- **外部世界**：OpenWeatherMap（真实天气，可选）、时间感知（结构化标签）；网络热点是硬编码话题池
- **桥接**：NapCatQQ v4.18.4 + OneBot 11 反向 WebSocket（Windows 验证）；微信 = wechaty echo 桩（规划中）
- **工程**：GitHub Actions CI（`npm ci` → typecheck → test）、`npm run doctor` 环境体检、Dockerfile（node:22-slim/非 root）、PM2 配置
- **不存在的**：TTS、图片生成（即梦）、真实语义向量检索、Web 控制台、多用户隔离

## 架构（十个域）与当前状态

图例：✅ 主路径可用 ｜ 🚧 半成品/有限 ｜ 🗺 规划中/未实现

| # | 域 | 状态 | 现状与证据 |
|---|---|---|---|
| 1 | 消息桥接 `src/bridge` | ✅/🚧 | QQ 私聊流式回复可用（`qq.ts`）；群聊仅 @ + 私聊过的人（半成品）；M0 已加固：默认监听 `127.0.0.1`、token/path 校验、`ALLOWED_USERS` 白名单、CQ 注入转义与超长切分、message_id 去重、延迟回复落库补发、进程级异常兜底；微信仅 echo 桩 🗺 |
| 2 | 消息路由 `src/router` | 💀/🚧 | `router/classifier.ts`、`router/session.ts` 未被主路径引用（死代码）；实际合并窗口在 `bridge/qq.ts`、复杂度分级在 `ai/router.ts` |
| 3 | 响应管线 `src/pipeline` | 🚧 | 双管线：`processMessage`（完整，CLI/群聊）/ `processMessageStream`（精简，QQ 私聊）。M0 已统一门控上下文（`buildGateContext`）与延迟消息落库/补发；记忆写入与其余演化步骤的统一在 M1 继续 |
| 4 | 人设引擎 `src/persona` | 🚧 | 六层 schema、校验器、Prompt 静态缓存 + 动态组装可用；未消费字段多（审计 2.3）；负债偿还、纠正层、社交分寸未闭环 |
| 5 | 演化引擎 `src/evolution` | 🚧 | 基线漂移/因果链/叙事重构/进化日志代码存在，但多数未接 QQ 主路径、状态不持久化（重启归零） |
| 6 | 冲动引擎 `src/impulse` | 🚧 | 消息门可用；延迟回复已在 M0 落库+补发；沉默弧线/tone 链/撤回仅有限生效 |
| 7 | 外部世界 `src/world` | ✅/🚧 | 天气 API（M0 已修复中英文 condition 映射与缓存）与时间感知可用；热点为硬编码话题池；信息圈层穿透是死代码 |
| 8 | AI 引擎 `src/ai` | ✅/🚧 | DeepSeek 非流式/流式、复杂度路由、Qwen-VL 可用；M0 已加固超时/429/5xx 指数退避重试/usage 记录；语义嵌入未接线；TTS/即梦 🗺 |
| 9 | 记忆与数据 `src/data` | 🚧 | SQLite 存储 + 艾宾浩斯衰减可用；M0 修复 data 目录自动创建、embedding 列迁移、`KAREN_DATA_DIR`；检索是 n-gram 非语义；多用户隔离未完成；T1/T3 链路不完整 |
| 10 | 质量评估 `src/eval` + 测试 | ✅/🚧 | 16 个测试文件 / 270 个用例通过（M0 新增 data/pipeline/bridge/weather 测试），`tsc --noEmit` 0 错误，CI 已接入；仍缺真实 QQ/LLM 集成测试与覆盖率；eval 多为实验代码、无产品入口，历史对外指标（99/100、Recall 99.4% 等）**不可复现，禁止再引用** |

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

- **文档真话 pass**：README/QUICKSTART 按实际代码重写；隐私声明修正为「数据本地存储，但对话会发给 DeepSeek、图片会发给 Qwen」；删除「数据不上传」「语义嵌入主路径」「sqlite-vec 检索」「延迟回复已实现」「不同好友不同人设已生效」「133 tests」等不实/过时表述
- **许可证**：新增 MIT `LICENSE`（© 2026 QIU0826）
- **工程化**：`.github/workflows/ci.yml`（Node 22 + `npm ci` + typecheck + test）、`.dockerignore`、Dockerfile 改为 node:22-slim / Asia/Shanghai / 非 root、`ecosystem.config.js` 补 `cwd` 与启动方式说明
- **开发者体验**：新增 `npm run doctor`（Node/config/Key/人设/数据目录/SQLite 六项检查 + 修复建议）；`engines` 统一为 `>=22`
- **地基修复（M0-1/2/3）**：数据目录自动创建与 embedding 列迁移、`KAREN_DATA_DIR`；`loadConfig` 返回并校验 `user_personas` / `one_bot_*` / `allowed_users`，端口统一 18080；消息门延迟消息落库与到点补发（新消息取消待补发）、连续沉默 3 次强制回复；主动消息单日上限 4 条 + 最小间隔 30 分钟；LLM 显式超时 + 仅 429/5xx 指数退避重试 + usage 记录；天气中英文映射与 30 分钟缓存；WS 默认回环 + token/path 校验 + 白名单 + CQ 转义 + 去重 + 异常兜底
- **验证**：`npm run typecheck` 0 错误；`npm test` 16 文件 / 270 用例通过（审计基线为 11 文件 / 178 用例）

### 已知问题（M0 之后继续修）

- 双管线仍不对等：QQ 私信缺少部分演化/表达步骤（M0-6 部分统一，M1 继续）
- 演化状态不持久化；`closeness` 运行时不变（M1-1/M1-2）
- 多用户隔离未完成：会话/记忆按人设隔离，同一人设多好友共享（架构级）
- 主动消息：M0 已加单日上限 4 条、两次最小间隔 30 分钟、连续沉默 3 次强制回复；仍无免打扰/暂停开关（M1-4）
- 记忆检索是 n-gram，非语义；sqlite-vec 未启用（M1-7）
- 测试覆盖率低；无 lint/coverage
- Windows-only QQ 桥接；平台/封号风险是结构性风险
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
2. **隐私表述**：本地存储 ≠ 数据不出本机。对话发 DeepSeek、图片发 Qwen（DashScope）、天气发 OpenWeatherMap、图库 query 发 Unsplash；不要写「数据不上传」。
3. **改动边界**：`data/`、`.env`、`config.yaml` 是运行时文件，不进仓库；不要手改 lock 文件；不提交密钥。
4. **测试**：新增逻辑配套 vitest 单测；提交前 `npm run typecheck && npm test`。测试被 tsconfig 排除，类型问题需单独跑 typecheck。
5. **不要基于死代码/未接线模块写宣称**：`router/*`、`data/state.ts`、`world/info-sphere.ts`、`impulse/trigger.ts`、`t2_vec`、`node-cron`、`downloadImageAsBase64`、`CategoryRAG`、`persona.md` 等。
6. **平台约束**：QQ 桥接仅在 Windows 验证，不承诺跨平台；微信桥接是桩。
7. **阶段纪律**：M0 完成前优先修地基（新装可用、不丢消息、安全、异常兜底），不要加新功能。

## 相关文档

- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) — 产品审计报告：功能清单、文档差异、P0/P1 风险、M0–M3 路线图、附录 B 最小修复清单
- [README.md](README.md) — 对外介绍、功能状态表、隐私与安全、已知限制
- [QUICKSTART.md](QUICKSTART.md) — 5 分钟安装与故障排查
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南（注意：部分规则尚未与代码对齐，以 `npm run persona:check` 为准）
