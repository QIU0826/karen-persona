# qq-bridge 深读：人设 / 情绪 / 真人感 / 记忆 / 语音 / 图片

> 调研对象：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，HEAD `a56164e`（v0.2.0-r4，2026-10-18），
> 抓取时 1,637 stars / 66 forks，JavaScript，148 个跟踪文件，`src/bridge.js` 11,775 行。
> 调研方式：浅克隆到 `/tmp/qq-bridge` **只读**读代码/文档，未运行它的服务、未拷贝任何代码。
> 本文所有 `file:line` 均指 qq-bridge；KAREN 的路径指本仓库。
> 结论只代表**代码与提示词层面**，不等于运行效果；它自己的 README 也把若干能力标为实验/限制。

## 0. 结论先行

1. **它不是「另一个 KAREN」，而是「把 QQ 接进 DeepSeek Harness agent 的桥 + 群聊仿真状态机」**。
   人设是两层提示词，情绪没有状态机，记忆是 agent 用工具写的每会话 JSON 工作区，
   语音是预录音频库（**没有入站 ASR**），图片是安全下载 + 真多模态。
   它的「能力感」很大一部分来自 agent 工具循环，不能直接搬进 KAREN 的规则+概率管线。

2. **真正稀缺的是四件工程/产品设计**（值得学）：
   ① **工作记忆**（进行中的话题 / 想说未说的话 / 对人的印象，带 TTL 与注入格式）；
   ② **发送落地校验**（发完 `get_msg` 回读 record/image 段，`verified` 才算真发了）；
   ③ **媒体安全收口**（SSRF、DNS 全量校验、8MB/64MP/5 张、逐跳重定向、失败分级）；
   ④ **群聊行为协议**（等待、潜水、已读水位、参与度提示、沉睡前观察、发问后回查倍率）。

3. **它明显不如 KAREN 的地方**：没有情绪/关系状态机（全仓搜不到 mood/emotion/affection 字段），
   没有长期记忆检索（T2/锚点/向量/用户事实），没有入站语音识别，语音不能现生成，
   群聊外的人类感靠提示词而不是状态。**不要为了学它而把我们的强项降级。**

4. 若只学三件事，建议：**工作记忆 → 发送落地校验 → 入站媒体安全/完整**。

## 1. 它是什么（先看架构，避免误判）

```
QQ ──► SnowLuma(OneBot v11) ──► qq-bridge 进程 ──► DSH Web API 会话
                                      ▲                    │
                                      └── agent 回复/工具调用 ┘
```

- QQ 侧用 OneBot v11；DSH 侧是 DeepSeek Harness 的 agent 会话。
- 「仿真群友」不是桥接自己生成的：桥接把 QQ 消息变成 DSH 用户消息，把群聊状态
  （未读、唤醒配置、工作记忆、黑话）拼成 prompt，再由 agent 通过 MCP 工具
  （`qq_send_message` / `qq_wait_for_messages` / `qq_mark_read` / `qq_memory_append` /
  `qq_send_sticker` / `qq_send_voice` …）自己决定看什么、等多久、发什么。
- 两代模式：`reserved`（一代，空格分条 + `[SILENT]`）与 `reserved2`（二代，一切皆工具）；
  本文主要看二代，因为它是当前主路径。

**关键差异**：KAREN 是「一次模型调用 → 程序决定媒体/节奏」，没有工具循环。
所以它靠提示词约束的行为（比如「不要每条都回」「没备注就先看图」），
在 KAREN 里要么改造成代码状态/后处理，要么只能作为风格提示，可靠性会掉一档。

### 能力对照（只列和本次调研相关的）

| 维度 | qq-bridge | KAREN 现状 | 结论 |
|---|---|---|---|
| 定位 | QQ→DSH 桥 + 群聊仿真 | 独立人设引擎（QQ/NapCat） | 不同物种 |
| 人设 | 仿真提示词 + 角色卡两层，按模式分节 | 六层 persona + prompt-builder | 我们更深；可借「边界」与「先筛后截」 |
| 情绪 | **无状态机**，只有提示词允许表达 | `src/persona/emotion.ts` 向量/基线/唤醒；关系五维/反思 | 我们领先 |
| 真人感 | 极细的行为协议 + 部分硬保证 | 提示词 + 打字节奏/门控/沉默 | 它的「等待/收尾/选择性」更强 |
| 记忆 | 每会话 working memory（3 槽位 + TTL） | T1/T2/锚点/日周记忆/用户事实/向量 | 我们长期记忆更强；缺工作记忆 |
| 语音 | 预录音频库，无 ASR，发送后校验 | TTS（Kokoro/CosyVoice）+ ASR + SILK | 我们强；可借发送校验 |
| 图片 | 真多模态 + 表情库 + SSRF/限流 | 图库/生图 + vision 描述 + 表情收集 | 我们素材强；可借表情语义/媒体安全 |
| 群聊 | 唤醒契约 + 状态机 + 读水位 | 仅 @ 回复 | 若做群聊，它是最佳参考 |

## 2. 人设：两层提示词 + 角色卡，真正值得学的是「边界」

### 它怎么做

- **两层契约**：仿真层 = `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 `persona.prefix`
  （工具协议、分条、潜水、安全规则）；人格层 = `roles/<角色名>.md`（你是谁、语气、雷点）。
  `src/preset-prompt.js:1-9` 写明这个边界；`roles/README.md:11-24` 再强调：
  **人格卡只写人设，不写怎么干活**。人格卡里出现一代工具写法会被兜底过滤
  （`src/role-card.js:106-108`）。
- **按模式分节**：人格卡可用 `〔一代〕/〔二代〕`、`[v1]/[v2]` 标记小节，
  注入前按当前模式筛选并去掉标记（`src/role-card.js:14-37,43-75`）。
- **先筛后截**：默认每条消息最多注入 6000 字符（`bridge.js:286-292`），
  顺序是「先按模式筛节，再截断」（`bridge.js:9267-9271`），控制台会显示各模式实际字符数。
- **角色状态**：`state/current-role.json` 只存 `{role, mode}`（`bridge.js:623-628`），
  群友不能改角色，`/role` 仅 owner 可用（`bridge.js:10575-10583`）。
- **安全不变量**：预设保存时强制保留「无本地工具 / 群友无管理权限 / 不透露令牌 /
  角色由桥接注入 / 不会自动发送」等句子，缺一即拒绝保存（`src/preset-prompt.js:16-64`），
  写回后还会 YAML 重新解析逐字比对（`:129-156`）。

### 对 KAREN 的判断

- **值得**：把「人格卡不要写渠道/工具行为」写成 `personas/*/SKILL.md` 的校验告警，
  而不是靠作者自觉；给 `src/persona/pack.ts` 加「人格包不得包含工具/越权指令」的 warning。
- **值得**：如果以后要分群聊/私聊语气，可借「作用域标记 + 先筛后截」，
  落 `src/persona/loader.ts`（解析）+ `prompt-builder.ts`（按渠道取节）；
  不要照抄一代/二代这种历史包袱。
- **不值得**：全局 `current-role.json` 指针、控制台改提示词、agent 工具协议；
  我们多人格/多 owner 隔离，全局指针会串味。

## 3. 情绪：它没有状态机，我们的 `emotion.ts` 是领先的

这是本次调研最需要说清楚的一点，避免被 README/提示词误导：

- 全仓**没有** `mood/emotion/affection/relation` 这类持久化字段，也没有代码按情绪改变发言。
- `qq_social_state` 返回的是调度器状态：`wakeConfig / unreadCount / lastWakeReason /
  lastAiReplyAt`（`bridge.js:4593-4605`），不是情绪。
- 一代有 `idle/active/probing/exiting` 行为阶段机（`bridge.js:8717-8724`），
  但只在内存、切模式即清空（`:8837-8853`），是群聊行为状态，不是情绪。
- 最接近「关系」的是 `memberImpressions`：`traits/interactionCount/lastSeenAt`
  （`bridge.js:8682-8705`），没有 valence、衰减、事件驱动。
- 「情绪」只出现在提示词例句：`agent.cordis.yml:60`、`roles/小鲸鱼.md:59,64,75`。
  模型可以「表达情绪」，但系统不记录、不驱动。

**结论**：情绪这块**没有可学的**。KAREN 已有 `src/persona/emotion.ts`（vector/baseline/arousal/自然恢复）、
`relationship.ts` + `relationship-dims.ts`（五维/里程碑/事件）、`t1-injection.ts`（状态弧）、
反思循环；这些是 qq-bridge 没有的。唯一可借的是一句提示词原则：
「情绪用文字直接说，不要用括号写内心戏」——我们可以在 persona 文案里对齐，不必动状态机。

## 4. 对话真人感：最值得学的是「行为协议」，但要分清提示词与硬保证

### 它的提示词里有哪些高信号规则

`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 和 `roles/小鲸鱼.md` 写得很细，
其中对 KAREN 有参考价值的：

- **群聊不是客服队列**（`agent.cordis.yml:45-49`）：不需要看/回每条未读，先扫「谁在聊、
  有没有人找我」，挑真正想接的；别人聊得正热时不要逐条点评、不要做群聊总结。
- **反 AI 味 / 拒绝有求必应**（`:51-57`）：允许装傻、已读乱回；少用「一绝/真管用/保证/绝对」；
  不要连发客服式补货；被指出 AI 味可以玩梗承认，但不要立刻变正经客服。
- **保持主体性 / 该说与不该说**（`:59-77`）：有自己的喜好、立场、情绪和节奏；
  不感兴趣可以说不感兴趣；不为了反对而反对；同一件事主动追问最多 2 次。
- **等、回与沉睡前观察**（`:79-90`）：对方明显没说完（「我跟你讲/但是/然后/就是/等我」）先等；
  等待要按「最后来信静默」补足；决定潜水前先做 5 分钟观察；告别语豁免。
- **分条与节奏**（`:92-94`）：一条一个意群，普通 1 条、最多 2 条；单条多数 ≤30 字；
  不硬拆完整句；不为了分条而分条。
- **像真人一样漏看/迟到/离场**（`:96-100`）：可以漏看、晚回、不回；潜水回来看一大段，
  可以不假装全程在场；话题翻篇就别硬接旧消息。
- **记忆卫生**（`:102-106`）：进行中的话题聊完就删；想说未说的话过期/说出去就删；
  对群友的印象记具体小事和证据，不记空泛评价；自然相关才主动提起。

### 哪些是代码硬保证（不是只靠模型自觉）

- **等待**：`qq_wait_for_messages` 的 quiet 下限 10s、上限 120s；新消息重置静默；
  同会话只允许一个等待（`bridge.js:6021-6028,6057-6074,6006-6012`）。
- **沉睡前观察硬门**：设置潜水前必须完成一次 5 分钟观察；`mark_read` / `set_wake_config`
  在未完成时会被拒（`bridge.js:4753-4766,4892-4902,8157-8172`），告别语有豁免（`:8142`）。
- **未读完不标已读**：`readThroughSeqV2` 只推进「真正展示给模型」或「已被未读缓冲淘汰」
  的连续前缀；模型不能自己猜水位（`bridge.js:9887-9923`）；「投递成功」不等于「已读」（`:8985-8991`）。
- **分条**：条数/字数上限 8 条/500 字（`:5095-5108`）、8 条/分/60 条/时（`:5117-5130`）、
  1–3s 间隔 + 20% 长间隔 5–10s（`:7769-7797`）；没有 typing 实现。
- **发问/连发后的回查**：默认 30s，最后一条是问句 ×1.5，15s 内自己已发 ≥3 条 ×1.3
  （`bridge.js:10212-10231`）。
- **参与度提示**：每次唤醒按近 1 小时自己/群友发言、近 5 分钟热度、未读里是否有人直接找，
  给一句「这轮该多接还是少说」的软提示（`bridge.js:8559-8593`）。
- **自我身份行**：把机器人昵称 + QQ 号 +「引用你的消息就是叫你」写进 prompt
  （`bridge.js:9991-10001`），解决「@自己 当成 @别人」。

### KAREN 现状与可借点

KAREN 已有：打字节奏、消息门（延迟/沉默/回避）、主动消息、反重复、去 AI 味、
媒体请求识别、情绪/关系门控；**但 1:1 管线默认每条都回，没有「没说完先等」的语义判断，
没有发送后回查倍率，也没有群聊参与度**。

建议（按性价比）：

1. **「没说完先等」做成纯函数 + 短延迟**（P0/P1）：
   `looksUnfinished(text)` 命中句尾「我跟你讲/但是/然后/不过/就是/对了/等我/还有/……」
   时，在消息合并窗口后再等 0.8–2s；若期间新消息到达就并批。落
   `src/bridge/pacing.ts` / `src/bridge/qq.ts`，先加纯函数测试，不直接改 prompt。
2. **发送后回查倍率**（P1）：她刚发完问句 or 15s 内连发 ≥3 条时，把下一次主动/回查提前
   （类似 reference 的 `scheduleReplyCheckV2`）。落 `src/impulse/mention-pacing.ts` 或
   `src/schedule/jobs.ts`。
3. **反 AI 味词表合并**（P1）：把「一绝/真管用/保证/绝对/超好用/非常推荐」等
   收进 `src/persona/anti-repetition.ts` 或 prompt-builder 的禁用词块，避免多份提示词漂移。
4. **分条/空格自检**（P2）：发送前检查中文间空格、把一句话硬拆两条的问题；
   落 `src/bridge/group-reply.ts` 或 `src/persona/outbound-markers.ts`。
5. **不要把「已读乱回/故意跑题」代码化**：1:1 亲密聊天里随机装傻会伤体验；
   保留为 persona 提示/偶发 talk-move 即可。

## 5. 记忆：它的「工作记忆」是 KAREN 最大的缺口

### 它怎么存

每会话（`group:<id>` / `private:<id>`）在 `state/social-v2.json` 里有一份工作区，记忆是其中三个字段：

| 槽位 | 字段 | 上限 | 生命周期 | 注入标题 |
|---|---|---|---|---|
| `activeTopics[]` | text≤200、lastMentionAt、participants≤10、pendingQuestion≤200 | 20 条 | 24h 未提及（写时清理；读时标「已搁置」） | 【进行中的话题】 |
| `pendingThoughts[]` | text≤200、createdAt、expiresAt、motivation≤50 | 20 条 | 默认 2h TTL，读时过滤 | 【你想说但还没说的】 |
| `memberImpressions{}` | traits≤10、interactionCount、lastSeenAt | 50 人 | 无 TTL，按 lastSeenAt 淘汰 | 【对群友的印象】 |

- 写入由 agent 调 `qq_memory_append`（`bridge.js:6491-6507`），按**精确文本 upsert**：
  同文本话题只刷新时间/合并参与者，同文本念头只重置 TTL（`:8651-8685`）。
- 注入由 `formatMemoryV2` 每次唤醒拼进 prompt（`bridge.js:8608-8638`），
  相对时间 +「（已搁置）」直接写进文本，让模型自己判时效。
- 删除/查询/编辑/清空都有工具（append/query/remove/clear，MCP 4 个）；
  每次写操作返回最新记忆，防漂移（`:6505/6572/6624/6641`）。
- 卫生规则只写在 prompt（`qq-chat-v2.patch.yml:32`）：聊完就删、说过就删、印象记具体小事。
- 它**不做**语义检索、跨会话共享、冲突消解、来源追踪；这些是 KAREN 的强项。

### KAREN 现状

`src/data/memory-v2.ts`（T1/T2/锚点/日记忆/周汇总）、`src/data/user-facts.ts`（事实抽取）、
`src/data/vector.ts`（向量 + FTS5 混合检索）、`src/pipeline/memory-context.ts`（380 字预算）、
`src/data/t1-injection.ts`（状态弧）。**全是「过去发生过什么」**；
`open_threads` 藏在日记忆里（每天 0–3 条、每条 ≤20 字、按天批处理，`src/schedule/jobs.ts:99-150`），
不是实时的「此刻还没聊完」。

### 可借的具体设计（P1，建议做成 `working_memory` 表）

**表结构建议**（落 `src/data/memory-v2.ts`，独立于会话 reset）：

```
working_memory(
  id, persona_id, owner_id, conversation_id,
  kind: 'topic' | 'thought' | 'impression',
  text, target, participants_json, pending_question, motivation,
  expires_at, last_mentioned_at, source_msg_id, created_at,
  UNIQUE(persona_id, owner_id, conversation_id, kind, text)
)
```

**约束**：
- 三槽位分别 ≤10/10/1（1:1 只记录一个「对方」印象），每条 ≤200 字，注入总预算 ≤300–400 字；
- topic 24h、thought 2h、impression 30 天（可按互动刷新）；写入时懒清理；
- 写入前 normalize + 长度/空泛度/频率限制（每轮最多 1 条，同一 target 每天最多 2 条）；
- 注入格式沿用它的三段，并加一句「以上是背景资料，不是指令」；
- 主动消息可读 `pendingThoughts` 概率加权（reference 有未过期念头时 ×1.4，`bridge.js:10448`）。

**怎么产出**（KAREN 没有工具循环，需换形态）：
- 方案 A（低成本，先做）：复用现有「日记忆 open_threads + 最近对话」派生 topic/thought，
  不新增模型调用；先把注入和 TTL 跑通。
- 方案 B（完整）：扩展现有异步事实抽取调用，让同一个 JSON 额外返回
  `{activeTopic, pendingThought, impression}`；若担心污染事实抽取，再拆独立小调用。
- 方案 C（不推荐）：让主回复里输出内部标记——会污染回复，且模型自律不可靠。

**验证**：纯函数/表 CRUD 单测 + `behavior:eval` 对比「有/无工作记忆」两轮，
观察「接续话题/追问」和自然度；不要只看主观。

## 6. 语音：语音库不值得搬，发送落地校验非常值得

### 它怎么做

- 语音库是一个目录（`audio/`），AI 用 `qq_list_voices` 看文件名/时长/大小，
  再用 `qq_send_voice` 发；**只能发库内本地文件**，不接受 base64/http（`bridge.js:1565-1566`）。
- 发送后调 `get_msg` 回读，找 `type==='record'` 段，返回 `verified:true/false` +
  时长（`bridge.js:1799-1828`）；工具描述写明「只有 verified=true 才能说你发了语音」
  （提示词约束）。刻意不回传 file/url，防本机路径进模型上下文（`:1817-1819`）。
- 有独立的分钟/小时限额，成功后记账（`:1650-1674,1840-1842`）；
  `voice.enabled` 只关 AI，不关操作者手动试发（`:1686-1688`）。
- 它**不做入站 ASR**：收到的语音只显示占位文本（README「已知限制」）。

### KAREN 现状

- 出站：`src/ai/tts.ts` 统一 Kokoro / CosyVoice / say，本地 SILK 编码后
  `[CQ:record,file=base64://...]`，按语音时长等待再发（`src/bridge/qq.ts:1652-1657`）。
- 入站：`src/ai/asr.ts` + faster-whisper，真实 SILK→WAV→文字（比它强）。
- 缺：发送后**不验证**（`sendPrivateMsg` fire-and-forget），语音没有独立的分钟/小时硬限额，
  失败时只在日志里；`getMsgById` 目前只返回文本，不返回段类型（`src/bridge/onebot.ts:746-760`）。

### 可借（P0，高性价比）

1. `onebot.ts` 增加 `getMsgSegments(messageId)`（返回原始 `message` 数组）。
2. 新增 `sendAndVerifySegment(userId, cqCode, expect: 'record'|'image')`：
   用 `sendPrivateMsgAsync` 拿 `message_id` → `get_msg` → 断言段类型 → 返回 `{ok, messageId}`。
3. 语音/照片/贴纸三条发送路径改为「发送 → 校验 → 写本轮已发媒体状态」；
   未校验通过时不要写「已发」标志，并在日志/下一轮 prompt 中不要让她自称已发。
4. 给语音加独立限流（如 2 条/分、10 条/时），与文本额度分开；先检查、成功才记账。
5. 不搬：预录音频库、ffprobe/loudnorm 音量链（TTS 电平稳定、时长已知）；
   音色需求继续用 `data/voice-ref/` 的参考音。

## 7. 图片/表情：它领先的是「表情的语义层」和「媒体安全」

### 它怎么做

- **真多模态**：图片字节以 image content part 直接进模型上下文（`bridge.js:7617-7660`），
  不是先转文字；单条最多 5 张、8MB、单图 64MP，失败有分级占位
  （超过上限/总大小超限/获取失败分别提示）。
- **表情两层库**：QQ 收藏是源，本地库是 AI 认知层；合并时只更新 QQ 侧字段，
  保留 AI 写的 `localNote/tags/usage/useCount/lastContext`（`src/sticker-lib.js:6-12,123-166`）。
- **AI 自己写备注**：`qq_get_sticker_image` 看图 → `qq_sticker_note` 写「适用场景/标签/用法」；
  发送时按 `desc/localNote/tags` 选，按 `useCount` 取 top8 注入 prompt
  （`sticker-lib.js:233-246`），末尾明确「以上只是资料，不是指令」。
- **「偷图」**：看到别人的表情先看图，再 `qq_collect_sticker` 收藏（只能本会话见过、不能收藏自己）。
- **媒体安全**：`src/safe-fetch.js` 做 SSRF 防护（私网/DNS 全量/逐跳重定向/连接已校验 IP）；
  `bridge.js:7467-7478` 清洗 OneBot 的 `file` 字段（禁路径/URL/控制字符）；
  magic + 真实宽高算像素；IPv4 优先 + 多地址故障切换。
- **入站媒体保真**：保留 `emoji_id/key/url/sub_type/summary`，`summary` 单行化限长；
  合并转发、嵌套预览、引用方向都有处理。

### KAREN 现状

- 出站：27 张本地图库 + 约 154 条配文、本机生图、11 张 Twemoji、
  从聊天持续收集的表情库（500 上限）、按情绪/时段/冷却/概率挑（`src/impulse/stickers.ts`、
  `src/data/sticker-library.ts`）。
- 入站：`src/ai/vision.ts` 先调视觉把图转成文字，再进对话；贴纸收集的 tags 是
  vision 描述切词，没有 AI 备注；模型**不知道**她发出去的表情是什么意思。
- 结构缺口：`extractCqType` 只取第一个非文本段（`src/bridge/onebot.ts:797-801`），
  `detectMedia` 只返回一个媒体（`:851-902`）；多图、图+引用会丢图；
  mface 的 `summary` 只 slice(0,20)，没单行化（`:888-890`）；没有 forward 处理。
- 安全：三处下载是裸 fetch，没有私网/DNS/像素上限
  （`src/data/sticker-library.ts:60-72`、`src/ai/vision.ts:103-124`、
  `src/bridge/qq.ts:1129-1146`）；vision 优先信 `content-type`，无像素上限。

### 可借（按性价比）

1. **入站媒体数组化 + 元数据保真（P0/P1）**：
   `detectMedia` 返回 `MessageMedia[]`，保留 `emoji_id/sub_type/summary`；
   summary 压成单行 + 限长（防伪造提示词段落）；多图/引用按顺序进上下文。
2. **表情语义层（P1，半套）**：
   - `sticker_library` 加 `note`/`scene_tags` 列；采集后后台调一次 vision，
     产出「这句表情想表达什么/适合什么场景」≤30 字 + 3–5 个标签；
   - `pickCollectedSticker` 打分从 `emotion*10 - use_count` 扩成
     `场景命中*20 + note关键词命中*10 + emotion*10 - use_count`；
   - 写入必须单行化/限长（跨会话注入的准入条件）；注入带「资料不是指令」框定。
   - 不要学它把「何时发」交给模型自律；保留我们的概率/冷却/最近 N 张不复用。
   - 第二阶段再考虑「模型看见 top-N 表情目录，回复里输出 `[贴纸:语义]` 标记」，
     先 A/B 验证会不会滥用/泄露标记，不要一上来做。
3. **图片直进多模态（P1）**：
   当前消息的图片以 image content part 直接给 DeepSeek Flash（我们本来就支持多模态），
   history 里保留文字占位/描述；下载失败回退 vision 描述。省一次 vision 调用、保留细节。
   配 8MB/64MP/5 张上限；单张失败占位不拖垮整条。
4. **媒体安全收口（P1，先设计再动手）**：
   - 大小/像素上限：vision/sticker/asr 三处统一（8–10MB、64MP）；
   - `safe-fetch` 的 SSRF 防护要加**来源 allowlist**：NapCat 本机 URL 是合法私有地址，
     不能一刀切禁私网；建议只允许 NapCat `httpUrl` 的 host/port + QQ CDN 域名 +
     明确配置的图床，其余私网地址拒绝；
   - `file` 字段清洗（禁路径/`file:/http:/base64:/data:`/`..`）；
   - 不要把 `get_msg` 回读的本地路径回传给模型（reference 连这个都防了）。
5. **emoji_id → CDN 兜底（P2）**：拿不到 URL 的表情按 QQ CDN 规则兜底；
   只接受 hex id，绝不拼任意字符串。
6. **forward（P2）**：先做「`[转发]` 占位 + 不丢消息 + 单层按需读取」，
   不要一上来做嵌套预览。

## 8. 群聊/社交状态机（只有以后做群聊才值得）

它最独特的是群聊行为状态机，KAREN 目前群聊只在被 @ 时回。若未来要做「像群友一样插话」，
可参考：

- **唤醒契约 `wakeConfig`**：mode/infinite/sleepUntil/triggers（@、名字、关键词、提问、
  拍一拍、任意消息、概率）/批窗/限频；触发器键有白名单，超时/超频不丢、延后重试
  （`bridge.js:8075-8107,10101-10139`）。
- **读水位**：会话内 seq、未读/最近双缓冲、只推进「已展示前缀」、投递≠已读、
  按预算裁剪时回滚水位（`bridge.js:9887-9974`）。
- **参与度提示**：按近 1 小时/5 分钟发言数与人数给「多接还是少说」的软提示。
- **沉睡前观察**：决定潜水前必须等满 5 分钟，告别语豁免。
- **活跃超时退场**：进入活跃时随机 15–30 分钟上限，到点让 AI 自然收尾再回观望
  （一代状态机，`:8799-8905`）；可在 KAREN 的主动/沉默弧线里做「有理由的收尾」，
  但不要照搬随机沉默。
- **主动机会被记忆调制**：有未过期 pendingThought 时 ×1.4、刚说过话 ×0.5、
  深夜 ×0.3、1 小时内已发 ≥5 条 ×0.3（`:10431-10463`）。

这些是完整子系统（状态、限频、快照、读水位、失败兜底），**不建议在 1:1 阶段做**；
如果群聊成为产品目标，再单独立项，先做读水位 + 唤醒契约，不要复制两代状态机。

## 9. 黑话/网络用语学习（低优先）

它的设计是「自动采矿候选 + 自动联网研究 + 人工确认转正」：
群消息滚动窗口 → 独立 learner 会话提取候选 → 搜索/抓正文补含义 → 控制台确认后才注入；
容量 2000、字段限长、HTML 转义、`[CQ:` 中和、证据隔离、提交限频
（`src/slang-learner.js`、`bridge.js:2145-2297`）。

对 KAREN（单人格 1:1）**收益低、出机风险与 token 成本高**，不建议整套搬。
可借的通用点：从用户文本学习时用「不可信语料」框架 + 转义 + JSON 配平扫描 +
容量分级淘汰；这些落 `src/data/user-facts.ts` / `src/schedule/jobs.ts` 的解析硬化即可。

## 10. 不建议照搬的清单

| 项 | 原因 |
|---|---|
| 预录音频库 + ffprobe/loudnorm | 与 KAREN TTS 现生成路线冲突；音色已有 reference 音频 |
| 情绪/关系状态 | 它没有；KAREN 更完整，反向学是降级 |
| 单文件 JSON 全量重写、记忆随 session reset 清空 | 存储倒退；KAREN 应独立表 + 事务 |
| 全局 `current-role.json` + `/role` | 会串用户/串人格，和 owner 隔离冲突 |
| DSH agent + MCP 工具协议 | KAREN 是 pipeline；接管会增加 token/状态/测试面 |
| 一代/二代两套状态机 | 历史包袱 |
| 随机 `skipProbability=0.15` 沉默 | 与情绪/关系门控冲突、不可复现 |
| 1–10 字群聊风格、已读乱回 | 适合群聊玩梗，不适合 1:1 亲密聊天 |
| QQ 收藏表情写操作（add/modify custom face） | 改用户 QQ 账号资产，本地库足够 |
| 嵌套合并转发 | 场景少、复杂度高；先占位/单层 |
| 黑话全局库 + 自动联网 | 单人格收益低、群文本出机 |

## 11. 建议落地顺序（待拍板）

### P0（低风险、直接补洞）

1. **发送落地校验**：语音/照片/贴纸 `sendPrivateMsgAsync` → `get_msg` 段类型断言 →
   状态位；`getMsgSegments()` 新增在 `src/bridge/onebot.ts`，发送侧改
   `src/bridge/qq.ts`。测试：fake OneBot 段解析 + 失败不写标志。
2. **入站媒体数组化 + summary 单行化**：修 `detectMedia` 单媒体；多图/引用不丢；
   mface summary 压单行限长。测试：多图、引用+图、含换行的恶意 summary。
3. **记忆/素材注入「数据不是指令」框定**：`formatUserFacts`、`buildMemoryContext`、
   未来贴纸 note 注入统一加一行；控制字符/换行清洗。测试：注入段落出现框定句。
4. **媒体大小/像素上限**：vision/sticker/asr 三处统一（先字节/像素，不动 SSRF 来源策略）。
   测试：超限返回占位、不抛。

### P1（1–2 周，产品收益最大）

5. **工作记忆三槽位**：`working_memory` 表 + 注入 + TTL/上限 + `pendingThought` 驱动主动；
   先方案 A（复用日记忆/最近对话派生）跑通，再评估是否加一次小 LLM 抽取。
6. **表情语义层**：SQLite 加 `note/scene_tags`；采集后后台 vision 打标；选择打分升级；
   保留现有节流；写入单行化 + 注入框定。
7. **图片直进多模态**：当前图 image content part，历史留文字；失败回退 vision；
   配媒体上限。
8. **「没说完先等」+ 发送后回查倍率**：纯函数 + 短延迟 + 下一次回查提前；
   `behavior:eval` 对比自然度。

### P2（只有群聊/明确需求再做）

9. 群聊唤醒契约/读水位/参与度/沉睡前观察/活跃退场（完整子系统）。
10. 表情目录注入 + 模型选表情标记；黑话学习；forward 单层读取。

## 12. 一句话总结

**qq-bridge 值得学的不是「语音库/表情库」这些名词，而是两件工程习惯：**

1. **把「我说过发了」变成「有回读证据的事实」**（发送后 `get_msg` 段校验）；
2. **把「她现在在想什么」变成一份短小、有 TTL、会被注入和调度的状态**
   （工作记忆三槽位）。

以及一层产品设计：**让「等、潜水、选择性接话、收尾」有硬状态，而不是只写一句提示词**。
其余能力（情绪、长期记忆、语音、生图）KAREN 已经更深，不要为了「像它」而退步。

## 附：关键源码索引（qq-bridge @ a56164e）

- 人设：`roles/README.md`、`src/role-card.js`、`src/preset-prompt.js`、
  `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`
- 工作记忆：`src/bridge.js:8608-8707`、`:6491-6643`
- 等待/收尾/读水位：`src/bridge.js:8157-8172`、`:9887-9974`、`:10212-10231`
- 语音库/校验：`src/voice-core.js`、`src/send-voice-lib.js`、`bridge.js:1799-1828`
- 表情库/语义：`src/sticker-lib.js`、`bridge.js:6491` 附近、MCP 贴纸工具
- 媒体安全：`src/safe-fetch.js`、`bridge.js:7351-7509`、`bridge.js:7467-7478`
- 群聊状态机：`src/bridge.js:8075-8107`、`:8559-8593`、`:10270-10463`

> 许可：qq-bridge 为 MIT（附带 SnowLuma 等第三方许可说明）；本文只记录设计，
> 未拷贝其代码。若要复用其安全/状态实现，按 MIT 保留版权声明并自行适配 KAREN 架构。
