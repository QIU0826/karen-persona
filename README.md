# Karen — AI 虚拟人设聊天系统

> 让通讯录里住进一个有自己生活、情绪和记忆的人。

你的特别关注铃声多久没有响过了。你是否有一个喜欢的人，但是你无法在现实中找到她。但是现在她可以出现在通讯录中。她不只是一个 AI 虚拟人物，她也有自己的生活，自己的想法，自己的决定。这个项目的出现只是为了将你们在不同平行世界的缘分连上。

> ⚠️ **免责声明**：本项目仅用于个人回忆与情感疗愈，不用于骚扰、跟踪或侵犯他人隐私。**她是 AI，不是真人**。QQ 桥接依赖非官方协议（NapCatQQ），存在封号与协议变更风险，请使用小号并自行承担后果。

> **项目状态（2026-10，v0.9.31）**：M0 地基修复完成（新装可启动、延迟消息不丢、桥接安全加固、LLM 异常兜底、文档真话）；M1 核心体验闭环主要项完成（状态持久化、关系成长、演化可见化、多用户隔离、双管线对齐）；M2 产品化交付 **首次引导 2.0**、**人设包 v2**、**本地 Web 控制台（只读）**、**真实 QQ 长跑观察**。近期（v0.4.1–v0.8.21）主线：**记忆重构**（本地真向量 768 维、锚点层 + 日度 LLM 复筛、日记忆/周汇总、事实状态机与冲突质疑、五维关系、反思循环）、**拟人化交互**（打字节奏、消息意图族、表情包收集、贴纸、语音）、**意图式主动**（每日由头 + 按回复率校准）；以及 **验证体系**——5 条真实链路冒烟（主动消息/锚点创建/日记忆/锚点复筛/周汇总）、桥接 E2E、离线评测守门进 CI、[验证手册](docs/VERIFICATION_PLAYBOOK.md) 与 [能力覆盖审计](docs/COVERAGE_AUDIT.md)。v0.9.0 起 **语音双向**：她发语音（TTS）+ **听得懂你发的语音**（本机 faster-whisper，1–1.5s/条，`npm run asr:start`；v0.9.3 鲁棒性压测：语速/台腔/粤语口音/5–10dB 噪声下 CER 3.0–10.7%，`npm run asr:robustness`）；v0.8.23 起 **本机生图已跑通**（热态 2.1–2.6s/张，2026-10-22 复验 2.6s）；语音音色已从系统 `say` 换到开源神经 TTS（v0.9.15）；v0.9.16 已接入 Fun-CosyVoice 3.0 零样本克隆；**2026-10-22 本机改用 IndexTTS-2.5**（MPS、8 维情绪向量；参考音仍是用户提供的 8.3s 视频；参考音只在 `data/voice-ref/`，不入库；代码默认仍 Kokoro，服务不可用自动回退 Kokoro→say）、微信桥接。**主动性 v0.9.4 有实质进展**：主动由头从"只追问对方"改成"分享她自己的生活"（自述条目 0→8、纯追问 24→0；8 轮真实长跑 主动 3/5→4/5，单次）。本文所有功能宣称都以当前代码为准：未完成的能力明确标成「半成品 / 规划中」，验证到哪一步见覆盖审计。
完整功能清单与路线图见 **[docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md)**。「哪些真做了、做到什么程度」见 **[docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)**（能力→代码→实测数字→弱项）。
>
> **v0.9.31 已发布**（2026-10-22）：GitHub `main` 分支 + tag。**语音换成 IndexTTS-2.5**：本机 MPS 零样本克隆 + 8 维情绪向量（高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静），按她的语气风格自动给向量；同一句带情绪合成实测 **5.9s/1.94s 音频**（热态），比 CosyVoice 的情绪更明显；参考音仍用你视频里的 8.3s。同时本机生图复验：SDXL-Turbo 热态 **2.6s/张**，`image:smoke` 全过。v0.9.30 是语音按文字线索选情绪；v0.9.29 是 CosyVoice instruct2。历史：v0.3.1 修掉 15 轮真实验证暴露的两个 P0（编造「怎么认识的」、多媒体内容错位）与情绪承接/嘲讽话术/图片复用等 P1-P2。
>
> 仓库实测状态（2026-10-22）：`npm run typecheck` 0 错误；`npm test` **128 个测试文件 / 1486 个用例**全部通过（vitest；审计基线为 11 文件 / 178 用例）。GitHub Actions CI 已接入类型检查、lint、单测与覆盖率基线（行覆盖 59.21%）。**干净 checkout + 真实 `npm ci` 已复验**（v0.2.1 时）：122 个依赖约 40s 安装、typecheck 0 错误、doctor 在缺 config/.env 时给出可执行的修复指引；v0.3.0 新增 `silk-wasm`（纯 wasm，无原生构建）。另有 **mock-OneBot 端到端集成测试**（真实 bridge 进程 + fake NapCat/DeepSeek，覆盖披露/年龄门/私聊/图片/群聊，CI 自动跑，见 [docs/QQ_E2E_TEST.md](docs/QQ_E2E_TEST.md)）与 **真实 QQ 长跑工具**（`npm run qq:watch`）：真机首轮 2 个完整回合平均延迟 2.9s、成本 ¥0.0057，暴露的「老用户披露缺失」「快速追问误延迟」已修复（见 [docs/QQ_REAL_RUN.md](docs/QQ_REAL_RUN.md)）；**样本仍少，真实 QQ 长跑继续进行中**；另用「本地模拟用户 + 真实 DeepSeek」跑过 30 轮长跑（记忆 6/6、复读对 0、错误 0、平均延迟 2047ms、成本 ¥0.147），见 [docs/LONGRUN_REGRESSION.md](docs/LONGRUN_REGRESSION.md)。

---

## 她和别的 AI 聊天机器人有什么不一样

**她想成为一个独立的人，而不是一个服务你的工具。**

下面是她「想成为的样子」与 2026-10 的实际进度——不夸大：

| 设计目标 | 当前进度 |
|---|---|
| 不是永久配合，有自己的底线 | 🚧 有 L1 弹性规则与内疚/偿还机制，但「规则被突破」目前主要影响内部状态，用户能观察到的行为差异有限 |
| 六层人设结构，层与层之间可以冲突 | ✅ schema、校验器、Prompt 装配已实现；🚧 部分字段（如 `hardRules`、`world.goals`）还没有进入 Prompt，详见审计报告 2.3 |
| 有自己的生活，会主动找你 | 🚧 15 分钟心跳，四条独立链路（生活流分享 / 没人接话补一句 / 冷场开话题 / 沉默保温），单日上限 4 条、两次最小间隔 30 分钟、对方不回时一天最多 2 条；`/pause` 可暂停、`quiet_hours_*` 免打扰生效、`/why` 可解释「她为什么没找你」 |
| 三层记忆 + 遗忘曲线 | ✅ T2 存储/衰减可用；检索 = **本地 768 维向量 + FTS5 BM25**（RRF，p95 <100ms，服务不可用自动降级 n-gram）；另有**锚点层**（重要事件永不衰减，日度 LLM 复筛）、**日记忆/周汇总**、**用户事实层 + 冲突状态机**；40 条金标离线 recall@8 97.5%、合并 100% |
| 她会慢慢变化 | ✅/🚧 情绪/负债/漂移/关系/叙事/herView 已持久化（重启不归零）；亲密度随结构性事件成长并有里程碑；`/journal`、`/timeline`、`/herview` 可见；部分演化模块仍未接 QQ 主路径 |
| 数据存储在本地 | ✅ 记忆、会话、人设、配置都保存在你自己的电脑上；⚠️ 但对话/记忆片段/图片会发送给 DeepSeek（对话与后台摘要、图片识别、检索重排），天气发 OpenWeatherMap，语义嵌入若启用发 DashScope——详见[隐私与安全](#隐私与安全) |
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

> `better-sqlite3` 13 已内置 Windows/macOS/Linux 的 N-API 预编译模块（`prebuilds/`）；仓库根 `.npmrc` 设了 `ignore-scripts=true`，避免 npm 对带 `binding.gyp` 的包自动跑 `node-gyp rebuild`。正常 `npm install` **无需 C++ 编译工具链**（Windows 也不需要 Visual Studio）。若确需重建：`npm rebuild better-sqlite3 --foreground-scripts`。

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
# 语义嵌入默认用本地服务（npm run embed:start），无需云 Key；
# QWEN_VL_API_KEY=sk-xxxxxxxx          # 可选：改用 Qwen 云端嵌入（不用于图片识别）
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

> ✅ `user_personas`（不同好友映射不同人设）的配置链路已可用；M1 已实现**多用户隔离**：主用户（白名单第一个 QQ）沿用历史会话/状态/记忆，其他好友使用隔离的会话、人格状态与记忆（T2 persona_id 带 owner 后缀）；Web 控制台目前只展示主用户数据。

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
| CLI 终端对话 | ✅ | `npm run dev`；命令：`/stats` `/mood` `/weather` `/journal` `/timeline` `/herview` `/evolution` `/fact` `/relations` `/reflect` `/forget` `/pause` `/resume` `/why` `/export` `/about` `/age` `/quit` |
| QQ 私聊流式回复 | ✅ | NapCatQQ / OneBot 11；标点断句、0.2–0.8s 间隔、400ms 消息合并、中断检测 |
| 消息复杂度路由 | ✅ | 规则分级 simple/normal/complex → `deepseek-v4-flash` / `deepseek-v4-pro` |
| 引用消息 / QQ 表情 | ✅ | 引用原文回查、qqface CQ 码发送 |
| 表情/贴纸（入站+出站） | ✅ | 入站 QQ 表情/表情包转合成文本；她会在合适情绪下主动发本地贴纸（11 个 Twemoji，CC-BY 4.0）；仅私聊 |
| 用户事实记忆 | ✅ | 后台抽取「你明确说过的」稳定事实（名字/工作/宠物/项目/偏好/计划），存 SQLite（按用户隔离），每轮以「她确定记得的事」注入 prompt |
| 主动发图 | ✅ | 亲密度/情绪/概率门控；**只在有对话钩子时发**（他点名 / 场景命中 / 她刚分享生活），抽象话题宁可不发；场景命中时用贴题配文（晚霞→「天这样了」；**v0.9.12 起配文只在照片真有该场景时才用**，旧逻辑不一致率 22%→0%）；照片带「拍摄时间/故事」——今天/昨天/以前，早上可发「昨天的晚霞」；亲密度 ≥4 才会分享「以前的生活」；有 `UNSPLASH_ACCESS_KEY` 走 Unsplash 搜索，无 Key 用**25 张本地图库 + 约 150 条配文**兜底，并会按他提到的场景挑图（晚霞/雨/咖啡/猫/山/湖/花…） |
| 本地 Web 控制台 | ✅ | `http://127.0.0.1:18082/`：聊天/记忆/关系时间线/状态成本四视图；只读、仅本机、可选 `web_token`；支持多用户只读切换（`/api/owners` + `web_all_owners: true`，默认关）与单用户 JSON 导出（`/api/export`，含会话/状态/T2 记忆） |
| 宣传页（promo） | ✅ | `http://127.0.0.1:18082/promo/`：单文件、零构建的深色编辑式落地页（v0.9.20 视觉重做）——去内容卡片与边框、两栏章节头、细发丝线、单一暖橙；16px 正文 + 540px 行宽 + 桌面端受控断行，平面聊天面板（无手机壳/状态栏/发光）、非对称主动区、照片统一降饱和调色；**首屏 6s 动态人像（双视频交叉淡入）+ 她正在发来的话（打字循环）**，**01 与 04–05 铺很轻的动态人像背景（有图的 02/03/间奏/outro 不铺）**，分区「她的日常 / 消息形态 / 间奏 / 主动性 / 记忆 / 隐私」，纯 HTML/CSS 聊天 mockup 展示照片、表情包、3″ 语音、撤回与正在输入；人物图只出现三次，1440/390 截图自检、390 宽无横向溢出，详见 [promo/README.md](promo/README.md) |
| 治理命令 | ✅ | QQ/CLI 可用：`/why`（解释上一轮门控）、`/pause`/`/resume`（暂停/恢复主动消息）、`/forget 关键词 [--yes]`（按关键词删除 T2 记忆，先预览再确认）、`/export`（导出对话+记忆 JSON）、`/about`（数据说明）、`/age`（年龄确认状态）、`/fact`（她记得的关于你的事，可 `ok`/`no` 确认或否掉）、`/relations`（五维关系现状）、`/reflect`（她的反思弧线：察觉/嘴硬/认了/慢慢改）、`/stats`、`/help` |
| 合规（年龄门/危机兜底/AI 披露可选） | ✅ | **年龄门**要求 QQ 用户先确认「我成年了」才进入对话（`/age` 查看，`age_gate_enabled` 可关；自我声明，非身份证校验）；危机信号强制回复并附专业求助资源（12356/010-82951332/110/120）；AI 披露能力保留但**默认关闭**（个人自用不在聊天里插入披露；公开发布/商用可在 `config.yaml` 显式 `ai_disclosure: true`） |
| 群聊 @ 回复 | 🚧 | 仅「@ 她 + 对方和她私聊过」才回复；不 @ 不回、不引用，与私聊共享状态；支持 QQ 表情/本地贴纸（收到表情更愿意回）；生活照默认不发群，`group_photo_enabled: true` 才开 |
| 微信桥接 | 🗺 | 无依赖占位桩，`npm run wechat` 会明确提示走 QQ |
| 消息门（睡眠/工作忙/回避话题等） | 🚧 | 基础判定可用；延迟回复会落库并在延迟到点自动补发（用户发新消息会取消待补发，M0 修复）；负面话题的回避行为仍然生硬 |
| 语音消息 | ✅ | 她偶尔会用一条短语音代替打字：**v0.9.31 起本机改用 IndexTTS-2.5**（MPS，8 维情绪向量，热态约 5.9s/1.9s 音频；参考音用用户提供的 8.3s 视频；服务未起自动回退 Kokoro→say）；**v0.9.15 起开源神经 TTS Kokoro** 仍是代码默认/回退（CPU RTF 0.16–0.20x、ASR CER ≤5%）；**v0.9.16 起可选零样本克隆**（CosyVoice / IndexTTS-2.5；v0.9.29 起 CosyVoice instruct2 情绪指令、v0.9.30 起按回复文字线索自动选风格）；系统 `say` 保留为最后回退；试听样本 `data/voice-samples/`（本地）与 `assets/voice-samples/`，核验见 [docs/INDEXTTS2.md](docs/INDEXTTS2.md)、[docs/VOICE_CLONE.md](docs/VOICE_CLONE.md) |
| 说话动作（先接住情绪 / 补一句自己） | ✅ | 对方在倒苦水时先接住情绪、别马上转到自己；否则低概率（28%）顺手补一句自己的近况。带亲密度门槛与连续两轮不重复，`KAREN_TALK_MOVES=off` 可关；8 轮 A/B 未测出评审分差异（见 docs/MOCK_VALIDATION.md §9） |
| 打字节奏 / 打错字撤回 | ✅ | 每轮最多 4 条文字气泡（超出合并）、当轮去重、气泡间隔按字数模拟打字（约 80–120ms/字）；低概率（默认 4%）先发错字、约 1.5s 后撤回、再发正确版（OneBot `delete_msg`，只允许撤回本进程 15s 内的消息）；会话/记忆只记正确原文；`typo_recall_*` 可关 |
| 相识不编造 | ✅ | 用户问「我们怎么认识的」而无任何依据（人设背景/用户事实/记忆都没有）时，确定性守卫会删掉编造的具体场景（吧台/下雨/借伞/每周来…），整条都在编就换成一句含糊的真人式回应；有依据时正常回忆 |
| 被点名要多媒体时真的会给 | ✅ | 识别「拍张照片看看」「发个表情包」「发条语音听听」：要照片时跳过概率判定（亲密度/冷却仍生效）并按他提到的场景挑图（晚霞→晚霞、雪→雪、店→咖啡），要表情/语音时提高概率并跳过冷却，同时给模型内部提示避免「嘴上说改天、其实没发」 |

### 记忆与数据

| 功能 | 状态 | 说明 |
|---|---|---|
| T2 情节记忆存储 + 艾宾浩斯衰减 | ✅ | SQLite（better-sqlite3）；衰减在启动时执行一次 |
| **本地真向量检索** | ✅ | 本机跑 Qwen3-Embedding-0.6B（`services/embed`，768 维，零迁移），历史记忆已全部重嵌入；检索 p95 从 ~664ms 降到 **<100ms**；服务不可用时自动降级 n-gram |
| 混合检索（向量 + FTS5 BM25） | ✅ | RRF 融合、中文 2 字词可命中（FTS5 OR + BM25 IDF）、阈值/去重/来源过滤；结果带相对时间标签（今天/昨天/3天前） |
| 语义重排（DeepSeek 候选重排） | ✅ | 对 top12 候选做一次 Flash 相关性重排；**本地向量启用时默认关掉**（实测 16→17–18/20 更好且省 ~664ms/轮），`KAREN_SEMANTIC_BOOST=on` 可强制开 |
| sqlite-vec 向量索引 | ✅ | vec0（cosine + persona/source/model metadata），写入/删除/归档同步；不可用时回退 JS 余弦 |
| **锚点记忆（长期不忘）** | ✅ | 相识/表白/冲突/和好/承诺/秘密/共同经历/失去等事件，永不衰减、双时间轴（否认只标记不删）；自动入库阈值 0.75，**每天再用 LLM 复筛**边界记忆（该记/不该记） |
| **日记忆 + 周汇总** | ✅ | 每天一条「发生了什么/情绪/未完成话题」+ 每周汇总；由心跳触发、按天幂等，靠日记忆取代「40 条一刀切」的压缩 |
| 用户事实记忆（SQLite） | ✅ | 后台抽取稳定事实，按 owner 隔离，每轮注入；值变化保留旧值（换工作/换城市显示「之前是…」）；**带状态机**：pending/confirmed/**disputed**（说法冲突时她会顺口确认一句，2 天内只问一次） |
| 认识初期主动了解 | ✅ | 亲密度 <5 时会顺口问工作/城市/宠物/名字/计划（每 4 轮最多一次、问过的不重复），解决"事实层没原料" |
| T3 长期摘要 | ✅/🚧 | 阈值 40 条或「≥20 条且隔天」兜底；`t3_compressed` 防重复压缩；prompt 保留事实/未完成话题/禁止编造（40 条真实压缩抽检通过；长期数据仍需按周抽检） |
| 记忆查看 / 导出 | ✅/🚧 | `/export` 导出 JSON；Web 控制台可只读查看/搜索/命中回放；`/forget` 可按关键词删除；批量编辑仍无入口 |
| 记忆评测（可复现） | ✅ | 40 条中文金标：离线 facts 100% / recall@8 97.5% / 合并 100%；真实模型 95–100%（加"说出具体实体"规则后）；`npm run eval:memory` |
| 锚点复筛评测 | ✅ | 30 条人工金标（该记 17 / 不该记 13）；四次跑**精确率 100%**（从不误建）、召回 82–100%；`npm run eval:anchor` |

### 人设与演化

| 功能 | 状态 | 说明 |
|---|---|---|
| 六层人设 schema + 校验 | ✅ | `npm run persona:check`；字段完整性与枚举校验 |
| 三个内置人设 | ✅ | 小雅（回避型）/ 苏迟（焦虑型）/ 秋瑶（安全型） |
| 人设创建 / 叙事创建 | 🚧 | `persona:create` 脚手架、`persona:narrate` 五种入口；叙事创建是**正则推导**而非 LLM 分析 |
| 人设包 v2（安装/分发） | ✅ | `manifest.json` + `persona.json` + 可选素材/记忆种子；`npm run persona:pack:validate/install/list`；结构/引擎兼容校验、覆盖备份、种子默认不写库；规范见 [docs/PERSONA_PACK.md](docs/PERSONA_PACK.md) |
| 人设字段进入 Prompt | 🚧 | 不足一半的字段真正影响对话（审计 2.3） |
| 不同好友不同人设 | 🚧 | 配置链路可用；M1 起多用户隔离（主用户兼容历史数据，其他好友的会话/状态/记忆隔离）；同一人设下的不同好友不会串记忆 |
| 演化（基线漂移 / 因果链 / 叙事重构 / herView） | 🚧/✅ | 已接主路径：因果链闯入、叙事弧、herView 更新、进化日志；状态随 `persona-state` 持久化（重启不归零） |
| 亲密度 / 关系成长 | ✅ | 由结构性事件驱动（深聊、连续互动、主动分享生活），每日 +0.1 上限、只增不减、带原因与里程碑；`/stats` 可查，`/timeline` 看关系事件 |
| **五维关系（亲密/信任/张力/互惠/依赖）** | ✅ | v0.8 起接主流程：事件驱动演化、张力随时间回落、注入 prompt 决定"话少不主动/愿意开玩笑"等倾向；`/relations` 可查 |
| **反思循环（觉察→否认→承认→整合）** | ✅ | v0.8.1：察觉需同类信号 2 次（他直接点破 1 次即察觉）→ 先嘴硬（撑 6 小时）→ 被戳 2 次才承认 → 整合期才真的改一次（情绪基线回落）；`/reflect` 可查 |

### 主动性与外部感知

| 功能 | 状态 | 说明 |
|---|---|---|
| **意图式主动性** | ✅ | 每天生成 2–3 个「今天想找他聊什么」的由头（当天第一条回复即懒加载，不再等心跳）；正常闲聊里也会自然带出这些事（来自日记忆的未完成话题 + 她生活里的事），按时间窗/免打扰/单日上限/最小间隔判定；**按他最近 10 次回复率校准每天条数**（不回→0 条、热络→3 条）；`KAREN_INITIATIVE=off` 可关 |
| 主动消息（15 分钟心跳） | ✅/🚧 | 四条链路独立可关（`proactive_channels`）：生活流分享（因果链/天气/情绪/时段）、没人接话补一句（20 分钟~3 小时）、冷场开话题（3~72 小时）、沉默保温（>72h，一轮失联只一次）；护栏 = 单日 4 条 + 间隔 30 分钟 + 连推 2 条收手；`/pause` `/resume`、免打扰时段、`/why` 决策原因都可查，详见 [docs/PROACTIVE_CHANNELS.md](docs/PROACTIVE_CHANNELS.md) |
| 真实天气（OpenWeatherMap） | ✅ | 需 `OPENWEATHER_API_KEY`；无 Key 时降级 mock |
| 时间感知 | ✅ | 结构化时刻标签注入 Prompt |
| 网络热点 | 🚧 | 本地硬编码话题池，无真实抓取 |
| 图片识别 | ✅ | 由 DeepSeek Flash 多模态完成（无需 Qwen-VL）；本地下载转 base64 兼容 NapCat 私有 URL；`detail=high` 保留分辨率；截图/文字类逐字转述（≤200 字），照片/插画 40–80 字描述 |
| 主动发图（Unsplash / 本地图库） | ✅/🚧 | 私聊会发（有 `UNSPLASH_ACCESS_KEY` 走 Unsplash，无 Key 用本地图库；按他提到的场景挑图）；群聊默认不发，`group_photo_enabled: true` 才开 |
| **表情包持续收集** | ✅ | 从你的聊天里自动下载表情包入库（去重、库容 500、单文件≤2MB、一键清空）；出站可优先用收集来的（`KAREN_STICKER_USE=on`）；**桥接 E2E 已验证「入站→入库→点名时从库里发出去」整条链路** |
| 本机生图 | ✅ | **v0.8.23 已跑通**：`stabilityai/sdxl-turbo` fp16 本地化，热态 **2.1–2.2s/张**（832×1216，MPS）；约 20% 照片走生成、点名要照片时直接生成；失败静默回退图库；`npm run image:smoke` 可复验；启动 `npm run image:start`（见 [docs/IMAGE_GEN.md](docs/IMAGE_GEN.md)） |

### 工程与运维

| 功能 | 状态 | 说明 |
|---|---|---|
| 首次引导 2.0 | ✅ | `npm run setup` 是「第一段对话」：写入会话 + `user_facts`（名字/城市/认识方式）+ 18+ 确认，并生成 `data/onboarding.json` 标记；CLI/QQ 首次聊天不再重复 18+ 确认（AI 披露默认关闭）；`npm run setup -- --force` 重设 |
| 类型检查 + lint + 单测 + 端到端 + 覆盖率 + 评测守门 | ✅ | `npm run typecheck`（0 错误）、`npm run lint`（tsc 未使用代码检查，0 违规）、`npm test`（**110 文件 / 1316 用例**，含 mock-OneBot 桥接 E2E、setup E2E、人设包、多用户 Web、TTS 真实链路、相识编造守卫）、`npm run test:coverage`（行覆盖 59.21%，阈值守护）、`npm run eval:offline`（记忆 40 条 + 锚点 30 条，卡阈值，CI 跑） |
| 结构化日志 | ✅ | 默认脱敏（消息只记长度/摘要，正文 `[redacted N chars]`；`LOG_CONTENT=1` 才输出 40 字预览）；TTY 可读，非 TTY JSON lines |
| 健康检查 | ✅ | `GET http://127.0.0.1:18081/health`（仅本机；返回 ws/db/pending/成本/最近错误） |
| 成本统计 | ✅ | `GET /cost` 7 日摘要；DeepSeek 峰谷价 + 缓存命中；主对话与旁路 LLM（事实抽取/独白/T3/视觉等）均按 `kind` 记账，Web 控制台可按模型/按用途查看 |
| PM2 守护 | ✅ | 改跑 `dist/bridge/qq.js`，部署前需 `npm run build` |
| CI（GitHub Actions） | ✅ | push/PR：Node 22 + `npm ci` + typecheck + lint + test；**ubuntu / macOS / Windows 三平台矩阵**；Linux 额外跑覆盖率基线 + **离线评测守门**（`npm run eval:offline`） |
| 环境体检 | ✅ | `npm run doctor` |
| 真实 QQ 长跑观察 | ✅ | `npm run qq:watch -- --duration 1800`：只读观察真实回合/延迟/成本/事实，结束写 `data/realrun-*.md` 报告；流程见 [docs/QQ_REAL_RUN.md](docs/QQ_REAL_RUN.md) |
| 真实验证台（mock OneBot + 真实模型） | ✅ | `node node_modules/tsx/dist/cli.mjs scripts/mock-onebot-longrun.ts --turns 15`：本地扮演 NapCat、用另一个真实 DeepSeek 扮演用户，跑多轮对话并输出延迟/气泡/多媒体/记忆探针/重复度/成本/LLM 评审报告；临时目录隔离，不碰真实 QQ 与真实 data/。见 [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md) |
| Docker | 🚧 | 提供 node:22-slim 多阶段镜像（非 root）；仅面向开发者/Linux，NapCat 仍需宿主机运行，未在所有平台验证 |
| PM2 守护 | ✅ | `ecosystem.config.js`；日志目录需手动创建（见注释） |
| 记忆管理（写操作） | 🗺 | Web 控制台 MVP 已只读上线，写操作属 M3 |
| 多用户隔离 | ✅ | owner=人设+用户+平台；主用户兼容历史数据，其他好友会话/状态/记忆隔离；Web 控制台默认只读展示主用户，`web_all_owners: true` 可切换查看其他用户（写操作仍无） |

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
| 检索重排（默认开启） | DeepSeek API | 初步命中的记忆片段（最多 12 条、每条截断 90 字）+ 你当前这句话 |
| 语义嵌入 | **本机**（默认，`services/embed` 本地模型，不出网）；仅当显式配置 Qwen Key 时才会发给阿里云 DashScope | 用于嵌入的文本 |
| 天气感知 | OpenWeatherMap | 城市名 |
| 主动发图（仅 CLI 非流式触发） | DeepSeek API + Unsplash | 用于生成图片搜索词的摘要、搜索关键词 |
| 后台 LLM 操作 | DeepSeek API | 内心独白、T3 长期摘要、人设进化日志、叙事重构等用到的对话/记忆内容 |

以上均由对应服务商的隐私政策约束。API Key 只保存在本地 `.env`，日志保存在本地终端或 PM2 日志文件里。

### 安全与风险

- **QQ 桥接使用非官方协议**：NapCatQQ 违反腾讯平台协议，可能被封号；请使用小号并自行承担风险。`start-all.bat` 等脚本硬编码了 `D:\NapCatShell`，Windows 之外需自行适配。
- **M0 已完成安全加固**：WS 默认只监听 `127.0.0.1`，支持 token 与 path 校验、`ALLOWED_USERS` 白名单、模型输出的 CQ 注入转义与超长消息切分；监听非回环地址却未配 token 时会打印警告。**仍然不要把端口暴露到公网。**
- 日志：默认脱敏（消息只记长度/摘要，内容打印为 `[redacted N chars]`；`LOG_CONTENT=1` 才输出 40 字预览）；请仍保护终端与 PM2 日志文件。
- 这是 AI：角色扮演时不主动暴露 AI 身份；AI 披露默认关闭（个人自用体验优先），公开发布/商用建议在 `config.yaml` 显式开启 `ai_disclosure: true`；`/about` 可随时查看数据说明，`/export` 可导出数据。
- 目标场景包含情感陪伴：已有危机关键词兜底（强制回复 + 专业求助资源）和 18+ 年龄确认门，但都只是**最低限度**的兜底（关键词可能漏判/误判；年龄门是自我声明），不是心理咨询或医疗产品。如果你或朋友处于心理脆弱期，请优先寻求专业帮助。

---

## 已知限制

按重要度排列（完整清单见 [审计报告第 4 节](docs/PRODUCT_AUDIT.md)）：

1. **QQ 桥接的跨平台验证不完整**：Windows/macOS 均已实机验证（macOS 原生 NapCat + 反向 WS）；Linux Docker 方案未验证；真实 QQ 端到端目前只在 macOS 跑过；平台/封号是结构性风险。
2. **多用户隔离的边界**：同一 QQ 用户在群聊与私聊共享 state；Web 控制台默认只展示主用户（`/api/facts?owner=` 可只读查其他 owner）；商用多租户托管（多实例/账号体系）仍属 M3。
3. **记忆深度**：已默认本地真向量（Qwen3-Embedding-0.6B，768 维）+ 锚点/日记忆/事实状态机；实测 40 条金标离线 recall@8 97.5%、合并命中 100%，真实模型 95–100%。仍缺：语义级重复的"改写"（只有句式提醒，9 次 A/B 未测出稳定效果）、长期数据的 T3 摘要需按周抽检、锚点复筛的"该记而漏记"率需真实数据积累。
4. **双管线仍是两份实现**：QQ 私聊流式与 CLI/群聊非流式行为已对齐（T1/T2/事实/反重复/重排均接入），但代码未抽共享 helper，后续改动需要双写。
5. **主动消息/夜间行为仍需真机长跑**：已支持 `/pause`/`/resume` 与可配置免打扰时段（`quiet_hours_*`），单日 4 条上限 + 30 分钟最小间隔；长时间无人值守的补发/主动行为仍需观察。
6. **发图图库有限**：贴纸 11 个内置 Twemoji（私聊+群聊可用）；发图 25 张本地兜底 + 约 150 条配文（配置 Unsplash Key 才走搜索）；仍会出现「同一类场景」的重复感；群聊发照片需 `group_photo_enabled: true`（默认关，隐私保守）。
7. **未完成/受限**：群聊语音（群聊仍不支持）、微信桥接（无依赖占位桩）、**本机生图已可用**（需先 `npm run image:start`，`.env` 里 `KAREN_IMAGE_GEN=on`）；Web 控制台只读。**语音消息只在 macOS 真正发声**（系统 `say`），其它平台自动降级为文字；**音色已在本机切到用户提供参考音的 IndexTTS-2.5**（见 [docs/INDEXTTS2.md](docs/INDEXTTS2.md) 与 [docs/VOICE_CLONE.md](docs/VOICE_CLONE.md)；代码默认仍 Kokoro，IndexTTS 服务需 `npm run indextts:start`）。**她已能听懂语音**（本机 ASR，见 [docs/ASR.md](docs/ASR.md)），但只有中文、`small` 模型对口音/噪声会错字。年龄门为一次性自我声明（非身份证校验）。
8. **测试与评测**：110 文件 / 1316 用例；覆盖率基线行 59.21%（CI 阈值守护）；可复现评测有 4 套——记忆 40 条金标（`npm run eval:memory`）、锚点复筛 30 条金标（`npm run eval:anchor`）、跨轮重复 A/B、30 轮真实长跑；**CI 里跑 `npm run eval:offline` 真卡指标阈值**（facts≥95% / recall@8≥90% / 合并≥95% / anti-forget PASS）。真实 QQ/NapCat 端到端（私有图片 URL、风控、网络抖动）仍需真机验证。
9. **人设字段消费不足**：创作者写的底线、软肋、人生目标等字段有一部分不进入 Prompt（审计 2.3）。
10. **成本统计仍是估算**：主对话与旁路 LLM 都已记账（按 `kind` 拆分）；但峰谷价按「工作日/周末」近似（节假日白天可能按高峰计费、偏高），provider 不返回 usage 的调用不记录（不估算）。
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
- **记忆不是存文本**：每条对话写入 T2 并生成本地 768 维向量，检索时向量 + FTS5 BM25 融合排序（再叠加衰减强度、情绪权重、相对时间标签）；重要事件额外进锚点层（不衰减）。
- **双管线说明**：QQ 私聊使用流式管线 `processMessageStream`，CLI/群聊使用完整管线 `processMessage`；M0 已让两者共用消息门上下文（`buildGateContext`），记忆写入与演化步骤的统一在 M1 继续。

### 设计上支撑「她像一个人」的机制

| 机制 | 实现位置 | 现状 |
|---|---|---|
| 六层人设（硬规则/身份/说话/情绪/关系/世界） | `src/persona/` | ✅ schema 与 Prompt 装配；部分字段未消费 |
| L1 弹性规则裁决（resistance / immutable / 三阶段） | `src/persona/prompt-builder.ts` | 🚧 只在非流式路径生效；突破主要影响内部状态 |
| 消息门 + 破例 | `src/impulse/` | 🚧 基础可用，延迟回复已落库+补发 |
| T2 情节记忆 + 衰减 | `src/data/` | ✅ 存储/衰减可用；本地向量 + FTS5 混合检索 |
| 主动生活流（心跳触发） | `src/pipeline/orchestrator.ts` | ✅ 四条链路 + 每日由头计划 + 按回复率校准频率 |
| 基线漂移 / 因果链 / 自我叙事 / 内心独白 | `src/evolution/` | 🚧/✅ 已接主路径并持久化；反思循环（觉察→否认→承认→整合）可用 |
| 外部感知（天气/时间/热点） | `src/world/` | 🚧 天气与时间可用；热点是硬编码话题池 |

---

## 命令行

| 命令 | 作用 |
|---|---|
| `npm run doctor` | 环境体检（推荐第一步） |
| `npm run dev` | CLI 对话模式 |
| `npm run qq` | QQ 桥接模式（NapCatQQ / OneBot 11） |
| `npm run qq:watch -- --duration 1800` | 只读观察真实 QQ 长跑（回合/延迟/成本/事实；结束写 `data/realrun-*.md`） |
| `npm run setup` | 交互式配置向导 |
| `npm run typecheck` | TypeScript 类型检查（0 错误） |
| `npm run lint` | 未使用导入/变量/参数检查（tsc noUnusedLocals/noUnusedParameters） |
| `npm run test:coverage` | 单元测试 + 覆盖率基线（v8，阈值见 vitest.config.ts） |
| `npm test` | 运行单元测试（vitest） |
| `npm run eval:offline` | 离线评测守门：记忆 40 条 + 锚点 30 条，卡阈值（CI 同款，不联网、不花钱） |
| `npm run eval:memory` | 记忆金标评测（`--offline` 离线 / `--live` 真实模型） |
| `npm run eval:anchor` | 锚点复筛评测（默认真实模型，约 ¥0.003） |
| `npm run eval:live` | 两套评测都跑真实模型（约 ¥0.02，手动） |
| `npm run initiative:sim` | 主动消息决策时序离线模拟（零成本，断言产品红线，CI 跑） |
| `npm run build` | 编译到 `dist/`（`npm start` 启动的是微信桩入口，不是主入口） |
| `npm run persona:list` | 列出可用人设 |
| `npm run persona:check <id>` | 校验指定人设 |
| `npm run persona:create` | 脚手架创建人设 |
| `npm run persona:narrate` | 叙事式创建人设（正则推导，非 LLM） |
| `npm run wechat` | 微信桥接（🗺 仅 echo 桩，不可用） |
| `node scripts/mock-onebot.mjs` | 无 QQ 联调：模拟 NapCat 反向 WS 客户端（需先启动 `npm run qq`） |
| `npm run persona:pack:validate/install/list` | 人设包校验 / 安装 / 列表（v2 格式） |
| `npm run embed:start` | 启动本地向量服务（Qwen3-Embedding-0.6B，127.0.0.1:18083） |
| `npm run embed:spike` | 向量检索离线对比（ngram vs 本地向量） |
| `npm run models:status/list/purge` | 查看/列出/清理本地模型占用（默认放 `~/Library/Application Support/karen/models`） |
| `npm run asr:start` | 启动本机语音识别服务（faster-whisper，1–1.5s/条） |
| `npm run asr:smoke` | ASR 真实链路冒烟（SILK→WAV→识别 往返） |
| `npm run asr:robustness` | ASR 鲁棒性压测（语速/口音/噪声 → 字错率） |
| `npm run indextts:start` | 启动本机 IndexTTS-2.5 服务（18088；模型/venv 在仓库外，见 docs/INDEXTTS2.md） |
| `npm run indextts:smoke` | IndexTTS 链路冒烟（健康/直接合成/产品 SILK） |
| `npm run image:start` | 启动本机生图服务（本地模型目录，热态约 2.6s/张，2026-10-22 复验） |
| `npm run image:smoke` | 生图真实链路冒烟（真出图/可复现/落盘/产品路径） |
| `npm run media:status` | 本机媒体环境状态（开关、目录占用、模型是否就绪） |
| `npm run media:pull-model` | 下载生图模型（≈5GB，需网络稳定） |
| `npm run media:start` | 启动 diffusers 生图服务（127.0.0.1:18084） |
| `npm run media:purge -- --images --yes` | 清空生成图（另有 `--models` / `--all`） |

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

版本历史见 [CHANGELOG.md](CHANGELOG.md)；发布检查与 Release Note 见 [docs/RELEASE_PREP.md](docs/RELEASE_PREP.md)。

> 个人自用默认关闭聊天里的 AI 披露（`ai_disclosure: false`）；如果公开给朋友/发布，请在 `config.yaml` 显式打开。

---

## License

[MIT](LICENSE) © 2026 QIU0826
