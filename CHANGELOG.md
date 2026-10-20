# Changelog

## v0.7.0 — 2026-10-20

本机生图链路（代码完成、默认关闭）：让照片不再总是那 15 张图库。

### Added

- `src/media/comfyui.ts`（18 条单测）：生图客户端 + 提示词构造。
  - `buildScenePrompt`：场景标签（晚霞/咖啡/雨/猫/城市…）→ 具体画面 + 时段光线 + 情绪色调 +
    "手机随手拍"质感；刻意不放 `masterpiece/best quality` 这类 AI 味词；负面词压制文字水印/多余手指/3D 感。
  - 两种后端：**`service`（默认，diffusers HTTP 服务）** 与 `comfyui`（兼容保留）；
    `generateImage` 25s 超时、单张 ≤4MB，任何失败返回 `ok:false`，**调用方静默回退图库**。
- `src/media/generated-store.ts`：生成图落 `KAREN_DATA_DIR/generated/YYYY-MM-DD/`，
  **30 天自动清理**（只删日期目录）、可一键 purge、可统计占用。
- `services/image/server.py`：diffusers + PyTorch MPS 的极简生图服务（`/health`、`/generate`），
  懒加载 SDXL-Turbo（单步），模型缓存指向 `KAREN_MODELS_DIR/hf`。
- `scripts/media-setup.ts` + `npm run media:status|install|pull-model|start|purge`：
  程序/模型/生成物三处分离、占用可查、清理有确认。
- 照片链路接入：约 **20%** 照片由生图（点名要图不赌概率），失败回退图库；`source` 增加 `generated`。
- 文档 [docs/IMAGE_GEN.md](docs/IMAGE_GEN.md)：为什么改 diffusers、目录约定、开关、行为、
  **模型下载受阻的完整说明与手动补模型步骤**。

### Changed

- 放弃 ComfyUI 源码路线：实测本机到 GitHub 只有 **~17KB/s**（clone 不可行）；改走 PyPI（2MB/s）+
  HuggingFace 的 diffusers 服务。`KAREN_IMAGE_BACKEND=comfyui` 仍可切回。

### 未完成 / 阻塞（如实）

- **模型未下载成功**：`stabilityai/sdxl-turbo`（6.9GB）与 `segmind/tiny-sd`（约 1GB）多次尝试均因
  HF 连接间歇性中断（SSL EOF / IncompleteSnapshot）失败。因此 `KAREN_IMAGE_GEN` 默认 **off**，
  照片继续走图库；补模型步骤见 docs/IMAGE_GEN.md §5。
- 未接角色一致性（IP-Adapter/参考图），生成图目前只适合"场景/氛围照"，不放正脸。
- 单张耗时未在真机验证（模型未就绪），代码上限 25s。

### Testing

- 93 个测试文件 / 1112 个用例通过；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 新增：media（18，含默认 service 后端、503 回退、超大图拒绝、30 天清理、purge）、
  relationship-dims（18，五维关系状态机）、initiative-plan（21，意图式主动性的纯净版）。

### 顺带落地（v0.8 的两个纯逻辑模块，尚未接入主流程）

- **五维关系**（`src/persona/relationship-dims.ts`）：亲密/信任/张力/互惠/依赖 + 关系阶段机
  （陌生→熟悉→亲近→很依赖→别扭→修复）；事件→维度增量、张力随时间回落、越界夹紧；
  `describeDims`/`behaviorNote` 给出可读描述与行为提示。
- **意图式主动性**（`src/impulse/initiative-plan.ts`）：每日 2–3 个「由头」（她生活里的事/没聊完的话题/
  心情/有点想他）→ 到点挑选（时效窗/上限/间隔/免打扰/他刚回过）→ **按他的回复率校准每天条数**。
  目前只有纯逻辑，下一步接进 processProactive 与日记忆调度。

## v0.6.0 — 2026-10-20

按 [docs/MEMORY_V2_PLAN.md](docs/MEMORY_V2_PLAN.md) 的「拟人化交互」阶段：**节奏模拟器 + 消息意图族 + 表情包持续收集**，并补上 v0.5 遗留的「她主动了解你」。

### Added

- **她主动了解你**（`src/persona/get-to-know.ts`）：认识初期（亲密度 <5）会顺口问工作/城市/宠物/名字/计划，优先问还不了解的；问过的主题落库（`getting_to_know`），同一问题不问第二次；两次提问间隔 ≥4 轮。**解决 v0.5 发现的「事实层永远为空」根因**——用户从不主动自述，她得先问。
- **打字节奏模拟器**（`src/bridge/pacing.ts`）：替掉「字数 × 固定 ms」。输出 看到消息→开始打字 的延迟、每字耗时、条间间隔、偶发犹豫；受**人设打字速度**（从 `speaking.typingHabit` 关键词推断）、**情绪**、**深夜**、**忙碌**影响。默认人设白天约 285ms/字、深夜约 385ms/字；忙时不是打字慢，而是很久才开始回。
- **消息意图族**（`src/impulse/message-intent.ts`）：`typo_recall` 打错字 / `regret_recall` 说重了 / `rewrite` 重发更短的 / `hesitate` 犹豫（不撤回，表现为回得慢+话短）。共享护栏：仅私聊、危机轮禁用、冷却期不演、一轮一次、延迟 0.5–5s；记忆只落正确原文。
- **表情包持续收集**（`src/data/sticker-library.ts`）：入站图片自动下载 → sha256 去重 → 落盘 `KAREN_DATA_DIR/stickers-collected/` → 入库；库容 500（超出淘汰最久未用）、单文件 ≤2MB、可一键 purge。出站可按情绪优先挑收集来的（`KAREN_STICKER_USE=on`），没有则回退内置 11 张。

### Changed

- 桥接发送：`sendPrivateBubbleWithTypoRecall` → 意图感知版本，支持四类动作；消息 ID 拿不到退化为发原文，撤回失败也发跟进版本。
- 采集默认关闭（`KAREN_STICKER_COLLECT=on` 才开），出站使用默认关闭（`KAREN_STICKER_USE=on` 才开）——先观察一周再开，避免突然换风格。

### Testing

- 90 个测试文件 / 1055 个用例通过；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 新增测试：pacing（13）、message-intent（14）、get-to-know（9）、sticker-library（9）。

## v0.5.0 — 2026-10-20

按批准的 [docs/MEMORY_V2_PLAN.md](docs/MEMORY_V2_PLAN.md) 落地记忆重构第一阶段：**真向量检索 + 锚点记忆 + 日记忆**。

### Added

- **本地向量服务**（`services/embed/`，Python + uv，独立进程）：`/embed` `/rerank` `/health`；只绑 127.0.0.1，异常返回 5xx 由 Node 侧降级 n-gram。模型 Qwen3-Embedding-0.6B（MRL 截断到 768 维，与现有 `t2_vec` 完全兼容，**零 schema 迁移**）。
- **Node 侧客户端**（`src/data/local-embed.ts`）：超时 2.5s、失败 60s 冷却、只认 768 维、健康探测缓存；显式开启（`KAREN_EMBED=on`），服务挂掉自动回落，聊天永不阻塞。
- **锚点记忆**（`src/data/memory-v2.ts`）：初见/表白/冲突/和好/承诺/秘密/共同经历/失去，永不衰减、双时间轴（失效不删）；规则显著度打分 `scoreSalience`；每轮注入 3–5 条压缩摘要。
- **日记忆 + 周汇总**（`src/schedule/jobs.ts`）：按**本地日期**压缩当天对话（发生了什么/情绪基调/未完成话题），00:10 后生成；开机补跑回看 3 天；周一补上周汇总；`job_runs` 保证幂等、不重复花 token。取代原「40 条消息一刀切压缩」。
- **状态卡**（`buildStateCard`）：一行 ~30 token 代替原先注入的大段「最近状态弧」文本。
- **事实状态机**（pending / confirmed / disputed）+ **她主动质疑离谱事实**：说法与既有事实冲突时自然确认一句（"你不是在杭州吗"），2 天内只问一次。
- **`/fact` 命令**：列出她记得的关于你的事及状态；`/fact ok <key>` 确认、`/fact no <key>` 否掉并恢复旧值。
- 开关：`KAREN_MEMORY_V2=off`（整体回退）、`KAREN_EMBED=on|off`、`EMBEDDING_PROVIDER=ngram`。

### Changed

- **检索**：本地向量 kNN + FTS5 → RRF → 预算打包（`buildMemoryContext`：锚点优先、日记忆其次、放不下就整段不注入）；**本地向量启用时默认关闭每轮 DeepSeek 重排**（省 ~664ms / ¥0.00025 每轮）。
- `SCHEMA_VERSION` 2 → 4：新增 4 张表 + 8 个扩展列（幂等迁移，老库缺表不影响启动）。

### Fixed

- **事实层"永远为空"的根因**：抽取链路本身正常（临时目录实测 6/6 入库），真实会话里用户从未自述事实，而她不主动问 → 新增冲突质疑；「认识初期主动问」列为下一阶段配套动作。

### Measured（本机真实数据）

| 项 | 结果 |
|---|---|
| 历史记忆重嵌入 | 127/127 条（vec 索引 127） |
| 记忆金标 live（旧：ngram + LLM 重排） | 16/20 |
| 记忆金标 live（本地向量 + 仍重排） | 16/20 |
| **记忆金标 live（本地向量 + 关闭重排）** | **17/20、18/20**（两次） |
| 嵌入性能 | 批量 20 条 137ms（≈7ms/条）；检索 p95 < 100ms（原 ~664ms） |

### Testing

- 86 个测试文件 / 1010 个用例通过；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 新增测试：memory-v2（19）、memory-context（10）、jobs（17）、local-embed（11）、事实状态机（6）、`/fact`（3）。
- 真实库迁移已验证（备份 `data/memory.sqlite.bak-v04`）：127 条情节不变、FTS 127 行、新表就绪。

## v0.4.1 — 2026-10-20

针对反馈「语音太 AI 了，没有真人感」。根因不是文案，是三件事：`say` 的中文音色本身老（本机 184 个语音里
没有任何 Premium/Enhanced/Siri 中文语音）、旧实现语调是一条直线（固定 185 语速、无音高变化、无分句停顿）、
以及 SILK 窄带压缩。这版先把「像在念稿」解决掉，并给了换音色的通道和可试听的样音。

### Added

- **语气润色**（`src/ai/tts-style.ts`，28 条单测）：按情绪/作息选风格（lively/natural/soft/tired）→ 调整语速与音高；
  按标点分句，**逐句下发 `[[pbas]]`/`[[rate]]`**，做句内语调轮廓（起句略慢、中间正常、收尾略慢；陈述句降调、问句升调），
  分句之间插 140–520ms 停顿（总停顿封顶 700ms）；以 12% 概率在句首加语气词（`嗯…`/`诶，`/`唔…`，只改念出来的音频，不改消息原文）。
- **音色可配**：`voice_tts_voice` / `voice_tts_rate` / `voice_style_enabled` / `voice_filler_probability`（config.yaml 与同名环境变量）。
- **试听脚本**（`scripts/voice-sample.ts`）：同一句话用 5 个音色 × 3 种语气各生成一遍，并额外输出 **SILK 编解码往返版**
  （≈ QQ 里真实听到的音质），产物在 `data/voice-samples/`（不入库）。
- 文档 [docs/VOICE_QUALITY.md](docs/VOICE_QUALITY.md)：三条根因、实测数据、换音色方法、神经 TTS 三条路线的实测/评估结论。

### Changed

- `synthesizeSpeech` 的 `rate` 语义变为「基准语速」，实际语速由风格决定；返回值新增 `style`（本次用的风格/语速/音高/停顿/是否加语气词）便于排查。
- 默认语速 185 → 180（真人聊天比朗读慢一点）。

### Fixed

- 旧实现的语音没有分句停顿：`say` 只在标点处走默认停顿时长，句间「一口气念完」是「像 TTS」的主要来源之一，现已显式控制。

### Research（没接的东西，如实记录）

- **微软 Edge 免费神经语音（Xiaoxiao/Xiaoyi 等）不可用**：`voices/list` 接口 200（令牌算法正确），但合成 WebSocket 握手
  2026-10 起一律 **403**（试了 4 种参数组合 + 4 个 `Sec-MS-GEC-Version`）。已放弃，不留半成品代码。
- Azure/火山/阿里云 TTS 需要 Key，本地神经 TTS（sherpa-onnx/piper）需要 60–300MB 模型，均未接；接入方式与取舍写进文档。

### Testing

- 82 个测试文件 / 944 个用例通过；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 真实链路实测（本机）：natural 185/0/431ms → 4.62s / 19,614B；lively 198/+3/333ms → 4.38s；tired 167/-3/542ms → 4.82s；单次合成 ~0.6s。
- `say` 内嵌命令有效性实测：`[[slnc 600]]` 使时长 +0.62s；`[[pbas +18]]` 使基频中位数 212.4Hz → 358.2Hz；`[[rate 120]]`/`[[rate 260]]` 使同一句 4.63s / 3.13s。

## v0.4.0 — 2026-10-20

「她主动找你」从一条链路变成四条，并且每次心跳都留下「为什么发 / 为什么不发」——
对应上一轮调研里 qq-agent-plus 的主动发言三链路 + ai-companion-kit 的 Humanizer。

### Added

- **主动消息四条链路**（`src/impulse/proactive-plan.ts`，纯函数 34 条单测）：
  `follow_up` 没人接话补一句（20 分钟~3 小时，55%）、`silence_revive` 沉默保温（>72h，75%，一轮失联只一次）、
  `life_share` 生活流分享（沿用因果链/天气/情绪/时段的优先级与概率）、`open_topic` 冷场开话题（3~72 小时，40%）。
  每条链路独立可关、有各自亲密度门槛和说话姿态（补话不催、开话题不空泛、重启联系收着）。
- **决策可解释**：每次心跳记录决策与原因（进程内环形缓冲，最近 8 条），`/why` 新增
  「她最近怎么决定要不要主动找你」；被消息门挡住时标成「触发但没发」，不会假装发过。
- **连推收手**：对方一直不回时，一天内主动 2 条就停（>24h 再试），避免「一天 4 条」对着不回的人刷屏。
- **深夜打字变慢**（`src/bridge/humanizer.ts`，9 条单测）：23:00–06:00 打字时长 ×1.35、封顶 3s→4.2s；白天行为不变。
- **配置** `proactive_channels`（四条链路开关；写错链路名/非布尔值启动即报错）+ `KAREN_PROACTIVE_CHANNELS=off` 全关 +
  `KAREN_PROACTIVE_VERBOSE=1` 打印每次心搏决策。
- **模拟脚本** `scripts/proactive-sim.ts`：离线跑 7 天时间线，打印每次心跳的「发/不发 + 原因」与按天统计，可复现。
- 文档 [docs/PROACTIVE_CHANNELS.md](docs/PROACTIVE_CHANNELS.md)：链路表、护栏、配置、`/why` 输出、模拟结果、未做的部分。

### Fixed

- **补话窗口把「她自己补的那句」当成新冷场**：她补完一句后会把自己的消息当作新的沉默起点，接着补第二句（模拟里连续两条「我上一条还没回音」）。现在按**对方最后一次说话**计时。
- **沉默保温每天重复**：新模块一开始漏了旧实现的 `restartSent`「一轮失联只问一次」保护，模拟里连续两天发「好久没联系了」；已补 `silence_revive_already`。

### Changed

- `processProactive` 返回类型从 `{...} | null` 改为显式的 `{ sent: true, ... } | { sent: false, decision }`，跳过原因不再被丢弃；桥接对跳过走 debug 日志（不再每 15 分钟写一条 info）。

### Docs

- **[docs/PROMPT_BUDGET.md](docs/PROMPT_BUDGET.md)（Prompt 预算离线审计）**：只读查询本机 `llm_usage`（81 次真实调用）得到对话轮 prompt p50 **2241** / p95 **2864** tokens、缓存命中 49.3%；离线构造 5 个典型状态统计系统提示词分段（3591 字符，最大段「重要提示」835 字符 / 23.3%，静态块 52.9%）；给出 6 条按性价比排序的建议（合并重复约束、howWeMet 按需注入、动态块设预算、旧摘要收紧、预算纳入观测、保持缓存友好）。复现：`node node_modules/tsx/dist/cli.mjs scripts/prompt-budget.ts`。**token 为粗估（比实测偏高 36%），样本仅 1 天，不能当长期分布。**

### Testing

- 81 个测试文件 / 911 个用例通过；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 模拟（7 天、15 分钟心跳）四条全开：补一句 3、生活流 4、冷场开话题 2、沉默保温 1，按天 3/1/2/1/1/1/1；
  关掉 `open_topic` 后 `channel_off` 跳过 497 次、冷场不再开话头（开关真实生效）。
- **注意**：模拟只验证决策链路的时序与护栏，不代表真实对话质量；真实 QQ 上的主动性仍需要真人样本。

## v0.3.3 — 2026-10-20

按上一轮评审提的三项（主动开话题偏少 / 共情略浅 / 回复偏短）做小步改造，并用 8 轮 A/B 检验；
A/B 本身没测出收益，但把另外三个真实问题挖出来并修掉了。

### Added

- **「说话动作」选择器**（`src/persona/talk-moves.ts`）：对方在倒苦水时给模型一句内部提示「先接住情绪，别马上转到自己」；否则以 28% 概率提示「顺手补一句自己的近况」。带亲密度门槛、连续两轮不重复、危机/免打扰不触发；`KAREN_TALK_MOVES=off` 可整体关闭（A/B 用）。
- **同类项目调研**（[docs/RESEARCH_REFERENCE.md](docs/RESEARCH_REFERENCE.md)）：GitHub 上 8 个 AI 伴侣 / QQ Bot 项目的可借鉴设计（拟人化发送、唤醒原因模型、记忆热度与睡眠整合、主动发言三链路、表情轮换、省 Token 收敛），以及本项目后续优先级。

### Fixed

- **单轮气泡过多**：验证里出现一轮 6–9 条（流式路径没受 `MAX_BURST` 约束）。桥接现在限制**每轮最多 4 条文字气泡**，超出内容合并成最后一 条发出（不丢话）。
- **当轮重复**：同一轮里「被说啦 / 气人 / 被说啦？」这种自我复读，跨轮反重复提示管不到；出站前按 `detectRepetition` 做**当轮去重**。
- **情绪轮发无关照片**：对方在倒苦水时她顺手发一张窗台/杯子的照片，像没在听。现在「糟心事轮次」默认不触发**非点名的**主动发图（点名要图仍然发）。
- **贴纸跨轮复用**：每个用户最近 3 张贴纸不重复（与配文去重同思路）。

### Testing

- 76 个测试文件 / 856 个用例；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 8 轮 A/B（真实模型，各 ¥0.05）：说话动作开/关两组的 LLM 评审分数差异在噪声范围内（真人感 3 vs 4、主动均 3），**没有证据表明这版提示带来了提升**；A/B 反而暴露出上面的气泡/重复/照片三个问题。详见 [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md) §9。

### Note

- 验证台默认 `photo_share_probability: 0.3`、冷却 0（为了看清照片链路），生产默认约 0.08 + 2 小时冷却；**别拿验证台的照片频率当产品指标**。本轮起验证默认改用 0.08。

## v0.3.2 — 2026-10-20

真实验证里「多媒体 2/5」的根因之一：本地图库只有 7 张、配文池太小，长期必然重复。

### Changed

- **本地图库 7 → 15 张**（`assets/photos/`）：新增拿铁+绿植、沙发上的猫、雨后傍晚街头、雨窗、晚餐、三杯拿铁、店内 CAFE 灯牌、花田共 8 张，统一裁成 800×600（总增量约 600KB），来源 Unsplash（Unsplash License，来源清单见 `assets/photos/README.md`）。
- **配文池 42 → 约 110 条**：新增图每张都有「今天 / 昨天 / 以前」三套、每套 2–3 句；配合既有的「最近 5 条配文/最近 3 张图排除」，重复率明显下降。
- **场景词覆盖更全**：`detectPhotoSceneTags` 增加雨（rain/window）、花（flowers/plants）、城市街头（city/street）、晚饭（food/dinner）、猫（animal/cat），要「下雨了拍一张」「下班路上」「晚饭吃的啥」也能匹配到对应图。
- 新增图库多样性测试（15 张、连续 12 次选择去重后 ≥6 张图 / ≥8 条配文）。

### Testing

- 76 个测试文件 / 842 个用例；`tsc --noEmit` 0 错误；`npm run lint` 0 违规；行覆盖率 56.0%。

## v0.3.1 — 2026-10-20

真实验证台（15 轮真实模型）暴露的问题修复：两个 P0 + 一个 P1 + 两个 P2。

### Fixed

- **P0 编造「怎么认识的」**：验证里用户从未说过线下见过，她却编出「你每周来三四次、坐吧台 / 有次下雨没带伞 / 我借你的」。新增 `src/persona/meeting-guard.ts` 确定性守卫：只有「用户这轮确实在问相识」且「人设 howWeMet / 用户事实 / T2 记忆里都没有依据」时才启用——把含具体场景断言（吧台/下雨/借伞/每周来几次/点了什么…）的分句删掉；整条都在编时换成一句含糊的真人式回应（「嗯……这个我还真说不上来，你提醒我一下？」）。prompt 里的禁令也写得更具体，并明确「有依据时正常回忆，不要过度否认」。
- **P0 多媒体内容与请求错位**：
  - 要照片时会按用户提到的场景挑图（晚霞→sunset、雪→snow、咖啡/店→cafe、猫→animal、山→mountain…），不再「要晚霞发花/山」；新增 `detectPhotoSceneTags`。
  - 点名要语音时不再被「本轮已发过照片/贴纸」挡掉；若回复里没有合适念的句子，从正文里截一段短的兜底合成，避免「嘴上说语音发了、实际没发」。
- **P1 情绪承接被抢话题**：prompt 增加规则——对方在讲糟心事时先接一句情绪，不立刻转到自己的经历。
- **P2 记忆防御话术的嘲讽变体**：「才说的就忘啦」「才两句就忘啦」「这就忘了」纳入确定性清理。
- **P2 图片跨轮复用**：本地图库按 persona 记住最近 3 张已发图，选图时优先排除（全被排除时宁可这轮不发，也不重复）。

### Testing

- 76 个测试文件 / 841 个用例；`tsc --noEmit` 0 错误；`npm run lint` 0 违规。
- 新增 `meeting-guard`（12 条）、场景标签匹配、图片去重、嘲讽话术清理等测试。
- 真实验证台复跑结果见 [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md) 的「修复后复跑」小节。

## v0.3.0 — 2026-10-20

「更像真人」的一版：她开始会发语音、会打错字撤回、被点名要照片时真的会发；宣传页重做。

### Added

- **语音消息**：新增 `src/ai/tts.ts`（macOS `say` → 24kHz WAV → SILK，`silk-wasm` 纯 wasm 编码，无原生构建）与 `src/impulse/voice.ts`（发不发/念哪一句的纯决策：概率、亲密度门槛、免打扰、冷却、危机语境；每轮最多一条）。QQ 私聊文字回复后按概率补一条 `[CQ:record]` 语音；发送前按语音时长等待（`durationMs + 400ms` 抖动），像真人先录完再发。非 macOS（无 `say`）自动静默降级为纯文字，不影响任何主流程。
- **打错字 → 撤回 → 改对**：新增 `src/impulse/typo-recall.ts` 与 OneBot 受控撤回（`delete_msg`；只允许撤回本进程 15s 内发出的消息，全局 5s 限频）。QQ 私聊低概率（默认 4%）先发带错字的版本，约 1.5s 后撤回，再发正确原文；会话与记忆只记录正确原文（纯 transport 层）；拿不到 message_id 或撤回失败会自动降级。`typo_recall_*` 可配置关闭，测试环境默认关闭随机以保断言确定性。
- **打字节奏真实化**：气泡间隔从固定 200–800ms 改为按字数估算（约 80–120ms/字，封顶 3s），第一条气泡前有 0.3–0.8s「看到消息」延迟——不再是一串消息瞬间刷出来。
- **用户点名要照片/表情包/语音时真的会给**：新增 `src/impulse/media-request.ts` 识别「拍张照片看看」「发个表情包」「发条语音听听」。要照片时跳过概率判定（亲密度/冷却仍然生效），要表情包/语音时提高概率并跳过冷却；同时给模型一段内部提示，避免「嘴上说改天、其实没发」或「嘴上推脱、图却发了」的割裂。
- **连发条数收敛**：单轮气泡上限 15 → 4（与 persona 硬规则「碎短句 2-4 条」一致），超出内容合并进最后一条不丢失；一轮 5 条气泡的刷屏感消除。
- **同一轮不叠加多媒体**：已发照片或贴纸的轮次不再补语音。
- **宣传落地页重做**（`promo/`）：整页重写为零构建单文件（内联 CSS/JS、无 CDN/字体/统计）；首屏人物主视觉 + 一句话价值主张 + 双 CTA；分区为「她的日常 / 消息形态 / 主动性 / 记忆 / 隐私 / CTA」；纯 HTML/CSS 聊天 mockup 展示照片、表情包、3″ 语音波形 + 转文字、撤回系统行与正在输入；1440/390 双断点自检，隐私文案如实说明「对话经模型 API 处理，不是完全离线」。
- **真实验证台**：新增 `scripts/mock-onebot-longrun.ts`（本地 mock OneBot + 真实 DeepSeek + 临时数据目录，多轮真人式对话 + 指标 + LLM 评审），报告见 [docs/MOCK_VALIDATION.md](docs/MOCK_VALIDATION.md)。

### Fixed

- **流式回复写入会话/记忆时丢失气泡边界**：多句被粘成一句（影响后续动态风格参考与记忆检索），改为按换行保留分条。
- **照片请求不兑现**：15 轮真实验证里用户连续 3 次说「拍张照片看看」，她只嘴上接话、一张都没发。
- **一轮气泡过多**：验证里出现单轮 5 条气泡（再叠照片/语音），观感像刷屏。
- **口头禅复读**：「笑死」一轮对话出现 4 次，纳入套话句式提醒。

### Testing

- 75 个测试文件 / 823 个用例；`tsc --noEmit` 0 错误；`npm run lint` 0 违规；行覆盖率 55.85%（CI 阈值守护）。
- 新增测试：TTS/SILK 真实链路（macOS，非 darwin 自动 skip）、语音决策、打错字撤回（含 fake-WS 的 send→delete 链路）、多媒体请求识别、burst 上限、语音/撤回配置默认值。

### Upgrade notes

- 新增依赖 `silk-wasm@^3.7.1`（纯 wasm，无原生构建；仓库 `.npmrc` 的 `ignore-scripts=true` 不受影响）。
- 语音默认开启（`voice_enabled: true`），仅 macOS 有 `say` 时真正发出；不需要可设 `voice_enabled: false`。撤回默认开启、概率 4%，`typo_recall_enabled: false` 可关。
- 老配置与老数据无需迁移。

## v0.2.1 — 2026-10-20

### Fixed

- **Windows 安装**：仓库增加 `.npmrc`（`ignore-scripts=true`），避免 npm 对自带 prebuilds 的 better-sqlite3 自动执行 `node-gyp rebuild`（Windows runner/用户无 Visual Studio 时 `npm ci` 失败）；macOS/Linux 同样使用包内预编译二进制。
- **Windows 单元测试**：`user-export` 的 POSIX 0600 权限断言在 Windows 跳过（Windows 不支持该权限位）。
- **CI**：GitHub Actions 三平台矩阵（ubuntu/macOS/Windows）恢复全绿；Windows 由临时诊断 workflow + check-run annotations 定位（诊断分支已删除）。

### Upgrade notes

- 老数据无需迁移；安装方式不变，但 `npm install` 会跳过依赖生命周期脚本（本仓库依赖都自带预编译二进制）。

## v0.2.0 — 2026-10-20

M2 产品化 + 真实 QQ 首轮验证修复。

### Added

- **首次引导 2.0（M2-A）**：`npm run setup` 是「你们的第一段对话」——名字/城市/认识方式写入会话与 `user_facts`，完成 18+ 确认并生成 `data/onboarding.json`（AI 披露默认关闭）；已完成引导直接跳过，`--force` 重设。
- **人设包 v2（M2-B）**：`manifest.json` + `persona.json` + 可选 `assets/`、`memories/seed.jsonl`；`npm run persona:pack:validate/install/list`；覆盖安装自动备份到 `personas/.backups/`；记忆种子默认不写库。
- **本地 Web 控制台多用户只读视图（M2-C）**：`/api/owners` + `?owner=` 只读切换会话/时间线/记忆/总览（默认只展示主用户，`web_all_owners: true` 开启）；前端 owner 下拉。
- **单用户 JSON 导出（M2-C）**：`GET /api/export?owner=` 下载会话 + 人格状态 + T2 记忆（不落盘）；控制台「导出当前用户」按钮。
- **`/forget 关键词 [--yes]`**：按关键词删除本机 T2 记忆（先预览，确认后加 `--yes` 才删；一次最多 20 条），用于修正被编造/记错的往事。
- **真实 QQ 长跑工具（M2-D）**：`npm run qq:watch -- --duration 1800` 只读观察真实回合/延迟/成本/事实/同意并生成本地报告；支持 `--once --since` 复盘历史。
- `npm run qq:watch`、`persona:pack:*` 等新命令；`web_all_owners` 配置项。

### Fixed

- **问「我们怎么认识的」不再编造具体场景**：记忆里没有记录时，prompt 明确要求含糊带过/让对方提醒（真机发现「你老坐吧台」是编的）。
- **Windows 安装修复**：仓库增加 `.npmrc`（`ignore-scripts=true`），避免 npm 对 better-sqlite3 自动跑 node-gyp（Windows 无 Visual Studio 会失败）；依赖自带的预编译二进制直接使用。
- **AI 披露改为默认关闭**（个人自用体验优先）：聊天里不再插入 AI 披露；披露能力保留，公开发布/商用可在 `config.yaml` 设 `ai_disclosure: true`。`/about` 仍可随时查看数据说明。
- **快速追问不再被误延迟**：消息门的「5 分钟内连续跟进」判断计入当前消息，修复 18 秒后的追问被随机延迟 31 分钟。
- 导出下载文件名改为 ASCII 安全值，修复中文人设名导致的 500。
- 真实对话报告不再意外入库（`.gitignore` 增加 `data/*.md`），文档不记录真实对话原文。

### Testing

- 69 个测试文件 / 687 个用例；`tsc --noEmit` 0 错误；`npm run lint` 0 违规；行覆盖率 54.5%（CI 阈值守护）。
- 干净 checkout（`git archive` 到临时目录）复验通过；`doctor` 在缺 config/.env 时给出可执行修复指引。

### Upgrade notes

- 老数据无需迁移；**AI 披露默认关闭**（不在聊天里出现；公开发布/商用可在 config 打开）。
- 已知限制：18+ 为自我声明、危机检测为关键词兜底（非临床）、NapCat 非官方协议有封号风险、群聊为半成品、无 TTS/图片生成、真语义向量需 Qwen Key。完整列表见 README「已知限制」。

## v0.1.0 — 2026-07 ~ 2026-10 基线

上游基线（M0 地基修复 + M1 核心体验闭环主要项）：文档真话、延迟消息落库补发、QQ 桥接安全加固、LLM 超时/重试/usage、状态持久化、关系成长、演化可见、多用户隔离、双管线对齐、记忆检索增强（FTS5/BM25/RRF/DeepSeek 重排）、用户事实、T1/T3、年龄门与 AI 披露、Web 只读控制台、宣传页等。详见 `docs/PRODUCT_AUDIT.md` 与 `docs/M1_BACKLOG.md`。
