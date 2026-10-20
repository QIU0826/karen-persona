# 同类项目调研：GitHub 上可借鉴的 AI 伴侣 / QQ Bot 项目（2026-10-20）

> 目的：围绕「真人感、主动、记忆、语音」，横向看 GitHub 上同类项目，记录**可借鉴的具体设计**（不是照抄功能）。
> 抓取方式：GitHub Search API（`sort=stars`）于 2026-10-20 检索；星标为抓取时数值；标注「实读」的项目读过 README。

## 1. 直接可借鉴（同类最强）

| 项目 | 星标 | 它解决什么 | 可借鉴的具体设计 | 对本项目的建议 |
|---|---|---|---|---|
| [pinganbbOvO/ai-companion-kit](https://github.com/pinganbbOvO/ai-companion-kit)（实读） | 224 | QQ 陪聊 + 记忆账本 + 拟人化发送 + 唤醒策略 + 日记；另有 phone-mcp 控手机 | ① **Humanizer**：打字时长按字符/情绪/深夜变慢、自动分条、条间停顿；② **Waker**：@/名字/提问/拍一拍/关键词/概率，条件独立、可潜水；③ 记忆**按人存**、跨场合共享对话流（群里说的私聊也记得）；④ **日记与记忆分离**，只喂最近 3 条防「今天真是充实的一天」，算「认识第几天」；⑤ 20 条/分钟被腾讯限速的防风控经验 | ①我们已按字数估算节奏，可加「深夜变慢」；②门控可借「唤醒原因」模型让 `/why` 更可解释；③日记已有，可加「认识第几天」「避免重复角度」；④防风控经验写进部署文档 |
| [sakurawwwxh/qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus)（实读） | 78 | Linux QQ 群聊 Agent：分条发言、表情包收发、长期记忆、主动发言、运维命令 | ① **主动发言三条链路**（冷场开话题 / 没人接话补一句 / 模型自安排唤醒）+ 多活跃时段 + 间隔护栏 + **跳过原因日志**；② 表情包「常用的 + 没用过的」**轮换写进系统提示**；③ 单轮分条 + 结束前自检；④ 省 Token 收敛（读入历史条数、工具轮、会话交接摘要上限）；⑤ 消息状态机：处理成功才确认、失败重试、`held` 人工核对 | ①本轮正在做「主动/共情」，可借它的「跳过原因日志」；②贴纸轮换我们刚做（最近 3 张不重复），它用「清单轮换」思路可再借；③我们的 pending queue 已近似；④长对话可加「会话交接摘要上限」控制 prompt 膨胀 |
| [69gg/Undefined](https://github.com/69gg/Undefined) | 262 | QQ bot 平台（OneBot v11）+ 认知记忆架构 + 多 Agent Skills | 认知记忆分层 + Skills 按需加载 | T0–T3 分层已有；「Skills 按需加载」可减少常驻 prompt |
| [AOrbitron/Eridanus](https://github.com/AOrbitron/Eridanus) | 208 | OneBot 多功能 bot + LLM function calling + Live2D 桌宠模式 | 以 function calling 组织功能调用；桌宠形态 | 若以后加工具调用（天气/日程），参考其 function calling 组织方式 |
| [kuliantnt/qq-maid-bot](https://github.com/kuliantnt/qq-maid-bot) | 125 | Rust 多入口 Agent（QQ 官方 / OneBot / NapCat / 微信）+ Memory/RAG/Todo/Tool | 低内存、多入口抽象、RAG | 部署体积/低内存参考；不建议迁语言 |
| [Canvixel-Eloweny/ai-bot-groupmate](https://github.com/Canvixel-Eloweny/ai-bot-groupmate) | 88 | QQ 群「像群友一样插话、接梗、潜水」 | 群聊插话/潜水的行为模型 | 群聊行为（Karen 目前只在被 @ 时回）可借鉴 |
| [LucieEveille/kiwi-mem](https://github.com/LucieEveille/kiwi-mem) | 339 | AI 伴侣**记忆网关**：向量搜索、记忆热度、Dream 睡眠整合、日历层级摘要 | ① **记忆热度**（访问次数 + 时间衰减影响召回）；② **Dream 睡眠整合**（离线把碎片合成记忆）；③ 日历层级摘要 | 我们已有艾宾浩斯衰减 + T3 压缩；可借「热度进召回排序」与「夜间离线整合」 |
| [DasterProkio/awesome-ai-companion](https://github.com/DasterProkio/awesome-ai-companion) | 1024 | AI 伴侣项目大全（持续更新：桌面宠物/长期记忆/主动性） | 索引入口 | 后续找参考的入口 |

## 2. 只在概念上参考

- **SillyTavern**（角色卡 + World Info/Lorebook + Author's Note + 摘要记忆）：Karen 的六层人设 + 动态注入已覆盖大半；可借「World Info 关键词触发条目」做**人设细节按话题按需注入**，减少常驻 prompt。
- **Letta/MemGPT、Mem0**：记忆分层与自编辑记忆；Karen 已有 T0–T3 + `user_facts`，短期不必换。
- **AIRI / Open-LLM-VTuber / xiaokeai**：语音 + Live2D/VRM 桌宠；与 Karen（QQ 文字 + 语音条）不冲突；其 **ASR / VAD / 流式 TTS** 管线可参考。

## 3. 本轮落实 & 后续优先级

**本轮已落地**

1. **「说话动作」选择器**（`src/persona/talk-moves.ts`）：对方在倒苦水 → 先接住情绪；否则低概率（28%）顺手补一句自己的近况；带亲密度门槛、连续两轮不重复、危机/免打扰不触发，`KAREN_TALK_MOVES=off` 可关（对应 ai-companion-kit 的 Humanizer/Waker 与 qq-agent-plus 的主动链路）。
2. **贴纸跨轮去重**：每个用户最近 3 张贴纸不重复（对应 qq-agent-plus「常用+未用轮换」）。
3. 图库 7→15 张 + 场景匹配（v0.3.2）。
4. **主动消息四条链路 + 决策留痕**（v0.4.0，`src/impulse/proactive-plan.ts`）：`follow_up` / `open_topic` / `life_share` / `silence_revive`，独立开关、各自概率与说话姿态；每次心跳记录原因，`/why` 可回答「她最近为什么没主动找我」；连推 2 条收手（对应 qq-agent-plus「主动发言三链路 + 跳过原因日志」）。
5. **深夜打字变慢**（v0.4.0，`src/bridge/humanizer.ts`）：23:00–06:00 打字时长 ×1.35、封顶 4.2s（对应 ai-companion-kit 的 Humanizer）。

**后续建议（按性价比）**

1. **群聊「插话/潜水」模型**（ai-bot-groupmate）——现在群聊只在被 @ 时回；这是主动链路之后最值得做的下一步。
2. **记忆热度 + 夜间 Dream 整合**（kiwi-mem）——T2 已有衰减，可加访问热度进入召回排序。
3. **会话交接摘要上限**（qq-agent-plus 省 Token）——历史已限最近 15 条 + 旧消息摘要 10×40 字，实际膨胀点待 [docs/PROMPT_BUDGET.md](PROMPT_BUDGET.md) 的实测结论。
4. **World Info 式按需注入**（SillyTavern）——人设细节按话题触发，降低常驻 token。
5. **ASR（语音转文字）**——参考 AIRI/Open-LLM-VTuber；目前用户发来的语音只当 `[语音]` 占位。

## 4. 说明

- 以上均为**设计参考**，未拷贝任何代码；本项目仍走自己的架构（人设六层 + 双管线 + T0–T3）。
- 星标、更新时间会变，引用时以抓取日期为准。
