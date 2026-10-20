# Karen Persona — 产品审计报告

> 审计对象：`QIU0826/karen-persona`（master，最后提交 2026-07-05，共 3 个 commit）
> 审计方式：全量静态代码精读 + 8 个领域并行深挖 + 文档逐条核对 + 调用链/引用图分析 + 关键结论实测复现。
> 运行时状态：已用内置 Node 24 + pnpm 完成依赖安装并实测——**`tsc --noEmit` 通过（0 错误）、178 个测试全部通过（11 文件，210ms）**；**P0-1（data 目录缺失 → CANTOPEN）与 P0-2（t2 表缺 embedding 列 → SQLITE_ERROR）均已复现**。macOS 上 better-sqlite3 11.10 无 Node 24 预编译包，需升级到 12.11+（12.11.1 实测可加载）。
> 图例：✅ 已实现且在主路径可用 ｜ 🟡 已实现但有明显限制/瑕疵 ｜ 🔴 半成品或未接入主路径 ｜ 💀 死代码/无调用 ｜ 📄 仅文档宣称

---

## 后记：M0 地基修复已完成（2026-10-19）

本报告是当天的审计快照。审计后已按第 5 节 M0 清单完成地基修复，并通过实测验证：

| 审计项 | 当前状态 |
|---|---|
| P0-1 无 `data/` 目录 → CANTOPEN | ✅ 已修：`src/data/paths.ts` 自动建目录，支持 `KAREN_DATA_DIR` |
| P0-2 `t2_episodes` 缺 `embedding` 列 | ✅ 已修：新库建表包含该列；旧库 `PRAGMA user_version` + 幂等迁移 |
| P0-3 缺 config 引导 / 端口不一致 | ✅ 已修：README/QUICKSTART 补 `cp` 步骤，QQ 默认端口统一 18080 |
| P0-4 `user_personas` 被丢弃 | ✅ 已修：`loadConfig` 返回并校验；但同人设多好友仍共享数据（M1 架构级） |
| P0-5 WS 无鉴权/绑 0.0.0.0 | ✅ 已修：默认 127.0.0.1 + path/token 校验 + `ALLOWED_USERS` 白名单 |
| P0-6 CQ 注入 | ✅ 已修：出站转义 + 仅放行受控 qqFace |
| P0-7 群聊未 await / 畸形事件崩溃 | ✅ 已修：await + try/catch + 事件字段容错 + 进程级异常兜底 |
| P0-8 延迟消息被吞 | ✅ 已修：延迟消息落库 + 到点补发（新消息取消待补发）；连续沉默 3 次强制回复 |
| P0-9 流式降级重复 | ✅ 已修：已发送过内容则不再降级重跑 |
| P1 天气英文/中文不匹配 | ✅ 已修：`mapOwCondition` 中英映射 + 30 分钟缓存 |
| P1 LLM 无超时/重试风暴 | ✅ 已修：30s 超时（`LLM_TIMEOUT_MS`）、仅 429/5xx/网络错误指数退避、usage 记录 |
| P1 主动消息无上限 | ✅ 部分修：单日 4 条上限 + 30 分钟最小间隔；免打扰/暂停仍待 M1 |
| 文档真话 | ✅ 已修：README/QUICKSTART/CLAUDE 重写，隐私/嵌入/sqlite-vec/测试数等按实际代码表述 |
| 工程门槛 | ✅ 部分补：LICENSE、CI（Node 22）、`.dockerignore`、`npm run doctor`；lint/覆盖率仍缺 |

**M0 验证结果（2026-10-19）**：`tsc --noEmit` 0 错误；`npm test` **16 文件 / 270 用例全部通过**；全新目录 + `npm run doctor` 6/6 ✅；CLI 首启不再崩溃（无 Key 时优雅提示）；QQ 桥接冒烟：绑定 `127.0.0.1:18099`、白名单生效、SIGTERM 清理正常。

**M1 追加进度（2026-10-19 晚间）**：
- M1-1 状态持久化 ✅（`src/data/state-store.ts`；重启后情绪/负债/漂移/因果链/叙事弧/herView/关系/计数/天气恢复，真实端到端已验证）
- M1-2 关系成长 ✅（`src/persona/relationship.ts`；结构性事件驱动、每日上限、里程碑、`/stats` 可见；实测 3.00→3.05 且重启保持）
- M1-3 演化可见化 ✅（`/journal` `/timeline` `/herview` `/evolution`，21 文件/330 测试）
- DeepSeek 能力审计与落地 ✅（思考模式默认关闭修复空回复；图片识别改 DeepSeek Flash；模型名 canonical；旁路 LLM 调用统一 thinking；prompt 缓存命中实测）
- 跨平台 QQ 桥接方案 ✅ 文档化（`docs/QQ_BRIDGE_CROSS_PLATFORM.md` + `deploy/napcat-macos`/`napcat-windows` + `scripts/mock-onebot.mjs`；mock 全链路实测通过；macOS 原生 NapCat 未实机扫码验证）
- 真机联调（2026-10-19 深夜）：NapCat 原生 macOS → Karen → DeepSeek 全链路跑通；图片识别/缓存/流式正常；已修复 BUG-1（关系误判）、BUG-2（延迟队列持久化）、IMP-1（图片描述过短），并新增免打扰配置；问题清单见 docs/M1_BACKLOG.md。
- M1-7 记忆检索 P0 完成：n-gram + FTS5 BM25 RRF 混合、sqlite-vec 启用、语义 embedding 双列（需 Qwen Key 实跑）、真实库 schema v2 幂等迁移验证。测试数更新为 27 文件 / 386 用例。
- 记忆评测 + 反重复 + 检索修复（2026-10-20）：新增可复现记忆金标集（20 条中文 case，离线 recall@k / facts 注入 / anti-forget，报告 `docs/MEMORY_EVAL_REPORT.md`）；修复 `searchEpisodesByFts` 的 FTS5 隐式 AND 问题（自然问句 FTS 命中 0/20 → 20/20，T2 recall@8 40%→85%）；新增跨轮反重复（`src/persona/anti-repetition.ts`，默认只注入开头词，真实 A/B 见 `docs/MEMORY_AI_TONE_AUDIT.md` §4.1）；补上流式主路径遗漏的用户事实注入；Web 控制台新增「用户事实」「记忆命中回放」只读面板。测试数更新为 62 文件 / 649 用例。
- M2-A 首次引导 2.0（2026-10-20）：setup 变为「第一段对话」并写入会话/facts/consent/onboarding 标记；知情+18+ 确认前置；已完成跳过/--force 重设；CLI/QQ 首次聊天不再重复披露/年龄门。测试 62 文件 / 649 用例。
- 延迟补发 E2E + 跨库表缓存修复（2026-10-20）：免打扰延迟 → pending 落库 → 重启 bridge → 到点补发的端到端场景；cost-tracker/pending-queue 建表缓存改为按 DB 路径（修 no such table 警告）。测试 59 文件 / 634 用例。
- 多用户 prompt 隔离修复（2026-10-20）：动态风格参考检索缺 persona_id 过滤导致第二用户 prompt 混入第一用户对话 → 强制按 persona 过滤 + 单测/E2E 回归；E2E 另增白名单静默忽略、CQ 码出站转义场景。测试 59 文件 / 631 用例。
- mock-OneBot 桥接 E2E 扩展（2026-10-20）：新增 /about /age 命令、危机兜底（12356）、多用户隔离（两个 owner 的同意记录 + 两份 persona 记忆）+ 未确认年龄群聊拦截（负向断言）。测试 59 文件 / 629 用例。
- mock-OneBot 桥接 E2E（2026-10-20）：`src/eval/bridge-e2e.test.ts`（真实 bridge 子进程 + fake NapCat/DeepSeek），覆盖披露/年龄门/确认+聊天合并/私聊流式/图片视觉/群聊；抓到并修复「确认+下一句被合并吞掉」与私聊缓冲竞态 2 个真实 bug。测试 59 文件 / 626 用例。
- 修复后端到端复验（2026-10-20）：2 次 30 轮真实长跑，记忆 6/6、复读 0、错误 0；修复「记性没那么差」变体漏网（guard 整族匹配）与连发消息节流丢事实（排队合并，专项实测 5/5）；memory-eval live 复验 17/20、违规 0。测试 58 文件 / 623 用例。
- 工程加固（2026-10-20）：零依赖 lint（tsc 未使用代码检查，47 处清理，CI 接入）、覆盖率基线（@vitest/coverage-v8：行 51.9%，阈值守护）、日志正文默认脱敏（obs/safe-text，LOG_CONTENT=1 才预览）。测试 57 文件 / 619 用例。
- 30 轮真实长跑回归（2026-10-20）：记忆 6/6、复读对 0、错误 0、137 次调用 ¥0.0758；修复事实抽取质量（角色人设泄漏/模糊职业/丢细节 → prompt+接地校验）、记忆防御话术漏网（确定性 reply-guard）、小候选池无用重排；报告 docs/LONGRUN_REGRESSION.md。测试 56 文件 / 615 用例。
- 成本统计覆盖旁路 LLM（2026-10-20）：新增 aux-usage 统一记账（事实抽取/独白/T3/herView/日志/叙事/视觉/配图搜索词），带 kind；/cost 与 Web 控制台按用途拆分；仍为估算（节假日峰谷近似）。测试 54 文件 / 600 用例。
- 年龄门 18+ 确认（2026-10-20）：新增 consent 存储 + age-gate 纯函数；QQ 私聊首次对话披露+确认请求，未确认不进入对话、未成年明确拒绝、群聊未确认不回复；`/age` 查看；默认开启（CLI 不强制），仍是自我声明。测试 53 文件 / 596 用例。
- 群聊贴纸/发图（2026-10-20）：新增 group-reply 出站计划（文字/QQ表情/贴纸/可选照片）；群聊贴纸按「群+人」冷却；生活照默认不发群，`group_photo_enabled` 显式开启；`skipPhoto` 避免群聊无谓发图决策。测试 51 文件 / 582 用例。
- T3 摘要质量 + facts 上限（2026-10-20）：T3 prompt 加固并真实压缩抽检（40 条 → 1 条，事实/未完成话题保留、无编造）；facts 超 20 条改为分类配额选择（核心分类不被挤掉）。测试 50 文件 / 576 用例。
- 记忆时间感 + 事实变更历史（2026-10-20）：T2 检索结果带相对时间标签并注入 `- [3天前] …`；`user_facts` 值变化保留旧值（user_fact_history），注入显示「（之前是：X）」；Web 回放显示时间徽标。测试 50 文件 / 569 用例。
- 检索增强：DeepSeek 候选重排（2026-10-20）：DeepSeek 无 embedding 接口，改用 Flash 对 top12 候选做一次相关性重排（默认开启、可关闭、超时降级）；20 条金标 T2 recall@1 55%→95%、recall@8 85%→95%，~664ms/轮、~¥0.00025/轮；查询改写降精度不采用。报告 docs/SEMANTIC_BOOST_EVAL.md。真语义向量（Qwen/本地模型）仍可选。
- T1 状态弧 + T3 压缩调参（2026-10-20）：T1 快照压成「最近几轮的状态」注入三条回复路径（数值趋势、不引用正文）；T3 阈值 80→40 + 时间兜底 + dry-run，真实数据跑通一次（40 条 → 1 条摘要，线上 t3_summary 0→1）。
- 步骤 3 可观测最小闭环完成（结构化脱敏日志 + `/health` + `/cost` + PM2 dist）；测试数更新为 30 文件 / 419 用例。
- 步骤 4 表情/贴纸完成（入站 face/mface + 本地 11 个 Twemoji 出站贴纸；仅私聊）；测试数更新为 31 文件 / 429 用例。
- 步骤 5 Web 控制台 MVP 上线（只读四视图，127.0.0.1:18082）+ 主动发图接通 QQ（Unsplash 可选/本地图库兜底）；测试数更新为 35 文件 / 462 用例。
- 0 号依赖升级完成（better-sqlite3 13 N-API 预编译 + engines >=22.12 + 移除 wechaty/node-cron + CI 三平台矩阵）；测试数保持 35 文件 / 462 用例。
- M1 治理与数据主权完成（/why、/pause、/resume、/export）；测试数更新为 37 文件 / 471 用例。
- 合规最小版完成（AI 披露、18+ 提示、危机兜底、/about）；测试数更新为 38 文件 / 477 用例。
- 多用户隔离完成（owner=人设+用户+平台；主用户兼容历史数据，其他好友隔离）；测试数更新为 40 文件 / 485 用例。
- 双管线行为对齐完成（流式主路径补齐完整管线演化步骤；代码仍两份实现待抽取）；测试 40 文件 / 485 用例。
- 宣传页（promo）完成：双视频 hero + 黑色画廊 + 白场 CTA，`http://127.0.0.1:18082/promo/`，素材可配置。
- 仍未修复（M1 剩余）：语音、真实 QQ 长跑、商用多租户；M2 首次引导/评测待做。

---

## 0. 一页结论

**它是什么**：一个完成度相当高、设计野心很大的「QQ 里的 AI 虚拟人」个人项目。真正的技术资产是**人格分层结构 + 消息门 + 记忆衰减 + 主动生活流**这套设计，而不是某段 prompt。

**它现在能做什么**：在一台 Windows 机器上，配好 DeepSeek Key、QQ 小号、NapCatQQ 后，可以用 CLI 或 QQ 私聊与她进行碎片化聊天；她能看图、偶尔主动发消息、有自己的口头禅和情绪门控、有可被检索的对话记忆、有可创建/校验的自定义人设。

**它离「完美产品」有多远**：三条硬伤决定了它现在**更像作品集而不是产品**：

1. **新装即坏（阻断级，已实测复现）**：全新克隆后没有 `data/` 目录，SQLite 报 `Cannot open database because the directory does not exist`；手动建 `data/` 后，`t2_episodes` 表缺少代码正在读写的 `embedding` 列，`backfillEpisodeVectors()` 抛 `SQLITE_ERROR: no such column: embedding`。这两步正卡在 CLI/QQ 启动路径上，首次运行必崩，记忆/演化链路全断。作者本机显然有历史数据库，所以从未暴露。
2. **「人格/记忆/演化」的主卖点大部分没有闭环**：QQ 私聊主路径走的是精简版流式管线，跳过 6 个演化模块；所有演化运行时状态不落盘，重启即归零；亲密度 `closeness` 永远不变；多用户记忆/会话隔离实质失效；`user_personas` 配置被 `loadConfig` 丢弃，文档宣传的「不同好友不同人设」根本不存在。
3. **文档与实现系统性脱节**：语义嵌入实际全程用 n-gram 哈希；sqlite-vec 只建表不读写；「数据不上传」与实际调用 DeepSeek/Qwen 矛盾；测试数 133/178 两套；作品集里 99/100、Recall 99.4%、63.2% 等指标无法由当前代码复现。

**建议下一步**：先做 M0（约 3–5 天）：修新装、修配置、修安全、修消息丢失、修异常兜底、统一双管线、持久化状态。**在 M0 完成前不要加新功能**——现在每加一个功能，都建立在会丢消息、会串数据、重启归零的地基上。

---

## 1. 项目画像

### 1.1 基本信息

| 项 | 内容 |
|---|---|
| 仓库 | github.com/QIU0826/karen-persona（公开，0 star / 0 fork，无 Issue） |
| 许可证 | README/package.json 写 MIT，但**仓库无 LICENSE 文件**（GitHub 识别为无许可证） |
| 开发周期 | 2026-04 ~ 2026-07（3 个 commit：初版 / 质量评估+语气系统 / A/B 评测+文档） |
| 定位 | 「通讯录里住着一个有自己生活、情绪、记忆和社交圈的人」，仅个人情感疗愈用途 |
| 目标平台 | Windows 10/11 + QQ（NapCatQQ v4.18.4，OneBot 11 反向 WS）；macOS/Linux 仅 CLI |
| 核心主张 | 她不是服务你的工具，是一个独立的人：有底线、会变化、会主动、有记忆、数据本地 |

### 1.2 代码与资产统计（本次克隆实测）

| 资产 | 数量 |
|---|---|
| 源码（非测试 TS） | **61 文件 / 12,811 行** |
| 测试（TS） | **11 文件 / 2,014 行 / 178 个 `it/test`**（M0 后：**16 文件 / 270 用例**） |
| 文档 | **1,361 行**（README 226 / QUICKSTART 153 / CLAUDE 129 / PERSONA_GUIDE / docs 431） |
| 内置人设 | 3 个（小雅·回避型 / 苏迟·焦虑型 / 秋瑶·安全型），各含 persona.json + SKILL.md |
| 运行脚本 | 4 个 Windows `.bat/.ps1` |
| 依赖 | 9 运行时 + 4 开发；其中 `node-cron` **0 引用**、`wechaty` 仅 1 个 echo 桩文件 |
| 域规模 | persona 3,210 行・eval 2,955 行・evolution 1,956 行・impulse 1,884 行・bridge 1,306 行・pipeline 1,250 行・data 841 行・world 617 行・ai 361 行・router **23 行（全死）** |

### 1.3 架构与真实消息链路

```
QQ 好友消息
  → NapCatQQ ──反向 WS──→ src/bridge/qq.ts（WS Server，400ms 合并）
      → processMessageStream()                        ← QQ 私聊走这里（精简版）
          → 消息门（门上下文被写死：今日消息数=0、快速跟进=false）
          → 检索 T2 记忆（n-gram 哈希 KNN）
          → buildPrompt（静态人设块 + 动态状态/规则/脚本/关系）
          → DeepSeek V4 流式 → 标点断句 → 逐条发送（0.2–0.8s 间隔）
          → 写 T2 记忆 / T3 检查 / 进化日志检查
      └ 群聊 @ → processMessage()                     ← 群聊/CLI 走这里（完整版）
          → 情绪恢复→天气偏移→因果链→漂移→负债→消息门→纠正→RAG→L1裁决
          → 破例→Prompt→LLM→渲染→T1/T2/T3→独白→因果链回响→herView→Unsplash
      └ 每 15min 心跳 → processProactive()            ← 主动消息（4 类触发源）
```

**最重要的结构性事实：两条管线能力不对等。** `processMessage` 有 20+ 个演化/表达步骤；`processMessageStream`（QQ 私聊主路径）缺少漂移、叙事弧线、风格参考、herView、T1 快照、内心独白、因果链痕迹、纠正注入、发图，且消息门上下文写死。**用户 90% 的体验发生在功能更少的那条管线上。**

### 1.4 依赖的真实度

| 组件 | 文档宣称 | 实际 |
|---|---|---|
| 对话模型 | DeepSeek V4 flash/pro 自动路由 | ✅ 真实（模型名与官方 V4 一致，按复杂度路由） |
| 图片识别 | Qwen-VL Max | ✅ 真实（需 Key + NapCat 能给出公网图片 URL） |
| 嵌入 | Qwen text-embedding-v3 主 + n-gram 降级 | 🔴 主路径**从未调用**，全程 n-gram 哈希 |
| 向量库 | sqlite-vec | 🔴 `t2_vec` 只 CREATE，从不读写；实际是 JS 逐条 JSON.parse + 余弦 |
| 图片生成 | 即梦 | 📄 仅 `hasImageGenModel()` 读 Key，无生成实现 |
| TTS | Fish Audio | 📄 `.env.example` 有 Key 位，全仓 0 消费 |
| 微信 | Gewechat + wechaty | 🔴 仅 echo 桩（`wechaty.ts:20-31`） |

---

## 2. 已实现功能全清单

### 2.1 用户视角 Reality Check：她现在「真的能做到」什么

| 卖点（README/文档） | 实际状态 | 差距 |
|---|---|---|
| 「她在你的 QQ 通讯录里」 | 🟡 Windows + QQ 小号 + NapCat + 反向 WS + 端口配置，首次运行还会因 data/schema 崩溃 | 六道门槛 + 阻断 bug |
| 「她记得你说过的事」 | 🟡 有 T2 存储与检索，但检索是**字符 n-gram**而非语义；新库缺 `embedding` 列直接不可用 | 记忆链路半坏 |
| 「她会慢慢忘记」 | 🟡 有指数衰减，但衰减只在启动时执行一次；回忆会重置计时 | 半可用 |
| 「她有自己的生活、会主动找你」 | 🟡 有 15min 心跳与四类触发，但天气触发因中英文 bug 永不成立、因果链不推进；主动消息无日上限/静默开关 | 有，但不可控 |
| 「她不是永久配合，有底线」 | 🟡 有 L1 规则裁决 + 负债，但突破主要影响内部状态；负面话题分支实质 100% 不回 | 行为可感知，机制不可解释 |
| 「她会慢慢变化」 | 🔴 演化状态全在内存，重启归零；亲密度永不增长；herView 几乎不触发 | 卖点不成立 |
| 「她和你关系会变化」 | 🔴 `relationship.closeness` 全仓**无任何赋值**，永远等于 persona.json 初始值 | 关系系统是静态的 |
| 「不同 QQ 好友不同人设」 | 💀 `loadConfig()` 未返回 `user_personas`，配置被丢弃；内存/记忆也不隔离 | 功能不存在 |
| 「数据不上传云端」 | 🔴 对话、记忆摘要、人设都发往 DeepSeek；图片/嵌入发往阿里云 Qwen | 表述不实 |
| 「178 测试 / 编译零错误」 | 🟡 178 个用例真实存在，但只测纯函数；无 CI、无覆盖率、测试不在 `tsc` 范围 | 数字对，含金量有限 |
| 「流式碎片化回复」 | ✅ QQ 私聊可用，标点断句 + 打字间隔 + 中断检测 | 可用 |
| 「偶尔撤回 / 颜文字 / 语气词」 | 🔴 撤回无人消费；tone/颜文字只在 CLI 非流式生效 | 大部分未生效 |
| 「图片识别」 | 🟡 可用（需 Key + URL）；无下载/压缩/超时/缓存 | 有限可用 |
| 「主动发风景图」 | 🔴 只有 CLI 非流式会显示 URL；QQ 私聊/群聊都不发 | 端到端未实现 |
| 「群聊一对一陪伴」 | 🟡 仅 @她 + 你俩私聊过才回；不 @ 回复、不引用、与私聊共享状态 | 半成品 |
| 「微信桥接」 | 🔴 echo 桩，`npm run wechat` 不能聊天 | 未实现 |

### 2.2 十大域逐项清单

#### 域一：消息桥接（src/bridge）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 1-1 | OneBot 11 反向 WS 服务端 | `ws` Server + 事件分发 | 🟡 | `qq.ts:220-233`；**默认绑 0.0.0.0、任意 path、无 token** |
| 1-2 | 私聊接收 → 流式回复 | `processMessageStream` + 逐段发送 | ✅ | `qq.ts:399-538`；真实主路径 |
| 1-3 | 400ms 消息合并窗 | debounce 合并连续消息 | 🟡 | `qq.ts:120-158`；处理中新消息只重投首条，其余丢失 |
| 1-4 | 中断检测 | 用户新消息到达丢弃剩余 burst | 🟡 | `qq.ts:490-525`；已发片段不落库 |
| 1-5 | 限流 | 每分钟 N 条 | 🟡 | `qq.ts:109-118`；按「入站批次」而非出站条数；主动消息公用同一桶 |
| 1-6 | 入站图片识别 | Qwen-VL → `[图片：描述]` | 🟡 | `qq.ts:418-426`；只读 URL，无下载/压缩/超时 |
| 1-7 | 引用消息 | 拼接引用原文 + `get_msg` 回查 | 🟡 | `qq.ts:429-446`、`onebot.ts:212-231` |
| 1-8 | 群聊 @ 回复 | 仅 @ + 有私聊状态才回 | 🟡 | `qq.ts:551-617`；不 @ 回去、不引用、与私聊共 state |
| 1-9 | QQ 表情 CQ 码发送 | qqface 附在回复后 | 🟡 | `qq.ts:502-510`、`onebot.ts:117-130` |
| 1-10 | 断线重连 / 心跳 / 掉线通知 | ping + close 检测 + Windows 气泡 | 🟡 | `qq.ts:239-293`；无 pong 超时；通知仅 Windows |
| 1-11 | 语音消息 | 仅 `[语音]` 占位 | 🔴 | 无 ASR、无 TTS |
| 1-12 | 出站图片 | — | 💀 | `imageUrl` 在 QQ 路径被丢弃；`downloadImageAsBase64` 零调用 |
| 1-13 | 微信桥接 | wechaty echo | 🔴 | `wechaty.ts:20-31` |
| 1-14 | CLI 对话 | readline + 非流式 + `/stats /mood /weather` | ✅ | `test-bot.ts:75-135` |
| 1-15 | Setup 向导 | 对话式配置生成 | 🟡 | `setup.ts:55-226`；不收 Key、不测连通、提示不存在的 `setup:minimal` |

#### 域二：消息路由（src/router）

| # | 功能 | 实现 | 成熟度 | 证据 |
|---|---|---|---|---|
| 2-1 | 消息类型分类器 | 文件存在 | 💀 | `router/classifier.ts` 全仓 0 引用 |
| 2-2 | 会话管理 | 文件存在 | 💀 | `router/session.ts` 全仓 0 引用 |
| 2-3 | 复杂度分级（实际在跑） | 正则规则 → simple/normal/complex | ✅ | `ai/router.ts:50-83`；驱动 flash/pro 与 max_tokens |
| 2-4 | 400ms 合并窗口 | 实际写在 qq.ts | 🟡 | 同 1-3 |

#### 域三：响应管线（src/pipeline/orchestrator.ts，1,250 行）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 3-1 | 非流式完整管线 | 情绪→天气→因果链→漂移→负债→门→纠正→RAG→L1→破例→Prompt→LLM→渲染→T1/T2/T3→独白→herView→发图 | ✅ | `orchestrator.ts:334-719`；CLI、群聊使用 |
| 3-2 | 流式精简管线 | 门→RAG→Prompt→流式→T2/T3 | 🟡 | `orchestrator.ts:789-932`；少 10 个能力，门上下文写死 |
| 3-3 | 主动消息心跳 | 因果链/天气/情绪/时间 四源 + 概率门控 | 🟡 | `orchestrator.ts:940-1161`、`qq.ts:303-354`；无日上限、无重入锁 |
| 3-4 | 短期上下文 | 最近 8 条摘要注入 | 🟡 | `orchestrator.ts:1166-1180`；与 15 条 history 重复 |
| 3-5 | 中断信号注入 | 情境提示写入下轮 system | 🟡 | `orchestrator.ts:736-774` |
| 3-6 | 状态统计 | `/stats`：消息/记忆/情绪/负债/漂移/因果链/亲密度 | ✅ | `orchestrator.ts:1184-1207` |
| 3-7 | 流式失败降级 | 非流式兜底 | 🔴 | `orchestrator.ts:896-903`；已 yield 后重跑全量 → 用户收到「半句+完整」 |

#### 域四：人设引擎（src/persona）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 4-1 | 六层人设 schema | hardRules/identity/speaking/emotions/relationship/world + chainRules/behavioralScripts | ✅ | `loader.ts:13-133`；类型完整 |
| 4-2 | 人设校验器 | 必填字段/枚举/范围/重复 trigger/推荐 trigger | ✅ | `loader.ts:217-391`；`npm run persona:check` |
| 4-3 | Prompt 静态缓存 + 动态组装 | 身份/风格/生活/铁律/关系/规则/脚本/状态标签 | ✅ | `prompt-builder.ts:532-640`；静态块按人设名缓存 |
| 4-4 | 内心状态标签（~15 token） | `[亲密-负债0.3-0.2-深夜]` | ✅ | `prompt-builder.ts:106-118` |
| 4-5 | EMA 状态平滑（α=0.3） | exposure/guilt 平滑；模式判定 | 🟡 | `orchestrator.ts:500-537`；注释承诺的「模式最小驻留 3 轮」**没实现** |
| 4-6 | 链式规则 L1 弹性裁决 | resistance + immutable + 三阶段 | 🟡 | `prompt-builder.ts:126-214`；突破后规则从 prompt 移除；immutable 只内耗不突破 |
| 4-7 | 行为脚本选择 | 系统→关键词→语义→默认 | 🟡 | `prompt-builder.ts:245-275`；「语义匹配」实际是固定 `casual_chitchat` fallback |
| 4-8 | 情绪状态机 | vector/baseline/arousal + 自然恢复 + 冲动强度 | 🟡 | `emotion.ts`；输入只有天气与因果链随机事件，无对话情绪识别（设计上故意禁止关键词情绪） |
| 4-9 | 负债偿还 | guilt/resentment + 三结局 | 🔴 | `incurGuilt` 在用；`attemptRepayment/confirmRepayment` **零调用**，偿还闭环不存在 |
| 4-10 | 社交分寸 | exposureRatio + 关门分析 | 🟡 | `social-tact.ts`；`analyzeDoorClosing` 零调用 |
| 4-11 | 纠正层 | 记录用户反馈 → 注入 prompt | 🔴 | `correction.ts` 能写文件；`state.corrections` 永远为空，`injectCorrections` 永不生效 |
| 4-12 | 标签翻译 | 7 个预设标签 → prompt 片段 | ✅ | `prompt-builder.ts:354-380` |
| 4-13 | 人设创建（脚手架） | 生成完整 persona.json | ✅ | `create.ts` |
| 4-14 | 人设叙事创建（5 入口） | 自由文本 → 正则推导字段 → 草稿 + 待补充清单 | 🟡 | `narrate.ts`；**不是 LLM 分析**（入口 5 却写「AI 会分析」），推导靠正则 |
| 4-15 | 三个内置人设 | 小雅/苏迟/秋瑶 | ✅ | 字段丰富；但大量字段不进 prompt（见 2.3） |
| 4-16 | 行为脚本触发覆盖 | 7 个 trigger | 🔴 | `negative_venting` / `after_silence` **永不可达**；`exception_moment` 依赖不可达的 guilty；`media_shared` 因 QQ 侧 `[图片：` 与 `^\[图片\]` 不匹配而失效 |
| 4-17 | 负债闭环 | guilt 产生 → 偿还 → 行为 | 🔴 | `incurGuilt` 仅两处：一处要求 `guilt>0.3`（循环依赖）、一处要求 `impulse>0.3`（实际典型 0.03–0.07）→ **guilt 恒≈0**；`dailyDecay` 名为每日、实为每消息 |
| 4-18 | 硬编码串味 | 时间感知/关系措辞 | 🟡 | `time-awareness.ts:111` 写死「咖啡店应该正忙」→ 苏迟（插画师）/秋瑶（学生）也这么想；`buildRelationshipPart` 写死「她眼里」，男性人设苏迟不适用 |
| 4-19 | 产物校验 | create/narrate | 🟡 | 生成后人设**没有**再过 `validatePersona`；narrate 入口写「AI 会分析」，实际是正则推导 |
| 4-20 | SKILL.md / persona.md | 人设文档资产 | 📄 | loader 只检查 `SKILL.md` 是否存在，内容不进 prompt；`persona.md` 全仓零引用 |

#### 域五：演化引擎（src/evolution）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 5-1 | 基线漂移 | 压力阈值阶跃 ±0.05、上下限 ±0.3、回弹 | 🔴 | `baseline-drift.ts`；仅非流式；压力取绝对值 → **只会向一个方向漂**；`perceivedBaseline` 每消息追 1%；无持久化 |
| 5-2 | 因果链 | 3 条硬编码链 + 10% 闯入 | 🔴 | `orchestrator.ts:172-176`；链**不推进**，trace 只打 log；主线剧情永远停在初始状态 |
| 5-3 | 记忆代谢 | 情绪加权 + 主题关键词 → 遗忘/压缩/重现 | 💀 | `memory-decay.ts`；启动时 `persona="unknown"` 空转，候选恒 0.5；核心分支从不生效 |
| 5-4 | 叙事重构 | 翻阅日记 → 觉察阶段（none→noticing→denying→admitting） | 🔴 | `narrative-reconstruct.ts`；**每条消息同步 await 一次 LLM**；产物 `narrativeInject` 根本没拼进 prompt；无 persona 过滤 |
| 5-5 | 人设进化日志 | 30 快照 + 7 天 → LLM 叙事 | 🔴 | `persona-journal.ts`；依赖 T1，而 QQ 流式不写 T1 → **纯 QQ 用户永不触发**；重启重复生成 |
| 5-6 | 内心独白 | 每轮异步生成 1–3 句 → T2 + 微量漂移 | 🟡 | `internal-monologue.ts`；只在非流式；关键词判「自我觉察」±0.02；用户不可见 |
| 5-7 | 动态风格参考 | 按情绪状态检索「自己以前怎么说话」 | 🟡 | `style-reference.ts`；无 persona 过滤；query 只有 15 字标签，实际近似「取最新 2 条」 |
| 5-8 | herView（她眼中的你） | 事件驱动 LLM 生成 | 🔴 | `her-view.ts`；触发条件依赖 closeness 跳变（永不发生）或叙事阶段变化（很少发生）→ 通常 0 次/进程；不持久化 |
| 5-9 | T3 长期摘要 | 每 80 条 → LLM 压缩 → T2 长半衰期 | 🟡 | `t3-summarizer.ts`；无并发锁 → 触发窗口内每消息重复压缩；无「已压缩」标记 → 重复；选 80 条只喂 60 条 |
| 5-10 | 状态持久化 | — | 💀 | drift/chains/arc/herView 全在内存；`data/state.ts` 无人调用 |

#### 域六：冲动引擎（src/impulse）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 6-1 | 冲动触发（4 源） | `trigger.ts` 完整但**无引用**；实际在 orchestrator 内重写 | 💀 | `trigger.ts`；运行时另有一套 |
| 6-2 | 消息门 V2 | 睡眠/负债/回避话题/自然收尾/工作忙/情绪低落 | 🟡 | `message-gate.ts:37-126`；**delay 没有兑现机制**，返回后消息即消失（不落库、不补发） |
| 6-3 | 门上下文感知 | 前 3 条豁免/快速跟进/快聊豁免 | 🔴 | 流式路径写死 `count=0, rapid=false` → 工作延迟分支**永不触发** |
| 6-4 | 破例（exception） | 高强度冲动越门一次 + 自我觉察 | 🔴 | `exception.ts`；阈值体系不自洽，且自我觉察函数未调用 |
| 6-5 | 沉默弧线 | 4 阶段 6h/24h/72h/72h+ | 🔴 | `silence-arc.ts`；只有 72h 触发一次重启消息；流式路径不更新沉默状态 → 会把活跃用户误判为沉默 |
| 6-6 | 表达渲染 | 标点断句 burst / 颜文字 / QQ face / 撤回 | 🟡 | `renderer.ts`；流式路径只取 qqFace，tone/颜文字/burst 不进消息；撤回无消费者 |
| 6-7 | 语气链（vault/engine/advisor/insertion） | 4 模块叠加生成语气词 | 🔴 | 只在 CLI/群聊非流式生效；advisor 每次新建、历史恒空、scene 猜自己回复、closeness 硬编码 5 |
| 6-8 | Unsplash 主动发图 | 冷却/亲密度/时段/概率 → LLM query → Unsplash | 🔴 | 仅 CLI 非流式；QQ 不发；失败前就锁冷却；caption 固定 4 条 |
| 6-9 | 主动消息治理 | 心跳 + 概率 + 8min 守卫 | 🟡 | 无日上限；情绪触发每 15min 都可能重现；心跳可重入；占用用户限速桶 |

#### 域七：外部世界（src/world）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 7-1 | 真实天气 | OpenWeatherMap + 失败降级 mock | 🟡 | `weather.ts:30-56`；**取 `weather[0].main` 英文（Clouds/Rain），却用中文「雨/晴」匹配** → 配置真 Key 后 moodOffset=0、天气主动触发永不成立；只在初始化拉一次 |
| 7-2 | 天气觉察/解释层 | 觉察时刻 + 个人解释 + 社交解释 | 🟡 | `weather.ts:97-151`；`personalInterpretation` 未注入 prompt |
| 7-3 | 时间感知 | 结构化时刻标签（~15 token） | 🟡 | `time-awareness.ts`；跨午夜/「每周三五」解析失败 |
| 7-4 | 网络热点 | 20 条硬编码话题池、2h 随机轮换 | 🔴 | `trending-fetcher.ts`；**零 HTTP**；池是「成都/会计学生」语境，默认人设是「上海咖啡店员」→ 圈层全不匹配；「五一/高考/40 度」无日期过滤 |
| 7-5 | 信息圈层穿透 | `info-sphere.ts` | 💀 | 全仓 0 引用 |
| 7-6 | 感知姿态 stance | 主动/被动/无所谓 → 天气觉察措辞 | 🟡 | 只用于未注入的 awareness 文本；`stance.ts:37-65` 零调用 |

#### 域八：AI 引擎（src/ai）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 8-1 | DeepSeek V4 双模型路由 | 复杂度 → flash/pro | ✅ | `router.ts:29-44`；模型名与官方 V4 一致；env 可覆盖 BaseURL/模型名 |
| 8-2 | 非流式对话 | OpenAI 兼容 SDK，温度 0.9，max_tokens 80/250/400 | ✅ | `chat.ts:14-78` |
| 8-3 | 流式对话 | AsyncGenerator 逐 token | ✅ | `chat.ts:83-142`；首 token 计时、慢响应日志 |
| 8-4 | 重试/超时 | 2 次尝试 + 固定 800ms | 🔴 | 无 AbortSignal、无 429 退避、对 400/401 也重试；openai SDK 自身还会重试 → 最坏 6 次 |
| 8-5 | 图片识别 | Qwen-VL Max，≤15 字描述 | 🟡 | `vision.ts`；无超时/压缩/缓存，串行阻塞消息处理 |
| 8-6 | 语义嵌入主路径 | Qwen text-embedding-v3 | 🔴 | `embedding.ts:89-224` 完整实现，但**全仓无调用** |
| 8-7 | n-gram 哈希嵌入（降级） | FNV-1a，768 维，确定性 | ✅ | `embedding.ts:45-76`；实际唯一在用的嵌入 |
| 8-8 | Unsplash 搜图 | 真 API + LLM query 生成 | ✅ | `image-gen.ts:22-41`；端到端在 QQ 断掉 |
| 8-9 | 即梦图片生成 | — | 📄 | 只有 `hasImageGenModel()` 死函数 |
| 8-10 | TTS / CLAUDE fallback | — | 📄 | Key 位存在，0 消费 |
| 8-11 | Token/成本统计 | — | 💀 | 全仓无 `usage` 采集；README 成本表无实现支撑 |

#### 域九：记忆与数据（src/data）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 9-1 | SQLite WAL + T1/T2 建表 | better-sqlite3 + 迁移补列 | 🔴 | `vector.ts:32-74`；**t2 表无 `embedding` 列**（代码到处读写）；**无 `data/` mkdir** → 新装 CANTOPEN/no such column |
| 9-2 | T1 人格快照 | 每轮写入 | 🟡 | 仅非流式写；QQ 私聊不写；永不清理 |
| 9-3 | T2 情节记忆 | 向量 + 强度 + 情绪权重 | ✅ | `vector.ts`；每轮对话后写入 |
| 9-4 | 艾宾浩斯衰减 | 指数衰减 + 归档 | 🟡 | `applyDecay/applyGlobalDecay`；UTC 串按本地时区解析；归档 = 硬 DELETE；仅启动执行一次 |
| 9-5 | 向量检索（KNN） | JS 全量加载 + 余弦相似度 | 🟡 | `vector.ts:245-266`；**sqlite-vec 只建表不用**；无索引、无阈值、负相似截 0 仍保留 |
| 9-6 | RAG 上下文 | `cos × decayedStrength × (1+|emotionalWeight|)` | 🟡 | `retriever.ts:26-57`；confidence 只看强度；内心独白可被当记忆注入 |
| 9-7 | T3 长期摘要 | 80 条 → LLM → 长半衰期 | 🟡 | 见 5-9 |
| 9-8 | 会话历史 | JSON 落盘，200 条窗口 | 🟡 | `history.ts`；非原子写 + fire-and-forget 并发；**按 persona.name 存 → 同人设多用户共享** |
| 9-9 | 配置加载 | YAML + 默认值 | 🟡 | `store.ts:20-44`；无类型校验；**`user_personas` 被丢弃**；`her_name` 仅用于日志 |
| 9-10 | 多人设隔离 | `WHERE persona_id = ?` | 🔴 | 只有 persona 级；无 user_id；全局 `setCurrentPersona` 单例，异步期间可被他人覆盖 |
| 9-11 | 记忆可视化/删除/导出/备份 | — | 💀 | 无任何入口 |
| 9-12 | CategoryRAG（六域索引） | — | 📄 | 无 category 字段/代码 |

#### 域十：质量评估（src/eval + 测试）

| # | 功能 | 实现 | 成熟度 | 证据 / 限制 |
|---|---|---|---|---|
| 10-1 | 单元测试 | 11 文件 / 178 用例 | ✅ | 但只测纯函数；orchestrator/message-gate/qq/vector 零覆盖；1 处 mock |
| 10-2 | CI / lint / coverage | — | 💀 | 无 `.github`；`lint` 脚本存在但 eslint 未安装、无配置；测试被 tsconfig 排除 |
| 10-3 | 健康检查 | 记忆完整性/DB | 🟡 | `eval/health.ts`；状态检查恒 true；无入口/测试 |
| 10-4 | 一致性评估 / LLM Judge | prompt 合规评分 + A/B | 🟡 | `consistency-eval.ts`；仅被 run-ab 调用；Judge 未验证 |
| 10-5 | 情感分析 / 关系弧线 | 趋势/转折/叙事/分类/预测 | 🟡 | 有测试（34 例），但无产品入口 |
| 10-6 | 指标采集 | 运行/一致性/交互指标 | 🔴 | 无入口、硬编码 DB 路径、无容错 |
| 10-7 | 门消融实验 | 38 场景 × 17 组合 | 🔴 | `applyOverrides` 原样返回 → 参数对决策**零影响**；差异全是随机噪声 |
| 10-8 | 嵌入基准 | 自检索 Recall | 🔴 | 同函数查自身、Recall@10 恒 0、无标注集 |
| 10-9 | A/B 评估脚本 | 唯一手工入口 | 🟡 | 无 npm script；缺 data 即崩；两侧上下文不一致，无盲评/CI |

### 2.3 人设字段消费审计（创作者最容易踩的坑）

人设 JSON 有 7 个顶层块、上百个字段，但**真正进入 prompt / 运行时决策的不到一半**：

| 已消费（影响聊天） | 未被消费（写了也白写） |
|---|---|
| name / age / gender / birthday / hometown / career | `identity.lifeStory.education` / `family` / `currentStatus` |
| appearance: face/hair/height/build/style | `appearance.features`（仅死代码 image-gen 用） |
| keyEvents | `hardRules.neverDo` / `alwaysDo` / `boundaries`（只用于校验，不进 prompt） |
| catchphrases / sentencePattern / tone / typingHabit / dialect | `speaking.emojiUsage` / `addressUser`（仅在死函数 assemblePrompt 用） |
| attachmentStyle / closeness / pace / jealousyMode / apologyStyle / howWeMet / herViewOfYou | `emotions.emotionalBaseline` / `emotionalRange` / `stressReaction` / `loveLanguage` / `vulnerabilities` / `triggers` |
| socialCircle.name / dailyRhythm（前 3 条）/ stressSources | `relationship.sharedMemories` |
| photoShare / chainRules / behavioralScripts / triggerWords | `world.goals` / `world.externalAwareness` / `chain.immutable_reason` |

**产品影响**：创作者按文档认真写「她的底线、软肋、情感模式、人生目标」，结果这些字段既不校验失败也不进 prompt——人格差异最后只剩「身份 + 口头禅 + 语气 + 依恋类型」四五个维度。这是「六层人设」卖点最大的落差；也是最容易补、收益最直接的一类改进。

### 2.4 成熟度汇总（按条目计）

| 成熟度 | 数量（约） | 代表 |
|---|---|---|
| ✅ 主路径可用 | 17 | 流式聊天、复杂度路由、六层 schema/校验、Prompt 组装、状态标签、标签翻译、T1/T2 写入、CLI、人设创建、178 单测、天气 API、Unsplash 搜图 |
| 🟡 可用但有瑕疵 | 30 | 消息门、合并窗口、限速、群聊、表情、引用、记忆检索、衰减、T3、情感状态、人设叙事创建 |
| 🔴 半成品/未接主路径 | 20 | 流式管线缺能力、纠正层、负债偿还、因果链、演化日志、herView、沉默弧线、tone 链、发图、天气触发、嵌入主路径 |
| 💀 死代码/无效 | 12 | router 两文件、data/state、info-sphere、trigger.ts、t2_vec、node-cron、downloadImageAsBase64、成本统计 |
| 📄 仅文档宣称 | 8 | 语义嵌入、sqlite-vec、CategoryRAG、即梦、TTS、微信、`user_personas`、撤回 |

---

## 3. 文档 vs 实现：可信度问题（必须修）

| # | 文档宣称 | 实际情况 | 严重度 |
|---|---|---|---|
| 3-1 | 「数据不上传任何服务器，所有记忆、日记、对话在你电脑里」 | 事实：对话每轮发 DeepSeek，图片发 Qwen-VL，人设/日记摘要也会进 LLM；只是**存储**在本地。面试文档 Q36 已自认 | 🔴 高（信任/合规） |
| 3-2 | 「语义嵌入 Qwen text-embedding-v3 主 + n-gram 降级」 | 主路径 0 调用，全程 n-gram 字符哈希 | 🔴 高 |
| 3-3 | 「sqlite-vec 向量检索」 | `t2_vec` 只建表；检索是 JS 全量 JSON 解析 | 🟡 中 |
| 3-4 | 「不同 QQ 好友不同人设，记忆完全隔离」 | `loadConfig` 丢弃 `user_personas`；会话/记忆按 persona 共享 | 🔴 高 |
| 3-5 | 「延迟回复」 | delay 分支直接 return，不落库不补发 → 用户消息消失 | 🔴 高 |
| 3-6 | 「偶尔撤回、tone 语气、Unsplash 发图」 | 撤回无消费者；tone 只在 CLI/群聊；QQ 不发图 | 🟡 中 |
| 3-7 | 「关系弧线追踪 / 她会慢慢变化」 | closeness 永不变化；演化状态不持久化；herView 几乎不触发 | 🔴 高 |
| 3-8 | 「133 tests / 8 模块」（CLAUDE）vs「178 / 11」（Portfolio） | 实际 178/11；CLAUDE 停在 6 月 | 🟡 中 |
| 3-9 | 作品集指标：99/100、Recall 99.4%、63.2%、8ms、覆盖 80%+ | 无法由当前代码复现：A/B 仅 20 样本且上下文不一致；Recall 是自检索恒等；消融参数未接线；无覆盖率工具 | 🔴 高（对外信誉） |
| 3-10 | 「每月 ¥3–5」 | 未计输出 token、重试、独白/日记/T3 的额外 LLM 调用；按官方价粗估 ¥6–15 | 🟡 中 |
| 3-11 | 「Docker / PM2 / 一键启动 / 开机自启 / 托盘」 | 基本存在但 Windows-only、硬编码 `D:\NapCatShell`、无 healthcheck/logrotate；托盘状态是假的 | 🟡 中 |
| 3-12 | 「`npm run setup:minimal` 离线模式」 | 脚本不存在 | 🟡 低 |
| 3-13 | 端口 `18080`（README/.env） | 代码默认 `8080`（`qq.ts:76`）；漏配 `.env` 就连不上且无提示 | 🟡 中 |
| 3-14 | MIT 许可证 | 仓库无 LICENSE 文件 | 🟡 低 |
| 3-15 | 「Node.js 22+」但 `engines: >=18` | 声明不一致 | 🟡 低 |
| 3-16 | PERSONA_GUIDE：「出生年份/半衰期会被校验」「dailyRhythm 直接影响消息门」「narrate/create 数据结构一致」 | 校验器无这些规则；消息门只做粗匹配；两者输出结构不同 | 🟡 低 |
| 3-17 | 「L1 弹性裁决统一」「负债偿还」「纠正层」 | L1 只在非流式路径；偿还函数 0 调用；纠正结果被丢弃 | 🔴 高 |
| 3-18 | 「语气系统 / 表情 / 撤回」 | tone 链只覆盖 CLI/群聊；emojiStyle 恒「动物系」；`isChatty` 靠口头禅是否含「跟你说」；撤回无消费者 | 🟡 中 |
| 3-19 | 「SKILL.md 七段模板」 | 运行时只检查文件存在，内容不注入 | 🟡 低 |

**建议**：建立「单一事实源」——README 面向用户、`docs/ARCHITECTURE.md` 面向开发者、所有数字由 `npm run eval:*` 生成并附产物；把无法复现的指标从作品集里删掉或重跑。诚实感本身就是产品力。

---

## 4. 从「完美产品」看：差距与风险

### 4.1 P0：开箱即坏（阻断级，必须最先修）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | 无 `data/` 目录时直接 open SQLite → `SQLITE_CANTOPEN` | `vector.ts:10,25`；`test-bot.ts:32`、`qq.ts:198` 先于 `loadSession` 的 mkdir 执行。**实测**：`npm run dev` 加载完人设后直接 `[致命错误] Cannot open database because the directory does not exist` | CLI/QQ 首次启动即崩 |
| P0-2 | `t2_episodes` 建表缺 `embedding` 列，但插入/查询/回填都引用它 | `vector.ts:49-61` vs `vector.ts:230,251,272`。**实测**：建 `data/` 后 `backfillEpisodeVectors()` 抛 `SQLITE_ERROR: no such column: embedding` | 记忆写入/检索全断，`initConversation` 抛错 |
| P0-3 | 没有 `config.yaml` 的引导（README 只说「编辑」） | README:83；setup 可生成，但 README 主路径没提 | 用户卡在第一步 |
| P0-4 | `user_personas` 被 `loadConfig` 丢弃 | `store.ts:32-43` | 文档宣称的多好友多人设功能不存在 |
| P0-5 | WS 默认绑 `0.0.0.0`、任意 path、无 token、无白名单 | `qq.ts:220-227` | 局域网任意程序可伪装事件、花你的 API 钱、读 `/stats` |
| P0-6 | 出站消息 `auto_escape:false`，模型输出 `[CQ:at,qq=all]` 会被执行 | `onebot.ts:117-130` | CQ 注入 / 群 @ 全员 |
| P0-7 | 群聊 `handleGroupMessage` 未 await、事件字段未校验、批量处理无 catch | `qq.ts:393,146-156`；`onebot.ts` 解析假定字段存在 | 一条畸形事件即可 unhandled rejection 崩进程 |
| P0-8 | delay 分支不落库、不补发 | `orchestrator.ts:433-436` | 「延迟回复」= 消息消失；睡眠时段（23–7 点）所有消息被吞 |
| P0-9 | 流式失败降级重复发送 | `orchestrator.ts:896-903` | 用户收到「半句 + 完整版」 |

### 4.2 P1：正确性与可靠性

- **消息丢失**：合并窗口处理期间新消息只重投首条（`qq.ts:153-155`）；无 `message_id` 去重；断线期间出站无队列/无 ack；中断后已发送片段不落历史，主动消息则先存全文再发（用户没看到的也“记得说过”）。
- **双管线分裂**：QQ 私聊缺 10 个能力（见 1.3）；流式门上下文写死；沉默弧线不更新 → 活跃用户被误判 72h 沉默。
- **状态不持久化**：情绪/负债/漂移/因果链/叙事弧/herView/计时器全在内存，重启归零；`data/state.ts` 是死文件。
- **亲密度静态**：`relationship.closeness` 无任何赋值 → 所有依赖亲密度的门控/阈值/解锁（发图、herView、亲近模式）实质是常量。
- **会话一致性**：`saveSession` 非原子 + 并发 fire-and-forget，旧快照可能覆盖新消息；旧版 JSON 缺 `t3` 字段会让 orchestrator 崩。
- **T3 并发**：无锁、无「已压缩」标记 → 触发窗口内重复压缩、重复扣强度。
- **翻日记阻塞**：每条非流式消息同步 await 一次 LLM（`orchestrator.ts:414`），产物却不进 prompt——纯成本。
- **天气中英文 bug**：配了真 Key 反而让天气情绪/主动触发失效（`weather.ts:47` vs `115-118`）。
- **检索质量**：n-gram 字符匹配（同词不同句式就不像）、无阈值、内心独白会混入 RAG。
- **异常兜底**：LLM 失败回「[系统] 消息发送失败，请稍后重试」——直接破坏人设；心跳吞掉所有异常。

### 4.3 P1：安全、隐私与伦理

- **网络安全**：WS 无鉴权（P0-5）；日志打印完整消息内容（`[收到]`/`[回复]`）进入 PM2 日志；密钥明文 `.env`。
- **数据主权**：无记忆查看/删除/导出/清空；T2 衰减自动 DELETE；无备份/迁移；`data/` 与 `personas/` 被 gitignore 但无加密。
- **隐私声明不实**（3-1）：这是产品最忌讳的一类问题，尤其目标用户是「情感脆弱期」的人。
- **AI 披露**：全篇设计目标是「不暴露 AI 身份」；作为个人玩具可接受，作为产品需要首次披露 + 用户知情同意。
- **危机干预**：目标场景含「情感疗愈」，但无自伤/自杀关键词兜底、无心理援助资源、无年龄门。
- **平台合规**：NapCat/QQ 自动化违反平台协议，封号风险由用户承担；README 只有一句免责声明。

### 4.4 P1：多用户与隔离（如果要给朋友用，必须重做）

- 会话文件按 `persona.name` 存（`history.ts:25-27`）→ 两个好友用同一个人设 = **共享聊天记录**。
- T1/T2 表只有 `persona_id`，无 `user_id`；`setCurrentPersona(config.persona)` 是进程级全局变量 → 用户 A 的 LLM await 期间用户 B 可以把它改掉，记忆归属错乱。
- 群聊与私聊共用同一个 `ConversationState`（按 userId）→ 群里的情绪/历史污染私聊。
- 用户状态 LRU 上限 500，但淘汰时用户记忆/情绪直接丢失（无持久化）。
- **结论**：当前架构只对「单用户单实例」成立；多用户需要把 owner (persona+user) 变成显式参数贯穿 session/memory/prompt，而不是全局变量。

### 4.5 P1：人格产品的「闭环」缺口（她为什么还不够像「一个人」）

1. **关系不生长**：亲密度静态、无关系里程碑、无「我们第一次聊到…」的时间线。用户感受不到「越来越熟」。
2. **变化不可见**：基线漂移/进化日志/内心独白都在后台，用户看不到；产品上等于不存在。
3. **底线不可感知**：规则突破只产生内部 guilt，没有「她今天有点不对劲」的可观察行为；负面话题（前任/结婚）直接装死。
4. **生活不真实**：因果链不推进、热点池与人设不匹配、天气不触发 → 「她有自己的生活」实际只剩时间节点。
5. **记忆不精确**：n-gram 检索让「她记得你说过」经常变成张冠李戴；没有「记住这件事」/「忘掉这件事」的用户控制。
6. **主动消息不可控**：没有免打扰、没有频率上限、没有「今天不想聊」；对情感陪伴产品这是致命体验。
7. **人设创作门槛高**：narrate 是正则推导，不是对话式 LLM 共创；写完 100+ 字段后一半不生效。
8. **三个人设被引擎同质化**：真实差异只剩 attachmentStyle（阈值/社交分寸）、静态 closeness、chainRules/behavioralScripts、photoShare 与口头禅；L4 情感文本、hardRules、goals 等差异不进运行逻辑，「三个不同的人」在实际对话中的区分度低于文档宣称。

### 4.6 P1：首次体验与可安装性

真实门槛：Node 22 → DeepSeek Key → 复制 config → 启动（此处已崩）→ QQ 小号 → NapCat → 反向 WS 地址 → 端口 → 扫码。对非技术用户 = 不可能。

- 无安装包、无 GUI、无 Web 界面、无「一键体检」；`npm run doctor` 不存在。
- setup 向导不收集 Key、不测 API 连通、不写 `user_personas`/端口/白名单，覆盖 config 时丢扩展字段。
- 错误提示不友好：连不上 NapCat 只打印「等待连接」；LLM 失败被包装成系统消息。

### 4.7 P1：可观测性与运维

- 全部日志是 `console.log`，无级别、无结构化、无请求 ID、无耗时/成本指标。
- 无 `/health`、无 metrics、无告警；`eval/health.ts` 未接任何入口。
- PM2 配置跑 devDependency `tsx`、无 cwd、无 healthcheck、无 logrotate；SIGTERM 直接 `process.exit`，会话写入可能丢。
- 无 schema 版本（`PRAGMA user_version`）、无备份/恢复、无迁移脚本、无灰度。

### 4.8 P2：平台、分发与合规

- **最大结构性风险**：把产品命运绑在非官方 QQ 协议上。封号、客户端升级、ToS 变化都会让产品归零；且 Windows-only。
- **建议的产品路径**：以「本地 Web 聊天 + 手机浏览器访问」为主入口（零门槛、跨平台、可截图分享），QQ/微信/Telegram 作为可选「桥接插件」；底层抽 `PlatformAdapter` 接口。
- 分发：无 License 文件、无 Release、无安装包、无自动更新；开源生态（人设市场、模板包）没有格式规范/版本/签名。

### 4.9 P2：成本与性能

- 无 token 统计/预算上限；主动心跳 + 独白 + 翻日记 + T3 + Judge 都是隐性 LLM 调用。
- 每条消息构造的 prompt 包含完整静态人设（约 1.5–3k tokens），无前缀缓存策略（DeepSeek 支持 context caching）。
- 记忆检索每次消息 ~45 条 SQL + 全量 JSON parse；T2 到 1 万条后性能会明显退化。
- 流式延迟依赖模型 TTFB；无「先发一条占位」等体验优化。

### 4.10 P2：工程质量

- 无 CI、无 lint 配置、无覆盖率；测试与源码类型检查脱节（测试被 tsconfig 排除）。
- 12 个死/半死模块（router/*、data/state、info-sphere、trigger.ts、t2_vec、node-cron、image-gen 部分）；eval 占 20% 代码量但 0 生产入口。
- 依赖偏重：`wechaty` 引入大量依赖，但只跑 echo；`node-cron` 零引用。
- `orchestrator.ts` 1,250 行、20+ 个可变状态字段、`Object.assign` 直接改状态；难以测试与扩展（作者自己在面试题库里也吐槽了这点）。
- 文档三套数字（README/CLAUDE/Portfolio）互相对不上。

---

## 5. 优化路线图（建议）

> 原则：**先地基，后体验，再差异化**。每一阶段都有可验收的「用户可感知结果」。估时按 1 名熟悉 TS 的工程师计。

### M0 — 阻断修复（3–5 天）：让「新装 → 能聊 → 不丢数据」成立

| ID | 任务 | 关键改动 | 验收标准 | 估时 |
|---|---|---|---|---|
| M0-1 | 新装可用 | `ensureDataDir()`；建表补 `embedding BLOB`；`PRAGMA user_version` + 迁移；升级 `better-sqlite3` 到 12.11+（Node 22/24 有预编译，避免 C++ 编译门槛）；启动 smoke test | 全新 clone + `npm run setup` + `npm run dev` 10 分钟内可对话；重启后记忆还在；Node 22/24 均无需本地编译 | 0.5–1d |
| M0-2 | 配置链路修复 | `loadConfig` 返回并校验 `user_personas`/端口/频率；端口统一 18080；README 补 `cp config.yaml.example`；删除 `setup:minimal` | 配置错误有清晰报错；多好友映射生效（一人设一记忆桶） | 0.5–1d |
| M0-3 | 消息不丢失 | delay/silence 消息落库；延迟队列 + 下轮补发或定时补发；合并窗口保留全部 pending；`message_id` 去重；中断时落已发片段 | 睡眠时段发消息，第二天能收到；连续打断不丢消息 | 1d |
| M0-4 | 安全加固 | WS 绑 `127.0.0.1`（可配）、握手 token、path 校验；`allowed_users` 白名单；CQ 转义；`/stats` 仅 owner；`.dockerignore` | 局域网未授权连接被拒；模型输出 `[CQ:...]` 不会被执行 | 0.5d |
| M0-5 | 异常兜底 | `unhandledRejection/uncaughtException`；事件 schema 校验（zod 或手写）；group await；LLM 失败用人设内话术 + 重试退避 | 畸形 WS 事件、LLM 401、断线均不崩进程且回复不破人设 | 0.5–1d |
| M0-6 | 统一双管线 | 抽 `buildGateContext()` + `postTurnEvolution()`；流式/非流式共用门控、T1、独白、演化 | 同一输入在 CLI/QQ 的「门控/记忆写入」行为一致 | 1–1.5d |
| M0-7 | 文档真话 pass | 修正隐私表述、嵌入/sqlite-vec、user_personas、延迟回复、测试数、端口、LICENSE | README 每条宣称可被代码/脚本验证 | 0.5d |

### M1 — 核心体验闭环（1–2 周）：让「她像一个人」成立

| ID | 任务 | 说明 | 验收 |
|---|---|---|---|
| M1-1 | 状态持久化 | `persona_state` 行存 drift/chains/arc/herView/timers；启动载入、节流写回 | 重启后关系/情绪/剧情连续 |
| M1-2 | 关系系统可增长 | 定义 closeness 增加/减少规则（对话深度、连续性、冲突/偿还），落库；关系里程碑时间线 | `/stats` 能看到亲密度变化；30 天使用后关系明显变化 |
| M1-3 | 演化可见化 | `/journal`（她的日记/进化日志）、关系时间线、herView 展示；情感日记可导出 | 用户能感知「她变了」 |
| M1-4 | 主动消息治理 | 日上限（默认 1–2）、最小间隔、安静时段、用户「免打扰/暂停」、有对话时抑制 | 不会刷屏；可一键静音 |
| M1-5 | 门控可解释/可配置 | 延迟真正兑现；负面话题不装死（改为回避式回应）；`/why` 查看本轮决策 | 每种门控有可观察行为与日志 |
| M1-6 | 人设字段接线 | 把 hardRules/emotions/world.goals 等未消费字段接入 prompt（结构化、非小作文）；修正 narrate 的「AI 分析」表述或真接 LLM | 新建人设的「底线/软肋/目标」能改变回复 |
| M1-7 | 记忆质量 | 接回语义嵌入（Qwen/本地 embedding，可配置）+ 阈值 + 去重 + source 过滤；sqlite-vec 真启用或删依赖 | 记忆命中率主观提升；检索延迟可控 |
| M1-8 | 天气/热点修复 | 天气中英映射 + 30min 刷新；热点改为 persona 配置或 RSS/搜索，带日期过滤 | 配置真 Key 后天气情绪/主动触发生效 |
| M1-9 | 可观测性 | 结构化日志（级别/请求 ID/耗时/token 成本）、`/health`、`/stats` 扩展（成本、延迟 P50/P95、记忆命中） | 出问题能定位；每日成本可见 |
| M1-10 | 记忆数据主权 | `/memory` 查看/搜索/删除/清空；导出 JSON+DB；备份/恢复 | 用户能掌控自己的数据 |

### M2 — 产品化（3–6 周）：从「能跑」到「好用」

| ID | 任务 | 说明 |
|---|---|---|
| M2-1 | 本地 Web 控制台 | 聊天窗口 + 设置 + 记忆管理 + 关系时间线 + 健康状态；手机浏览器可访问；QQ 变可选桥接 |
| M2-2 | 首次引导 2.0 | 对话式 setup（真人格共创）、API Key 校验、连通性测试、`/doctor` 自检 |
| M2-3 | 人设包格式 v2 | 导入/导出/版本/预览对聊/字段消费报告；附人设创作指南更新 |
| M2-4 | 多模态 | TTS（Fish Audio 等）、表情包/图片发送（CQ image / Web）、语音消息 ASR |
| M2-5 | 群聊/多平台完善 | @ 回复、引用、独立群会话、PlatformAdapter、Telegram/Discord 可选 |
| M2-6 | 质量与安全 | AI 披露/年龄门/危机干预资源/内容开关；记忆与日志可删除；隐私声明重写 |
| M2-7 | 工程化 | CI（typecheck+test+lint+coverage）、集成测试（mock LLM + 临时 SQLite）、Release、跨平台启动器 |
| M2-8 | 评测闭环 | 真实标注集（记忆命中/自然度/人设一致性）、盲评 A/B、线上指标；文档数字全部可复现 |

### M3 — 长期（可选）

人设市场 / 社区模板、多用户托管（每用户独立数据与成本）、主动生活流 2.0（真正会推进的剧情线）、长期关系记忆（周年/纪念日）、插件系统。

---

## 6. 需要你补充/拍板的问题

这些答案会直接决定 M1/M2 的取舍，建议先回答再开工：

1. **身份与目标**：你是作者本人吗？这个项目最终是「自己用」「给朋友用」还是「公开发布/投简历作品集」？（三者优化方向完全不同）
2. **主入口**：继续死磕 QQ，还是优先做「本地 Web + 手机浏览器」？（后者能一次性解决安装门槛、平台封号、跨平台三个问题）
3. **多用户**：只服务你一个人，还是要给多个朋友用？（决定要不要重做 owner 隔离与配额）
4. **QQ 风险**：能接受 NapCat 封号/协议变更风险吗？是否有备用小号？
5. **预算**：每月 API 上限大概多少？（决定主动消息频率、模型选择、是否接语义嵌入）
6. **优先级**：最在意哪一项——稳定性 / 沉浸感（更像真人）/ 人设创作深度 / 多模态 / 可分享给别人？
7. **主动消息**：你希望她多主动？能接受每天几条？是否需要「免打扰」默认开启？（陪伴类产品的核心体验参数）
8. **AI 披露**：作为个人使用可以「她不是 AI」；如果给朋友用，是否需要首次告知「这是 AI」、以及心理危机兜底？
9. **文档数字**：作品集里的 99/100、Recall 99.4%、63.2% 是否愿意重跑成可复现版本，或从对外文档删除？
10. **下一步选择**：先做「M0 地基修复」，还是先做某个你最想要的功能（例如 Web 聊天界面 / 关系时间线 / TTS）？（我建议先 M0，但可以按你的偏好调整顺序）

---

## 7. 你的补充区（待填写）

> 以下是留给你的空间：补充你认为重要的功能/优化点、对上面条目的优先级调整、或者你希望她具备但我没列到的能力。

- 

---

## 附录 A：审计方法与限制

- 全量阅读 61 个非测试源文件中的核心链路 + 8 个领域并行深挖；用调用链 grep 区分「有代码」与「真接入」。
- **实测环境**：内置 Node 24.21 + pnpm 11 安装依赖成功（446 packages）；`tsc --noEmit` **0 错误**；`vitest run` **11 文件 / 178 用例全部通过**（210ms）。macOS 下 better-sqlite3 11.10 无 Node 24 预编译包，审计时临时替换为 12.11.1 + 预编译二进制并绕过签名限制后跑通；升级 12.11+ 已列入 M0-1。
- **P0-1 / P0-2 已用真实代码路径复现**：在空目录执行 `getVectorDb()` → `Cannot open database because the directory does not exist`；补 `data/` 后执行 `backfillEpisodeVectors()` → `SQLITE_ERROR: no such column: embedding`。
- 数据目录、`config.yaml`、`.env` 不在仓库中（被 gitignore），无法观察作者本机历史数据库，故「作者旧库有 embedding 列」为推断。
- 依赖安装与测试在 macOS（arm64）完成；QQ 桥接、NapCat、真实 LLM 调用未在本轮验证（无 QQ 小号 / API Key）。

## 附录 B：最小修复清单（可直接开工）

1. `src/data/vector.ts`：`ensureDataDir()` + 建表补 `embedding TEXT` + 迁移 + 索引 + `busy_timeout`。
2. `package.json`：`better-sqlite3` 升级到 `^12.11.1`（Node 22/24 预编译可用）；删除零引用的 `node-cron`。
3. `src/data/store.ts`：返回/校验 `user_personas`、`one_bot_ws_port/path`、`allowed_users`；补 `message_frequency_limit` 校验。
4. `src/bridge/qq.ts`：`host: "127.0.0.1"` + token + path 校验 + 白名单 + `try/catch` + `await handleGroupMessage` + 保留 pending + 去重。
5. `src/pipeline/orchestrator.ts`：抽 `buildGateContext` / `postTurnEvolution`；delay 消息落库；流式复用完整门控/T1/独白。
6. `src/ai/chat.ts`：超时（AbortSignal）、429/5xx 指数退避、`usage` 采集。
7. `src/world/weather.ts`：中英 condition 映射 + 30min TTL；`trending-fetcher.ts` 人设化/真实来源。
8. `src/persona/prompt-builder.ts` + `correction.ts`：接未消费字段；修纠正覆盖注入。
9. 根目录：`LICENSE`、`.dockerignore`、`.github/workflows/ci.yml`、`README` 真话 pass。
