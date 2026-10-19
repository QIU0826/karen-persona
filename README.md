# Karen — AI 虚拟人设聊天系统

> 让通讯录里住进一个有自己生活、情绪和记忆的人。

你的特别关注铃声多久没有响过了。你是否有一个喜欢的人，但是你无法在现实中找到她。但是现在她可以出现在通讯录中。她不只是一个 AI 虚拟人物，她也有自己的生活，自己的想法，自己的决定。这个项目的出现只是为了将你们在不同平行世界的缘分连上。

> ⚠️ **免责声明**：本项目仅用于个人回忆与情感疗愈，不用于骚扰、跟踪或侵犯他人隐私。**她是 AI，不是真人**。QQ 桥接依赖非官方协议（NapCatQQ），存在封号与协议变更风险，请使用小号并自行承担后果。

> **项目状态（2026-10）**：M0「地基修复」完成（新装可启动、延迟消息不丢、QQ 桥接安全加固、LLM 异常兜底、文档真话）；**M1 进行中**：情绪/负债/关系/演化状态已持久化（重启不归零）、亲密度会随互动成长并有里程碑、CLI 可查看她的日记/关系时间线/她眼中的你；图片识别已切换到 DeepSeek Flash（不再需要 Qwen-VL Key）。双管线完全统一、多用户隔离、语义检索等仍在 M1/M2。本文所有功能宣称都以当前代码为准：未完成的能力明确标成「半成品 / 规划中」，不会把设计目标写成已实现。完整的功能清单、差距分析与 M0–M3 路线图见 **[docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md)**。
>
> 仓库实测状态（2026-10-19）：`npm run typecheck` 0 错误；`npm test` **35 个测试文件 / 462 个用例**全部通过（vitest；审计基线为 11 文件 / 178 用例，M0/M1 新增数据层、消息门、编排器、桥接解析、天气、关系成长、状态持久化、演化视图、AI 路由/视觉等测试）。GitHub Actions CI 已接入类型检查与单测；CLI + 真实 DeepSeek Key 已完成 3 轮端到端实测（含缓存命中、关系成长、重启恢复）。仍缺真实 QQ/NapCat 端到端测试（M2-7 规划）。

---

## 她和别的 AI 聊天机器人有什么不一样

**她想成为一个独立的人，而不是一个服务你的工具。**

下面是她「想成为的样子」与 2026-10 的实际进度——不夸大：

| 设计目标 | 当前进度 |
|---|---|
| 不是永久配合，有自己的底线 | 🚧 有 L1 弹性规则与内疚/偿还机制，但「规则被突破」目前主要影响内部状态，用户能观察到的行为差异有限 |
| 六层人设结构，层与层之间可以冲突 | ✅ schema、校验器、Prompt 装配已实现；🚧 部分字段（如 `hardRules`、`world.goals`）还没有进入 Prompt，详见审计报告 2.3 |
| 有自己的生活，会主动找你 | 🚧 15 分钟心跳 + 四类触发源（因果链/天气/情绪/时间）；M0 已加每日上限（4 条/日）与两次主动消息最小间隔 30 分钟；仍无免打扰/暂停开关 |
| 三层记忆 + 遗忘曲线 | 🚧 T2 记忆的存储、衰减、写入可用；检索目前是**字符 n-gram 匹配**而不是语义检索；T3 长期摘要存在但触发逻辑有缺陷 |
| 她会慢慢变化 | 🗺 演化模块代码已写，但运行时状态不落盘（重启归零），亲密度 `closeness` 暂时是常量；可见的成长系统在 M1 规划中 |
| 数据存储在本地 | ✅ 记忆、会话、人设、配置都保存在你自己的电脑上；⚠️ 但对话内容会发送给 DeepSeek、图片会发送给 Qwen——详见[隐私与安全](#隐私与安全) |
| 不用括号、不像 AI 助手 | ✅ 「铁律」+ 流式碎片回复可用；部分场景仍有瑕疵（括号、语气一致性） |

她的设计准则只有一句话：**「这是让她更完整地成为她自己，还是让她更好地服务用户？」** 每一个功能都经过这个问题的过滤。

---

## 快速开始

更短的 5 分钟版本：[QUICKSTART.md](QUICKSTART.md)。

### 你需要准备

| 项目 | 说明 | 必需？ |
|---|---|---|
| Node.js 22.12+ | [nodejs.org](https://nodejs.org) 下载 LTS。`package.json` 的 `engines` 要求 `>=22.12`（better-sqlite3 13 使用 N-API 预编译包） | ✅ |
| npm（随 Node 安装） | 仓库只跟踪 `package-lock.json`，CI 使用 `npm ci`；pnpm 仅本地开发可选（不提交 pnpm-lock） | ✅ |
| DeepSeek API Key | [platform.deepseek.com](https://platform.deepseek.com) 创建；没有 Key 无法对话（新用户额度以平台当前政策为准） | ✅ |
| QQ 小号 | 单独注册，用于 NapCatQQ 登录 | 仅 QQ 模式 |
| Windows 10/11 或 macOS 12+ | QQ 桥接需要 NapCat：Windows 已验证、macOS 有官方原生安装器（方案见 [跨平台桥接指南](docs/QQ_BRIDGE_CROSS_PLATFORM.md)）；Linux 可用 Docker | 仅 QQ 模式 |

### 1. 安装

```bash
git clone <repo-url> && cd karen-persona
npm install
# 可选：pnpm install（仅本地开发；仓库只跟踪 package-lock.json）
```

> `better-sqlite3` 13 已内置 Windows/macOS/Linux 的 N-API 预编译模块（`prebuilds/`），正常 `npm install` **无需 C++ 编译工具链**。若安装的是更老版本才需要 VS Build Tools。

### 2. 配置

```bash
cp .env.example .env
cp config.yaml.example config.yaml
```

编辑 `.env`，至少填入：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxx          # 必填。platform.deepseek.com → API Keys
```

可选（不填也能启动，对应功能自动关闭）：

```env
# 图片识别已内置在 DeepSeek Flash 中，无需额外 Key（可选覆盖 DEEPSEEK_VISION_MODEL）
# QWEN_VL_API_KEY=sk-xxxxxxxx          # 仅语义嵌入（可选，规划中），不用于图片识别
OPENWEATHER_API_KEY=xxxxxxxx          # 真实天气。openweathermap.org/api
UNSPLASH_ACCESS_KEY=xxxxxxxx          # 主动发图。unsplash.com/developers
```

QQ 桥接配置（`.env.example` 的默认值即可用，端口为 `18080`）：

```env
ONE_BOT_HOST=127.0.0.1                # 只监听本机回环（安全默认值，别改成 0.0.0.0）
ONE_BOT_WS_PORT=18080                 # 与 NapCat 反向 WS 地址中的端口一致
ONE_BOT_WS_PATH=/onebot/v11/ws        # 与 NapCat 反向 WS 地址中的 path 一致

# 选填：跨机连接 / 白名单（也可以写在 config.yaml 的 one_bot_token / allowed_users，config.yaml 优先）
# ONE_BOT_TOKEN=换成一段足够长的随机字符串   # NapCat 反向 WS 的 access_token；跨机/非回环时必须设
# ALLOWED_USERS=123456789,987654321          # 允许聊天的 QQ 号，逗号分隔；留空 = 允许全部（启动时警告）
```

> 上述桥接参数同样可以写在 `config.yaml`（`one_bot_ws_host` / `one_bot_ws_port` / `one_bot_ws_path` / `one_bot_token` / `allowed_users`）；两处都写时 **config.yaml 优先**。超长回复的切分上限可用 `ONE_BOT_MAX_MESSAGE_LENGTH`（默认 1000）调整。

编辑 `config.yaml`：

```yaml
persona: "xiaoya"       # xiaoya / suchi / qiuyao，或你自建的人设 ID
her_name: "小雅"         # 她的名字
your_name: "你"          # 她怎么称呼你
location: "上海"         # 影响天气感知和话题

# 免打扰时段（可选，默认 23:00-07:00；start==end 表示关闭；支持 "23:30"）
quiet_hours_start: "23:00"
quiet_hours_end: "07:00"
```

> 🚧 `user_personas`（不同好友映射不同人设）的配置链路已在 M0 修复（`loadConfig` 会返回并校验该字段）。但注意：**同一人设的多个好友仍会共享会话与记忆**——完整的多用户隔离尚未实现（见[已知限制](#已知限制)）。

### 3. 体检

首次启动前建议先跑一次环境体检：

```bash
npm run doctor
```

它会检查 Node 版本、`config.yaml`、DeepSeek Key、人设加载、数据目录可写性与 SQLite 可用性，输出 ✅/❌ 清单和修复建议；有失败项时退出码为 1。首次运行会创建 `data/` 目录与 `data/memory.sqlite`（自动建表与迁移）。

### 4. 开始聊天

**命令行模式**（最快，不需要 QQ）：

```bash
npm run dev
```

**QQ 桥接**（完整体验——她在你的 QQ 通讯录里；Windows 已验证，macOS/Linux 方案见 [跨平台桥接指南](docs/QQ_BRIDGE_CROSS_PLATFORM.md)）：

1. 准备一个 QQ 小号（建议单独注册）
2. 下载 [NapCatQQ](https://github.com/NapNeko/NapCatQQ/releases)，解压到 `D:\NapCatShell`
3. 打开 NapCat WebUI → `http://127.0.0.1:6099` → 网络配置 → 新增反向 WebSocket：
   - 地址：`ws://127.0.0.1:18080/onebot/v11/ws`
   - access_token：与 `.env` 的 `ONE_BOT_TOKEN` 保持一致
4. Windows：双击 `scripts\start-all.bat`；macOS：按[跨平台桥接指南](docs/QQ_BRIDGE_CROSS_PLATFORM.md)安装原生 NapCat 后启动；扫码登录 QQ 小号
5. 用你自己的 QQ 号给她发消息（如果配置了 `ALLOWED_USERS`，确保你的 QQ 号在白名单里）

**首次启动可能遇到的问题**：[QUICKSTART.md](QUICKSTART.md) 有详细的故障排查。

### 费用（如实）

项目**目前没有 token 统计与预算上限**（规划中），但每次 LLM 调用都会记录 token/缓存命中日志；后台还会产生额外调用（内心独白、T3 摘要、人设进化日志等）。DeepSeek V4 的思考模式默认已关闭、静态人设前缀可命中 prompt 缓存，按官方价格粗估：日均 100 条消息、开启全部后台调用时约 **¥3–8/月**；OpenWeatherMap / Unsplash 按各自服务商计费。具体以账单为准，不要以本文估算为承诺。详见 [DeepSeek 能力审计](docs/DEEPSEEK_CAPABILITY_AUDIT.md)。

---

## 功能状态

图例：✅ 已实现且可用 ｜ 🚧 半成品 / 有明显限制 ｜ 🗺 规划中 / 未实现

### 对话与桥接

| 功能 | 状态 | 说明 |
|---|---|---|
| CLI 终端对话 | ✅ | `npm run dev`；命令：`/stats` `/mood` `/weather` `/journal` `/timeline` `/herview` `/evolution` `/quit` |
| QQ 私聊流式回复 | ✅ | NapCatQQ / OneBot 11；标点断句、0.2–0.8s 间隔、400ms 消息合并、中断检测 |
| 消息复杂度路由 | ✅ | 规则分级 simple/normal/complex → `deepseek-v4-flash` / `deepseek-v4-pro` |
| 引用消息 / QQ 表情 | ✅ | 引用原文回查、qqface CQ 码发送 |
| 表情/贴纸（入站+出站） | ✅ | 入站 QQ 表情/表情包转合成文本；她会在合适情绪下主动发本地贴纸（11 个 Twemoji，CC-BY 4.0）；仅私聊 |
| 主动发图 | ✅ | 亲密度/情绪/概率门控；有 `UNSPLASH_ACCESS_KEY` 走 Unsplash 搜索，无 Key 用本地 7 张授权图库兜底；QQ 私聊 base64 发送配文+图片 |
| 本地 Web 控制台 | ✅ | `http://127.0.0.1:18082/`：聊天/记忆/关系时间线/状态成本四视图；只读、仅本机、可选 `web_token` |
| 群聊 @ 回复 | 🚧 | 仅「@ 她 + 对方和她私聊过」才回复；不 @ 不回、不引用，与私聊共享状态 |
| 微信桥接 | 🗺 | 无依赖占位桩，`npm run wechat` 会明确提示走 QQ |
| 消息门（睡眠/工作忙/回避话题等） | 🚧 | 基础判定可用；延迟回复会落库并在延迟到点自动补发（用户发新消息会取消待补发，M0 修复）；负面话题的回避行为仍然生硬 |
| 语音消息 / TTS | 🗺 | 未实现，`[语音]` 仅占位 |
| 撤回消息 | 🗺 | 暂无消费者 |

### 记忆与数据

| 功能 | 状态 | 说明 |
|---|---|---|
| T2 情节记忆存储 + 艾宾浩斯衰减 | ✅ | SQLite（better-sqlite3）；衰减目前在启动时执行一次 |
| 混合检索（n-gram + FTS5 BM25） | ✅ | RRF 融合、中文 2 字词可命中、阈值/去重/来源过滤 |
| sqlite-vec 向量索引 | ✅ | vec0（cosine + persona/source/model metadata），写入/删除/归档同步；不可用时回退 JS 余弦 |
| 语义嵌入（Qwen text-embedding-v3） | 🚧 | 代码已接通写入/检索（双列不混比），但**需要 Qwen Key 才能实跑**；无 Key 自动降级 n-gram |

| 语义嵌入（Qwen text-embedding-v3） | 🚧 | 代码已实现但**未接入主路径**，当前实际使用 n-gram |
| sqlite-vec 向量索引 | 🚧 | 仅建表，检索仍是 JS 层全量 JSON 解析 + 余弦 |
| T3 长期摘要 | 🚧 | 每 80 条触发 LLM 压缩；无并发锁与「已压缩」标记，存在重复压缩 |
| 记忆查看 / 删除 / 导出 / 备份 | 🗺 | 无任何入口 |

### 人设与演化

| 功能 | 状态 | 说明 |
|---|---|---|
| 六层人设 schema + 校验 | ✅ | `npm run persona:check`；字段完整性与枚举校验 |
| 三个内置人设 | ✅ | 小雅（回避型）/ 苏迟（焦虑型）/ 秋瑶（安全型） |
| 人设创建 / 叙事创建 | 🚧 | `persona:create` 脚手架、`persona:narrate` 五种入口；叙事创建是**正则推导**而非 LLM 分析 |
| 人设字段进入 Prompt | 🚧 | 不足一半的字段真正影响对话（审计 2.3） |
| 不同好友不同人设 | 🚧 | M0 修复配置链路；同一人设多好友仍共享会话/记忆 |
| 演化（基线漂移 / 因果链 / 叙事重构 / herView） | 🚧 | 模块存在，但多数未接入 QQ 主路径、状态不持久化；重启归零 |
| 亲密度 / 关系成长 | 🗺 | `relationship.closeness` 当前不会被运行时修改 |

### 主动性与外部感知

| 功能 | 状态 | 说明 |
|---|---|---|
| 主动消息（15 分钟心跳） | 🚧 | 因果链/天气/情绪/时间四类触发；M0 已加单日上限 4 条 + 两次最小间隔 30 分钟 + 连续沉默 3 次强制回复；仍无免打扰/暂停开关 |
| 真实天气（OpenWeatherMap） | ✅ | 需 `OPENWEATHER_API_KEY`；无 Key 时降级 mock |
| 时间感知 | ✅ | 结构化时刻标签注入 Prompt |
| 网络热点 | 🚧 | 本地硬编码话题池，无真实抓取 |
| 图片识别 | ✅ | 由 DeepSeek Flash 多模态完成（无需 Qwen-VL）；本地下载转 base64 兼容 NapCat 私有 URL；`detail=high` 保留分辨率；截图/文字类逐字转述（≤200 字），照片/插画 40–80 字描述 |
| 主动发图（Unsplash） | 🚧 | 仅 CLI 非流式会展示；QQ 私聊/群聊不发图 |
| 图片生成（即梦）/ 表情包 | 🗺 | 未实现（仅有 Key 占位） |

### 工程与运维

| 功能 | 状态 | 说明 |
|---|---|---|
| 类型检查 + 单元测试 | ✅ | `npm run typecheck`、`npm test`（35 文件 / 462 用例） |
| 结构化日志 | ✅ | 默认脱敏（消息只记长度/摘要）；TTY 可读，非 TTY JSON lines |
| 健康检查 | ✅ | `GET http://127.0.0.1:18081/health`（仅本机；返回 ws/db/pending/成本/最近错误） |
| 成本统计 | ✅ | `GET /cost` 7 日摘要；DeepSeek 峰谷价 + 缓存命中；仅主聊天路径（旁路未计入） |
| PM2 守护 | ✅ | 改跑 `dist/bridge/qq.js`，部署前需 `npm run build` |
| CI（GitHub Actions） | ✅ | push/PR：Node 22 + `npm ci` + typecheck + test；**ubuntu / macOS / Windows 三平台矩阵** |
| 环境体检 | ✅ | `npm run doctor` |
| Docker | 🚧 | 提供 node:22-slim 多阶段镜像（非 root）；仅面向开发者/Linux，NapCat 仍需宿主机运行，未在所有平台验证 |
| PM2 守护 | ✅ | `ecosystem.config.js`；日志目录需手动创建（见注释） |
| 记忆管理（写操作） / 宣传页 | 🗺 | Web 控制台 MVP 已只读上线，写操作与宣传页 M2 |
| 多用户隔离 | 🗺 | 当前架构只对「单用户单实例」成立 |

---

## 隐私与安全

### 数据存在哪里

- **本地存储**：`data/`（SQLite 记忆库、会话 JSON）、`personas/`、`config.yaml`、`.env` 都在你自己的电脑里。
- 本项目**不运营任何云端服务器**，不会把数据上传到作者那里，也没有任何遥测。
- 注意：本地存储 ≠ 数据不出本机。用到的 LLM / 视觉 / 天气 / 图库服务都是第三方 API。

### 哪些内容会离开你的电脑（如实说明）

| 操作 | 发往 | 发送内容 |
|---|---|---|
| 每一轮对话 | DeepSeek API | 你的消息 + 上下文（含人设块、记忆检索结果、状态标签） |
| 图片识别 | DeepSeek API（deepseek-flash 多模态） | 图片数据（base64，先下载后上传） |
| 语义嵌入（当前未接主路径） | 阿里云 DashScope | 用于嵌入的文本 |
| 天气感知 | OpenWeatherMap | 城市名 |
| 主动发图（仅 CLI 非流式触发） | DeepSeek API + Unsplash | 用于生成图片搜索词的摘要、搜索关键词 |
| 后台 LLM 操作 | DeepSeek API | 内心独白、T3 长期摘要、人设进化日志、叙事重构等用到的对话/记忆内容 |

以上均由对应服务商的隐私政策约束。API Key 只保存在本地 `.env`，日志保存在本地终端或 PM2 日志文件里。

### 安全与风险

- **QQ 桥接使用非官方协议**：NapCatQQ 违反腾讯平台协议，可能被封号；请使用小号并自行承担风险。`start-all.bat` 等脚本硬编码了 `D:\NapCatShell`，Windows 之外需自行适配。
- **M0 已完成安全加固**：WS 默认只监听 `127.0.0.1`，支持 token 与 path 校验、`ALLOWED_USERS` 白名单、模型输出的 CQ 注入转义与超长消息切分；监听非回环地址却未配 token 时会打印警告。**仍然不要把端口暴露到公网。**
- 日志：QQ 桥接日志已脱敏（只打印消息长度/摘要），但编排器等其他模块仍可能打印消息片段，请保护终端与 PM2 日志文件。
- 这是 AI：本项目的设计目标是「不暴露 AI 身份」，作为产品对外提供前需要做 AI 披露与用户知情同意（M2 规划）。
- 目标场景包含情感陪伴，但项目**没有自伤/危机干预兜底、没有年龄门槛**。如果你或朋友处于心理脆弱期，请优先寻求专业帮助。

---

## 已知限制

按重要度排列（完整清单见 [审计报告第 4 节](docs/PRODUCT_AUDIT.md)）：

1. **QQ 桥接的跨平台验证不完整**：Windows 已实机验证；macOS 有官方原生 NapCat 方案 + Docker 备选（见 [跨平台桥接指南](docs/QQ_BRIDGE_CROSS_PLATFORM.md)），但本项目尚未在 macOS 实机扫码验证；掉线通知仍是 Windows-only。
2. **多用户隔离未完成**：会话与记忆按人设而非「用户」隔离，同一个人设被多个好友使用时共享聊天记录；群聊与私聊共享状态。
3. **演化状态不持久化**：情绪、负债、漂移、因果链、herView、计时器多存在内存里，重启归零。
4. **记忆检索默认不是语义检索**：未配置 Qwen Key 时是「字符 n-gram + FTS5 BM25 混合」；配置 `QWEN_VL_API_KEY` 后才启用语义向量检索（阈值待标定）。
5. **双管线能力不对等**：QQ 私聊走精简流式管线，CLI/群聊走完整非流式管线，部分能力（内心独白、T1 快照、发图、语气链）只在后者生效；M0 已统一门控上下文与延迟回复语义，其余步骤在 M1 继续统一。
6. **主动消息仍不可完全控制**：M0 已加单日 4 条上限与 30 分钟最小间隔，但还没有免打扰/暂停开关，也不能按用户配置频率（M1-4 规划）。
7. **未实现**：TTS/语音、微信桥接、图片生成、撤回、记忆查看/删除/导出、Web 控制台、token 成本统计、健康检查端点。
8. **测试覆盖仍不足**：M0/M1 新增了数据层、消息门、编排器、桥接解析、天气、关系成长、状态持久化、演化视图、AI 路由/视觉等测试（35 文件 / 462 用例），但真实 QQ/NapCat 与完整对话质量没有自动化集成测试，也没有覆盖率统计。
9. **人设字段消费不足**：创作者写的底线、软肋、人生目标等字段有一部分不进入 Prompt（审计 2.3）。
10. **平台风险**：产品命运绑定在非官方 QQ 协议上，封号/协议变更/客户端升级都可能让桥接失效。

---

## 她是怎么运作的

```
你的消息 → 消息门（回不回、什么时候回）→ 情绪/天气/因果链状态
    → 记忆检索（T2 RAG）→ Prompt 组装（六层人设 + 动态状态）
    → DeepSeek 生成 → 标点断句 / 流式逐句发送
    → 写回记忆（T2）→ 后台演化检查（T3 摘要 / 内心独白 / 进化日志）
```

- **消息门**不是简单的是/否：睡眠时段、工作忙、回避话题、情绪低落等会决定「现在不回 / 晚点回 / 破例回」。延迟回复会落库，到点自动补发（M0）。
- **记忆不是存文本**：每条对话写入 T2 并生成嵌入向量，检索时按相似度 × 衰减强度 × 情绪权重综合排序（相似度目前由 n-gram 计算）。
- **双管线说明**：QQ 私聊使用流式管线 `processMessageStream`，CLI/群聊使用完整管线 `processMessage`；M0 已让两者共用消息门上下文（`buildGateContext`），记忆写入与演化步骤的统一在 M1 继续。

### 设计上支撑「她像一个人」的机制

| 机制 | 实现位置 | 现状 |
|---|---|---|
| 六层人设（硬规则/身份/说话/情绪/关系/世界） | `src/persona/` | ✅ schema 与 Prompt 装配；部分字段未消费 |
| L1 弹性规则裁决（resistance / immutable / 三阶段） | `src/persona/prompt-builder.ts` | 🚧 只在非流式路径生效；突破主要影响内部状态 |
| 消息门 + 破例 | `src/impulse/` | 🚧 基础可用，延迟回复已落库+补发 |
| T2 情节记忆 + 衰减 | `src/data/` | ✅ 存储/衰减可用；检索为字符匹配 |
| 主动生活流（心跳触发） | `src/pipeline/orchestrator.ts` | 🚧 可用，M0 已加日上限与最小间隔 |
| 基线漂移 / 因果链 / 自我叙事 / 内心独白 | `src/evolution/` | 🚧 模块存在、多未闭环或未持久化 |
| 外部感知（天气/时间/热点） | `src/world/` | 🚧 天气与时间可用；热点是硬编码话题池 |

---

## 命令行

| 命令 | 作用 |
|---|---|
| `npm run doctor` | 环境体检（推荐第一步） |
| `npm run dev` | CLI 对话模式 |
| `npm run qq` | QQ 桥接模式（NapCatQQ / OneBot 11） |
| `npm run setup` | 交互式配置向导 |
| `npm run typecheck` | TypeScript 类型检查（0 错误） |
| `npm test` | 运行单元测试（vitest） |
| `npm run build` | 编译到 `dist/`（`npm start` 启动的是微信桩入口，不是主入口） |
| `npm run persona:list` | 列出可用人设 |
| `npm run persona:check <id>` | 校验指定人设 |
| `npm run persona:create` | 脚手架创建人设 |
| `npm run persona:narrate` | 叙事式创建人设（正则推导，非 LLM） |
| `npm run wechat` | 微信桥接（🗺 仅 echo 桩，不可用） |
| `node scripts/mock-onebot.mjs` | 无 QQ 联调：模拟 NapCat 反向 WS 客户端（需先启动 `npm run qq`） |

---

## 分享你的人设

如果你创建了一个不错的人设，欢迎贡献回项目——让别人也能遇见她。

**方式**：Fork 项目 → 在 `personas/` 下新建目录 → 放入 `persona.json` 和 `SKILL.md` → 提 PR。

**提交前检查**：

```bash
npm run persona:check <your-persona-id>   # 零错误才能通过
```

**人设创作指南**：[PERSONA_GUIDE.md](PERSONA_GUIDE.md)——从五种创作入口开始。注意：指南中的部分校验规则与字段消费说明尚未与代码对齐（审计 3-16），以实际 `persona:check` 结果为准。

**注意**：提交的人设不要包含真实个人信息。`persona.json` 中的 `howWeMet`、`keyEvents` 等字段应是虚构内容。

---

## 项目结构

```
karen-persona/
├── src/
│   ├── persona/       # 人设引擎（六层 schema、校验、情绪、Prompt 组装）
│   ├── evolution/     # 演化引擎（漂移、因果链、记忆代谢、进化日志）—— 🚧 多未闭环
│   ├── impulse/       # 冲动引擎（消息门、触发、沉默弧线、表达渲染）—— 🚧
│   ├── world/         # 外部感知（天气、时间、热点）
│   ├── ai/            # AI 引擎（DeepSeek 路由、流式、视觉、Unsplash）
│   ├── data/          # 记忆系统（SQLite 存储、RAG 检索、会话历史、路径解析）
│   ├── pipeline/      # 管线编排器（orchestrator）
│   ├── bridge/        # QQ 桥接（NapCat/OneBot 11）；微信桥接为无依赖占位
│   ├── eval/          # 评估脚本与实验代码（无产品入口）—— 🚧
│   ├── router/        # 消息路由实验代码（当前未被主路径引用）—— 💀
│   ├── doctor.ts      # 环境体检
│   └── setup.ts       # 配置向导
├── personas/          # 人设模板（persona.json + SKILL.md）
├── scripts/           # Windows 启动/托盘脚本
├── docs/              # 产品审计报告等
├── data/              # 运行时数据（gitignore，首次启动创建）
└── config.yaml        # 用户配置（从 config.yaml.example 复制）
```

---

## 技术栈

贴纸素材：Twitter Twemoji（CC-BY 4.0）。Node.js 22+ · TypeScript 5.6 · DeepSeek V4.1 Flash / V4-Pro（对话 + 视觉 + JSON/Tools，flash 自动路由）· OpenWeatherMap（天气）· Unsplash（图库）· better-sqlite3 13（SQLite，预编译跨平台）· sqlite-vec + FTS5（混合检索）· NapCatQQ / OneBot 11（QQ 桥接）· 微信桥接（无依赖占位，不在路线图）· vitest（测试）· GitHub Actions（CI）

---

## 注意事项

- **这是 AI，不是真人。** 请勿在心理脆弱期过度依赖。
- QQ 桥接使用 NapCatQQ 协议，本项目不提供 QQ 账号，封号风险由使用者承担。
- 本项目为开源学习与个人疗愈用途。使用者自行承担使用后果。

---

## License

[MIT](LICENSE) © 2026 QIU0826
