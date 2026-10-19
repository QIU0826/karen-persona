# Karen Persona — AI 技术雷达（2026-10）

> **文档定位**：面向本项目（QQ 里的 AI 虚拟人，Node.js/TypeScript，单机 SQLite）的「AI 栈技术雷达」。只回答一个问题：**我们现在的 AI/记忆/检索/评测栈，哪些该换、哪些只需小改、哪些不该跟风。**
>
> **调研日期**：2026-10-19（Asia/Shanghai）。版本号、star 数、`pushed_at` 均为当日快照；价格/模型名以文末来源清单的官方页面为准。
>
> **代码快照**：`karen-persona` 工作区 2026-10-19 23:xx（含未提交的 M1 改动：`src/pipeline/orchestrator.ts`、`src/persona/relationship.ts`、`src/impulse/message-gate.ts`、`src/data/store.ts` 等）。本文所有「现状」均以该快照的**实际代码**为准，不采信 README 宣称。
>
> **实测环境**：macOS / Node 24.21.0 / openai SDK 4.104.0 / better-sqlite3 12.11.1（`node_modules` 实装，`package.json` 声明 `^11.10.0`）/ SQLite 3.53.2 / sqlite-vec 0.1.9。
>
> **证据标记**：`[代码]` 仓库内实现 ｜ `[实测]` 本次本地跑通 ｜ `[官方]` 官方文档/仓库 ｜ `[版本]` npm/PyPI/GitHub API 当日快照 ｜ `[待核实]` 无法在本次调研中确认的事实。
>
> **边界**：本文只做调研与建议，**不改任何 src/配置/依赖**；所有落地方案都写成「改动点 + 验收标准 + 工作量」，供后续排期。

---

## 0. 一页结论

### 0.1 雷达结论表

| # | 领域 | 现状（代码事实） | 2026 主流方案 | 结论 | 工作量 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | Agent 编排 | 手写双管线 `orchestrator.ts`（约 1.6k 行），`processMessage` 20+ 步骤 / `processMessageStream` 精简版；自研消息门 + 状态机 | LangGraph JS 1.5.1、Mastra 1.78.0、OpenAI Agents SDK JS 0.20.0、Vercel AI SDK 7.0.143、DSPy 3.4.1 | **不换框架**；只可选把传输层换成 AI SDK（P2） | S–M | P2 |
| 2 | 记忆层 | better-sqlite3 + JSON 向量 + 艾宾浩斯衰减；T0/T1/T2/T3 名义存在；无 user 隔离、无冲突消解、无用户画像块 | Mem0、Zep/Graphiti、Letta(MemGPT)、LangMem、Cognee | **不引入外部记忆服务**；**借 4 个机制**升级（ADD-only、时序失效、画像块、混合检索） | M | P1 |
| 3 | 向量 | `t2_vec` 只 CREATE、**从不读写**；实际是 JSON 字符串 + JS 全量余弦 | sqlite-vec 0.1.x、LanceDB、Qdrant、Chroma、Milvus Lite | **用 sqlite-vec 正确用法（小改）**；不引专用向量库 | S | **P0** |
| 4 | 检索 | 纯 n-gram 哈希 KNN；无阈值/去重/来源过滤；负相似度截 0 后仍保留 | SQLite FTS5 BM25、混合检索、cross-encoder rerank | **值得换**：向量 + BM25 混合（RRF），阈值/过滤最小可行 | M | **P0** |
| 5 | Embedding | n-gram FNV 哈希 768 维；Qwen `text-embedding-v3` 代码已写但**全仓 0 调用** | Qwen API、Qwen3-Embedding、BGE-M3、EmbeddingGemma、本地 ONNX（transformers.js） | **值得换**：先接通已实现的 Qwen API（S），再评估本地 ONNX（M） | S–M | **P0** |
| 6 | DeepSeek 能力 | thinking 已默认关闭 ✅；视觉已接 Flash ✅；JSON Output / Tool Calls / Search **0 使用**；prompt cache 已利用（实测命中 768–1536） | DeepSeek V4 官方能力 | **小改**：JSON Output 接后台任务、Search 替换硬编码热点；thinking 保持关；工具调用暂缓 | S–M | P1 |
| 7 | 评测/可观测 | `src/eval/` 约 2.4k 行、**零生产 import**（死代码）；console.log；usage 只在内存 + 日志 | promptfoo、Langfuse、OpenTelemetry GenAI、OpenAI Evals | **值得建最小闭环**：promptfoo 金标集 + 人设一致性规则断言 + 每轮 JSONL trace；Langfuse 暂缓 | M | P1 |
| 8 | 成本/上下文 | 静态人设 prompt 约 1.5–3k tokens；短期上下文与最近 8 条历史**重复注入**；后台 LLM 调用无预算上限 | prompt cache、上下文压缩、token 预算 | **小改**：prompt 瘦身 + 去重 + 每轮/每日预算 + 缓存命中率监控 | S–M | P2 |

图例：P0 = 现在就做（1–3 天）；P1 = 近期做（1 周）；P2 = 排期观察。

### 0.2 如果只做 3 件事（按收益/成本排序）

1. **把「记忆检索」从名义变成真实**：接通语义 embedding + sqlite-vec 正确用法 + FTS5 BM25 混合 + 阈值/去重/来源过滤。**收益最高**（直接命中「她记得你说过」这一核心卖点），成本 S–M，风险低。
2. **用 DeepSeek JSON Output 统一「后台结构化任务」**：记忆抽取/独白/日记/herView/关系事件全部走一个带 schema 的调用，替换正则与脆解析；顺带补齐 thinking 关闭 + max_tokens 余量。成本 S，立刻减少空回复与脏数据。
3. **建一个最小评测闭环**：promptfoo 金标集（记忆命中 / 人设一致性 / 对话质量）+ 每轮 JSONL trace（token/缓存/延迟/命中的记忆 id）。成本 S–M，让第 1、2 项有可验收的数字，而不是「感觉变好了」。

> 附加（第 4 件，若还有时间）：**静态 prompt 瘦身**——审计已证明人设 JSON 中大量字段不进 prompt，而 prompt 是最大的输入成本项；按实际消费字段裁剪可省 30–50% 输入 token。

### 0.3 明确「不换」清单（详见第 5 节）

LangGraph JS / Mastra 重写编排；Mem0 / Zep / Letta / Cognee 作为运行时记忆服务；Qdrant / Chroma / Milvus Lite / LanceDB 替换 SQLite；DSPy 优化；Langfuse 自托管全量接入；Responses/Anthropic API 全量迁移；追求 1M 上下文硬塞；多 agent / MCP 架构（除非做 Web 控制台与工具生态）。

---

## 1. 现状基线（代码事实）

> 本节只陈述**代码里真实存在的行为**，不重复审计报告全文，只保留与本次技术选型相关的部分。

### 1.1 AI 引擎与调用链

| 项 | 现状 | 证据 |
|---|---|---|
| 模型 | `deepseek-flash`（simple/normal + 视觉）/ `deepseek-v4-pro`（complex），OpenAI 兼容 SDK | `src/ai/router.ts:102-117` [代码] |
| 思考模式 | 默认**关闭**（`thinking:{type:"disabled"}`）；`DEEPSEEK_THINKING=enabled` 可开，按复杂度映射 effort | `src/ai/router.ts:85-93`、`src/ai/chat.ts:278-297` [代码] |
| 非流式/流式 | `chat()` / `chatStream()`：自研超时（30s）、仅 429/5xx/网络错误指数退避（最多 3 次）、`stream_options.include_usage` 失败静默降级 | `src/ai/chat.ts:358-560` [代码] |
| usage | 每轮打印 prompt/completion/reasoning/cache_hit；进程内累计，但**不落盘、不算钱、无预算** | `src/ai/chat.ts:36-52,192-226` [代码] |
| 旁路 LLM | 独白/T3/日记/herView/叙事/发图 query 共 7 处 `new OpenAI`，均已统一 `withThinking()`（默认关思考） | `src/evolution/*.ts`、`src/impulse/unsplash-trigger.ts` [代码] |
| 结构化输出 | **全仓 0 处** `response_format` / `json_object`；后台任务的 JSON 靠正则/`JSON.parse` 兜底 | `grep` 结果 [代码] |
| 工具调用 | **全仓 0 处** `tools` / `tool_choice`；天气/热点/搜索均为预取后拼进 prompt | `src/world/*`、`src/pipeline/orchestrator.ts` [代码] |
| 视觉 | `deepseek-flash` + 下载转 base64 + `detail:"low"` + ≤15 字描述 | `src/ai/vision.ts` [代码] |

**双管线事实**（决定「要不要上编排框架」）：`processMessage`（快照 L613 起，20+ 演化步骤）与 `processMessageStream`（快照 L1056 起，QQ 私聊主路径，约 8 步）。两条管线共享 `buildGateContext`/`buildPrompt`/T2 写入，但后者缺漂移、叙事、风格参考、herView、T1、独白、因果链回响等步骤；本次 M1 改动正在逐步补齐。**复杂度来源是领域步骤，不是编排能力**——这是后文「不换框架」判断的关键依据。

### 1.2 记忆数据模型

| 层 | 现状 | 证据 |
|---|---|---|
| T0 会话 | JSON 文件，200 条滚动窗口；构建 prompt 时取最近 **15** 条 + 更早 10 条 40 字摘要 | `src/data/history.ts:33,163-184` [代码] |
| T1 快照 | 每轮写一条（两条管线都写：非流式快照 L892 / 流式在 finally 快照 L1227）；不清理 | `src/data/vector.ts:137-156`、`orchestrator.ts` [代码] |
| T2 情节 | `content`（截断 100 字的「用户: … \| 回复: …」日志行）+ `source` + `strength` + `half_life_days` + `emotional_weight` + `embedding`(JSON TEXT) | `src/data/vector.ts:56-69`、`src/data/retriever.ts:65-73` [代码] |
| T3 摘要 | 每 80 条未压缩 T2 触发一次 LLM 压缩，写回 T2（`source=t3_summary`，半衰期 90 天）；**无锁、无「已压缩」标记** | `src/evolution/t3-summarizer.ts` [代码] |
| 衰减 | 指数衰减；**检索时** `applyDecay` 会更新 `strength` 与 `last_recalled_at`（即「回忆=重置计时」）；启动时全量衰减一次；归档 = **硬 DELETE** | `src/data/vector.ts:216-249` [代码] |
| 检索打分 | `relevance = max(0, cosine) × decayedStrength × (1+\|emotional_weight\|)`；`confidence` 只看强度 | `src/data/retriever.ts:22-58` [代码] |
| 检索实现 | 全量加载当前 persona 的活跃 episode，`JSON.parse` 每条 embedding，JS 点积排序；**无索引/无阈值/无去重/无来源过滤** | `src/data/vector.ts:286-308` [代码] |
| 隔离 | 只有 `persona_id`，**无 `user_id`**；全局单例 `setCurrentPersona` | `src/data/vector.ts:15-24` [代码] |
| 用户画像 | herView 是**单个字符串**，触发条件苛刻、经常不更新；无结构化画像块 | `src/evolution/her-view.ts`、`state-store.ts:27-32` [代码] |

### 1.3 人设状态机与消息门

- 六层 persona schema + 校验器：`src/persona/loader.ts`（hardRules/identity/speaking/emotions/relationship/world）；`[代码]`
- Prompt 组装：静态块（身份/风格/世界/铁律/提示词）**按人设名缓存**，动态块（状态标签/行为指南/原则/关系/纠正）每轮生成 → 缓存友好；`src/persona/prompt-builder.ts:521-640` `[代码]`
- 消息门 `decideGate`：免打扰 → 负债 → 回避话题 → 自然收尾 → 工作/日常延迟 → 情绪低落 → 正常回复；返回 `reply (delayMs)` / `delay (resumeAfterMs)` / `silence`；`src/impulse/message-gate.ts:60-152` `[代码]`
- 状态持久化：`data/persona-state-<persona>.json`，原子写、容错归一化；情绪/负债/漂移/因果链/叙事弧/herView/关系/计数/天气均恢复；`src/data/state-store.ts` `[代码]`
- 已修但仍有缺口：延迟队列的 **timer 不持久化**（重启后延迟消息丢补发，见 `docs/M1_BACKLOG.md` BUG-2）；多用户隔离仍未做（架构级）。

### 1.4 评测与可观测现状

- `src/eval/` 共 8 个模块约 2.4k 行（`consistency-eval` 483、`run-ab-eval` 357、`metrics-collector` 374、`sentiment` 354、`relationship-arc` 302、`gate-ablation` 328、`embedding-bench` 231、`health` 84）。`grep` 全仓（排除 `src/eval/` 自身）**没有任何生产 import** → 死代码 `[代码]`。
- `run-ab-eval.ts` 无 npm script、用旧模型名 `deepseek-v4-flash`、无 thinking 参数 → 即使运行结果也不可信 `[代码]`。
- 运行日志全部 `console.log`，无级别/请求 ID/结构化字段；usage 只打印 `[LLM] usage(...)`；无 `/metrics`、无 trace 落盘 `[代码]`。
- 测试：M0/M1 后 21 文件 / 330 用例（CLAUDE.md 口径），但 `orchestrator`/`message-gate` 主路径覆盖仍薄；历史对外指标（99/100、Recall 99.4% 等）不可复现，禁止引用（`CLAUDE.md` 开发约定 1）`[代码]`。

### 1.5 成本现状

- 静态人设 prompt 约 1.5–3k tokens（审计 4.9）；System + 最近 15 条历史 + **重复的最近 8 条短上下文** + RAG 5 条；`[代码]`
- DeepSeek 自动前缀缓存已利用：M1 真机日志 `cache_hit=1024–1536` tokens/轮，首 token 416–1195ms（`docs/M1_BACKLOG.md`）`[实测]`；
- 后台 LLM 调用：独白（每轮）、T3（每 80 条）、日记（30 快照）、叙事翻日记（非流式每轮 `await`）、herView（罕见）、发图 query；**无每日预算、无调用次数上限** `[代码]`；
- 官方价格（非高峰/高峰，元/百万 tokens）：flash 输入命中 0.02/0.04、未命中 1/2、输出 4/8；v4-pro 命中 0.15/0.30、未命中 4.5/9.0、输出 13.5/27.0；**命中与未命中差 50 倍**（来源见附录 A）`[官方]`。

---

## 2. 雷达逐项

### 2.1 Agent 编排：手写 orchestrator vs LangGraph JS / Mastra / OpenAI Agents SDK / Vercel AI SDK / DSPy

#### 现状

- 20+ 个领域步骤硬编码在两个函数里，步骤之间有大量可变状态（情绪/负债/漂移/因果链/叙事弧/session/门控），通过 `Object.assign` 直接改状态；`[代码]`（审计 4.10 亦指出难测难扩展）
- 流式回复是 `AsyncGenerator`，由 QQ 桥接逐段消费、断句、模拟打字、支持中断；`gate.type==="delay"` 时返回 `deferred` 交由桥接落库/补发；`[代码]`
- 状态通过 `state-store.ts` 落 JSON 快照，`session` 另存 JSON；**没有** durable execution / 断点续跑 / 图执行引擎。`[代码]`

#### 2026 可选方案

| 项目 | 一句话定位 | 语言/平台 | 最新版本（2026-10-19 快照） | 维护活跃度 | 许可 | 与本项目匹配度 |
|---|---|---|---|---|---|---|
| **LangGraph JS** | 低层有状态 agent 编排：图/状态/checkpoint、durable execution、HITL interrupt | TypeScript（Node/Deno/Bun） | npm `@langchain/langgraph` **1.5.1**；v1 为「稳定性优先」版本，核心图 API 不变；`createReactAgent` 已弃用，改用 LangChain `createAgent` | ★3,364，`pushed_at` 2026-10-19 | MIT | 低：我们不需要图执行/断点续跑；迁入=重写 1.5k 行 + 与现有状态文件双写 |
| **Mastra** | TS 全栈 agent 框架：Agents + 图式 Workflows + suspend/resume + memory（Observational Memory）+ evals/observability + Studio | TypeScript | npm `@mastra/core` **1.78.0**（release 2026-10-15） | ★28,907，`pushed_at` 2026-10-19；YC W25；Apache-2.0 核心 + `ee/` 商用许可 | 中：若做 Web 控制台/多端/多 agent 才值得考虑；对当前单机单人形态过重 |
| **OpenAI Agents SDK (JS)** | 轻量多 agent：agents/tools/handoffs/guardrails/sessions/tracing，provider-agnostic | TypeScript | npm `@openai/agents` **0.20.0**（仍 0.x） | ★3,928，`pushed_at` 2026-10-16 | MIT | 低：我们的主体是「人设状态机」，不是工具型 agent；0.x API 不稳 |
| **Vercel AI SDK 7** | 统一模型 provider 抽象 + 流式/工具调用/结构化输出 + 前端 hooks | TypeScript | npm `ai` **7.0.143**；官方博客《AI SDK 7 is now available》 | ★27,399，`pushed_at` 2026-10-19 | 仓库 NOASSERTION（以包内 LICENSE 为准） | **中**：只作为「传输层」替换 `chat.ts` 可考虑（S）；不值得为了它改管线 |
| **DSPy** | 声明式 LM 程序 + 优化器（用数据自动优化 prompt/示例） | Python | PyPI `dspy` **3.4.1**（2026-10-12） | ★38,695，`pushed_at` 2026-10-19 | MIT | 低：Python；且项目设计哲学明确反对静态 few-shot/响应评分（CLAUDE.md），与 DSPy 范式冲突 |

#### 逐项判断

| 方案 | 迁移收益 | 迁移成本 | 风险 | 结论 | 工作量 |
|---|---|---|---|---|---|
| LangGraph JS | 断点续跑/HITL/图可视化；对「延迟消息、长任务」有概念价值 | 重写两管线为图 + 状态迁移 + 流式适配 | 与 `state-store` 双状态源；QQ burst/中断语义需重写；升级跟随 LangChain 生态节奏 | **不换**；借鉴「checkpoint/durable execution」思想用于延迟队列 | L（若换） |
| Mastra | TS 原生、workflow suspend/resume、内置 evals/observability，最像「产品化框架」 | 存储适配 + 管线重写 + 依赖膨胀 | 框架意见强；`ee/` 许可边界；与既有 SQLite 状态模型整合成本高 | **不换**；列入 M2/M3「Web 控制台/多端」候选观察 | L（若换） |
| OpenAI Agents SDK | 现成的 tracing/guardrails/sessions | 需要把「人设」改造成 agent instructions，丢掉大部分领域步骤 | 0.x 不稳定；框架假设与「她有自己生活」的状态机模型不匹配 | **不换**；借鉴 guardrails（输出校验）+ tracing 字段设计 | M–L |
| Vercel AI SDK 7 | 省掉自研重试/流式/usage 细节；统一 provider；未来接 Web UI 方便 | 替换 `chat.ts` 传输层（保留所有调用方签名） | DeepSeek 扩展字段 `thinking` 需通过 provider options 透传（**待核实** v7 的 DeepSeek provider 支持）；流式降级/usage 逻辑要重做 | **小改可选（P2）**；当前不必要 | S |
| DSPy | 有标注数据后自动优化 prompt | 需要数据集/指标 + Python 服务 | 数据量不足；与「不做静态 few-shot」原则冲突 | **不换** | — |

#### 为什么不适合把「人设状态机 + 消息门」迁到图框架

1. **领域复杂度 ≠ 编排复杂度**：消息门是同步策略决策（毫秒级），不需要图、checkpoint、HITL；真正复杂的是情绪/关系/负债/叙事的状态转移，框架帮不上忙。
2. **状态已经在两个地方**：`state-store`（人格运行时）+ `session`（对话）。再引入框架 checkpointer = 第三个状态源，重启一致性更难，不是更容易。
3. **流式/中断语义绑定了 QQ 桥接**：`AsyncGenerator` + 逐段 yield + 中断丢弃 + delay 回执是桥接协议的一部分；框架的 stream 抽象需要重写 `qq.ts` 的 burst 发送逻辑，回归风险高。
4. **单人单机场景**：框架的收益（多用户、长任务、可视化、部署）当前都用不上，成本却是实打实的依赖与迁移风险。

#### 值得借鉴的 3 个概念（不引入框架）

| 概念 | 来源 | 在本项目的最小落地 |
|---|---|---|
| Durable execution / checkpoint | LangGraph JS | 延迟队列持久化（`docs/M1_BACKLOG.md` BUG-2 已计划）：把 `resumeAfterMs` + 待回复消息写 SQLite/JSON，启动时恢复 |
| Typed interrupt / suspend-resume | LangGraph JS、Mastra | 用户说「今天不想聊」时，把会话标记为 suspended 而不是依赖门控随机；`/pause` `/resume` 命令 |
| Guardrails | OpenAI Agents SDK | 输出后处理校验（括号动作、AI 自称、超长、越界内容）作为独立可测函数，而不是散落在 prompt 里 |

#### 结论

**不换编排框架（L 成本、低收益、高风险）**。当前真正要做的是「把双管线合并为一条步骤化管线 + 单一状态源」，这是 S–M 的工程重构，不需要框架。若 M2 做本地 Web 控制台/多端，再评估 Mastra（TS 原生、workflows + memory + observability 一体）或 AI SDK 作为 UI/流式层。

---

### 2.2 记忆层：Mem0 / Zep(Graphiti) / Letta(MemGPT) / LangMem / Cognee

#### 现状（一句话）

**有分层（T0/T1/T2/T3）但没有语义、有衰减但没有冲突消解、有画像字段但没有画像块、有记忆但没有用户控制。**

具体缺口（均可在代码中定位）：

1. T2 存的是「用户: xx | 回复: yy」的日志行，不是事实（`retriever.ts:70`）；
2. 记忆是**覆盖式**的：没有「同一件事的新旧版本」，无法表达「她以前以为 A，后来知道是 B」；
3. 冲突/纠正无处理：纠正层（`correction.ts`）写了文件但 `state.corrections` 恒空（审计 4-11）；
4. 没有用户画像块（herView 只是一个字符串且很少更新）；
5. 没有 entity/关系结构：无法回答「他妈妈叫什么」「我们上次吵架是因为什么」这类多跳问题；
6. 归档是硬 DELETE（`vector.ts:244-249`），不可恢复、无历史；
7. 无 TTL 分级：所有记忆统一 30 天半衰期（T3 90 天），内心独白与用户事实混在一起（审计 4.2：独白可被当记忆注入）；
8. 无 user_id 隔离（`vector.ts` 只有 persona_id）。

#### 2026 可选方案

| 项目 | 一句话定位 | 语言/形态 | 最新版本（2026-10-19 快照） | 维护活跃度 | 许可 | 单机 SQLite 适配度 |
|---|---|---|---|---|---|---|
| **Mem0** | 通用记忆层：单次 LLM 抽取 + 多信号检索（语义/BM25/entity）+ 时间推理 | Python 为主，有 npm `mem0ai`、自托管 Server、Cloud | PyPI `mem0ai` **2.2.1**、npm `mem0ai` **3.3.1**；README 标注「New Memory Algorithm (April 2026)」 | ★67,446，`pushed_at` 2026-10-17 | Apache-2.0 | 低：每次写入要 LLM 调用；默认依赖向量库/平台；多租户假设。但**机制值得抄** |
| **Zep / Graphiti** | 时序知识图谱：事实带有效期（valid_at/invalid_at）、episode 溯源、矛盾自动失效、hybrid 检索 | Python（Graphiti）；Zep 平台有 TS/Go SDK | PyPI `graphiti-core` **0.31.1**；README 明确需 Neo4j/FalkorDB/Neptune（Kuzu 已弃用） | ★32,037，`pushed_at` 2026-10-19 | Apache-2.0 | 低：需要图数据库 + 强 structured output 的 LLM；**时序失效机制值得抄** |
| **Letta (MemGPT)** | 有状态 agent：memory blocks（核心记忆，带 token 预算）+ archival/recall memory + 自编辑工具 | Python 服务 + npm `@letta-ai/letta-code` | PyPI `letta` **0.34.12**、npm `@letta-ai/letta-code` **0.34.17**；源码迁至 `letta-ai/letta-code` | ★25,190，`pushed_at` 2026-10-18 | Apache-2.0 | 低：是 agent runtime，不是可嵌入库；**memory block + token 预算**概念值得抄 |
| **LangMem** | LangChain 的长期记忆 SDK：hot-path memory tools + 后台 memory manager + prompt 优化 | **仅 Python**（`pip install langmem`） | PyPI `langmem` **0.0.30**（2025-10-27） | ★1,712，`pushed_at` 2026-10-02 | MIT | 低：Python-only、绑定 LangGraph store；**hot path vs background 的设计**值得抄 |
| **Cognee** | 图+向量记忆平台：文档/对话→知识图谱，可本地小模型（GLiNER）无 Key 运行 | Python 核心 + TS SDK/MCP | PyPI `cognee` **1.6.5**（2026-10-16）；README 提到 v1.6.1（2026-09-24） | ★32,538，`pushed_at` 2026-10-19 | Apache-2.0 | 低：ETL 与图数据库依赖重；**数据模型/本体（ontology）** 值得参考 |

#### 收益/成本/风险（逐项）

| 方案 | 迁移收益 | 迁移成本 | 迁移风险 | 结论 | 工作量 |
|---|---|---|---|---|---|
| Mem0 运行时 | 现成的记忆抽取 + 多信号检索 + 时间推理 | 接入 Python/Node SDK + 向量库 + 每次写入 LLM 调用 | 写放大成本、数据出境/隐私口径、多租户假设 | 不换（抄机制） | L |
| Graphiti/Zep 运行时 | 时序事实、矛盾失效、图检索质量 | 图数据库 + 结构化输出强依赖 LLM + Python 服务 | 常驻服务、LLM 抽取失败导致图谱脏、运维 | 不换（抄时序失效） | L |
| Letta 运行时 | memory blocks/自编辑/长期状态 | 引入 agent runtime + 迁移现有状态机 | 把「人设」变成「agent 指令」丢领域步骤 | 不换（抄画像块） | L |
| LangMem | hot/background 分层与 consolidation 设计 | Python-only、绑定 LangGraph store | 无法在 Node 直接使用 | 不换（抄分层） | — |
| Cognee | 图+向量一体、TS SDK/MCP、本地小模型 | ETL 管道 + 图数据库 + 本体建模 | 与 SQLite 单机场景不匹配 | 不换（参考数据模型） | L |

#### 值得借鉴的机制 → 单机 SQLite 映射（重点）

| 机制 | 来源 | 为什么值得 | 在 Karen 的最小落地（不引服务） |
|---|---|---|---|
| **ADD-only 单次抽取** | Mem0（2026-04 新算法：一次 LLM 调用，不做 UPDATE/DELETE，记忆只增不减） | 避免「改写记忆」导致的人格不一致；写入成本可预算 | 每 N 轮（或强信号时）用 **JSON Output** 调一次 flash：从最近对话抽 `{subject, predicate, object, confidence, valid_from}` → 写 `memory_facts` 表；**永不覆盖** |
| **时序有效期 + 矛盾失效** | Graphiti（fact 带 validity window；新事实使旧事实失效但保留历史） | 解决「张冠李戴」和「她慢慢变化」：旧版本可追溯，检索只看 `invalidated_at IS NULL` | `memory_facts` 加 `valid_from/valid_to/invalidated_at`；新事实与旧事实矛盾时写 `valid_to=now` 而不是 DELETE；支持「她以前以为…后来知道…」的叙事 |
| **记忆块 + token 预算 + 自编辑** | Letta/MemGPT（core memory blocks，被编辑工具修改） | 用户画像需要稳定、可审计、有预算，而不是自由文本 | 新增 `profile_block`：称呼/偏好/雷区/近期事件，**硬上限 200 tokens**；每周或里程碑时用 JSON Output 重建；注入 prompt 替代自由 herView 段落 |
| **hot path vs background** | LangMem（对话中工具写 + 后台 manager 整理） | 不能每轮都做重抽取；后台任务要能批处理 | 对话主路径只写 raw episode（零 LLM）；事实抽取/画像更新/去重合并全部异步、可跳过、有每日上限 |
| **多信号融合检索** | Mem0（语义 + BM25 + entity 并行融合）、Graphiti（semantic + keyword + graph traversal + rerank） | 单靠向量对「人名/数字/日期」弱；单靠关键词对同义表达弱 | FTS5 BM25 + 向量 + 实体命中加分（`person/place/event` 简单词典或抽取出的 entity），RRF 融合（见 2.3） |
| **用户控制（查看/删除/导出）** | 各家的 memory API（`forget`/delete by id） | 隐私合规与信任；审计 4.3 已列为 P1 | `/memory`、`/remember`、`/forget <id>`、`/export`；软删（`invalidated_at`）而非物理删除 |

#### 为什么不引入它们作为运行时

1. **语言/形态不匹配**：主力都是 Python 服务或 Python 库；Node 侧要么走 HTTP 服务（多一个进程 + 运维），要么用 npm 包但底层仍连 Qdrant/平台（`mem0ai` 需要向量库/LLM Key）。
2. **写放大成本**：Mem0 类方案每次 add 要一次 LLM 调用；Karen 已有每轮独白等后台调用，再叠加会让成本失控（当前月成本目标是几元级）。
3. **多租户假设 vs 单机单人**：这些系统的价值在「服务多用户/多 agent/跨会话治理」；Karen 是单机、单用户、SQLite 文件，收益被场景吃掉。
4. **图数据库依赖**：Graphiti 需要 Neo4j/FalkorDB；引入即多一个常驻服务，违背「个人项目开箱即用」。
5. **数据主权**：Vercel/云托管记忆与项目「本地存储」的隐私口径冲突（CLAUDE.md 开发约定 2）。

#### 结论

**不换记忆服务（L 成本、场景不匹配）**；**记忆层做机制升级（M）**：schema v2（`user_id`/`kind`/`valid_from`/`invalidated_at`/`source_episode_id`/`embedding_model`/`confidence`）+ `memory_facts` + `profile_block` + 软失效 + 混合检索 + 用户控制命令。验收指标：标注集记忆命中 hit@5 提升、冲突场景可解释、无硬删除、重启一致。

---

### 2.3 向量与检索：sqlite-vec 正确用法 vs LanceDB / Qdrant / Chroma / Milvus Lite；BM25+向量混合与 rerank

#### 现状（实测确认）

- `t2_vec` 虚拟表**只 CREATE 不写入**：`vector.ts:76-81` 建表；全仓 `grep` 只有这一处 `t2_vec`，无 INSERT/MATCH `[代码]`；
- 实际检索：`SELECT id, embedding FROM t2_episodes ...` 全量拉取 → `JSON.parse` 每条 768 维数组 → JS 点积 → 排序 `[代码]`；
- 检索质量缺陷：无阈值（负相似截 0 后保留）、无去重、无 source 过滤（内心独白/系统摘要都可能被当记忆注入）、`confidence` 只看强度不看相似度 `[代码]`；
- 数据量：单用户单机，T2 规模通常 10³–10⁴ 条；当前 JS 全量余弦在 1 万条时仍可跑（~7.7M 次乘加），但每轮 JSON.parse 1 万条 768 维字符串是主要开销，且不可索引 `[代码]`+推断。

#### 候选对比

| 方案 | 一句话定位 | 形态/语言 | 最新版本（2026-10-19 快照） | 维护活跃度 | 许可 | 结论 |
|---|---|---|---|---|---|---|
| **sqlite-vec** | 纯 C 的 SQLite 向量扩展，`vec0` 虚拟表 + KNN | C 扩展；npm `sqlite-vec` 可 `load()` 进 better-sqlite3 | npm **0.1.9**（已安装）；官方文档站 **0.1.10-alpha.4**；README 明确 **pre-v1，会有 breaking change** | ★8,196，`pushed_at` 2026-05-18（发布节奏偏慢，但稳定可用） | Apache-2.0 | **推荐（小改）**：零新依赖、同一 SQLite 文件、支持 metadata 过滤与 cosine |
| **LanceDB** | 基于 Lance 列式格式的嵌入式多模态向量库，向量+全文+SQL | Rust 核心；Python/Node.js/Rust SDK | `lancedb/lancedb` release **v0.38.0** | ★11,703，`pushed_at` 2026-10-19 | Apache-2.0 | 不换：数据量没到需要列式索引；引入原生模块与第二套存储 |
| **Qdrant** | Rust 向量数据库服务端：过滤/量化/混合检索，生产级 | Rust 服务 + REST/gRPC；JS client | Qdrant **1.18**（2026-05-11 发布，TurboQuant 等）；npm `@qdrant/js-client-rest` **1.19.0** | ★35,139，`pushed_at` 2026-10-19 | Apache-2.0 | 不换：单机单人不需要常驻服务；多进程/多端时再评估 |
| **Chroma** | 「AI 原生」向量库，collection + metadata 过滤，入门简单 | Rust 核心；Python/JS 客户端 | PyPI `chromadb` **1.5.9**（2026-05-05）；npm `chromadb` **3.5.0** | ★29,533，`pushed_at` 2026-10-17 | Apache-2.0 | 不换：需要第二个数据库；Node 侧嵌入仍需自己做 |
| **Milvus Lite** | 嵌入式 Milvus（本地 `.db`），支持 BM25/混合检索/Jieba 分词 | **纯 Python**（README 明确 Python 3.10+，`pymilvus` 驱动） | PyPI `milvus-lite` **3.2.2** | ★465，`pushed_at` 2026-10-16 | Apache-2.0 | **不适用**：Python-only，Node 项目无法直接使用 |
| **SQLite FTS5** | SQLite 内置全文检索：`bm25()` 排序、trigram/unicode61 分词 | SQLite 内置（better-sqlite3 编译开启 FTS5，本次实测 `ENABLE_FTS5=true`） | SQLite **3.53.2**（实测） | 随 SQLite 维护 | Public Domain | **推荐（混合检索另一半）**：零依赖 BM25 |

#### 收益/成本/风险（逐项）

| 方案 | 迁移收益 | 迁移成本 | 迁移风险 | 结论 | 工作量 |
|---|---|---|---|---|---|
| sqlite-vec（vec0） | 索引化 KNN、metadata 过滤、同一 SQLite 文件、零新服务 | 建表/写入/同步/回填 + 适配 pre-v1 API | 向量表与主表不同步；升级 breaking change | **值得做** | S |
| FTS5 BM25 | 关键词/原话命中，补向量短板，零依赖 | 分词策略（中文）+ external content 表 + 触发器 | 2 字词 trigram 不命中；分词不一致 | **值得做** | S–M |
| LanceDB | 列式索引/多模态/版本化，10⁵+ 数据更强 | 引入原生模块 + 第二套存储 + ETL | 双存储一致性、体积、运维 | 不换（观察） | M–L |
| Qdrant | 生产级过滤/量化/混合检索 | 需常驻服务（Docker/二进制）+ 客户端 | 单机单人运维负担 | 不换 | M |
| Chroma | 简单 collection + metadata 过滤 | 第二个数据库 + 嵌入仍需自备 | 双存储一致性 | 不换 | M |
| Milvus Lite | 本地 BM25/hybrid/Jieba 一体 | **Python-only**，Node 需跨语言服务 | 进程/协议适配成本 | 不适用 | — |

#### sqlite-vec 正确用法（本项目缺失的部分）

官方文档要点（[vec0 文档](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)、[KNN 文档](https://alexgarcia.xyz/sqlite-vec/features/knn.html)、[Node.js 文档](https://alexgarcia.xyz/sqlite-vec/js.html)）：

1. **建表指定距离度量**：默认是 L2；要余弦必须显式 `distance_metric = cosine`（否则「归一化后 L2」和真余弦排序不一致的怀疑会一直存在）；
2. **KNN 写法**：`WHERE embedding MATCH ? AND k = 10`（`LIMIT` 需要 SQLite ≥3.41，本项目 3.53 可用，但 `k=` 兼容性最好）；
3. **非向量列三种方式**：
   - **metadata columns**（普通列定义）：可进 KNN 的 WHERE 过滤（`persona_id = ?`、`source != 'internal_monologue'`），最多 16 个；
   - **partition key**：内部按 key 分片，适合每分区「上百条以上」；**单人单 persona 数据量小时不要滥用**，会过分割；
   - **auxiliary columns**（`+content`）：避免 JOIN，但**不能进 WHERE**；
4. **Node 绑定**：`Float32Array` 必须传 `.buffer`（或 `Uint8Array(buf)`）；传 JSON 字符串/`number[]` 会类型不匹配；
5. **pre-v1 注意**：0.1.x 会有 breaking change，升级要锁版本（当前 `package.json` 已 `^0.1.9`，但 `^` 仍可能升 minor；建议临时锁死 + 有升级测试）。

最小正确写法（示意，不直接改代码）：

```sql
-- 1) 向量索引表：用 metadata 列过滤 persona/source，不用 partition（数据量小）
CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(
  episode_id INTEGER PRIMARY KEY,
  persona_id TEXT,                 -- metadata column
  source     TEXT,                 -- metadata column
  embedding  FLOAT[768] distance_metric = cosine
);

-- 2) 写入（与 t2_episodes 同一事务）
INSERT INTO t2_vec(episode_id, persona_id, source, embedding)
VALUES (?, ?, ?, ?);   -- embedding 用 Float32Array.buffer 绑定

-- 3) 检索：先向量 topK，再过滤/加权
SELECT episode_id, distance
FROM t2_vec
WHERE embedding MATCH ? AND k = 30
  AND persona_id = ? AND source != 'internal_monologue'
ORDER BY distance;
```

#### 混合检索（BM25 + 向量）与 rerank 的最小可行方案

**为什么需要**：纯向量对「人名/日期/数字/原话」弱；纯 BM25 对同义改写弱；Karen 的记忆是「聊天式短句」，两者互补非常明显。

**实测（本项目环境，2026-10-19）**：better-sqlite3 12.11.1 / SQLite 3.53.2 `ENABLE_FTS5=true`；FTS5 的 `trigram` 分词对中文 **2 字词查不到、≥3 字可命中**；把中文逐字加空格后用 `unicode61` 建索引，2 字词可命中。结论：**中文 BM25 必须选分词策略**：

| 策略 | 2 字词 | 是否需额外依赖 | 适用 |
|---|---|---|---|
| `tokenize='trigram'` | ❌（MATCH 无结果） | 无 | 3 字以上片段、英文/数字；作为对照组 |
| 逐字空格预分词 + `unicode61` | ✅ | 无（自己写 `Array.from(s).join(" ")`） | **MVP 推荐**：中文短句、零依赖 |
| jieba/external tokenizer | ✅ 更好 | 需要依赖/扩展 | 数据量上来后再评估（当前不引） |

**MVP 方案（S–M，零新依赖）**：

1. `t2_fts` 用 FTS5 external content 表（`content='t2_episodes', content_rowid='id'`）+ 三个触发器保持同步；索引列存「逐字空格」文本（或 trigram 版本对照）；
2. 检索：向量 top 30（sqlite-vec）+ BM25 top 30（FTS5）→ **RRF 融合**（`score = Σ 1/(60+rank)`）→ 过滤（persona/source/strength/decay）→ 取 top 5；
3. 阈值/去重：cosine < 0.35（**待标定**）直接丢弃；相同 content hash 只留最高分；最近 3 轮已出现的内容不重复注入；
4. rerank 三档（按需升级）：
   - **档 1（默认，零成本）**：RRF + 衰减强度 + 情感权重加权，不上模型；
   - **档 2（本地 cross-encoder）**：`BAAI/bge-reranker-v2-m3`（FlagEmbedding，MIT，multilingual，官方推荐）经 transformers.js/ONNX 在本地跑；CPU 延迟与 ONNX 可用性 **待核实**；适合 M2；
   - **档 3（LLM rerank）**：top 10 交给 `deepseek-flash` 做一次「选出最相关的 3 条」JSON 调用（~300 tokens、+0.5s），仅在「复杂/回忆类」消息触发；
5. 评测：用标注集（query → 期望 episode/fact id）算 hit@1/@5、MRR，对比「纯 n-gram」「纯向量」「混合」三档（见 2.6）。

#### 结论

**用 sqlite-vec 正确用法 + FTS5 混合（值得换，S–M）**；不引入 LanceDB/Qdrant/Chroma；Milvus Lite 因 Python-only 直接排除。关键风险：向量表与主表同步、维度/模型版本、中文分词预期（详见第 6 节）。

---

### 2.4 Embedding：n-gram 现状 vs 本地 ONNX / BGE-M3 / EmbeddingGemma / Qwen API

#### 现状（含两个隐藏 bug）

- 主路径：`generateEmbedding()` 字符 n-gram（unigram/bigram/trigram）→ FNV-1a 哈希 → 768 维符号投影 → L2 归一化；**这是词法哈希，不是语义模型**：同义改写（「难过」vs「不开心」）不相似，只有字面重叠才相似 `[代码]`（`src/data/embedding.ts:45-76`）
- 语义路径：`generateSemanticEmbedding()`（Qwen `text-embedding-v3`，DashScope OpenAI 兼容）**全仓 0 调用**；`upgradeEmbeddings()` 回填函数也 0 调用 `[代码]`（`embedding.ts:89,184`）
- **Bug A（维度截断）**：`callEmbeddingApi` 拿到 Qwen 向量后 `normalizeToDim(emb, 768)`：若返回 1024 维则**直接截断前 768 维再归一化**（`embedding.ts:157-178`）——可用但丢信息，且与 Qwen 官方推荐用法不一致；应显式请求 768 维（若 API 支持 `dimensions`，**待核实**）或把列宽改成 1024；
- **Bug B（向量空间混用）**：即使有人调用 `upgradeEmbeddings()` 回填旧数据，**新写入仍走同步 n-gram**（`insertEpisodeWithEmbedding` 只接受调用方传入的向量，`retriever.ts:71` 用 n-gram）→ 同一 `embedding` 列里同时存在「语义向量」和「哈希向量」，余弦比较无意义。**这是迁移时最容易踩的坑**（见第 6 节）。

#### DeepSeek 的约束

DeepSeek 官方模型清单只有 `deepseek-flash` / `deepseek-v4-pro`，能力矩阵**没有 Embeddings**（JSON/Tools/Responses/Anthropic/FIM/视觉都有，独缺 embedding）；项目实测 `POST /embeddings` 返回 404（`DEEPSEEK_CAPABILITY_AUDIT.md` 7 节）。因此：**embedding 必须由外部（Qwen API / 本地模型）提供，这个约束 2026 年不变**。

#### 候选对比

| 方案 | 一句话定位 | 形态 | 关键参数（来源见附录） | 许可/成本 | 适配度 |
|---|---|---|---|---|---|
| **Qwen `text-embedding-v3`（DashScope API）** | 阿里云托管 embedding，OpenAI 兼容接口；代码已实现 | HTTP API（需 QWEN Key） | 代码把 API 返回向量截断/补零到 768 维（若返回 1024 维则丢尾部 256 维）；单价 **待核实**（官方价目页） | 按 token 计费；查询+写入约 200 tokens/轮 → 成本量级可忽略（月 < ¥1） | **最高**：S 成本接通，无需 GPU，无模型分发 |
| **Qwen3-Embedding（0.6B/4B/8B）** | 开源多语言 embedding/rerank 系列，指令感知 + MRL | 开源权重（HF/ModelScope）；可 ONNX/llama.cpp 本地 | 0.6B：1024 维 / 32K 上下文；4B：2560；8B：4096；MRL 支持自定义维度；100+ 语言（官方 README，2026-10 查） | 许可按 HF 模型卡（**待核实**）；0.6B 本地 CPU 可跑，4B/8B 偏重 | 中：本地隐私好，但需 ONNX 转换/运行器，体积 0.6B≈1.2GB(fp16) 起 |
| **BGE-M3** | 多语言、多粒度（8192）、多功能（dense+sparse+colbert）embedding；中文强 | 开源权重；ONNX 生态较成熟 | 100+ 语言、8192 tokens、dense/sparse/colbert 三合一（FlagEmbedding README，MIT）；维度 1024（**待核实于 HF 卡**） | MIT；568M 参数，CPU 推理偏慢 | 中：质量强；若启用 sparse 可省掉 FTS5？但 Node 侧支持链路长 |
| **EmbeddingGemma（300M 级）** | Google 端侧 embedding 系列，主打设备端、多语言、MRL | 开源权重（Gemma 生态） | 300M 级、MRL 维度（768/512/256 等），2026 年已有「EmbeddingGemma 2」公开报道；官方页本次抓取失败 → **具体维度/许可/ONNX 支持待核实** | Gemma 许可（待核实） | 中高：CPU/端侧友好，若能拿到 ONNX 版本是最佳本地选项 |
| **bge-small-zh-v1.5** | 中文小模型 embedding（BGE 系列），CPU 友好 | 开源权重（ONNX 生态成熟） | 512 维（**待核实**）；体积 ~100MB 级 | MIT | 高（本地 MVP）：最快落地、中文够用 |
| **transformers.js 4.x** | 在 Node/浏览器直接跑 ONNX 模型的运行时 | npm `@huggingface/transformers` **4.3.1** | 支持 `feature-extraction` pipeline（embeddings）；ONNX Runtime 后端 | Apache-2.0 | **本地方案的载体**：无需 Python 服务 |

#### 建议路线（分三步，不一步到位）

| 阶段 | 做什么 | 收益 | 成本 | 风险 |
|---|---|---|---|---|
| **P0（现在，S）** | 接通已实现的 Qwen API：统一 async `embed()`（查询与写入同源）；**修掉截断/维度问题**；写入时记录 `embedding_model`；失败降级 n-gram 并标记；新增/存量数据全量重嵌（复用 `upgradeEmbeddings` 思路但纳入写入路径） | 立刻获得语义检索；隐私口径需如实写「记忆文本会发 Qwen」（CLAUDE.md 要求） | S（1 天内可完成 + 回归） | 网络依赖；Qwen Key；维度一致性 |
| **P1（M2，M）** | 本地 ONNX 选项：优先 `bge-small-zh-v1.5`（快）或 EmbeddingGemma（质量/端侧），用 transformers.js 4.x 加载；`EMBEDDING_PROVIDER=ngram\|qwen\|local` 配置化；模型文件首次下载/内置 | 隐私（记忆不出本机）、离线可用、无 API 成本 | M（1–3 天 + 模型分发） | ONNX 模型可用性（待核实）；CPU 延迟；包体积 |
| **P2（观察）** | BGE-M3 / Qwen3-Embedding-0.6B 作为高质量本地选项（如果 P1 质量不够） | 质量提升 | M–L | 体积/CPU；需基准测试证明收益 |

**成本估算**：Qwen embedding 每轮约 1 次查询 + 1 次写入（~200 tokens），按托管 embedding 的公开价量级每月远低于 ¥1（**具体单价待核实**）；本地模型为一次性下载 + CPU 电费。结论：**成本不是决策因素，隐私与质量才是**。

#### 结论

**值得换（P0 S 成本）**：先把已写好但没接线的 Qwen 语义路径接通并修维度/一致性问题；**不推荐**训练/微调 embedding、不推荐 8B 级本地模型。本地 ONNX 作为 M2 隐私选项保留。

---

### 2.5 DeepSeek V4 能力利用：thinking / JSON Output / Tool Calls / Search / prompt cache / Anthropic / Responses

#### 能力现状与未用价值

| 能力 | 官方（2026-10） | 本项目现状 | 未用价值 | 建议 | 工作量 |
|---|---|---|---|---|---|
| **思考模式** | 默认开启；`thinking:{type}` 可关；effort low/high/max；reasoning 与正文共用 max_tokens；思考模式不支持 temperature；带 tools 时必须回传 reasoning_content | 已默认关闭并实测修复空回复；complex 自动走 v4-pro；**但未给思考留预算**（`COMPLEXITY_TOKENS` 160/320/640 是按非思考定的） | 对「复杂情绪分析/长文回忆」可能有质量收益 | **保持关闭**；若将来开启：仅 complex、`max_tokens×2–3`、且必须重做预算与回归 | S |
| **JSON Output** | `response_format:{type:"json_object"}`；prompt 须含 `json` 字样+样例；官方承认**有概率空 content** | **0 使用**；后台任务全是自由文本 + 正则/`JSON.parse` | 高：记忆抽取、情绪/事件标注、herView、日记、独白、关系事件、评测 judge 全部可结构化 | **P1 接入**：统一 `jsonTask<T>(schema, prompt)` 封装（thinking disabled + max_tokens ≥300 + 解析失败兜底 + 空 content 重试） | S |
| **Tool Calls** | function calling；思考模式也可用（需回传 reasoning_content）；`/beta` 有 strict 模式 | **0 使用**；天气/热点/搜索都预取后拼 prompt | 中：天气/搜索可工具化；记忆读写可工具化（Letta 式） | **暂缓（P2）**：工具循环增加延迟与状态复杂度；先把 JSON Output 用起来 | M |
| **Search / Fetch API** | 独立 API；Search 5 元/1000 成功请求，QPS 100；Fetch 5 元/1000，QPS 25；失败/无结果不计费 | `trending-fetcher.ts` 是 **20 条硬编码话题池**（零 HTTP） | 高：「她有自己的生活」需要真实热点；可带人设语境查询 | **P1 接入**：每 1–2h 搜一次 + 缓存 + 只取 snippet；成本 ≈ ¥1.8/月 | S |
| **prompt 前缀缓存** | 默认开启；命中/未命中差 50 倍价格；usage 返回 `prompt_cache_hit_tokens` | 已利用；真机 `cache_hit=1024–1536`/轮；静态块按人设缓存、动态追加尾部 | 高：输入成本的主要杠杆 | **P2 优化**：静态块逐字节稳定、监控命中率（目标 ≥60%）、避免动态内容前置 | S |
| **Responses API** | 支持；内置 `web_search` 工具**仅 v4-pro**；无状态、不支持 previous_response_id | 0 使用 | 低：Chat Completions 已够；web_search 仅 pro 且计费不同 | **不换** | — |
| **Anthropic API** | `base_url=/anthropic`；`claude-*` 映射到 DeepSeek；支持 thinking block | 0 使用 | 低：只在想复用 Claude SDK/工具链时有意义 | **不换** | — |
| **视觉** | 仅 flash 支持；`detail:"low"` 省 token（实测 208 vs 1015） | 已接：下载→base64→low→≤15 字 | 中：描述太短导致回应泛化（M1_BACKLOG IMP-1） | **小改**：描述 30–60 字，仍用 low | S |
| **长上下文** | 1M 上下文 / 384K 输出 | 用不上 | 低 | **不追求**：检索比堆上下文便宜且质量更好 | — |

#### 关键结论

1. **thinking 保持关**是正确决策（省钱 + 修空回复 + 降延迟），不要为了「更聪明」在聊天主路径开；
2. **JSON Output 是当前最大的一块未用价值**：它不是「更花哨」，而是把 7 个旁路调用从「自由文本 + 脆解析」变成「schema 契约」，直接减少脏数据与静默失败；
3. **Search 替换硬编码热点**是 M1-8 的现成方案，成本极低；
4. Tool Calls / Responses / Anthropic 当前**没有值得迁移的价值**；工具化留到「她真的会用工具查天气/搜东西/记事情」的产品阶段；
5. prompt cache 已经是免费收益，继续监控命中率即可，不必额外工程。

---

### 2.6 评测与可观测：Langfuse / OpenTelemetry GenAI / OpenAI Evals / promptfoo

#### 现状

- `src/eval/` 是死代码（见 1.4）：一致性评估/LLM Judge/情感曲线/关系弧线/门消融/嵌入基准都有代码，但**没有生产入口、没有金标数据、参数未接线**（审计 10-7/10-8 指出消融参数原样返回、Recall 恒 0）；
- 运行时可观测只有 `console.log`：无请求 ID、无 trace、无结构化字段；usage 有打印但**不聚合、不落盘、不算钱**；
- 人设一致性从未被自动化度量（括号动作、AI 自称、长度、口头禅等只能靠肉眼）；
- 记忆检索质量从未被度量（改动 embedding/检索 = 盲改）。

#### 候选对比

| 方案 | 一句话定位 | 形态 | 最新版本（2026-10-19 快照） | 维护活跃度 | 许可 | 适配度 |
|---|---|---|---|---|---|---|
| **promptfoo** | 命令行 + 库的 LLM 评测/红队工具：YAML 用例、断言（contains/regex/json/llm-rubric）、CI、模型对比 | Node.js CLI/npm | npm **0.124.1** | ★26,148，`pushed_at` 2026-10-19；README 注明「已加入 OpenAI，仍 MIT 开源」 | MIT | **最高**：JS 原生、本地跑、CI 友好，和项目同语言 |
| **Langfuse** | LLM 应用可观测 + prompt 管理 + 评测 + 数据集；OTel 风格 trace | Web 服务（Docker 自托管）或 Cloud；JS/Python SDK | npm `@langfuse/client` **6.0.1**、`@langfuse/otel` **6.0.1**；2026-01 起加入 ClickHouse（README） | ★36,026，`pushed_at` 2026-10-19 | MIT（`ee/` 除外） | 中：自托管要 Docker + ClickHouse，对单机个人项目过重；Cloud 有免费额度但隐私口径需评估 |
| **OpenTelemetry GenAI** | 跨语言可观测标准：GenAI spans/metrics/events 语义约定 | 语言无关规范 + SDK | GenAI 语义约定已迁到独立仓库 `open-telemetry/semantic-conventions-genai`；**schema URL 仍 TODO（未稳定）**；npm `@opentelemetry/sdk-node` **0.223.0**、`@opentelemetry/semantic-conventions` **1.43.0**（2026-10-19） | 规范类项目，随 OTel 维护 | Apache-2.0 | 中：字段设计值得抄；现在全量接入是过度工程 |
| **OpenAI Evals** | 评测框架/数据集注册表（Python） | Python 库 + 平台 | PyPI `evals` **3.0.1.post1**；仓库 ★19,620，`pushed_at` 2026-04-14 | 维护节奏放缓 | 仓库 NOASSERTION（以 LICENSE 为准） | 低：Python 生态、偏 OpenAI 模型；不引，借鉴「数据集+grader」结构 |

#### 落地到「对话质量 / 记忆命中 / 人设一致性」的具体做法

按「便宜、可自动化、能指导决策」排序，**不要一上来接 Langfuse**：

**A. 人设一致性（规则断言，零 LLM 成本，最先做）**
- 指标：括号动作率（`（…）`/`(…)` 出现在回复中）、AI 自称率（"作为AI/根据训练数据"）、长度分布（目标 5–15 字/条，长回复占比）、连续问句率、口头禅命中率、hardRules 违规率；
- 实现：纯函数 `checkPersonaConsistency(replies: string[], persona)` → promptfoo 断言或 vitest 快照；对 100 条真实回复跑一次就能定位退化。

**B. 记忆命中（标注集 + 检索指标，做 embedding/检索改动前必须先有）**
- 数据集：50–100 条 query，每条标 `expected_episode_ids`（或 expected fact 三元组）+ 10 条「本应无命中」的负例；
- 指标：hit@1、hit@5、MRR、负例误命中率；
- 实现：直接 import `retrieveRelevantMemories`（或新接口）跑离线脚本；对比「n-gram / 纯向量 / 混合 / +rerank」四档；**这是 2.3/2.4 改动的验收依据**。

**C. 对话质量（LLM Judge，少量抽样，每周）**
- Rubric 5 维（每维 1–5）：人设一致 / 自然度（像微信不像文章）/ 记忆使用恰当 / 情绪适配 / 不越界；固定同一 prompt、同一模型（flash、thinking disabled、JSON Output）、20–50 条抽样；
- 必须做**盲评 A/B**（改前 vs 改后，随机顺序、未知来源），否则 judge 偏好会骗自己；
- 复用 `eval/consistency-eval.ts` 的 judge prompt 思路即可，**不要直接复活整条死代码链路**。

**D. 运维指标（每轮落 JSONL trace）**
- 字段：`turn_id, persona_id, ts, complexity, model, prompt_tokens, completion_tokens, cache_hit_tokens, latency_ms, first_token_ms, gate_decision, retrieved_memory_ids+scores, compressed_t3?, background_llm_calls, error`；
- 落盘：`data/traces/YYYY-MM-DD.jsonl`（或 SQLite `trace` 表）；每日/每周脚本聚合 p50/p95、缓存命中率、每轮成本、记忆命中率；
- 隐私：trace 默认不存消息原文（长度 + hash），调试开关才存（对齐 M1_BACKLOG IMP-5）。

**E. 工具选择：promptfoo 先行，Langfuse/OTel 后置**
- 现在：promptfoo + 规则断言 + JSONL trace 足够（成本 S–M，无需新服务）；
- 当出现「多轮回归要火焰图/多端 trace 汇聚/人工标注队列」需求时，再评估 Langfuse 自托管（Docker + ClickHouse，M 成本）；
- OTel GenAI：现在只**借字段名**（`gen_ai.request.model`、`gen_ai.usage.input_tokens` 等），等规范 stable 再考虑导出。

#### 为什么「旧 eval 代码」不能直接复活

1. 没有金标数据（`embedding-bench` 是自检索恒等，`gate-ablation` 参数未接线）；
2. 对外指标不可复现，重新跑只会产出更难看且不可比的数字；
3. 评测必须**先有任务定义**（记忆命中/人设一致性），旧代码是「指标堆砌」不是「验收条件」。

#### 结论

**值得建最小闭环（M）**：promptfoo + 3 类指标（A/B/C）+ JSONL trace；Langfuse 自托管与 OTel 全量接入**暂缓**（P2）。工作量拆分：A 0.5d、B 1d、C 1d、D 0.5d。

---

### 2.7 成本与上下文工程：prompt 压缩 / token 预算 / 缓存命中

#### 现状（可量化的问题）

| 问题 | 证据 | 影响 |
|---|---|---|
| 静态人设 prompt 1.5–3k tokens | 审计 4.9；`prompt-builder.ts` 静态块含大量提示词 | 每轮输入成本主体；缓存命中后仍占 miss 部分 |
| 短期上下文与历史**重复** | `buildChatMessages` 已注入最近 15 条（`history.ts:163-184`）；`buildShortTermContext` 又取最近 8 条拼进 system（`orchestrator.ts:1499` 起、`chat.ts:69-85`） | 白白多 ~8 条 × 80 字 ≈ 300–600 tokens/轮 |
| 后台调用无预算 | 独白每轮、T3 每 80 条、日记/发图/herView 各自触发 | 成本不可控、夜间可能集中触发 |
| usage 不聚合 | `chat.ts` 只打印 + 进程内累计 | 无法知道每天花了多少、缓存命中率趋势 |
| 无压缩/预算机制 | 无 `DAILY_TOKEN_BUDGET`、无单轮上限 | 长会话/异常重试时成本尖刺 |

#### 工程做法（按性价比排序）

1. **静态 prompt 瘦身（最高性价比）**：审计 2.3 已列出「写了但不消费」的人设字段（hardRules 的 neverDo/alwaysDo/boundaries、emotions 的 baseline/range/triggers、world.goals 等）。两种做法：
   - a) 把未消费字段**接进** prompt（M1-6，收益是人格差异更明显）；
   - b) 把 prompt 里**重复/低价值内容裁掉**（如重复的「不用括号」提示出现两次、超长「重要提示」清单），目标静态块 ≤1.5k tokens。
   建议先 b 后 a：先降成本，再按需接线。
2. **去掉重复注入**：短期上下文只保留「被历史窗口截断后的更早摘要」；若 15 条历史已覆盖，`shortTermContext` 传空。预计省 5–15% 输入 tokens。
3. **缓存友好写法（已有，继续守住）**：
   - 静态人设/系统规则放 `messages[0]` 最前、逐字节稳定（不要在静态块里放时间戳/随机数）；
   - 动态内容（时间/情绪/关系/RAG/门控提示）放 system 尾部或后续消息；
   - 不要随机重排段落；RAG 措辞随机化只能放在静态块之后（当前实现符合）；
   - 监控 `prompt_cache_hit_tokens`，目标 ≥60%（当前真机 1024–1536，已达标）。
4. **单轮 token 预算表（建议值，按非思考 flash 估）**：

| 部分 | 建议上限 | 现状 |
|---|---|---|
| 静态人设 | ≤1,500 | ~1.5–3k |
| 当前状态标签 + 行为指南 + 原则 | ≤350 | 动态块 |
| 关系 + 纠正 | ≤150 | 动态块 |
| 历史（15 条） | ≤800 | 现状 15 条 |
| RAG（5 条 × ≤120 字） | ≤500 | 现状 5 条 |
| 门控/中断/时间标签 | ≤150 | 现状 |
| **合计** | **≤3,000** | 现状 ~3–4k+ |

5. **后台任务预算**：每轮最多 1 个后台 LLM 调用（默认独白）；日记/T3/画像更新改为「离线批处理」（夜间/空闲时，单次批处理多任务）；所有后台调用 flash + thinking disabled + max_tokens ≥300；加 `DAILY_LLM_CALL_BUDGET` 与超限告警。
6. **T3 压缩修复**：加「已压缩」标记（或用 `source`/`compressed_at` 字段）、并发锁、每 80 条只压一次；压缩结果 3–5 句叙事，替代原文注入；原 episode 降 strength 而非删除。
7. **上下文压缩的边界**：不要追求 1M 上下文硬塞；「检索 + 摘要 + 结构化状态标签（~15 tokens）」比堆历史更便宜也更像人。真正需要长上下文时优先 T3 摘要 + 关键词/时间过滤。
8. **成本核算落地**：把官方价目表做成常量（输入命中/未命中/输出，flash 与 pro，非高峰/高峰），每轮用 `usage` 计算 `cost_cny` 写 trace，每日汇总；再加 `MONTHLY_BUDGET_CNY` 告警。

#### 预期收益

- 静态瘦身 + 去重：输入 token 降 30–50%，在缓存命中 60–80% 下月成本可从「几元」进一步降到「几毛–几元」量级（**估算，非账单承诺**）；
- 后台预算：消除不可控成本尖刺；
- 缓存命中率监控：把「省 50 倍」的杠杆变成可观测指标。

#### 结论

**小改（S–M）**：不做复杂压缩算法，先把「瘦身 + 去重 + 预算 + 指标」四件事做好，收益已经足够。

---

## 3. 收益/成本矩阵与路线

| 事项 | 收益（1–5） | 成本 | 风险 | 建议顺序 | 对应路线 |
|---|---|---|---|---|---|
| sqlite-vec 正确接入 + 向量写入路径 | 5 | S | 低（同步/维度） | 1 | M1-7 |
| 语义 embedding 接通（Qwen API，修维度/一致性问题） | 5 | S | 中（网络/隐私口径） | 1 | M1-7 |
| 混合检索 BM25+向量 + 阈值/去重/来源过滤 | 5 | M | 中（中文分词/标定） | 2 | M1-7 |
| JSON Output 统一后台结构化任务 | 4 | S | 低（空 content 兜底） | 2 | M1-4/M1-5 延伸 |
| 最小评测闭环（promptfoo + 3 类指标 + JSONL trace） | 4 | M | 低 | 2 | M2-8 前置 |
| Search API 替换硬编码热点 | 3 | S | 低（缓存/成本） | 3 | M1-8 |
| 记忆 schema v2（facts/画像块/时序失效/软删） | 4 | M | 中（数据迁移/一致性） | 3 | M1-10 + M2 |
| 静态 prompt 瘦身 + 去重 + 预算 | 3 | S | 低（人格变淡需回归） | 3 | M1-9 |
| 本地 ONNX embedding（隐私/离线） | 3 | M | 中（模型/CPU） | 4 | M2 |
| 工具调用（天气/搜索/记忆读写工具化） | 2 | M | 中（延迟/状态） | 4 | M2/M3 |
| Vercel AI SDK 传输层替换 | 2 | S | 低–中（thinking 透传待核实） | 4 | 可选 |
| Mastra/LangGraph 重写编排 | 2 | L | 高 | 不推荐 | — |
| 外部记忆服务（Mem0/Zep/Letta/Cognee） | 2 | L | 高（服务/成本/口令） | 不推荐 | — |
| 专用向量库（Qdrant/Chroma/LanceDB/Milvus） | 1 | M–L | 中 | 不推荐 | — |

**路线映射**：1–2 项对应审计 M1-7（记忆质量）；JSON Output 对应 M1 剩余「后台任务可靠性」；评测对应 M2-8，但建议提前到 M1 末尾做最小版；记忆 schema v2 对应 M1-10（数据主权）与 M2「长期关系记忆」。

---

## 4. 如果只做 3 件事（详细方案）

### 第 1 件：记忆检索闭环（P0，S–M，约 2–4 天）

**目标**：让「她记得你说过」从 n-gram 字面匹配升级为「语义 + 关键词 + 时间/情感权重」的可用记忆，且可度量。

**改动点（按顺序）**：
1. 统一 embedder：`embed(text): Promise<{vector: Float32Array, model: string}>`；查询与写入同源；失败降级 n-gram 并记录 `model='ngram'`；
2. 修维度：请求 Qwen 时显式 768（若 `dimensions` 支持，待核实）或把 `FLOAT[768]` 改 1024；删除「1024→768 截断」路径；
3. sqlite-vec 接入：建 `t2_vec`（`distance_metric=cosine`，metadata 列 persona/source），写入与 T2 同事务；删除/归档同步；提供 rebuild 脚本（从 `t2_episodes.embedding` 重建）；
4. 混合检索：FTS5（中文逐字空格方案）+ 向量 top30 → RRF → 过滤（source 排除内部独白、strength/decay、去重、最近 3 轮去重）→ top5；
5. 阈值与 confidence 重定义：`confidence` 综合「相似度 + 强度 + 来源可信度」，而不是只看强度；
6. 把 T2 写入内容从「日志行」升级为「摘要句」：`storeConversationEpisode` 只存用户关键信息 + 她的事实性回应，且长度 ≤120 字（不存全量原文）；
7. 迁移：`embedding_model` 列 + 全量重嵌入 + 旧向量标记。

**验收**：标注集 hit@5 比 n-gram 基线提升 ≥20pp（示例目标）；负例误命中率下降；每轮检索耗时 <100ms（1 万条内）；`/stats` 展示记忆数/命中数；重启后一致。

**风险**：向量空间混用（必须一次性重嵌 + 禁止新旧混写）；中文 BM25 2 字词（用逐字空格方案兜底）；Qwen Key 缺失时降级行为必须显式可见（否则默默退回 n-gram 又「看起来没效果」）。

### 第 2 件：JSON Output 统一后台结构化任务（P1，S，约 1–2 天）

**目标**：把 7 个旁路 LLM 调用从「自由文本 + 正则」变成「schema 契约」，顺带修复空 content/截断。

**改动点**：
1. 新增 `ai/structured.ts`：`jsonTask<T>({ system, user, schema, maxTokens=400, model='flash' })`：显式 `thinking disabled`、`response_format: json_object`、prompt 含 `json` 字样 + 样例、超时/重试/usage 记录、**解析失败与空 content 兜底**（重试一次 → 返回 null）；
2. 逐步迁移：`internal-monologue`（独白）、`persona-journal`（日记）、`her-view`（她眼中的你）、`t3-summarizer`（摘要）、记忆事实抽取（新）、关系事件抽取（新）、评测 judge；
3. 为每个任务定义最小 schema（如独白：`{thoughts: string[], self_awareness: 0..1}`；事实：`{facts: [{subject, predicate, object, confidence, valid_from}]}`）；
4. 每个任务加「空结果可接受」语义（不要因为解析失败就抛错阻塞主流程）；
5. 顺带把 `eval/run-ab-eval.ts` 的旧模型名/thinking 修掉或直接删除（死代码）。

**验收**：所有后台任务在「thinking 关闭 + max_tokens 300–400」下非空率 ≥95%（采样 50 次）；解析失败率 <2%；不引入新的主路径阻塞；usage 日志能看到这些调用。

**风险**：官方承认 JSON 模式有概率空 content（叠加 thinking 会放大）→ 必须显式关思考 + 余量 + 兜底；schema 太复杂会降低合规率（先 3–5 字段）。

### 第 3 件：最小评测闭环（P1，S–M，约 2–3 天）

**目标**：让「记忆/人设/质量」的每次改动都有数字，而不是靠感觉。

**改动点**：
1. 数据集：`eval/datasets/`（不进生产路径）：
   - `memory_cases.jsonl`：50–100 条 query + expected ids + 10 条负例；
   - `persona_cases.jsonl`：20–30 条典型对话（越界/冷淡/撒娇/回忆）→ 规则断言 + judge rubric；
2. promptfoo 配置：`promptfooconfig.yaml`（provider 用 DeepSeek OpenAI 兼容端点 + 项目导出的 `buildPromptForEval()`），断言：人设规则（正则）、记忆命中（自定义 JS 断言）、质量（`llm-rubric`，同一 judge prompt）；
3. JSONL trace：每轮写 `data/traces/`；每日脚本聚合 p50/p95、tokens、cache_hit、cost、gate 分布、记忆命中；
4. CI：PR 时跑规则断言（不调外部模型的部分）+ 单元测试；每周手动跑一次全量 judge/AB。

**验收**：改 embedding/检索前后能给出「hit@5、人设违规率、judge 均分、成本/轮」的四行对比；回归失败能定位到具体 case。

**风险**：judge 自偏好（用盲评 + 固定 judge 模型）；数据集太小导致噪声（先 50 条起，逐步扩）；不要把死代码 eval 复活成第二套体系（新目录、新入口）。

---

## 5. 明确「不推荐跟风」清单

| 项 | 为什么听起来对 | 为什么不建议 | 什么条件下再考虑 |
|---|---|---|---|
| **LangGraph JS / Mastra 重写 orchestrator** | 「业界都在用编排框架」；可视化、断点续跑、HITL 听起来很专业 | 我们的复杂度在人设领域逻辑，不在编排；迁移=重写 1.5k 行 + 第三状态源 + 重写 QQ 流式/中断；收益（多用户/长任务/部署）当前用不上 | 做本地 Web 控制台/多端/多用户托管时，用 Mastra 或 AI SDK 作为 UI+流式层 |
| **OpenAI Agents SDK 作为主架构** | 官方 SDK、tracing/guardrails 现成 | 0.x 不稳定；它是「工具型 agent」范式，Karen 是「人设状态机」；会丢掉情绪/关系/门控等核心步骤 | 若未来 Karen 需要大量工具调用（天气/搜索/日程）且主路径重构时 |
| **引入 Mem0 / Zep / Letta / Cognee 作为运行时记忆** | 记忆是 Karen 的核心卖点，这些是「专业记忆层」 | Python/服务/图数据库依赖；写入 LLM 成本；多租户假设；隐私与「本地存储」口径冲突；单机单人用不上它们的治理能力 | 多用户托管版（M3）：需要跨用户隔离、配额、可视化治理时，可评估 Zep/Letta 平台 |
| **Qdrant / Chroma / LanceDB / Milvus 替换 SQLite** | 「向量就该用向量数据库」 | 数据量 10³–10⁴、单机单进程；SQLite + sqlite-vec + FTS5 零运维；多一个数据库=多一个备份/迁移/故障点 | 向量 >10⁵ 或需要多进程/多端共享/多模态检索时（LanceDB 优先） |
| **DSPy / prompt 自动优化** | 「自动优化 prompt，不用手写」 | 没有标注数据与稳定指标；项目设计哲学明确反对静态 few-shot/响应评分（会让她变成讨好者）；Python | 有 ≥500 条标注对话 + 明确质量指标，且能接受 prompt 由优化器生成（M3 研究项） |
| **Langfuse 自托管 + 全量 OTel** | 「可观测性标准配置」 | Docker + ClickHouse + SDK；单用户单机项目过重；GenAI semconv 仍未 stable（schema URL TODO） | 做 Web 控制台/多端/多人使用时，自托管 Langfuse 才有收益 |
| **Responses API / Anthropic API 全量迁移** | 「新 API 更先进」 | Chat Completions 已满足；Responses 的 web_search 仅 v4-pro、无状态限制；Anthropic 兼容层无收益；迁移=重写 `chat.ts` + 回归 | 需要内置 web_search 且愿意把复杂对话全走 pro（成本翻 4.5 倍）时 |
| **追求 1M 上下文 / 把整本日记塞 prompt** | 「上下文大就是好」 | 成本随长度线性涨；缓存只帮命中部分；长上下文≠更好回忆；检索 + 摘要更便宜也更像人 | 单次「回忆一整段关系史」的特定功能，可用 1M 做一次性离线总结 |
| **多 agent / MCP 架构**（她 + 多个子 agent） | 「Agent 生态标配」 | 当前只有一个角色、一个对话流；多 agent 会引入路由/协调/成本/不可解释性；MCP 工具生态对聊天产品无直接价值 | 做「她的生活模拟」（多角色社交圈）或对外工具生态时 |
| **GraphRAG / 知识图谱记忆** | 「图记忆更高级」 | 抽取需要多次 LLM + 图数据库；单用户对话量下轻量事实表（三张表）即可覆盖 80% 收益 | 记忆规模 >10⁴ 事实或需要多跳推理（她的社交圈/家庭关系）时，用 SQLite 递归 CTE 先试 |

---

## 6. 最容易踩坑的迁移点（Top 5）

### 坑 1（最危险）：embedding 向量空间混用
- 现状：`t2_episodes.embedding` 列里已有大量 n-gram 768 维向量；新接语义模型后若**边回填边写入**，同一列会混入两种不可比向量；
- 代码里还有一个放大因素：`normalizeToDim` 把 1024 维**截断**成 768（`embedding.ts:157-178`），不同模型截断后的空间也不一致；
- 规避：增加 `embedding_model`/`embedding_dim` 列；切换时一次性全量重嵌（禁止混写）；检索 SQL 过滤当前模型；保留旧向量只读用于对比；阈值重新标定（不同模型余弦分布不同，0.35 不一定适用）。

### 坑 2：sqlite-vec 写入/同步/绑定
- 绑定：`Float32Array.buffer` 才能被识别为向量；传 `number[]` 或 JSON 字符串会失败或得到错误结果；
- 主键同步：`vec0` 的 rowid 必须与 `t2_episodes.id` 对齐；插入/回填/删除/衰减归档都要同步，否则 KNN 返回「已删除/低强度」的脏 id；
- 过滤：metadata 列只能 `=`/`!=`/`>`/`<`/`BETWEEN`，不能 `LIKE`/函数；要用 `persona_id`/`source` 过滤就用 metadata 列，不要事后在 JS 里滤（会浪费 KNN 名额）；
- 分区：文档明确 partition key 适合每分区「上百条以上」，单用户小数据量会过分割变慢 → 用 metadata 列即可；
- 版本：sqlite-vec 仍是 pre-v1，`^0.1.9` 的 `^` 可能引入 breaking change → 建议锁 exact 版本并加回归测试。

### 坑 3：编排框架迁移的「双状态源 + 流式语义」
- 现有状态：`state-store`（人格 JSON）+ `session`（对话 JSON）+ SQLite（T1/T2）；框架会再引入 checkpointer 状态；
- 现有流式：`AsyncGenerator` 逐段 yield → QQ 桥接断句/打字/中断；delay/silence 返回给桥接落库补发；
- 迁移后最容易出现：同一轮回复走框架 stream + 自研 burst 两套中断逻辑；框架 checkpoint 与 JSON 状态冲突导致重启后「人格状态回退/重复演化」；
- 若必须迁：先做 `PlatformAdapter`（桥接接口）与「单一状态源」重构，再换编排层；不要同时改三层。

### 坑 4：JSON Output 的空 content 与 thinking 预算
- 官方明确 JSON 模式可能返回空 content；叠加思考模式（共用 max_tokens）会显著放大；
- 旁路调用 `max_tokens` 只有 240–400（`evolution/*.ts`），必须：显式 `thinking:{type:"disabled"}` + 充足余量（≥300）+ prompt 含 `json` 字样与样例 + 解析失败兜底/重试；
- 已有 `withThinking()` 封装可用，但 `eval/run-ab-eval.ts` 仍未接（死代码，建议删或修）；新增结构化调用一律走统一封装，避免再次出现「越修越散」。

### 坑 5：中文 BM25 的分词预期
- 本次实测：FTS5 `trigram` 分词对中文 **2 字词 MATCH 返回 0**（「咖啡」「下雨」「上海」都不命中），≥3 字才命中；`unicode61` 直接对中文不切词，需要逐字空格预分词才能命中 2 字词；
- 不要假设「SQLite 内置 FTS5 就能中文 BM25」；MVP 用「逐字空格 + unicode61」或接受 trigram 的 3 字限制；jieba 等外部分词要额外依赖与分词一致性维护；
- BM25 分数是相对值，不能跨 query 比较；融合时用 RRF（按排名）而不是直接加权原始分数。

### 附加坑位（同样值得记录）
- **延迟消息 timer 不持久化**（`docs/M1_BACKLOG.md` BUG-2）：门控 `delay` 后重启丢失补发，与「她用自己生活节奏回复」的体验直接冲突；
- **隐私口径**：启用 Qwen embedding 后，记忆文本会发往阿里云；文档必须如实写，不能继续暗示「所有记忆只在本机」（CLAUDE.md 开发约定 2）；
- **shortTermContext 重复**：改上下文预算时别忘了先删重复注入，否则「瘦身」数字会被抵消；
- **缓存命中率骤降**：若把动态内容（时间/情绪/RAG）插到静态人设之前，命中会归零——每次改 prompt 结构后看 `cache_hit`。

---

## 7. 一句话选型结论

> **保留自研管线与人设状态机；SQLite 内做真正的语义 + 混合检索（sqlite-vec + FTS5 + Qwen/本地 embedding）；用 DeepSeek JSON Output 收编后台任务；用 promptfoo + 轻量 trace 建立最小评测。不引入任何编排框架、记忆服务或专用向量库。**

---

## 附录 A：来源清单（2026-10-19 抓取/查询）

> 说明：版本号/star/`pushed_at` 来自 npm registry、PyPI JSON、GitHub REST API 当日查询；功能描述来自官方 README/文档；标注「待核实」的事实未能在本次抓取中确认。

### A1. 项目内文档（本地）
- `docs/PRODUCT_AUDIT.md`（审计快照与 M0/M1 进度）
- `docs/DEEPSEEK_CAPABILITY_AUDIT.md`（DeepSeek 能力与价格，2026-10-19 实测）
- `docs/M1_BACKLOG.md`（2026-10-19 真机联调证据：缓存命中、首 token、延迟 bug）
- `CLAUDE.md`（开发约定、现状口径）

### A2. DeepSeek 官方
| 内容 | 链接 | 备注 |
|---|---|---|
| 模型与价格（含能力矩阵、新旧模型名、高峰/空闲、Search/Fetch 价格） | <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> | 抓取 2026-10-19；`deepseek-flash` / `deepseek-v4-pro`；1M 上下文、384K 输出；思考默认开 |
| 上下文硬盘缓存（命中规则、usage 字段） | <https://api-docs.deepseek.com/zh-cn/guides/kv_cache> | 抓取 2026-10-19；缓存默认开启、best-effort |
| 思考模式 | <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode> | 项目审计已实测；温度和 tools 限制 |
| JSON Output | <https://api-docs.deepseek.com/zh-cn/guides/json_mode> | 需 prompt 含 json 样例；有概率空 content |
| Tool Calls | <https://api-docs.deepseek.com/zh-cn/guides/tool_calls> | 思考模式带 tools 需回传 reasoning_content |
| 视觉 | <https://api-docs.deepseek.com/zh-cn/guides/vision> | 仅 flash；detail low/high；token 上限 |
| Search / Fetch | <https://api-docs.deepseek.com/zh-cn/guides/search> | 5 元/1000 成功请求；QPS |
| 模型 & 价格（英文） | <https://api-docs.deepseek.com/quick_start/pricing> | 同上 |

### A3. Agent 编排
| 项目 | 链接 | 当日版本/数据 |
|---|---|---|
| LangGraph JS（v1 release notes） | <https://docs.langchain.com/oss/javascript/releases/langgraph-v1> | v1 稳定性优先；`createReactAgent` 弃用；typed interrupts；npm `@langchain/langgraph` 1.5.1 |
| LangGraph JS 仓库 | <https://github.com/langchain-ai/langgraphjs> | MIT；★3,364；pushed 2026-10-19 |
| Mastra 仓库 | <https://github.com/mastra-ai/mastra> | Apache-2.0 核心 + EE；★28,907；npm `@mastra/core` 1.78.0；release 2026-10-15（<https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.78.0>） |
| OpenAI Agents SDK JS | <https://github.com/openai/openai-agents-js> | MIT；★3,928；npm `@openai/agents` 0.20.0；Node 22+ |
| Vercel AI SDK 7 发布博客 | <https://vercel.com/blog/ai-sdk-7> | npm `ai` 7.0.143；页面为客户端渲染，功能细节以官方文档为准 |
| DSPy | <https://github.com/stanfordnlp/dspy>；<https://pypi.org/project/dspy/> | MIT；★38,695；PyPI 3.4.1（2026-10-12）；Python |

### A4. 记忆层
| 项目 | 链接 | 当日版本/关键机制 |
|---|---|---|
| Mem0 | <https://github.com/mem0ai/mem0> | Apache-2.0；★67,446；PyPI 2.2.1 / npm 3.3.1；README「New Memory Algorithm (April 2026)」：单次 ADD-only 抽取、entity linking、多信号检索（语义/BM25/entity）、时间推理；benchmark LoCoMo 92.5 等（managed platform 口径，OSS 为方向性收益） |
| Zep / Graphiti | <https://github.com/getzep/graphiti> | Apache-2.0；★32,037；PyPI graphiti-core 0.31.1；时序事实有效期、episode 溯源、矛盾失效、hybrid 检索；需 Neo4j/FalkorDB/Neptune（Kuzu 已弃用） |
| Letta (MemGPT) | <https://github.com/letta-ai/letta>；<https://github.com/letta-ai/letta-code> | Apache-2.0；★25,190；PyPI letta 0.34.12；npm `@letta-ai/letta-code` 0.34.17；memory blocks/archival/recall + 自编辑 |
| LangMem | <https://github.com/langchain-ai/langmem> | MIT；★1,712；PyPI 0.0.30（2025-10-27）；**Python-only**；hot-path memory tools + background manager |
| Cognee | <https://github.com/topoteretes/cognee> | Apache-2.0；★32,538；PyPI 1.6.5（2026-10-16）；图+向量记忆、TS SDK/MCP、GLiNER 本地无 Key 模式 |

### A5. 向量与检索
| 项目 | 链接 | 当日版本/关键事实 |
|---|---|---|
| sqlite-vec 仓库 | <https://github.com/asg017/sqlite-vec> | Apache-2.0；★8,196；pushed 2026-05-18；README：**pre-v1，会有 breaking change**；vec0 支持 float/int8/binary |
| sqlite-vec vec0 文档 | <https://alexgarcia.xyz/sqlite-vec/features/vec0.html> | 文档站版本 0.1.10-alpha.4；metadata/partition/auxiliary 列规则（16/4 上限、过滤限制） |
| sqlite-vec KNN 文档 | <https://alexgarcia.xyz/sqlite-vec/features/knn.html> | `distance_metric = cosine` 用法；`MATCH ... AND k = N`；`vec_distance_cosine()` |
| sqlite-vec Node.js 文档 | <https://alexgarcia.xyz/sqlite-vec/js.html> | `sqliteVec.load(db)`；Float32Array `.buffer` 绑定；better-sqlite3 兼容 |
| LanceDB | <https://github.com/lancedb/lancedb> | Apache-2.0；★11,703；release v0.38.0；Python/Node.js/Rust/REST SDK |
| Qdrant 1.18 发布 | <https://qdrant.tech/blog/qdrant-1.18.x/> | 2026-05-11；Apache-2.0；★35,139；npm `@qdrant/js-client-rest` 1.19.0 |
| Chroma | <https://github.com/chroma-core/chroma> | Apache-2.0；★29,533；PyPI 1.5.9（2026-05-05）；npm `chromadb` 3.5.0 |
| Milvus Lite | <https://github.com/milvus-io/milvus-lite> | Apache-2.0；★465；PyPI 3.2.2；**纯 Python**、本地 `.db`、支持 BM25/hybrid/Jieba |
| SQLite FTS5 | <https://sqlite.org/fts5.html> | 内置；`bm25()`、trigram/unicode61 分词（本次实测见附录 C） |

### A6. Embedding
| 项目 | 链接 | 当日版本/关键事实 |
|---|---|---|
| Qwen3-Embedding | <https://github.com/QwenLM/Qwen3-Embedding> | 0.6B/4B/8B；维度 1024/2560/4096；32K 上下文；MRL；instruction-aware；100+ 语言（README，2026-10 查）；许可按 HF 模型卡（待核实） |
| BGE-M3 / FlagEmbedding | <https://github.com/FlagOpen/FlagEmbedding> | MIT；100+ 语言、8192 tokens、dense+sparse+colbert；reranker `bge-reranker-v2-m3`（multilingual） |
| EmbeddingGemma（Google 官方页） | <https://ai.google.dev/gemma/docs/embeddinggemma> | 页面本次抓取失败；300M 级、端侧、MRL；2026 年有 EmbeddingGemma 2 公开报道（<https://thenextweb.com/news/embeddinggemma-2-on-device-europe>）；**维度/许可/ONNX 支持待核实** |
| transformers.js | <https://github.com/huggingface/transformers.js> | Apache-2.0；★16,354；npm `@huggingface/transformers` 4.3.1；ONNX Runtime、支持 embeddings/feature-extraction |
| DashScope（Qwen embedding API） | 项目代码 `src/ai/router.ts:163-172`（`https://dashscope.aliyuncs.com/compatible-mode/v1`，`text-embedding-v3`） | 单价与 `dimensions` 参数支持**待核实**（以阿里云百炼官方价目/文档为准） |

### A7. 评测与可观测
| 项目 | 链接 | 当日版本/关键事实 |
|---|---|---|
| promptfoo | <https://github.com/promptfoo/promptfoo> | MIT；★26,148；npm 0.124.1；README 注明已加入 OpenAI、仍开源；本地评测 + red teaming |
| Langfuse | <https://github.com/langfuse/langfuse> | MIT（`ee/` 除外）；★36,026；npm `@langfuse/client` 6.0.1、`@langfuse/otel` 6.0.1；2026-01 起加入 ClickHouse |
| OpenTelemetry GenAI semconv | <https://opentelemetry.io/docs/specs/semconv/gen-ai/> → <https://github.com/open-telemetry/semantic-conventions-genai> | 已迁至独立仓库；README 显示 schema URL 仍 TODO（未稳定）；npm `@opentelemetry/sdk-node` 0.223.0、`@opentelemetry/semantic-conventions` 1.43.0 |
| OpenAI Evals | <https://github.com/openai/evals>；<https://pypi.org/project/evals/> | ★19,620；pushed 2026-04-14；PyPI 3.0.1.post1；Python |

### A8. 版本/元数据查询方式（可复现）
- npm：`curl -s https://registry.npmjs.org/<pkg>/latest`
- PyPI：`curl -s https://pypi.org/pypi/<pkg>/json`
- GitHub：`curl -s -H 'Accept: application/vnd.github+json' https://api.github.com/repos/<owner>/<repo>`
- 查询时间：2026-10-19 23:1x–23:2x（Asia/Shanghai）

---

## 附录 B：待核实清单

| # | 事实 | 为什么重要 | 如何核实 |
|---|---|---|---|
| 1 | DashScope `text-embedding-v3` 的单价与是否支持 `dimensions=768` | 决定 embedding 是否「成本可忽略」、能否不截断 | 阿里云百炼官方价目页 + API 文档；用真实 Key 小样本实测 |
| 2 | EmbeddingGemma（及 2026 的 EmbeddingGemma 2）的维度、参数、许可证、ONNX/transformers.js 可用性 | 决定本地 embedding 的默认模型 | Google AI for Developers 文档 / HF 模型卡 / ONNX 模型仓库 |
| 3 | Qwen3-Embedding 系列许可证 | 商用/分发合规 | HuggingFace / ModelScope 模型卡 |
| 4 | BGE-M3 的精确维度与参数量 | 本地部署显存/CPU 预估 | HF 模型卡 `BAAI/bge-m3` |
| 5 | Vercel AI SDK 7 对 DeepSeek `thinking` 扩展字段的透传方式 | 决定能否用 AI SDK 替换 `chat.ts` 传输层 | AI SDK 7 文档 + DeepSeek provider 配置；小样本实测 |
| 6 | LangGraph JS v1 的正式发布日期与 1.5.1 的变更范围 | 评估生态成熟度 | GitHub releases / changelog |
| 7 | Mastra `ee/` 目录具体功能边界（哪些必须商用许可） | 若未来采用需合规评估 | `LICENSE.md` / `ee/LICENSE` |
| 8 | transformers.js 4.x 在 Node 上跑 embedding 的 CPU 延迟（bge-small-zh / EmbeddingGemma） | 本地方案可行性 | 本地 benchmark（下载 ONNX 模型跑 100 条中文短句） |
| 9 | FTS5 中文最佳分词方案在 Karen 语料上的实际召回 | 决定 BM25 权重 | 用标注集对比「逐字空格 / trigram / 无 BM25」 |
| 10 | Qwen embedding 的隐私条款（记忆文本是否用于训练） | 隐私口径 | 阿里云百炼服务协议；必要时改用本地 ONNX |

---

## 附录 C：本地复现命令与实测记录

> 以下命令均为只读/内存操作，未修改仓库文件，可用于复核本文结论。

### C1. 依赖与 SQLite 能力

```bash
cd karen-persona
N=/Users/liangwenhao/玩具/.devtools/node   # 本机无全局 node，用内置 Node 24.21
$N -e "console.log(require('./node_modules/better-sqlite3/package.json').version)"
$N -e "
const Database=require('better-sqlite3');
const db=new Database(':memory:');
console.log(db.prepare('select sqlite_version() v').get().v);
const opts=db.pragma('compile_options').map(r=>r.compile_options);
console.log('FTS5:', opts.includes('ENABLE_FTS5'));
require('sqlite-vec').load(db);
console.log('sqlite-vec:', db.prepare('select vec_version() v').get().v);
"
```

实测结果（2026-10-19）：Node 24.21.0 / better-sqlite3 12.11.1（node_modules）/ SQLite 3.53.2 / `ENABLE_FTS5=true` / sqlite-vec v0.1.9。

### C2. FTS5 中文行为（本次新增实测）

```js
// trigram：中文 2 字词不命中，≥3 字命中
db.exec("CREATE VIRTUAL TABLE tg USING fts5(content, tokenize='trigram')");
db.prepare("INSERT INTO tg(content) VALUES (?)").run("今天上海下雨了，我有点想喝咖啡");
// '咖啡' → 0 条；'喝咖啡' → 1 条；'想喝咖啡' → 1 条；'下雨' → 0 条；'上海' → 0 条

// 逐字空格 + unicode61：2 字词可命中
db.exec("CREATE VIRTUAL TABLE ts USING fts5(content, tokenize='unicode61')");
db.prepare("INSERT INTO ts(content) VALUES (?)").run(Array.from("今天上海下雨了，我有点想喝咖啡").join(" "));
// MATCH '咖啡'（同样逐字空格）→ 1 条；'下雨' → 1 条；'喝咖啡' → 1 条
```

### C3. 代码事实核对

```bash
cd karen-persona
grep -rn "generateSemanticEmbedding\|upgradeEmbeddings" src --include=*.ts   # 只有定义，无调用
grep -rn "t2_vec" src --include=*.ts                                       # 只有 CREATE
grep -rn "response_format\|json_object\|tools:" src --include=*.ts         # 0 处
grep -rn "withThinking" src --include=*.ts                                 # 旁路调用已统一
grep -rn "from \"\.\./eval\|eval/" src --include=*.ts | grep -v src/eval   # 无生产 import
```

### C4. 本文引用的实测业务证据（来自项目已有记录）
- `docs/M1_BACKLOG.md`：真机缓存命中 1024–1536 tokens/轮；首 token 416–1195ms；图片识别可用；延迟消息重启丢失（BUG-2）。
- `docs/DEEPSEEK_CAPABILITY_AUDIT.md`：思考模式关闭前后对比、视觉 detail low/high 对比、前缀缓存命中实验、价格测算。

---

*本文档为调研产物，不含代码改动。后续若采纳第 4 节建议，应先建「记忆命中标注集 + JSONL trace」，再动检索与 embedding，以避免盲改。*
