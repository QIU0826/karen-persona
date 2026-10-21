# 能力覆盖审计（Capability Coverage Audit）

> 最后更新：2026-10-21（v0.9.4）
>
> 目的：回答「文档里写着 ✅ 的能力，到底被验证到什么程度？」
> 三层口径：**① 文档宣称 → ② 单测覆盖 → ③ 真实链路/端到端覆盖**。
> 原则：**宁可标"未验证"，不把"设计目标"写成"已实现"**（见 CLAUDE.md 开发约定第 1 条）。

## 口径说明

| 层 | 含义 | 判定方式 |
|---|---|---|
| ① 宣称 | 能力总表 `docs/CAPABILITY_MATRIX.md` 里的状态（✅/🚧/⛔） | 人工维护，被 `src/eval/docs-consistency.test.ts` 校验路径存在 |
| ② 单测 | 该能力引用的代码至少被一个测试文件覆盖 | **自动化**：`src/eval/coverage-audit.test.ts`（标 ✅ 的能力缺单测会失败） |
| ③ 真实链路 | 真的跑过一次（真实模型或真实桥接），不是纯函数断言 | 人工维护 + 对应 `npm run *:smoke` / `test:e2e` / 真机复盘 |

② 是自动护栏，③ 靠这份文档 + 验证手册（[VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md)）维护。

## 一、记忆与数据（核心能力，验证最充分）

| 能力 | 宣称 | 单测 | 真实链路验证 | 结论 |
|---|---|---|---|---|
| 本地真向量嵌入（Qwen3-Embedding-0.6B，768 维） | ✅ | ✅ | `services/embed` 实测 127/127 条重嵌入、检索 p95 <100ms | 已验 |
| 向量 + FTS5 混合检索（RRF） | ✅ | ✅ `retriever.test.ts`（行为契约：召回/排除内部来源/persona 隔离/limit） | `eval:offline` 40 条金标 recall@8 97.5%；21 轮/58 轮长跑 | 已验 |
| 锚点记忆（长期不忘） | ✅ | ✅ `memory-v2.test.ts`（含至亲离世正反例） | `npm run anchor:smoke`（真实模型）：该记记住/闲聊不记/会注入 | 已验 |
| 锚点日度 LLM 复筛 | ✅ | ✅ `anchor-refine.test.ts`（含幂等 3 条） | `npm run refine:smoke`（真实模型）：3 条值得记全建、闲聊 0 误建、重跑候选 0 | 已验 |
| 日记忆生成 | ✅ | ✅ `jobs.test.ts`（截断/幂等/解析） | `npm run digest:smoke`（真实模型）：事实不丢、同日幂等、92 条长日对抗 | 已验 |
| 周汇总 | ✅ | ✅ `jobs.test.ts`（7 天覆盖/话题保留/≤400 字） | `npm run rollup:smoke`（零成本）：7 天全覆盖、注入文本 188 字 | 已验 |
| 记忆注入预算 | ✅ | ✅ | 同上（注入路径由 `digest/anchor/rollup` 冒烟覆盖） | 已验 |
| 记忆金标（40 条） | ✅ | ✅ `memory-gold.test.ts`（id 唯一/字段齐全/答案有原文依据） | `eval:offline`（CI 每次跑，卡阈值） | 已验 |
| 事实层 + 状态机 | ✅ | ✅ `user-facts.test.ts` 等 | 30 轮真实长跑：city/job/pet 抽取修复后正确 | 已验 |
| 认识初期主动提问 | ✅ | ✅ | 30 轮长跑 + 真机 58 轮（会话中观察到） | 部分验（未专门冒烟） |

## 二、拟人化交互

| 能力 | 宣称 | 单测 | 真实链路验证 | 结论 |
|---|---|---|---|---|
| 打字节奏模拟器 | ✅ | ✅ `pacing.test.ts` | 21 轮长跑延迟归因（深夜 395ms/字）；E2E 中 NODE_ENV=test 快速模式 | 已验（延迟特性） |
| 消息意图族（打错字/撤回/重发） | ✅ | ✅ `typo-recall.test.ts` + fake WS 链路 | 未在真实 QQ 上触发过（概率 4%） | **未验（真实触发）** |
| 表情包持续收集 | 🚧 | ✅ `sticker-library.test.ts` | `bridge-e2e`：入站图片→入库（真实 bridge 子进程） | 已验（采集） |
| 内置贴纸 | ✅ | ✅ `stickers.test.ts` | `bridge-e2e`：出站 CQ image 发送 | 已验 |
| 语音消息（TTS→SILK） | ✅/🚧 | ✅ `voice.test.ts`（35 条）+ darwin-only 真实 say→silk | 真实 QQ 语音条只人工验过 1 次；mock OneBot 覆盖协议形态 | 部分验 |
| 语音识别（ASR） | ✅ | ✅ `asr.test.ts`（11 条，含 silk-wasm 真实编解码往返） | `asr:smoke` 真实服务：SILK→ASR 1414ms「今天天气不错…」/ WAV 962ms「明天下午3点开会。」；桥接 E2E **真实 SILK 入站**（断言送给 ASR 的是解码后的 WAV）且转写进 prompt；`--scenario voice --voice-in` 真实长跑：入站语音 2 条 / ASR 成功 2 次，语音说的事实被记住，文字回问 1/1 通过 | 已验 |
| 相识不编造 | ✅ | ✅ `meeting-guard.test.ts` | 21 轮回归：P0 编造「咖啡店」修复后复验改口 | 已验 |
| 多媒体相关性 | ✅ | ✅ `media-relevance.test.ts` | 21 轮评审 2/5 → **4/5**（两轮复现） | 已验（定性） |
| 被点名要媒体会真给 | ✅ | ✅ `media-request.test.ts` | `bridge-e2e` 图片链路；21 轮中照片请求兑现 | 已验 |

## 三、关系与主动性

| 能力 | 宣称 | 单测 | 真实链路验证 | 结论 |
|---|---|---|---|---|
| 亲密度成长 | ✅ | ✅ `relationship.test.ts` | 真机 58 轮 + 持久化重启验证 | 已验 |
| 五维关系 | ✅ | ✅ `relations` 相关测试 | `/relations` 真机可见；`mock-longrun` 采集运行时状态 | 已验（可见性） |
| 意图式主动性 | ✅ | ✅ `initiative-plan.test.ts` + `initiative-priority.test.ts` | `initiative:sim`（时序）+ `proactive:smoke`（真实模型）；**由头内容 before/after 评测**：她自己的生活条目 0→8、纯追问 24→0、自然度 1→4（`proactive:content-eval`，8 组上下文） | 已验 |
| 四条主动链路 + 护栏 | ✅/🚧 | ✅ `proactive` 相关测试 | `initiative:sim` 7 条红线全过；21 轮评审**主动性仍 3/5、未测出提升（如实记录）** | 已验（未提升） |
| 反思循环 | ✅ | ✅ `reflection.test.ts` | 编排状态在 `mock-longrun` 可采集；**真实模型下"察觉→承认"完整弧线未专门冒烟** | **部分验** |

## 四、媒体与外部世界

| 能力 | 宣称 | 单测 | 真实链路验证 | 结论 |
|---|---|---|---|---|
| 照片分享（本地图库 + 配文） | ✅ | ✅ `photo-library.test.ts` 等 | 21 轮：多媒体 2/5→4/5；真机 E2E 收到配文+图片 | 已验 |
| 图片识别（DeepSeek Flash 多模态） | ✅ | ✅ E2E fake 视觉 | 真实中文会议截图 OCR 四行全对（人工真机）；E2E 每次跑 | 已验 |
| 生成图治理（落盘/清理/统计） | ✅ | ✅ `generated-store.test.ts` | 临时目录实测；真实生成图落盘统计已验（image:smoke） | 已验 |
| 本机生图（diffusers+MPS） | ✅ | ✅ `comfyui.test.ts` | `image:smoke`：真出图 832×1216 / 热态 2.1–2.2s / 同 seed 可复现；mock 长跑里真的发出 2 张生成图 | 已验 |
| 天气 / 时间感知 | ✅ | ✅ `weather.test.ts` | 真机 `/stats`、状态注入可见 | 已验 |
| 网络热点 | 🚧 | ✅ | 硬编码话题池，未真实注入观察 | 部分验 |

## 五、工程与评测

| 能力 | 宣称 | 单测 | 真实链路验证 | 结论 |
|---|---|---|---|---|
| 六层验证体系 | ✅ | ✅ 各 smoke 脚本自身有断言 | 5 条冒烟 + 桥接 E2E 全部实跑（见 [VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md)） | 已验 |
| 桥接 E2E（fake OneBot + fake 模型） | ✅ | ✅ `bridge-e2e.test.ts`（5 场景） | 真实 bridge 子进程，连跑 3 次稳定 | 已验 |
| 离线评测守门（40+30 条） | ✅ | ✅ 守门自带"该失败时会失败"测试 | CI 每次跑 | 已验 |
| 文档一致性（命令/路径/版本号/手册） | ✅ | ✅ `docs-consistency.test.ts`（14 条） | 每版本发布前跑 | 已验 |
| 能力×单测覆盖核对 | ✅ | ✅ `coverage-audit.test.ts`（v0.8.21 新增） | 本审计 | 已验 |
| 真机复盘工具（`qq:watch`） | ✅ | ✅ `qq-realrun` 相关测试 | 58 轮真实数据跑过 2 次 | 已验 |

## 六、明确「未验证 / 不存在」清单（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| 语音零样本克隆 | ❌ 不存在 | 需要 10–20s 参考音；音色仍偏 AI（按用户要求暂停） |
| 打错字撤回的真实触发 | ⚠️ 未验 | 4% 概率 + 依赖 NapCat echo；只在 fake WS 验过 |
| 反思循环完整弧线（真实模型） | ⚠️ 未验 | 单测覆盖状态机；真实模型下"被点破→承认→改一次"未专门冒烟 |
| 群聊语音发送 | ❌ 未接线 | 决策层有开关，私聊才真正发 |
| 出站 mface/收藏表情 | ❌ 未做 | 只有内置贴纸 + 收集来图片 |
| 生成图角色一致性 | ⚠️ 未做 | 只有场景/氛围照，生成「她本人」需接 IP-Adapter/参考图 |
| ASR 口音/噪声鲁棒性 | ⚠️ 部分验证 | `asr:robustness`：TTS 标准/慢/快/台湾腔/粤语口音 + 合成 5–10dB 噪声，CER 3.0–10.7%，small 够用；**真实人声/真实环境噪声样本仍缺** |
| ASR 群聊语音 | ❌ 未做 | 群聊语音仍不支持（无法区分说话人） |
| 微信桥接 | ❌ 占位桩 | 无依赖 echo |
| 多实例商用托管 | ❌ 未做 | M3 |
| 真实 QQ 长期稳定性 | ⚠️ 样本不足 | 58 轮 + 30 轮模拟，仍需更多真机数据 |

## 七、本轮（v0.8.21）核对发现并修掉的缺口

三层核对（新增 `coverage-audit.test.ts`）当场抓到 4 个「宣称 ✅ 但没有单测」的能力：

| 能力 | 缺口 | 处理 |
|---|---|---|
| 向量 + FTS5 混合检索 | `retriever.ts` 从无直接单测（只有黑盒金标） | 新增 `retriever.test.ts` 8 条：召回/排除内部来源/persona 隔离/limit/RAG 格式 |
| 意图式主动性 | `initiative-llm.ts` 序列化无单测 | 新增 `initiative-llm.test.ts` 4 条：往返一致/坏 JSON→null/空计划合法 |
| 生成图治理 | `generated-store.ts` 只有间接引用 | 新增 `generated-store.test.ts` 5 条：保存/统计/prune/purge/空输入 |
| 记忆金标（40 条） | 金标集自身没有校验，坏了评测会静默失真 | 新增 `memory-gold.test.ts` 4 条：数量/id 唯一/字段齐全/答案有原文依据 |

另外修正了核对器的一处误判（`name-nickname`/`work-role` 允许多种可接受叫法，断言改为"至少一个答案有原文依据"）。

## 八、维护约定

- 新增能力：先更新 `CAPABILITY_MATRIX.md`，再确认 `coverage-audit.test.ts` 通过（否则补单测或加白名单并写理由）。
- 新增"真实链路已验"结论：必须能在 [VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md) 第 2 节找到对应命令，并注明是真实模型还是 fake。
- 本文件只写**已发生的事实**；未验证的写在第六节，不许挪到上面表格里"看起来已完成"。
