# 能力与实测总表（v0.5–v0.8）

> 目的：一眼看清**哪些是真做了、做到什么程度**。每一行都必须能在代码里找到对应，
> 数字必须能复现（跑法写在「怎么复现」列）。不确定的地方写清楚弱项，不写成优点。
>
> 最后更新：2026-10-21（v0.9.7）。配套文档：[README](../README.md)（对外）、
> [CLAUDE.md](../CLAUDE.md)（开发总控）、[PRODUCT_AUDIT.md](PRODUCT_AUDIT.md)（审计与路线图）。

图例：✅ 可用 ｜ 🚧 有明确限制 ｜ ⛔ 受阻（代码就绪但依赖未到位）

---

## 1. 记忆

| 能力 | 代码 | 状态 | 实测 | 弱项 / 边界 |
|---|---|---|---|---|
| 本地真向量嵌入 | `src/data/local-embed.ts`、`services/embed/server.py` | ✅ | Qwen3-Embedding-0.6B（768 维）；批量 20 条 **137ms**（≈7ms/条）；127/127 条历史记忆重嵌入 | 需本机跑 `npm run embed:start`；服务不在时自动降级 n-gram |
| 向量 + FTS5 混合检索 | `src/data/retriever.ts` | ✅ | 检索 **p95 <100ms**（原 LLM 重排路径 ~664ms） | 语义级"改写重复"仍未处理 |
| 关掉每轮 LLM 重排 | `src/data/retrieval-boost.ts` | ✅ | 本地向量下默认关；开启后反而更慢且不更准（金标 16→17–18/20） | `KAREN_SEMANTIC_BOOST=on` 可强制开 |
| 锚点记忆（长期不忘） | `src/data/memory-v2.ts`、`scripts/anchor-smoke.ts` | ✅ | 关键事件永不衰减、双时间轴（否认只标记不删）；真实库当前 0 条（还在等"值得记"的事件） | 自动入库阈值 0.75 仍会漏无关键词事件 |
| 锚点日度 LLM 复筛 | `src/schedule/anchor-refine.ts`、`anchor-llm.ts`、`scripts/refine-smoke.ts` | ✅ | 30 条金标四次跑：**精确率 100%**（从不误建）、召回 82–100%、kind 79–94%；真实链路冒烟：该记的记住 / 闲聊不乱记 / 会注入（v0.8.15） | 漏记偏"越界/冲突"类；kind 不稳定（不影响记不记得） |
| 日记忆 / 周汇总 | `src/schedule/jobs.ts`、`scripts/digest-smoke.ts`、`scripts/rollup-smoke.ts` | ✅ | 真实数据一次生成 **1.5s**，抓到「橘猫/换工作/骂人推文截图」+2 条未完成话题 | 长周期摘要质量需按周抽检 |
| 事实层 + 状态机 | `src/data/user-facts.ts` | ✅ | pending/confirmed/**disputed**；冲突时她顺口确认一句（2 天内只问一次）；`/fact` 可确认/否掉 | 用户不自述时事实层为空 → 靠下一行补 |
| 认识初期主动提问 | `src/persona/get-to-know.ts` | ✅ | 亲密度 <5 时问工作/城市/宠物/名字/计划；间隔 ≥4 轮、问过不重复 | 只问 5 类主题，用户不答时不会追问 |
| 记忆注入预算 | `src/pipeline/memory-context.ts` | ✅ | 锚点占 60% 预算、日记忆装不下就整块跳过（`budgetChars=380`） | 预算偏保守，长对话里可能挤掉日记忆 |
| 记忆金标（40 条） | `src/eval/memory-eval.ts`、`src/eval/memory-gold.json` | ✅ | 离线：facts **100%**、recall@1 47.5% / @3 80% / **@8 97.5%**、合并 **100%**、anti-forget PASS | 离线强制 ngram 路径，非完整管线 |
| 真实模型记忆表现 | 同上（`--live`） | ✅ | 40 条：加"说出具体实体"规则前 85–92.5%，之后 **95–100%**（每版三次） | **单次波动可达 7+ 个点**，只报区间 |

**怎么复现**：`npm run eval:offline`（不联网）｜`npm run eval:memory -- --live --limit=40`（约 ¥0.01）

---

## 2. 拟人化交互

| 能力 | 代码 | 状态 | 实测 | 弱项 / 边界 |
|---|---|---|---|---|
| 打字节奏模拟器 | `src/bridge/pacing.ts` | ✅ | 人设×情绪×深夜×忙碌决定 readDelay/每字耗时/条间间隔/犹豫；默认人设白天 ≈285ms/字、深夜 ≈385ms/字 | "忙碌度"目前恒为 0（还没接她的日程） |
| 消息意图族 | `src/impulse/message-intent.ts` | ✅ | 四类：打错字 55% / 说重了 30% / 重发 15% / 犹豫（夜间/低落更易）；共享撤回护栏（仅私聊、危机禁用、0.5–5s） | 群聊不演；依赖 NapCat 返回 message_id |
| 表情包持续收集 | `src/data/sticker-library.ts`、`src/bridge/qq.ts` | 🚧 | 入站图片自动入库：sha256 去重、库容 500、单文件≤2MB、可一键清空 | **采集默认关**（`KAREN_STICKER_COLLECT=on`）；出站使用默认关（`KAREN_STICKER_USE=on`） |
| 内置贴纸 | `src/impulse/stickers.ts` | ✅ | 11 个 Twemoji（CC-BY 4.0），22% 概率顺手发、收到表情时 55%、5 分钟冷却 | 数量少，靠上一行补 |
| 语音消息（TTS） | `src/ai/tts.ts`、`src/impulse/voice.ts` | ✅/🚧 | macOS `say`→WAV→SILK→QQ 语音条；实测 2.4s 语音 ≈9.3KB | **音色仍偏 AI**（用户明确反馈）；非 macOS 降级文字；群聊未接 |
| 语音识别（ASR） | `src/ai/asr.ts`、`services/asr/server.py`、`scripts/asr-smoke.ts` | ✅ | **v0.9.0 新增**：faster-whisper CPU int8（small 484MB）；SILK→ASR 1414ms、WAV 962ms；OpenCC t2s 保证简体；`asr:robustness` 语速/台腔/粤语口音/5–10dB 噪声 CER 3.0–10.7%；失败回退 `[语音]` 占位；桥接 E2E 用**真实 SILK 入站**（断言 ASR 收到的是解码后的 WAV）且转写进 prompt；`voice` 长跑 4 轮：入站语音 2/ASR 2，语音事实被记住并答对（[报告](VOICE_ASR_E2E.md)） | 只支持中文；口音/噪声会错字；群聊语音不支持；服务需 `npm run asr:start` |
| 相识不编造 | `src/persona/meeting-guard.ts` | ✅ | 无依据时确定性删掉编造场景（吧台/下雨/借伞），整条都在编就换含糊回应 | 有依据时仍可能细节漂移 |
| **多媒体相关性** | `src/impulse/media-relevance.ts` | ✅ | 只在点名/场景命中/她刚分享生活时发图；场景配文池；21 轮评审 **2/5→4/5**（两轮复现） | 抽象话题下宁可少发，图库只有 15 张 |
| 被点名要媒体会真给 | `src/impulse/media-request.ts` | ✅ | 要照片跳概率判定（亲密度/冷却仍生效）、按场景挑图；要语音/表情提高概率并跳冷却 | 图库只有 15 张，仍会撞图 |

---

## 3. 关系、主动性与演化

| 能力 | 代码 | 状态 | 实测 | 弱项 / 边界 |
|---|---|---|---|---|
| 亲密度成长 | `src/persona/relationship.ts` | ✅ | 结构性事件驱动、每日 +0.1 上限、只增不减、带原因与里程碑 | 数值本身不区分"哪种亲近"（下一行补） |
| 五维关系 | `src/persona/relationship-dims.ts` | ✅ | 亲密/信任/张力/互惠/依赖，持久化 + 事件演化 + 张力随时间回落；注入 prompt 决定措辞倾向；`/relations` 可查 | 目前只影响措辞，不改门控（避免大范围联动风险） |
| 意图式主动性 | `src/impulse/initiative-plan.ts`、`src/schedule/initiative-llm.ts`、`src/impulse/initiative-reply.ts`、`src/eval/initiative-sim.ts` | ✅ | 每天 2–3 个由头（真实数据一次 **942ms**，如「裁员的事他到底怎么打算的」20–23 点）；按最近 10 次回复率校准 0–3 条 | 由头质量依赖日记忆；`KAREN_INITIATIVE=off` 可关 |
| 四条主动链路 + 护栏 | `src/pipeline/orchestrator.ts` | ✅/🚧 | 生活流/补一句/冷场开话题/沉默保温；单日 4 条 + 间隔 30 分钟 + 连推 2 条收手；`/why` 可解释 | 深夜被门控延后的主动不会早上补发 |
| 反思循环 | `src/evolution/reflection.ts` | ✅ | 觉察（同类信号 2 次 / 被点破 1 次）→否认（撑 6h）→被戳 2 次承认→整合期才真改一次；`/reflect` 可查；真实管线验证「第1轮察觉→第2轮嘴硬」 | 承认需要真实时间流逝（6h），短期内看不出完整弧线 |
| 演化副作用可见化 | `src/evolution/journal-view.ts`、`/journal` `/timeline` `/herview` `/evolution` | ✅ | 日记/时间线/她眼中的你/变化都能查，数据来自持久化快照 | 部分演化模块（叙事重构）仍偏半成品 |

---

## 4. 媒体

| 能力 | 代码 | 状态 | 实测 | 弱项 / 边界 |
|---|---|---|---|---|
| 本机生图（diffusers+MPS） | `src/media/comfyui.ts`、`services/image/server.py` | ✅ | `stabilityai/sdxl-turbo` fp16 已本地化（5.14GB）；**热态 2.1–2.2s/张**（832×1216，MPS）；`npm run image:smoke` 全过；mock 长跑真的发出 2 张生成图；失败静默回退图库 | 无角色一致性（只有场景照）；首次请求加载模型约 10s；服务需手动启动（`npm run image:start`） |
| 生成图治理 | `src/media/generated-store.ts` | ✅ | 按日期落盘、30 天自动清理、可 purge、可统计占用 | 依赖上一行启用才有内容 |
| 照片分享 | `src/impulse/unsplash-trigger.ts` | ✅ | 时间关系（今天/昨天/以前）+ 场景匹配（晚霞/雨/猫…）+ 亲密度门槛 | 无 Unsplash Key 时只有 15 张本地图 |
| 图片识别 | `src/ai/vision.ts` | ✅ | DeepSeek Flash 多模态，`detail=high`，截图逐字转述 ≤200 字 | 中文小字/模糊截图仍可能错 |

---

## 5. 语音（现状与阻塞）

| 项 | 状态 | 说明 |
|---|---|---|
| TTS → SILK → QQ 语音条 | ✅ | 仅 macOS；噪声/语速已有语气润色（v0.4.1） |
| 音色像真人 | 🚧 | **用户明确说"太 AI"**，已挂起。下一步是本地零样本克隆（IndexTTS），需要 10–20 秒参考音 |
| 语音 ASR | ⛔ | 用户发来的语音只当 `[语音]` 占位 |

---

## 6. 工程与评测

| 项 | 状态 | 实测 |
|---|---|---|
| 单元/集成测试 | ✅ | **110 文件 / 1316 用例**（`npm test`）；验证方法论见 [VERIFICATION_PLAYBOOK.md](VERIFICATION_PLAYBOOK.md)；覆盖核对见 [COVERAGE_AUDIT.md](COVERAGE_AUDIT.md)；文档数字核对见 `doc-facts.test.ts` |
| 类型检查 + lint | ✅ | `tsc --noEmit` 0 错误；`npm run lint`（未使用代码）0 违规 |
| 覆盖率 | 🚧 | 行 59.21%（`npm run test:coverage`，CI 阈值守护） |
| 离线评测守门 | ✅ | `npm run eval:offline`：facts≥95% / recall@8≥90% / 合并≥95% / anti-forget PASS / 锚点≥30 条；5 项全达标；CI 已接入 |
| 评测守门的自检 | ✅ | 10 条单测证明"该失败时会失败"（含 anti-forget 未跑也算失败） |
| 文档一致性 | ✅ | 7 条单测：README 的 `npm run` 脚本、斜杠命令、docs 链接必须真实存在 |
| 桥接 E2E | ✅ | mock-OneBot 冒充 NapCat + fake DeepSeek，覆盖披露/年龄门/私聊/图片/群聊/危机/多用户隔离 |
| 真实链路冒烟（5 条） | ✅ | 主动消息 / 锚点创建 / 日记忆 / 锚点复筛 / 周汇总；每条都抓到过编排层 bug、截断或断链 |
| 真机复盘（58 轮真实 QQ） | ✅ | 空回复 0 / AI 措辞 0 / 括号 0 / 平均 13 字 / 延迟 2067ms / ¥0.167459；发现并修掉 30 轮间距逐字重复 |
| 全链路回归（21 轮 mock） | ✅ | 见 [LONGRUN_V08_ANALYSIS.md](LONGRUN_V08_ANALYSIS.md)：0 错误 / 记忆探针 5/5 / 编造 0 / 多媒体 7+2+4+9 |
| 真实 QQ 长跑 | 🚧 | 已跑通（首轮 2 回合，¥0.0057；模拟 30 轮记忆 6/6、复读对 0）；仍需更多真机样本 |
| CI | ✅ | ubuntu/macOS/Windows 三平台 + Linux 覆盖率 + 离线评测守门 |

---

## 7. 明确未做的事（避免误解）

- **没有** ASR、没有语音克隆（音色仍假）、没有微信桥接（占位桩）。
- **没有** 生成图的角色一致性（未接 IP-Adapter/参考图）；生图服务需手动启动（`npm run image:start`）。
- **没有** 语义级"改写重复"处理（只有句式提醒，9 次 A/B 未测出稳定效果）。
- **没有** 交互式记忆编辑（只有 `/forget` 按关键词删 + Web 只读查看）。
- **没有** 商用多租户/托管；Web 控制台只读且只绑本机。
- 情色/恋爱向内容有 18+ 自我声明门槛，**不是身份证校验**；危机检测是关键词兜底，不是临床评估。

---

## 8. 怎么快速验证这份表没吹牛

```bash
npm run typecheck && npm run lint && npm test   # 代码/测试
npm run eval:offline                            # 记忆 40 条 + 锚点 30 条，卡阈值
npm run eval:memory -- --live --limit=40        # 真实模型记忆（约 ¥0.01）
npm run eval:anchor                             # 锚点复筛（约 ¥0.003）
npm run qq:watch -- --duration 1800             # 真实 QQ 长跑观察（需真机）
```

数字来源：`docs/MEMORY_EVAL_REPORT.md`、`docs/ANCHOR_EVAL_REPORT.md`、`docs/MOCK_VALIDATION.md`、
`docs/LONGRUN_REGRESSION.md`、`docs/PROMPT_BUDGET.md`、`docs/VOICE_QUALITY.md`。
