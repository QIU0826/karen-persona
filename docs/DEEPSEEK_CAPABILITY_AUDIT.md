# DeepSeek 能力审计与落地指南

> 审计日期：2026-10-19（晚，非高峰时段）
> 审计对象：karen-persona 的 AI 引擎（`src/ai/`）与 DeepSeek 官方 API
> 官方文档基线：2026-10-19 抓取（链接见文末）
> 实测环境：macOS / Node 24.21 / openai SDK 4.104 / `https://api.deepseek.com` / DeepSeek Key（项目 `.env`，未落盘、未打印、未提交）
> 实测成本：全部调用合计 < ¥0.1
> 读者：产品 + 工程。产品看第 0/6/10 节，工程看第 1–5、7–9、11 节。

---

## 0. 结论速览（本项目已按此落地）

| # | 结论 | 直接影响 | 依据 |
|---|---|---|---|
| 1 | 正式模型名只有两个：`deepseek-flash`、`deepseek-v4-pro`；旧名 `deepseek-v4-flash` 仍可调用但已下线（服务端映射到新模型） | 代码/文档统一 canonical 名；`GET /models` 实测只返回这两个 | 官方价格页；实测 [M1][M2] |
| 2 | **思考模式默认开启**（effort 默认 high），会把 `max_tokens` 预算耗在 `reasoning_content` 上 → 正文为空或半截 | 旧代码 `max_tokens 80/250/400` 下**必然出现空回复**（已复现）；聊天必须默认关闭思考 | 官方思考模式页；实测 [T1][T2][T3][T4] |
| 3 | `{"thinking":{"type":"disabled"}}` 可直接放进 Node SDK 请求对象（等价 Python 的 `extra_body`），实测生效 | `chat.ts` 非流式/流式均已默认关闭思考，`DEEPSEEK_THINKING=enabled` 可覆盖 | 实测 [T1] vs [T2]：reasoning_tokens 0 vs 80 |
| 4 | 视觉只有 `deepseek-flash` 支持；`deepseek-v4-pro` 不支持图片 | 视觉从 Qwen-VL Max 切换到 DeepSeek Flash，不再需要 `QWEN_VL_API_KEY` | 官方价格页/视觉页；实测 [V1][V2][V3] |
| 5 | 自动 prompt 缓存默认开启且免费享用；相同长 system 前缀第 2 次请求实测命中 768/984 tokens | 人设 prompt 保持「静态前缀置顶、动态内容放尾部」，可省约 80% 输入成本 | 官方缓存页；实测 [C1][C2] |
| 6 | 没有 embeddings / TTS / 图片生成 API（均 404） | 语义嵌入继续用 Qwen `text-embedding-v3` 或本地 n-gram；TTS/即梦维持「规划中」 | 实测 [X1][X2][X3] |
| 7 | 有独立的 Search / Fetch API（5 元 / 1000 次成功请求） | 硬编码热点话题池可升级为真实搜索（加缓存控制成本） | 官方搜索页；实测 [S1] |
| 8 | 图片 `detail:"low"` 实测把 2000×1500 图的 prompt tokens 从 1015 降到 208 | 视觉请求固定 `detail:"low"`，单图成本可忽略 | 官方视觉页；实测 [V3] |

**一句话**：DeepSeek 现在的默认行为（思考模式开启）与「短回复聊天」场景不匹配，这是旧代码空回复的根因；关闭思考 + canonical 模型名 + Flash 视觉 + 前缀缓存友好，是本项目正确的落地方式，成本仍可控制在每月几元级别。

---

## 1. 模型与硬限制

### 1.1 模型清单（官方，2026-10-19）

| 模型名（canonical） | 版本 | 思考模式 | 上下文 | 最大输出 | 图像理解 | 并发限制 | 适用 |
|---|---|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 支持非思考/思考（默认思考） | 1M | 384K | ✅ 支持 | 2500 | 日常聊天、视觉、后台小任务 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 支持非思考/思考（默认思考） | 1M | 384K | ❌ 不支持 | 500 | 复杂对话/推理 |

- **旧模型名**：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但官方明确「对应模型已下线」，请求由 V4.1-Flash 承接并按 Flash 计费。实测 `deepseek-v4-flash` 返回的 `model` 字段已是 `deepseek-flash` [M3]。**不要再写进新代码/文档**。
- `GET /models` 实测返回：`["deepseek-flash", "deepseek-v4-pro"]` [M1]。
- Base URL：OpenAI 格式 `https://api.deepseek.com`；Anthropic 格式 `https://api.deepseek.com/anthropic`。
- Token 换算参考：1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token（官方口径）。
- 本项目用不到 1M 上下文/384K 输出；实际瓶颈是**回复预算**（见第 2 节）。

### 1.2 能力矩阵（官方）

| 能力 | flash | v4-pro | 本项目是否需要 |
|---|---|---|---|
| JSON Output | ✅ | ✅ | 🟡 后台结构化任务可用 |
| Tool Calls | ✅ | ✅ | 🟡 天气/搜索可转工具调用 |
| Responses API | ✅ | ✅ | ❌ 暂不需要（Chat Completions 够用） |
| Anthropic API | ✅ | ✅ | ❌ 暂不需要 |
| 对话前缀续写（Beta） | ✅ | ✅ | ❌ |
| FIM 补全（Beta，`/beta` base） | 仅非思考 | 仅非思考 | ❌ |
| 图像理解 | ✅ | ❌ | ✅ 视觉主路径 |
| 自动 prompt 缓存 | ✅（默认开启） | ✅ | ✅ |
| Embeddings / TTS / 图片生成 | ❌ | ❌ | 保留 Qwen / 本地实现 |

> 模型名与价格是官方页面口径；价格可能调整，以官方页面为准。

---

## 2. 思考模式（本次修复的核心）

### 2.1 官方机制

- 官方文档：<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- 开关参数（OpenAI 格式）：`{"thinking": {"type": "enabled" | "disabled"}}`；Python SDK 通过 `extra_body` 传入。**Node SDK 没有 `extra_body`，直接把 `thinking` 放进请求对象即可**（SDK 会 `JSON.stringify` 整个 body，不过滤未知字段——已用真实 Key 验证）。
- 思考强度：`reasoning_effort: "low" | "high" | "max"`；默认 effort 为 `high`。
- 官方 effort 映射：`minimal→low`、`low→low`、`medium→high`、`high→high`、`xhigh→high`、`max→max`、`ultra→max`。
- 思考模式**不支持** `temperature`、`presence_penalty`、`frequency_penalty`：传了不报错，但也不生效。
- `top_p` 行为：flash 仅在思考模式生效（0.95–1.0，低于 0.95 按 0.95），非思考模式恒为 1.0；v4-pro 思考模式忽略、非思考模式生效。
- 思维链在响应里以 `reasoning_content` 返回（与 `content` 同级）。不带 `tools` 时**不需要回传** `reasoning_content`；带 `tools` 时必须回传，否则 400。
- **计费**：`usage.completion_tokens` 包含 `completion_tokens_details.reasoning_tokens`，即思考 token 按输出价计费。实测 [T2] `completion=80`、`reasoning=80`，正文 0。

### 2.2 实测：关 / 开思考对比（deepseek-flash，2026-10-19 晚非高峰）

| 场景 | 延迟 | prompt | completion | reasoning | 正文结果 |
|---|---|---|---|---|---|
| 同 prompt，`thinking:disabled`，max_tokens=80 [T1] | 1317ms | 47 | 18 | — | ✅「我也挺好的呀，刚忙完手头的事…」 |
| 同 prompt，**不传 thinking（默认开启）**，max_tokens=80 [T2] | 1165ms | 72 | 80 | **80** | ❌ **content=null，finish=length**（空回复 bug 复现） |
| 同 prompt，显式 `thinking:enabled`，max_tokens=80 [T3] | 1097ms | 72 | 80 | 80 | ❌ content=null（与默认行为一致） |
| 复杂问题，disabled，max_tokens=640 [T4a] | 1488ms | 55 | 26 | — | ✅ 正常长回复 |
| 复杂问题，enabled，max_tokens=640 [T4b] | 1744ms | 80 | 156 | 128 | ✅ 正常，但输出 token 约 6 倍、延迟 +17% |
| 流式 enabled [T5] | 首 reasoning 651ms / 首正文 1601ms，总 1775ms | 80 | 169 | 138 | ✅ 正文在思考后才开始输出 |
| enabled 显式 + simple(160) + 难题 [T6] | 2374ms | 93 | 160（=上限） | 148 | ⚠️ 正文被截断成半句（`finish=length`） |

**结论**：
1. 思考模式开启时，思考 token 与正文**共用** `max_tokens`。旧代码的 80/250/400 预算会被思考吃光：80 时正文直接为 null；160 时正文被截断。
2. 思考模式下 **prompt 还会多约 25 tokens**（服务端注入思考相关提示，实测 47→72、52→77），且输出 token 是关闭时的数倍。
3. 默认关闭思考后，日常回复的延迟稳定在 ~0.7–1.5s（流式首 token 533–668ms），完全满足 QQ 聊天。

### 2.3 本项目的落地方式（已实现）

`src/ai/router.ts`：

```ts
getThinkingConfig(complexity) → { enabled, thinking: {type}, reasoningEffort }
// 默认 enabled=false（DEEPSEEK_THINKING 未配置/非法值都回退 false）
// DEEPSEEK_THINKING=enabled 时按复杂度映射强度：simple→low / normal→high / complex→max
// DEEPSEEK_REASONING_EFFORT=low|high|max 可覆盖映射
```

`src/ai/chat.ts`：

- 非流式 `chat()` 与流式 `chatStream()` 都通过请求体发送 `thinking`；
- 关闭思考时发送 `temperature: 0.9`；开启思考时不发送 temperature（官方会忽略）；
- 非流式空正文会抛可读错误：`AI 思考占满 max_tokens…请关闭思考模式或提高 max_tokens`；
- 流式若整段没有正文，会打印 `[LLM] 警告：流式响应未产出正文（thinking=enabled…）`；
- usage 日志新增 `reasoning=` 与 `cache_hit=`：`[LLM] usage(chat, deepseek-flash): prompt=52 (cache_hit=0) completion=10 (reasoning=0) total=62`。

**配置建议**：生产默认 `DEEPSEEK_THINKING` 留空（=disabled）。只有明确需要深度推理的场景才设 `enabled`，且必须同时把 `max_tokens` 提到 2–3 倍（本项目 `COMPLEXITY_TOKENS` 未按思考模式预留，属有意为之）。

---

## 3. 视觉（图像理解）

### 3.1 官方机制

- 官方文档：<https://api-docs.deepseek.com/zh-cn/guides/vision>
- 仅 `deepseek-flash` 支持；**`deepseek-v4-pro` 不支持图片**（价格页功能表）。
- 支持格式：JPEG、PNG、GIF、WebP；**按文件实际内容判断**，不看文件名/MIME 声明。
- 三种传图方式：
  1. base64 data URL（内联，计入 48 MiB 请求体限制）；
  2. 公网 `http(s)` URL（≤8192 字符、≤32 MiB、60s 内下载完成）；
  3. Files API 上传后用 `file_id` 引用（`file` 内容块；≤64 MiB；跨请求复用）。
- `detail` 字段（仅 `image_url` 支持）：`low` = 推理前缩放到 512×512（更快更省）；`high`/`original` = 原图；`auto` 当前等价 `original`。
- 图片 token：每张图自动缩放后**最多 1024 tokens**；总像素小于约 544×544 会被放大，更大的图会缩到约 1300×1300。
- 关键限制：单请求 48 MiB body、base64/URL 单图 ≤32 MiB、单请求 ≤600 张、单边最长 8192px（≥15 张图时 4096px）；**图片只能出现在 `user` 消息里**，system/assistant 带图会 400。

### 3.2 实测

| 场景 | 延迟 | prompt tokens | 结果 |
|---|---|---|---|
| 640×480 PNG，base64 + `detail:"low"` + thinking disabled [V1] | 991ms | 232 | ✅「蓝天白云下有一座小房子。」（12 字） |
| 私有 URL 直传（`http://127.0.0.1:…`） [V2] | — | — | ❌ `400 Failed to download image from …` → **必须先本地下载转 base64** |
| 2000×1500 PNG，`detail:"low"` [V3a] | 1321ms | **208** | 「粉红色」 |
| 同一张图，`detail:"high"` [V3b] | 938ms | **1015** | 「洋红色」 |
| 落地实现：本地 HTTP 图片 → 下载转 base64 → 识别 [V4] | 742ms | — | ✅「蓝天白云下有一座小房子。」 |
| 落地实现：404 下载失败 → 回退 URL → 服务端不可达 [V5] | 103ms | — | ✅ 返回 null（不阻塞聊天） |

### 3.3 本项目落地方式（已实现）

`src/ai/vision.ts`（函数签名不变：`describeImage(imageUrl): Promise<string | null>`）：

1. 先 `fetch` 下载图片（**10s 超时、≤10MB、content-length 预检**），转成 `data:<mime>;base64,…`；
   - QQ/NapCat 图片 URL 常是私有/临时地址，DeepSeek 服务端访问不到（[V2] 实测 400），所以「先下载」是必需路径；
2. 下载失败 → 回退直接传原 URL（兼容公网地址）；
3. 请求参数：`model=deepseek-flash`（可用 `DEEPSEEK_VISION_MODEL` 覆盖）、`detail:"low"`、`thinking:{type:"disabled"}`、`max_tokens=120`、`temperature=0.3`；
4. 输出清洗：去引号/换行 → 按 Unicode 码点截断 ≤15 字；
5. 无 Key / 下载失败 / 请求异常 / 空内容 → 返回 `null`，调用方降级为 `[图片]`。

**视觉成本**：detail low 单图约 200–230 input tokens，按 Flash 非高峰价 ≈ ¥0.0002/张，1000 张约 ¥0.2；detail high 约 1015 tokens，约为 low 的 5 倍。**没有理由用 high**（本项目只需要 15 字描述）。

**Qwen-VL 的处置**：视觉不再使用 Qwen；`QWEN_VL_API_KEY` 仅保留给语义嵌入（`getEmbeddingConfig()` 仍把它当 `QWEN_EMBEDDING_API_KEY` 的兜底）。`.env.example` 已同步改注释。

> ✅ 审计后已完成文档统一：README/QUICKSTART/CLAUDE/doctor/setup 的「图片识别 = Qwen-VL」旧表述已改为 DeepSeek Flash；图片隐私口径已改为「图片发 DeepSeek」。PRODUCT_AUDIT 与归档材料保留历史快照，以本文件与 README 为准。

---

## 4. 结构化输出与 API 家族（能力盘点）

| 能力 | 官方 | 实测 | 本项目建议 |
|---|---|---|---|
| JSON Output | `response_format:{type:"json_object"}`；prompt 必须含 `json` 字样+样例，否则可能报错；官方提示**有概率返回空 content**，需合理设 `max_tokens` | ✅ 820ms 返回 `{"mood":"开心","intensity":0.9}` [J1] | 后台结构化任务（情绪标签/评估）可用；必须兜底解析失败/空串 |
| Tool Calls | function calling；思考模式也可用；带 tools 时必须回传 `reasoning_content`，否则 400；另有 `/beta` 的 `strict` 模式 | ✅ 874ms 正确返回 `get_weather({"location":"杭州",...})` [F1] | 天气/搜索工具化可选，暂不接主路径 |
| Responses API | `base_url` 同 `https://api.deepseek.com`，支持 `input/instructions/tools/reasoning` 等；无状态、不支持 `previous_response_id`；有 `web_search` 内置工具（仅 v4-pro） | ✅ HTTP 200 [R1] | 暂不需要；若做 Agent 化再评估 |
| Anthropic API | `base_url=https://api.deepseek.com/anthropic`；`claude-*` 模型名会自动映射到 DeepSeek 模型；支持 thinking/output_config.effort、图片 block | ✅ HTTP 200，返回 `thinking` content block [A1] | 暂不需要 |
| FIM 补全（Beta） | `base_url=https://api.deepseek.com/beta`，`/completions`；最大补全 4K；**仅非思考模式** | 未实测（文档明确） | 不需要（无代码补全场景） |
| Files API | `POST /files`（multipart，`purpose=user_data`），`file_id` 跨请求复用；单文件 ≤64MiB、存储 25GiB/10000 文件 | 未实测（文档明确） | QQ 图片一次性使用，base64 足够；无需接入 |

---

## 5. 自动 prompt 缓存（省钱关键）

### 5.1 官方机制

- 官方文档：<https://api-docs.deepseek.com/zh-cn/guides/kv_cache>
- **对所有用户默认开启，无需改代码**。请求结束位置、公共前缀检测、固定 token 间隔都会产生「缓存前缀单元」；后续请求**完整匹配**前缀单元才命中。
- 响应 `usage` 增加两个字段：`prompt_cache_hit_tokens`（命中）、`prompt_cache_miss_tokens`（未命中）。
- 缓存「尽力而为」，不保证 100%；构建耗时秒级，几小时到几天不用会清空；命中不影响输出随机性。

### 5.2 实测

| 实验 | 结果 |
|---|---|
| Lead 基线（task-6 描述，真实人设前缀） | 第二次请求命中 1152/1328 |
| 原始请求：985-token system，连续两次 [C1] | 第 1 次 hit=0；第 2 次 **hit=768 / miss=217** |
| 落地实现：1516 字 system（984 tokens），连续三次 [C2] | call#1 hit=0；call#2 **hit=768**；call#3 **hit=768**（累计 1536） |
| 短 system（42–43 tokens）连续两次 [C3] | 均 hit=0 | 
| 未命中价格对比（非高峰 flash） | 命中 0.02 元/M vs 未命中 1 元/M → **命中便宜 50 倍** |

**解读**：长且稳定的前缀（本项目的六层人设 prompt，通常 2k+ tokens）从第 2 次请求起就能命中约 768 tokens 的固定间隔单元；短 prompt 前缀太短，没有可命中的固定间隔单元，两次请求又不构成完整前缀单元 → 不命中。

### 5.3 本项目的缓存友好写法（建议 + 现状）

- ✅ 静态人设/系统规则**放在 messages[0] 的最前面**，且逐字节稳定（不要在里面插入时间戳、随机 ID、当前情绪数值）；
- ✅ 动态内容（时间/情绪/关系/RAG 检索结果）放在 system 末尾或后续消息——`chat.ts` 的 `buildFinalMessages()` 目前是把上下文**追加在第一条 system 末尾**，静态前缀仍在最前，符合缓存友好原则；
- ✅ 会话历史天然递增，多轮对话的旧轮次会作为前缀被命中；
- ❌ 不要把随机内容前置；不要每次重排 system 中的段落顺序；
- ✅ 继续记录并观察 `prompt_cache_hit_tokens` —— 已在 `chat.ts` usage 日志中输出 `cache_hit=`，可直接用于线上验证（若长期为 0，说明前缀被动态内容污染）。

---

## 6. 价格与成本（官方价格页，2026-10-19）

### 6.1 模型价格（元 / 百万 tokens）

| 项目 | flash 非高峰 | flash 高峰 | v4-pro 非高峰 | v4-pro 高峰 |
|---|---|---|---|---|
| 输入·缓存命中 | 0.02 | 0.04 | 0.15 | 0.30 |
| 输入·缓存未命中 | 1 | 2 | 4.5 | 9.0 |
| 输出（含思考 token） | 4 | 8 | 13.5 | 27.0 |

- **高峰时段**：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；其余时段（含周末、法定节假日全天）**全部半价**。
- 本项目的个人使用场景大部分落在非高峰（晚间/周末），按非高峰价估算更贴近实际。
- Search / Fetch：**5 元 / 1000 次成功请求**（失败的、搜索无结果的请求不计费）。

### 6.2 本项目成本估算（非高峰、flash、关闭思考）

假设单轮输入约 3000 tokens（人设+历史+RAG），其中 80% 命中缓存，输出 50 tokens：

```
输入命中：2400 × 0.02 / 1e6 = 0.000048 元
输入未命中：600 × 1 / 1e6    = 0.0006   元
输出：50 × 4 / 1e6           = 0.0002   元
合计 ≈ 0.00085 元/轮（约 0.085 分）
```

| 场景 | 估算 |
|---|---|
| 100 条/天、全 flash 非高峰 | ≈ ¥0.08–0.10/天 ≈ **¥3/月** |
| 上表 + 10% complex 走 v4-pro（≈0.0044 元/轮） | ≈ ¥0.12–0.15/天 ≈ **¥4–5/月** |
| 若关闭缓存（全 miss） | 单轮输入成本 0.003 元（约 3.5 倍），月成本 ≈ ¥10–15 |
| 视觉细节 low | ≈ ¥0.0002/张 ≈ 1000 张 ¥0.2 |
| 视觉改 detail high | ≈ ¥0.001/张（约 5 倍） |
| Search 热点（每 2h 一次，每天 12 次） | 12 × 0.005 = ¥0.06/天 ≈ ¥1.8/月 |
| 思考模式开启（每轮多 ~128 reasoning tokens） | 输出成本 +≈0.0005 元/轮（+60%），且延迟 +0.5–1.5s |

> 以上是量级估算，不是账单承诺；后台调用（内心独白/T3 摘要/进化日志/LLM Judge）会额外产生费用，实际以官方账单为准。README 里「¥6–15/月」的旧估算偏保守，量级一致。

### 6.3 成本结论

1. **默认关闭思考**是最大的省钱 + 提速动作（同时修空回复）；
2. **缓存命中**是第二大省钱项（输入成本降 ~50 倍），靠「稳定长前缀」白拿；
3. 视觉从 Qwen-VL（需单独账号/计费）迁到 DeepSeek Flash 后，单图成本可忽略，且少维护一个 Key；
4. v4-pro 只在真正复杂场景使用即可，不要让普通闲聊走 pro。

---

## 7. 不存在的能力（避免误规划）

以下结论来自官方文档 + 用真实 Key 的端点探测（2026-10-19）：

| 能力 | 探测 | 结果 | 结论 |
|---|---|---|---|
| Embeddings | `POST /embeddings` | **404**（body 为空） [X1] | DeepSeek 无 embeddings API；语义嵌入保留 Qwen `text-embedding-v3`（已实现未接线降级）或本地 n-gram |
| TTS / 语音合成 | `POST /audio/speech` | **404** [X2] | 语音继续用 Fish Audio Key（当前也是规划中）；不要写「DeepSeek TTS」 |
| 图片生成 | `POST /images/generations` | **404** [X3] | 图片生成维持「即梦=规划中」；不要写「DeepSeek 生图」 |

> 注意：OpenAI SDK 能调用这些端点不代表服务端支持；以 404 为准。

---

## 8. Search / Fetch API（真实热点可落地）

- 官方文档：<https://api-docs.deepseek.com/zh-cn/guides/search>
- 端点：`POST https://api.deepseek.com/v1/tools/search`、`POST https://api.deepseek.com/v1/tools/fetch`；Bearer 鉴权，与模型 API 同一个 Key。
- Search 请求字段：`query`（1–128 字符，支持 `site:`/`lang:`/`after:` 等语法）、`count`（1–50，默认 10）、`ori_question`、`localization`、`need_content`（默认 false）。
- 响应 `results[]`：`title/url/snippet/summary/content/site_name/date/authority/rerank_score`（rerank ≥1.5 为优质）。
- Fetch：传 `url`，返回 `title` + Markdown 正文。
- 价格：各 **5 元/1000 次成功请求**；QPS：Search 100、Fetch 25（账号级）。
- 实测 [S1]：Search 返回 200 + 3 条结果（rerank 2.29/2.24/2.04），响应结构符合文档。

**本项目建议**：
- `src/world/trending-fetcher.ts` 目前是硬编码 20 条话题池（审计域 7-4 已标 🔴）。可用 Search 替换为真实热点：每 1–2 小时搜一次「今日热点/本地话题」，结果缓存到内存/磁盘，避免每次对话都查（成本 0.005 元/次，12 次/天 ≈ 1.8 元/月）；
- 只取 `snippet/summary`，不取 `content`，省 token、免存全文；
- 搜索关键词应带人设语境（如「上海 咖啡 生活 热点」），否则圈层不匹配的问题依旧存在；
- Fetch 适合后续做「用户发链接 → 她真的读一下」能力（当前没有）；
- 也可走 Responses API 的内置 `web_search` 工具（**仅 v4-pro**），但计费/行为不同，当前不建议作为默认路径。

---

## 9. 实测记录（原始数据）

> 全部调用为真实 API；Key 只存在于进程环境，未打印/未写入任何文件；`/tmp` 测试图片用完即弃，不在仓库。
> 时间：2026-10-19 22:30–22:45（Asia/Shanghai，周一晚间 = 非高峰）。

### 9.1 端点与模型

| 编号 | 请求 | 结果 |
|---|---|---|
| M1 | `GET /models` | 200，`["deepseek-flash","deepseek-v4-pro"]` |
| M2 | 用 `deepseek-v4-flash`（旧名）请求 | 200，响应 `model` 字段为 `deepseek-flash`（旧名被映射） |
| X1 | `POST /embeddings` | 404 |
| X2 | `POST /audio/speech` | 404 |
| X3 | `POST /images/generations` | 404 |
| R1 | `POST /responses`（max_output_tokens=20） | 200，`object=response`（被截断为 incomplete，属预期） |
| A1 | `POST /anthropic/v1/messages` | 200，返回 `thinking` content block（预期行为） |
| S1 | `POST /v1/tools/search`（count=3） | 200，3 条结果，rerank 2.29/2.24/2.04 |
| J1 | Chat + `response_format=json_object` | 200，820ms，合法 JSON |
| F1 | Chat + tools（get_weather） | 200，874ms，正确 tool_call + 参数 |

### 9.2 思考模式 / 视觉 / 缓存（原始请求）

| 编号 | 场景 | 延迟 | usage（prompt/completion/reasoning） | 正文摘要 |
|---|---|---|---|---|
| T1 | disabled, max_tokens=80 | 1317ms | 47/18/— | 「我也挺好的呀，刚忙完手头的事…」 |
| T2 | 不传 thinking（默认开启）, max_tokens=80 | 1165ms | 72/80/**80** | **null**，finish=length |
| T3 | enabled 显式, max_tokens=80 | 1097ms | 72/80/**80** | null，finish=length |
| T4a | 复杂问题 disabled, 640 | 1488ms | 55/26/— | 正常 |
| T4b | 复杂问题 enabled, 640 | 1744ms | 80/156/**128** | 正常 |
| T5 | 流式 enabled, 640 | 首 reasoning 651ms / 首正文 1601ms / 总 1775ms | 80/169/**138** | 正常 |
| T6 | enabled + simple(160) + 难题（落地代码） | 2374ms | 93/160/**148** | 被截断成半句 |
| V1 | 640×480 PNG base64, detail low | 991ms | 232/7/— | 「蓝天白云下有一座小房子。」 |
| V2 | 私有 URL 直传 | — | — | 400 Failed to download image |
| V3a | 2000×1500 PNG, detail low | 1321ms | **208**/2/— | 「粉红色」 |
| V3b | 2000×1500 PNG, detail high | 938ms | **1015**/2/— | 「洋红色」 |
| C1 | 985-token system 连续 2 次 | 1021ms / 1221ms | 第1次 hit=0；第2次 hit=**768**/miss=217 | — |
| C2 | 落地代码：984-token system 连续 3 次 | 945/1379/827ms | hit=0 → **768** → **768** | — |

### 9.3 落地实现联调（直接 import `src/ai` 模块）

| 编号 | 场景 | 延迟 | usage | 结果 |
|---|---|---|---|---|
| I1 | `chat()` simple（默认关思考，max=160） | 966ms | 52/10/reasoning 0 | ✅「哇真的吗，橘猫都特别能吃哈哈」 |
| I2 | `chatStream()` normal（max=320） | 首 token 668ms / 总 811ms | 52/19/reasoning 0 | ✅正常逐字输出 |
| I3 | `describeImage()` 本地 HTTP 图片（模拟 QQ 私有 URL） | 742ms | — | ✅「蓝天白云下有一座小房子。」 |
| I4 | `describeImage()` 下载 404 → 回退 URL → 服务端不可达 | 103ms | — | ✅ 返回 null，日志「[Vision] 识别失败: 400 …」 |
| I5 | `DEEPSEEK_THINKING=enabled` + simple（max=160） | 1539ms | 77/123/**107** | ✅ 有正文，但成本/延迟明显上升 |
| I6 | `DEEPSEEK_THINKING=enabled` + normal（max=320） | 1428ms | 77/144/**119** | ✅ 有正文 |
| I7 | `getChatModel("complex")` → v4-pro（关闭思考） | 1435ms | 51/17/reasoning 0 | ✅ 正常回复 |
| I8 | 空回复防护（enabled + simple + 难题） | — | 93/160/**148** | ⚠️ 正文被截断（content 非空，未触发抛错路径）；content 完全为空时会抛可读错误（代码逻辑） |

### 9.4 复现方式（不提交 Key / 图片）

```bash
# 测试图片用 Python PIL 生成到 /tmp（不入仓库）
# 实测脚本放 /tmp，cwd 必须是项目根（dotenv/import 解析）
cd /Users/liangwenhao/玩具/karen-persona
/Users/liangwenhao/玩具/.devtools/node-dsh node_modules/tsx/dist/cli.mjs /tmp/<probe>.ts
# key 从项目 .env 读取，仅放 process.env，不打印
```

---

## 10. 本项目落地变更清单（2026-10-19）

### 10.1 代码变更

| 文件 | 变更 |
|---|---|
| `src/ai/router.ts` | canonical 模型名（`deepseek-flash`/`deepseek-v4-pro`，env 仍可覆盖）；`COMPLEXITY_TOKENS` 80/250/400 → **160/320/640**（依据见注释）；新增 `getThinkingConfig(complexity)`（默认关闭，支持 `DEEPSEEK_THINKING`/`DEEPSEEK_REASONING_EFFORT`）；`hasVisionModel()` 改查 `DEEPSEEK_API_KEY`；`getEmbeddingConfig()` 注释明确 Qwen 仅用于嵌入 |
| `src/ai/chat.ts` | 非流式 + 流式请求体均发送 `thinking`（默认 disabled）；仅非思考模式发送 `temperature:0.9`；思考模式发送 `reasoning_effort`；usage 记录 `reasoning_tokens` 与 `prompt_cache_hit_tokens`；空正文/思考耗尽输出可读错误；流式空正文告警；保留原有超时/重试/usage 逻辑 |
| `src/ai/vision.ts` | 改为 DeepSeek Flash 视觉：本地下载→base64（10s/10MB，失败回退 URL）→ `detail:"low"` + thinking disabled + max_tokens 120 → ≤15 字；无 Key/失败返回 null |
| `.env.example` | DeepSeek 段补充思考模式/视觉/超时说明；模型示例名改 canonical；QWEN 段改为「仅用于语义嵌入」，删除「Qwen-VL 图片识别」 |
| `src/ai/router.test.ts`（新增） | 20 用例：canonical 模型名/env 覆盖/缺 Key、复杂度 token、思考开关与 effort、hasVisionModel、复杂度分级回归 |
| `src/ai/vision.test.ts`（新增） | 9 用例：base64 成功、下载失败回退 URL、非 2xx 回退、无 Key、请求异常、空内容、超长截断、data URL 直传、模型名覆盖（全部 mock，不联网） |

### 10.2 建议配置（`.env`）

```bash
DEEPSEEK_API_KEY=...                # 必填（真实 Key，勿提交）
DEEPSEEK_BASE_URL=https://api.deepseek.com

# 日常配置（推荐）
# 不设 DEEPSEEK_THINKING = 思考模式关闭（默认）
# 需要更强推理时：
# DEEPSEEK_THINKING=enabled
# DEEPSEEK_REASONING_EFFORT=high      # 可选 low/high/max；不设则按复杂度映射

# DEEPSEEK_FLASH_MODEL=deepseek-flash # 通常不用写，默认值即 canonical
# DEEPSEEK_PRO_MODEL=deepseek-v4-pro
# DEEPSEEK_VISION_MODEL=deepseek-flash
# LLM_TIMEOUT_MS=30000
```

### 10.3 验证

```bash
cd /Users/liangwenhao/玩具/karen-persona
/Users/liangwenhao/玩具/.devtools/node node_modules/typescript/bin/tsc --noEmit
/Users/liangwenhao/玩具/.devtools/node node_modules/vitest/vitest.mjs run src/ai/
```

结果：`tsc --noEmit` 通过；`src/ai/` 2 个测试文件 / 29 用例通过（全部 mock，不联网）。

---

## 11. 遗留风险与后续项（重要）

### 11.1 高优先级：其他直接调 DeepSeek 的代码没有关思考

`chat.ts` 之外的模块自己 new OpenAI 发请求，**没有传 `thinking`**，因此仍走服务端默认「思考开启」。它们普遍使用很小的 `max_tokens`，存在与本次修复前完全相同的空回复/截断风险：

| 文件 | 现存 max_tokens | 风险 |
|---|---|---|
| `src/evolution/narrative-reconstruct.ts:87` | 80 | 高（思考极易耗尽 → 空） |
| `src/evolution/internal-monologue.ts:95,199` | 120 / 80 | 高 |
| `src/evolution/her-view.ts:123` | 120 | 高 |
| `src/evolution/persona-journal.ts:145` | 200 | 中高 |
| `src/evolution/t3-summarizer.ts:144` | 200 | 中高 |
| `src/impulse/unsplash-trigger.ts:74` | 30 | 高（JSON 解析会失败） |
| `src/eval/run-ab-eval.ts:127,202` | 250 / 800 | 中（评估结果失真） |

**建议**（下一轮 AI 引擎任务，统一改）：把这些调用点改为共享的请求构造（或至少 `thinking: getThinkingConfig().thinking`），并逐个验证输出非空；同时 `run-ab-eval.ts` 的旧模型名 `deepseek-v4-flash` 应改为 `deepseek-flash`。本次任务写权限限定在 `src/ai/`，故未改。

### 11.2 中优先级：文档/工具里的旧视觉表述

视觉从 Qwen-VL 改为 DeepSeek Flash 后，以下位置仍写旧事实，需要统一更新（均在本任务写权限外）：

- `README.md:75,137,190,221,348`（Key 说明、隐私声明、功能表、技术栈）
- `QUICKSTART.md:15`
- `CLAUDE.md:18,40`（技术栈与域 8 描述）
- `docs/PRODUCT_AUDIT.md:102,129,145,250,321`（依赖真实度、域 1-6、域 8-5、隐私差异）
- `src/doctor.ts:178`、`src/setup.ts:345`（把 `QWEN_VL_API_KEY` 描述为「图片识别」；应改为「语义嵌入（可选）」或检查 DeepSeek Key 判断视觉）
- `docs/INTERVIEW_QA.md` / `docs/PROJECT_PORTFOLIO.md` 若有 Qwen-VL 视觉叙述，同批清理

### 11.3 低优先级 / 长期

1. **思考模式开启时的预算策略**：若未来确实需要思考，应给 `max_tokens` 加 2–3 倍余量并按复杂度区分（目前代码有意不预留）。
2. **图片下载阻塞主流程**：vision 最坏约 25s（下载 10s + 请求 15s），目前与消息处理串行；后续可考虑并发/超时更短/失败快速降级。
3. **图片下载只校验 content-length 与读后大小**：恶意/超长流仍可能占用内存；上生产可加流式截断。
4. **隐私口径**：切换后图片仍会发给第三方（由 Qwen 改为 DeepSeek），隐私声明要如实更新为「图片会发送给 DeepSeek」，不能写「不上传」。
5. **价格与模型名会变**：本文价格为 2026-10-19 官方页面快照；接入 `usage` 日志后可做真实账单对账。
6. **Search API 接入前先做频率/缓存设计**，否则可能超预期成本（虽然 5 元/1000 次不贵）。
7. **JSON Output 官方承认有概率空 content**：任何依赖结构化输出的后台任务都要有解析失败兜底（与 11.1 的 max_tokens 问题叠加时更明显）。

---

## 12. 官方参考资料（2026-10-19 抓取）

- 模型 & 价格（含能力矩阵、新旧模型名、高峰/空闲时段、Search/Fetch 价格）：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 思考模式（开关、effort 映射、temperature 限制、reasoning_content 多轮回传规则）：<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- 图像理解（三种传图方式、detail、token、限制）：<https://api-docs.deepseek.com/zh-cn/guides/vision>
- 上下文硬盘缓存（命中规则、usage 字段）：<https://api-docs.deepseek.com/zh-cn/guides/kv_cache>
- 网页搜索与抓取（端点、价格、QPS、字段）：<https://api-docs.deepseek.com/zh-cn/guides/search>
- JSON Output：<https://api-docs.deepseek.com/zh-cn/guides/json_mode>
- Tool Calls：<https://api-docs.deepseek.com/zh-cn/guides/tool_calls>
- Responses API（兼容性明细、web_search 仅 v4-pro）：<https://api-docs.deepseek.com/zh-cn/guides/responses_api>
- Anthropic API（模型名映射、thinking）：<https://api-docs.deepseek.com/zh-cn/guides/anthropic_api>
- FIM 补全 Beta（仅非思考、4K 补全）：<https://api-docs.deepseek.com/zh-cn/guides/fim_completion>
- Files API：<https://api-docs.deepseek.com/zh-cn/guides/files_api>
- Token 用量计算（图片 token 估算器）：<https://api-docs.deepseek.com/zh-cn/quick_start/token_usage>
