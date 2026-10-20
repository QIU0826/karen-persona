# M1 真机联调问题记录与修复清单（2026-10-19）

> 状态：**已记录、已获批准修复**（用户 2026-10-19 明确同意）。
> 环境：macOS 26.5.1（Apple Silicon）+ QQ 7.0.2 + NapCat v4.18.38（原生）→ Karen 桥接 → DeepSeek V4.1 Flash。
> 测试配置：白名单 `2889386774`；免打扰临时 `02:00–07:00`（产品默认仍为 23:00–07:00）。

## 一、真机联调实测证据（2026-10-19 23:05–23:12）

| 能力 | 结果 | 证据 |
|---|---|---|
| NapCat → Karen 反向 WS | ✅ 通 | `[WS] 连接: /onebot/v11/ws` |
| Token 校验 / 白名单 | ✅ 生效 | 仅白名单 QQ 可聊 |
| 文本对话（流式碎片） | ✅ 通 | 首 token 416–1195ms，多段发送 |
| 思考模式关闭 | ✅ 生效 | `reasoning=0`，无空回复 |
| Prompt 缓存 | ✅ 生效 | 每轮 `cache_hit=1024~1536` tokens |
| 关系成长 | 🟡 通但有误判 | 亲密度 3.00→3.04，见 BUG-1 |
| 内心独白 / 情绪漂移 | ✅ 生效 | 每轮生成独白；自我觉察触发 ±0.02 漂移 |
| 图片识别 | ✅ 通 | `[Vision] 图片识别完成: 12 字`；会话记录 `[图片：两个动漫少女在花海中相拥]`，她回了「笑死 还挺好看你发这个做啥啦」 |
| 延迟回复 | 🟡 机制生效但重启丢失 | 23:05 的 `hello` 被睡眠门延迟，重启后 timer 丢失，见 BUG-2 |
| 免打扰时段 | ✅ 可配置（本次新增） | `quiet_hours_start/end`，默认 23–7，测试改为 2–7 |

**真实对话记录（节选）**

```
用户: hello            → （23:00 睡眠门，延迟到明早）
用户: cum              → 她: 你这条我有点没看懂……算了，当你在打招呼了晚上好呀
用户: how about we have some fun? → 她: 啥意思大晚上的
用户: u know, something only in couples. → 她: ...你这话说得我有点不舒服
用户: hey?             → 她: 在的但我不想接这个话
用户: ok, let's switch to another → 她: 嗯今天店里来了只猫 赖着不走
用户: 好不好看          → 她: 好看啊 橘色的 胖得很
用户: [图片]           → 她: 笑死 还挺好看你发这个做啥啦
用户: 这图片好不好看     → 她: 好看啊 你发这个是想说啥啦
```

## 二、缺陷与修复项（已批准）

### BUG-1｜关系成长误判（优先级 P0，下一轮第一个修）

- **现象**：边界试探 /「换话题」类消息被计为「愿意分享自己的生活」，亲密度 +0.02；她刚表达不舒服、用户轻飘飘换话题，关系反而上涨。
- **根因**：`src/persona/relationship.ts` 的规则只看消息长度/复杂度/是否问句，不看**互动质量**与**她的状态**（她的烦/失望没有反馈到关系评估）。
- **修复方案**：
  1. 关系事件评估输入增加「本轮她的状态」：回复文本是否表达抵触、guilt/resentment、是否发生边界事件；
  2. 「分享生活」规则增加语义门槛：排除明显的性暗示/越界内容（内容安全过滤器）与纯话题切换；
  3. 增加负向事件与修复事件：越界 → closeness 冻结/微降 + resentment；用户道歉/尊重边界 → 修复 + 小幅回升（与「负债偿还」设计对齐）；
  4. 单测覆盖：边界试探不涨、换话题不涨、真诚分享涨、修复后涨。
- **验收**：复现上面的对话序列，亲密度不应上涨；道歉场景能出现修复事件。

### BUG-2｜延迟回复 timer 不持久化（P1）✅ 已修复（2026-10-19 晚）

- **状态**：已实现并实测通过。新增 `src/data/pending-queue.ts`（SQLite `pending_replies` 表，pending→done/cancelled，失败 60s×attempts 退避重试，启动/重连恢复）；bridge 在 NapCat 连上后自动恢复队列；退出只清 timer、保留记录。
- **实测证据**：预置一条 10s 后到期的待补发 → 启动桥接 + 模拟 NapCat 客户端（不发消息）→ 日志 `发现 1 条待补发回复，开始恢复` → 10s 后 `[延迟补发] -> 恢复测试: 6 字`，客户端收到 `send_private_msg("这个点还不睡")`。

- **现象**：睡眠门延迟 8 小时，进程重启（本次为加载白名单）后 timer 丢失，消息只留在记忆里没有补回复。
- **修复方案**：新增持久化延迟队列（`data/delayed-queue.json` 或 SQLite 表），启动时恢复未到期任务；补发失败重试；与新消息合并策略。
- **验收**：23:00 发消息 → 重启 → 明早 7:00 仍能收到补回复。

### IMP-1｜图片描述过短导致回应泛化（P1）✅ 已修复（2026-10-19 晚）

- **状态（两轮）**：第一轮 30–60 字描述；真机发现文字截图在 `detail=low`（512×512 缩放）+ 60 字截断下 OCR 失真/信息被概括。第二轮改为 `detail:"high"` + 类型分流（截图/文字类逐字转述 ≤200 字；照片/插画 40–80 字）+ max_tokens 600、截断 220 字。**真实中文会议截图 OCR 实测四行原文全部正确**；单图成本 ≈¥0.002。

- **现象**：视觉描述被限制 ≤15 字（本次为「两个动漫少女在花海中相拥」），她的回复只能「还挺好看」，没有细节/情绪反应。
- **修复**：视觉 prompt 改为 30–60 字，包含主体、场景、氛围/情绪、可能的文字；保留 `detail=low` 控制成本；对图片回复增加「具体细节 + 她的主观反应」引导。
- **验收**：同一张图，回复能引用图中具体元素，而不是只说「好看」。

### IMP-2｜情绪会跨轮累积但缺少修复动力学（P1，M1-2 延伸）

- **现象**：她被冒犯后连续几轮冷淡（「在的但我不想接这个话」→ 独白「有点生气、有点失望」→ 后续「有点烦」），但没有任何机制让关系转暖，除了下一条消息继续聊。
- **修复**：把「冲突 → 修复」接进关系/负债状态机；修复方式包括用户道歉、用户尊重边界、时间流逝 + 她主动给台阶；状态影响消息门与 prompt 的关系部分。
- **验收**：冒犯 → 表达不舒服 → 用户道歉 → 她的语气明显缓和，关系事件记录一次修复。

### IMP-3｜图片/表情/语音的边界能力（P2）

- 图片识别已通；但表情包（face/mface）目前整条丢弃，她不会对表情包做反应；
- 语音消息只有 `[语音]` 占位，无 ASR；
- 修复方向：表情包至少占位回应（或本地贴纸库检索）；语音接入 SenseVoice/Whisper 本地 ASR（技术雷达 B 会调研）。

### IMP-4｜内容安全/边界策略缺失（P1，商用前置）

- **现象**：本次越界内容全靠人设临场发挥（回复是得体的），但没有统一的内容安全策略与拒绝模板；换一个人设可能失守。
- **修复**：加一层内容安全与边界策略（不覆盖人设表达，只在越界时给「回避/拒绝」行为脚本 + 可选过滤）；商用前必须做 AI 披露、年龄门、危机干预。

### IMP-5｜调试期日志脱敏需要可开关（P2）

- 为保护隐私，桥接日志只打印长度；真机排障时看不到原文。加 `LOG_CONTENT=1` 调试开关（默认关），并禁止把内容写进永久日志。

### IMP-6｜主动消息与夜间行为需要真机观察（P2）

- 今晚已观察到深夜冲动被消息门延迟 + 独白记录；明早 7 点后观察是否按预期补发/主动联系；日上限 4 条、30 分钟间隔需真实使用验证。

### ✅ 已完成（2026-10-19 深夜）

### ✅ 已完成（2026-10-20 M2-B 人设包 v2）

- **包格式**：`manifest.json` + `persona.json` + 可选 `assets/`、`memories/seed.jsonl`（3–20 条）。
- **校验**：id 规则、语义化版本、personaSchemaVersion 与引擎一致、minEngineVersion、素材类型/单文件/总量/数量、seed JSONL 合法性与条数。
- **安装**：默认拒绝覆盖；`--force` 备份旧人设到 `personas/.backups/`（隐藏目录，不会出现在 setup 人设列表）；`--with-seeds` 才写 T2。
- **CLI**：`npm run persona:pack:validate/install/list`；`list` 标注 legacy 历史人设。
- **测试**：9 条（含子进程 CLI）；全仓 63 文件 / 658 用例，tsc 0、lint 0、覆盖率阈值通过（行 52.8%）。
- **限制**：目录安装（无 zip）、素材不自动接入头像/贴纸路径、不做内容审核。

### ✅ 已完成（2026-10-20 M2-A 首次引导 2.0）

- **方向确认**：目标场景「个人自用 + 朋友小范围」；第一方向 A（首次引导 2.0），见 `docs/M2_PRODUCT_PLAN.md`。
- **实现**：`src/setup/flow.ts`（纯函数：标签/端口校验、config 合并、第一段对话/事实生成、跳过判断）+ `src/setup/onboarding.ts`（会话 + facts + consent + `data/onboarding.json`，legacy 会话只写一遍）+ `src/setup.ts`（知情/18+ 确认、`--force`、已完成跳过）。
- **效果**：CLI/QQ 首次聊天不再重复披露/年龄门，她记得「怎么认识/叫什么/在哪」。setup 输出改为「她记住了你们的第一段对话」。
- **测试**：flow 10、onboarding 4、setup 子进程 E2E 1（真实 CLI driver + 二次运行跳过）；全仓 62 文件 / 649 用例，tsc 0、lint 0、覆盖率阈值通过（行 52.5%）。
- **未做**：图形引导、QQ 扫码自动配置、引导后新增白名单用户的自动补写。

### ✅ 已完成（2026-10-20 延迟补发 E2E + 跨库表缓存修复）

- **延迟补发端到端**：第二个 bridge 实例（免打扰时段覆盖当前小时）：
  聊天消息断言不立即回复 → 数据库断言 `pending_replies` 落库 → 把 `due_at` 改到过去 → **重启 bridge 进程** → 恢复队列 ~2s 后补发（断言收到回复 + 队列行 `done`）。
- **修掉全量测试的缺表警告**：`cost-tracker` / `pending-queue` 的懒建表缓存是进程级布尔，同一进程切换 `KAREN_DATA_DIR` 后第二个库缺表（`no such table: llm_usage`）→ 改为按当前 DB 路径缓存（与 user-facts 一致），并各加 1 条切库单测。
- **E2E 稳定性**：断言「消息已发送但 DB 尚未落库」的窗口增加轮询；延迟场景 6/6 通过。
- **测试**：59 文件 / 634 用例，tsc 0、lint 0、覆盖率阈值通过（行 52.1%）。

### ✅ 已完成（2026-10-20 多用户 prompt 隔离修复 + E2E 安全场景）

- **严重隐私 bug（E2E 发现）**：`src/evolution/style-reference.ts` 的 `retrieveStyleReference` 查 `t2_episodes` 时没有 `persona_id` 过滤，第二个用户的 system prompt 里混入了第一个用户的历史对话片段（「动态风格参考」）。
  - 修复：查询强制 `WHERE persona_id = ?`，`personaId` 必填（缺省返回空，宁可不检索也不跨用户）；orchestrator 两处调用传 `state.storagePersona`。
  - 回归：单测两个 persona 的片段互不出现；E2E 断言用户 2 的 prompt 不含用户 1 标记内容。
- **E2E 新增安全场景**：白名单外私聊静默忽略（负向断言）；模型输出 CQ 码时出站必须转义（`&#91;CQ:...&#93;`，不能当 OneBot 指令发出）。
- **测试**：59 文件 / 631 用例，tsc 0、lint 0、覆盖率阈值通过（行 52.2%）。

### ✅ 已完成（2026-10-20 桥接 E2E 场景扩展）

- **新增 3 个场景**：治理命令（`/about` 披露+数据去向、`/age` 已确认）、危机兜底（强制回复 + 12356 求助资源）、多用户隔离 + 合规拦截（第二个 QQ 独立披露/年龄门；未确认 18+ 时群聊 @ 不回复负向断言；确认后私聊正常；数据库断言两个 owner 的 `user_consent` 与两份 `persona_id` 记忆）。
- **方式**：同一文件内追加 3 个 `it`，共享真实 bridge 子进程与 fake NapCat/DeepSeek；单次全跑约 7s（CI 可接受）。
- **测试**：59 文件 / 629 用例，tsc 0、lint 0、覆盖率阈值通过。

### ✅ 已完成（2026-10-20 mock-OneBot 桥接端到端测试）

- **新增 E2E**：`src/eval/bridge-e2e.test.ts` + `npm run test:e2e`（随 `npm test` 也跑）。测试进程扮演 NapCat（OneBot WS 客户端），用临时 config/数据目录启动真实 bridge 子进程；fake DeepSeek HTTP 服务提供非流式/SSE/视觉/事实抽取响应。
- **覆盖**：新用户披露 → 年龄门 → 「我成年了」+ 紧接着的聊天（合并窗口）→ 私聊流式回复 → 图片消息（断言 image_url 视觉请求）→ 群聊 @ 回复。
- **抓到并修复的真实 bug**：
  - 「确认 + 下一句」在 400ms 合并窗口被拼成一批，确认分支提前 return 吞掉后半句 → 确认后剥离标记，继续走正常回复（`stripAgeConfirmationMarkers` + 单测）；
  - 私聊缓冲消费竞态：新消息在 `processing=true` 时入队，而 drain 恰好退出 → 消息卡死不回；`drainUserBuffer` finally 再检查积压并重新排期。
- **稳定性**：单跑 3/3、连续 3 次全过（约 1.6s/次，无真实网络/QQ 依赖）。
- **测试**：59 文件 / 626 用例，tsc 0、lint 0。

### ✅ 已完成（2026-10-20 修复后端到端复验）

- **30 轮真实长跑 ×2**：记忆 6/6、复读对 0、错误/空回复 0；延迟 avg 2175→2039ms；成本 ¥0.0766/¥0.0762。报告 `docs/LONGRUN_REGRESSION.md` §2.1。
- **记忆防御话术变体**：真实出现「才一个月 记性没那么差」（省略「我」）漏网 → `reply-guard` 改为匹配「记性没那么差/记性没那么好/我记性不好」整族，harness 同步，单测补变体。
- **连发事实丢失**：用户连发时，1.5s 节流窗口内的消息被直接丢弃（`pet` 事实两次长跑缺失）→ 改为排队合并（最多 5 条，窗口结束补抽）；fake-timer 单测 + 专项 live 实测连发 3 条 5/5 事实。
- **memory-eval live 复验**：17/20（85%）、违规表达 0、错误 0，与历史一致。
- **长跑 harness 增强**：结果新增 T3 摘要条数/未压缩数/最新摘要，便于后续 T3 抽检；括号/防御规则修正误报。
- **测试**：58 文件 / 623 用例，tsc 0、lint 0。

### ✅ 已完成（2026-10-20 工程加固：lint / 覆盖率 / 日志脱敏）

- **lint（零新依赖）**：`npm run lint` = tsc `noUnusedLocals/noUnusedParameters`；修掉 47 处未使用导入/变量/参数（含 qq.ts 两个死函数、orchestrator 未用导入）；CI 增加 lint 步骤。
- **覆盖率基线**：安装 `@vitest/coverage-v8`，`npm run test:coverage`；首次基线 Statements 50.9% / Branch 47.25% / Functions 57.76% / Lines 51.91%；vitest 阈值守护（50/45/55/51），CI 仅 Linux 跑一次；`coverage/` 加入 .gitignore。
- **日志正文脱敏（IMP-5）**：新增 `src/obs/safe-text.ts`（`previewText`/`previewError`，4 条单测）；默认输出 `[redacted N chars]`，`LOG_CONTENT=1` 才输出 40 字预览；替换独白/日记/发图配文/主动消息/因果链/搜索词等 12 处内容打印；`.env.example` 增加开关说明。
- **测试**：57 文件 / 619 用例，tsc 0、lint 0。

### ✅ 已完成（2026-10-20 30 轮真实长跑回归）

- **新增长跑 harness**：`src/eval/longrun-sim.ts`（30 轮混合场景 + 指标汇总单测）+ 报告 `docs/LONGRUN_REGRESSION.md`。
- **首轮结果**：记忆检查 6/6、复读对 0、错误/空回复 0；延迟 avg 2231ms / p95 2876ms；成本 137 次调用 ¥0.0758。
- **修复问题**：
  - 事实抽取质量：角色老家人设「嘉兴」被当成用户城市、职业抽成「上班族」、丢宠物细节、推断偏好 → prompt 加固 + `isFactGroundedInUserText` 确定性接地校验；修复后实测 `city=杭州/job=产品设计/pet=橘猫叫团子`。
  - 记忆防御话术漏网（T9「我记性没那么差」）→ `src/persona/reply-guard.ts` 出站前删分句，普通/流式/主动三管线接入 + 6 条单测。
  - 候选 <3 条仍调用检索重排 → 跳过（省一次调用/~1s）。
  - harness 颜文字括号误报 → 规则收窄。
- **测试**：56 文件 / 615 用例，tsc 0。

### ✅ 已完成（2026-10-20 成本统计覆盖旁路 LLM）

- **统一记账（已完成）**：新增 `src/ai/aux-usage.ts`（`recordAuxUsage`）——事实抽取/内心独白/深夜独白/T3 摘要/herView/进化日志/叙事重构/视觉描述/配图搜索词全部写入 `llm_usage`，带 `kind` 标签；无 usage 不记录（不估算）。
- **报表**：`getCostReport` 新增 `by_kind`；`/cost` 与 Web 控制台新增「按用途」拆分（对话/事实抽取/独白/长期摘要/图片识别/配图搜索词…）。
- **真实验证**：一次真实事实抽取调用 → `llm_usage` 出现 `kind=fact_extraction, model=deepseek-flash, prompt 234, completion 63, ¥0.000486`，同时抽出 4 条用户事实。
- **测试**：cost by_kind 1 条、aux-usage 2 条、dashboard「按用途」1 条；全仓 54 文件 / 600 用例，tsc 0。

### ✅ 已完成（2026-10-20 年龄门 18+ 确认）

- **合规升级（已完成）**：`src/data/consent.ts`（`user_consent` 表，按 owner 隔离、跨重启持久化）+ `src/persona/age-gate.ts`（`detectAgeConfirmation` / `detectUnderageDecline` / `evaluateAgeGate` / 文案）。
- **QQ 私聊**：首次对话发「AI 披露（含 18+ 指引）+ 确认请求」，未确认前不进入角色对话（5 分钟内最多提醒一次）；回复「我成年了」记录并放行；明确表示未成年则拒绝服务；首条消息不会在确认前落库/回复。
- **群聊**：未确认用户 @ 她也不会回复（避免多人场合诱导未成年人互动）。
- **/age**：查看年龄确认状态（已确认时间 / 尚未确认）。
- **配置**：`age_gate_enabled` 默认 true（config.yaml 或 `AGE_GATE=false` 关闭）；CLI 开发者模式不强制；仍是自我声明式年龄门，非身份证/生日校验。
- **测试**：consent 4 条 + age-gate 9 条 + `/age` 1 条；全仓 53 文件 / 596 用例，tsc 0。

### ✅ 已完成（2026-10-20 群聊贴纸/发图）

- **群聊出站计划（已完成）**：新增 `src/bridge/group-reply.ts` 纯函数 `buildGroupReplyPlan`——文字气泡按换行拆分 → QQ 表情 →（可选）照片+配文；5 条单测（拆行/表情/默认不发图/显式开启/只有图）。
- **群聊贴纸**：`maybeSendSticker` 支持 private/group 两种目标；群聊按「群+人」5 分钟冷却，收到对方表情时概率更高；冲突未化解不发。
- **群聊发照片（默认关闭）**：`group_photo_enabled: true`（config.yaml 或 `GROUP_PHOTO=true`）才把主动发图结果发到群里；默认只发文字/表情/贴纸（多人语境隐私保守）。
- **省成本**：`processMessage` 新增 `skipPhoto`，群聊默认跳过发图决策（不值得为必被丢弃的图跑生成/搜索）；1 条单测验证「默认有图 / skipPhoto 无图」。
- **测试**：全仓 51 文件 / 582 用例，tsc 0。

### ✅ 已完成（2026-10-20 T3 质量抽检 + facts 上限）

- **T3 摘要 prompt 加固（已完成）**：保留具体事实（人名/公司/项目/宠物/数字/计划）、保留未完成话题（待续/没定）、禁止编造片段外内容；`buildT3SummaryPrompts` 纯函数 + 2 条单测。
- **T3 质量抽检（真实模型）**：临时 40 条混合记忆 → 真实压缩 1 条；摘要保留「林哲/杭州/星野科技/咖啡品牌包装/团子/云南未定/看电影没定/美式不加糖」等事实与未完成话题，3 句、无编造。
- **facts 超 20 条压测（已完成）**：`selectFactsForPrompt` 分类配额（profile4/work3/pet3/relationship3/plan3/preference2/other2）+ 时间回填；29 条事实注入 20 行，工作/宠物/计划全部保留；两档单测（>20 / <20）。
- **测试**：全仓 50 文件 / 576 用例，tsc 0。

### ✅ 已完成（2026-10-20 句式复读提醒）

- **句式复读检测/提醒（已完成，效果未验证）**：`anti-repetition.ts` 统计最近 3 条回复里的套话句式（是不是/要不要/有没有/我跟你说/其实/确实/哈哈/早点/别太），≥2 次就提示「换成陈述句或别的问法」。
- **9 次真实 A/B（baseline/openers/full 各 3+6 次）**：openers 9 次零复读对、平均相似度最低（0.057）；full 2/9 次出现复读、平均相似度最高（0.100）；套话指标噪声大（0–4 次/轮），未测出提醒的稳定效果——不宣称有效。
- **测试**：句式检测 3 条；全仓 50 文件 / 572 用例，tsc 0。

### ✅ 已完成（2026-10-20 记忆时间感 + 事实变更历史）

- **记忆时间感（已完成）**：`src/data/relative-time.ts`；检索结果带 `createdAt/timeLabel`，RAG 注入 `- [3天前] …`；`/api/memory-probe` 返回 `created_at/time_label`，Web 回放显示时间徽标。按本地日历日判断今天/昨天/前天，更久远用天/周/月/年。
- **事实变更历史（已完成）**：`user_fact_history` 表（值真变化才记录旧值，每 key 最多 20 条）；最近 180 天变更注入「（之前是：X）」；`listFactHistory` / `getRecentFactChanges` 接口。
- **顺带修复**：user-facts 建表缓存改为按 DB 路径记录——评测/测试同进程切 `KAREN_DATA_DIR` 时不再缺表。
- **测试**：relative-time 6 条、user-facts 历史 3 条、检索时间标签 1 条、Web 时间徽标断言；全仓 50 文件 / 569 用例，tsc 0。

### ✅ 已完成（2026-10-20 检索增强 DeepSeek 重排）

- **DeepSeek 没有 embeddings**：官方 `POST /embeddings` 404（DEEPSEEK_CAPABILITY_AUDIT §7），真语义向量需外部 Key/本地模型。
- **候选重排（已完成，生产默认）**：`src/data/retrieval-boost.ts` 对初步召回 top12 做一次 Flash 相关性重排；20 条金标 T2 recall@1/3/8 = 55%/80%/85% → **95%/95%/95%**；平均 ~664ms、~¥0.00025/轮；`KAREN_SEMANTIC_BOOST=off` 可关，异常/超时（默认 2.5s）降级原顺序。
- **查询改写（实测不采用）**：只加改写 recall@1 50%（降精度）、改写+重排 90%（低于仅重排），因此生产只做重排。
- **测试**：`src/data/retrieval-boost.test.ts` 7 条（顺序生效/非法输出/异常/超时/关闭/短输入）；全仓 49 文件 / 560 用例，tsc 0。

### ✅ 已完成（2026-10-20 记忆深度：T1/T3）

- **T1 快照注入（已完成）**：`src/data/t1-injection.ts`——最近 8 条快照 → 「最近几轮的状态」（亲密度/情绪/负债趋势；不引用对话正文/脱敏）；reply/stream/proactive 注入；`getRecentSnapshots` 支持显式 personaId。
- **T3 压缩调参（已完成）**：阈值 80→40 + 「≥20 条且距上次摘要 ≥1 天」时间兜底 + `KAREN_T3_DRY_RUN=1` 干跑；真实数据验证：42 条未压缩 → 压缩 40 条 → 1 条摘要（id=89），摘要保留事实与情绪；线上 t3_summary 0→1。
  - 附带修复：原逻辑压缩后只降 strength 不标记，计数仍 ≥阈值会每轮重复压缩（激活后是新 bug）；新增 `t3_compressed` 列（幂等迁移）+ 计数/候选排除，单测覆盖。
- **测试**：49 文件 / 560 用例全绿，`tsc` 0。

### ✅ 已完成（2026-10-20 记忆与反重复专项）

- **FTS5 自然问句 0 命中（已修）**：`searchEpisodesByFts` 逐字 token 用 FTS5 默认 AND，自然问句要求每个字都在同一条记忆里，20/20 probe 无候选、混合检索退化为 n-gram 单路。改为 OR + BM25 IDF（token 去重、≤48），T2 recall@1/3/8 = 20%/35%/40% → 50%/75%/85%。
- **QQ 私聊（流式）漏注入用户事实（已修）**：事实层只接在 `processMessage`，而 QQ 私聊走 `processMessageStream`；已补事实块 + 反重复块，单测断言两条管线都注入。此前文档「流式/非流式都生效」的说法已修正。
- **跨轮反重复（已完成）**：`src/persona/anti-repetition.ts`（抽取最近开头词/检测 exact/prefix/similar/opener）；reply/stream/proactive 三条路径注入；默认 `openers` 模式（A/B 实测回放整句会诱发模型照抄自己上一轮，full 组复读对 0→0.33，openers 组 0 且相似度 0.056→0.027）。
- **记忆评测金标集（已完成）**：20 条中文 case（7 类，direct 8 / indirect 12）+ 离线 recall@k/facts 命中/anti-forget harness + `--live` 真实模型验证；报告 `docs/MEMORY_EVAL_REPORT.md`。live 20 条 expect 命中 17/20、违规表达 0。
- **Web 控制台新面板（已完成）**：`/api/facts`（只读 user_facts，owner 参数）、`/api/memory-probe`（同步混合检索回放）；页面新增「用户事实」「记忆命中回放」两张卡；CSP/转义/无写库（表不存在不建表）保持不变。
- **回放按展示人设检索（补）**：桥接刚重启、尚无对话时 `getCurrentPersona()` 为空会让回放全空；`retrieveRelevantMemories/searchSimilarEpisodes/searchSemanticEpisodes/searchEpisodesByFts` 增加显式 `personaId` 选项，Web 回放用控制台人设检索（默认行为不变，单测覆盖）。

- **BUG-2 延迟队列持久化**：`src/data/pending-queue.ts` + 桥接恢复；实测重启后到点补发成功。
- **IMP-1 图片描述增强**：30–60 字描述 + max_tokens 240，单测已更新。
- **步骤 3 可观测最小闭环（已完成）**：`src/obs/logger.ts`（JSON lines/脱敏/TTY 可读）、`cost-tracker.ts`（SQLite `llm_usage`，DeepSeek 峰谷价）、`health-server.ts`（`/health` + `/cost`，仅 127.0.0.1:18081）；qq/chat 关键链路接结构化日志；PM2 改跑 dist。实测 `/health` 200、单次调用成本正确入账；30 文件 / 419 用例全绿。
- **发图时间关系模型（已完成）**：照片带场景/时间关系/亲密度门槛，早上可发「昨天的晚霞」、亲密度达标后分享「以前的生活」；配文按时间关系生成，修复「上午发今天的晚霞」；单测覆盖时间关系/亲密度门槛。
- **用户事实记忆 + 去 AI 味（已完成）**：`user_facts` 结构化事实层（后台抽取/owner 隔离/每轮注入）；prompt 反套话/反反问/反编造；burst/流式去尾部软标点与空行；删除重复 shortTermContext；实测「5 轮前项目」从不记得→答对。详见 `docs/MEMORY_AI_TONE_AUDIT.md`。
- **宣传页（已完成）**：`promo/` 单文件滚动落地页（双视频 hero/黑色画廊/白场 CTA），`/promo/` 可由本机 Web 服务访问；素材与文案集中于 CONFIG，卡通角色占位与替换规格见 `promo/README.md`；测试覆盖路由/静态素材/路径穿越。
- **双管线对齐（已完成）**：QQ 流式主路径补齐因果链/漂移/叙事/纠正/L1+EMA/风格参考/热点/T1/因果回响/herView/门控记录；冒烟实测流式回复 + T1/T2/成本落库正常；两份实现仍并存（后续可抽共享 helper）。
- **多用户隔离（已完成）**：owner=人设+用户+平台；主用户/CLI 沿用历史存储（旧数据零迁移），其他好友会话/状态文件后缀隔离、T2/T1 存储 persona_id 带 `@ownerSlug`；每轮显式切回存储 persona。E2E 双用户隔离实测通过；40 文件 / 485 用例。
- **合规最小版（已完成）**：首次对话 AI 披露（AI 身份/数据去向/18+）、`/about`、危机信号强制回复+安全指引+求助资源；E2E 实测通过。测试 38 文件 / 477 用例。
- **M1 治理与数据主权（已完成）**：`/why` 门控可解释（lastGate 持久化）、`/pause`/`/resume` 主动消息暂停、`/export` 导出会话+人格状态+T2 记忆（本地 JSON/600 权限）；QQ 与 CLI 共用命令层；测试 37 文件 / 471 用例。
- **0 号依赖升级（已完成）**：better-sqlite3 11.10→13.0.3（N-API 预编译，无需 C++ 工具链）、engines >=22.12、移除 wechaty/node-cron 未使用依赖（包数 ~446→162）、CI 三平台矩阵；Node 22 下 462 用例全绿、桥接实测正常；vitest 5 暂缓。
- **步骤 5 本地 Web 控制台（已完成）**：零新依赖 `src/web/` 单页四视图（聊天/记忆/关系/状态+成本），仅 127.0.0.1:18082，可选 token、CSP、XSS 转义、5s 自动刷新；实测页面/API 正常。
- **主动发图接通（已完成）**：流式路径接入 `photoShare`；有 Unsplash Key 搜索、无 Key 本地 7 张授权图兜底；QQ 出站 base64 图片 + 配文；修复 qqFace break 丢 fragment 的 bug；E2E 实测收到图片。测试期 config 覆盖门槛/概率/冷却。
- **步骤 4 表情/贴纸（已完成）**：入站 face/mface 转合成文本；本地贴纸库（11 个 Twemoji，CC-BY 4.0）；按情绪/时段/冲突状态选择，22% 概率（收到表情 55%）、5 分钟冷却；仅私聊；CQ 白名单只放行内部 base64 图片。31 文件 / 429 用例全绿。
- **P0 记忆检索闭环（技术雷达第 1 件事）**：语义 embedding 双列、sqlite-vec 启用、FTS5 中文 BM25、RRF 混合、阈值/去重/来源过滤；真实库 22 条记忆 schema v2 迁移验证通过；27 文件 / 386 用例全绿。语义路径需 Qwen Key 才能实跑（当前降级 n-gram+BM25）。

## 三、修复顺序（已批准）

1. **BUG-1 关系误判 + IMP-2 修复动力学**（一起改，涉及 relationship/prompt/orchestrator）
2. **BUG-2 延迟队列持久化**
3. **IMP-1 图片描述增强 + IMP-3 表情占位**
4. **IMP-4 内容安全/边界策略**（商用前置，M2 前必须）
5. **IMP-5/6 可观测与真机验证**

## 四、测试配置备忘

- `config.yaml` 当前：`allowed_users: [2889386774]`、`quiet_hours_start: "02:00"`、`quiet_hours_end: "07:00"`（**测试期**，方便夜间联调）。
- 测试结束后改回 `23:00–07:00`。
- 桥接日志：托管后台任务（会话结束前保持运行）；NapCat 配置：`~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config/`。
