# Changelog

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
