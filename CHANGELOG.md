# Changelog

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
