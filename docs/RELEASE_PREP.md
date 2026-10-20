# 发布准备（Release Prep）

> 状态：**已拍板发布 v0.2.0（2026-10-20）**。本文件记录可复现的检查结果、发布决策与执行记录。
> 版本：`0.2.0`。远端：`origin` → `https://github.com/QIU0826/karen-persona.git`（远端现有分支为 `master`，本地为 `main`）。

## 1. 已完成检查（可复现）

### 1.1 干净 checkout 验证

```bash
TMP=$(mktemp -d)
git archive HEAD | tar -x -C "$TMP"
ln -s "$PWD/node_modules" "$TMP/node_modules"
cd "$TMP"
node node_modules/tsx/dist/cli.mjs src/doctor.ts     # 无 config/.env 时给出可执行修复指引
node node_modules/typescript/bin/tsc --noEmit        # 0 错误
node node_modules/vitest/vitest.mjs run              # 68 文件 / 682 用例全绿
```

结果（2026-10-20）：typecheck 0 错误；679 用例全绿（含 mock-OneBot bridge E2E、setup E2E、人设包、多用户 Web、真实长跑报告）；`doctor` 在缺 `config.yaml` / `.env` 时输出 ✅/❌ 清单和修复命令，不崩溃。

### 1.2 仓库卫生 / 隐私

| 检查 | 结果 |
|---|---|
| `.env` / `config.yaml` / `data/` / `coverage/` / `.runtime/` 是否入库 | ✅ 均未跟踪 |
| 真实密钥扫描（`sk-…`、NapCat token、WebUI token） | ✅ 仅文档/示例里的占位（`sk-your-key-here`、`sk-xxxxxxxxxxxxxxxx`） |
| 真实对话原文 | ✅ 只在本地 `data/realrun-*.md`（600 权限）；`.gitignore` 已加 `data/*.md`，文档只写转述 |
| 跟踪文件 | 257 个，约 12.6MB（最大的 `promo/assets/*.mp4` ~6.6MB） |
| `.git` 大小 | ~21MB |
| 远端 | `origin` → `https://github.com/QIU0826/karen-persona.git`；尚未 push/tag |

### 1.3 安全默认

- Web 控制台 / 健康检查只绑 `127.0.0.1`；可选 `web_token`；CSP `default-src 'none'`；出口 CQ 转义；白名单；消息去重；延迟补发落库。
- 合规：AI 披露（`ai_disclosure` 默认开）、18+ 自我声明年龄门、危机关键词强制回复 + 专业求助资源。
- 已知局限（发布说明必须保留）：年龄门是自我声明、危机检测是关键词兜底（非临床）、NapCat 非官方协议有封号风险、群聊是半成品。

### 1.4 真机与测试

- 真实 QQ 长跑：首轮 2 个完整回合，平均延迟 2876ms，成本 ¥0.005650，空/重复 0；暴露的「老用户无 AI 披露」「快速追问被误延迟 31 分钟」已修复（见 [QQ_REAL_RUN.md](QQ_REAL_RUN.md)）。**样本仍少**。
- 测试：68 文件 / 682 用例；`tsc` 0、lint 0；覆盖率行 54.2%（CI 阈值守护，Linux）。
- CI：ubuntu / macOS / Windows 三平台矩阵；Linux 额外跑覆盖率。

## 2. 发布决策与待办

已拍板：**升级 v0.2.0 + push + tag**。

- [x] 版本号 `0.1.0` → `0.2.0`（无破坏性变更）
- [x] 干净 checkout、密钥扫描、仓库卫生检查
- [ ] push `main` 到远端（远端 `master` 是上游旧历史，本次**不 force push**；详见 §5）
- [ ] push tag `v0.2.0`
- [ ] GitHub CI 三平台绿
- [ ] 提醒用户：宣传页素材公开许可 / DeepSeek Key 轮换 / 朋友试用邀请文案（如需要）

## 3. 你批准后的发布步骤（草案）

```bash
# 1) 版本号
npm version 0.2.0 --no-git-tag-version   # 只改 package.json + lock（或手动改为 0.2.0）
# 2) 再跑一次完整验证
npm run typecheck && npm run lint && npm test && npm run test:coverage
# 3) 提交 + 打 tag
git add package.json package-lock.json && git commit -m "chore: release v0.2.0"
git tag -a v0.2.0 -m "Karen v0.2.0：M2 产品化（首次引导/人设包/多用户只读 Web/真实长跑工具）"
git push origin main --follow-tags
# 4) GitHub Release：粘贴下方草案，确认 CI 三平台绿
```

## 4. Release Note（v0.2.0，可直接用于 GitHub Release）

**Karen v0.2.0 — M2 产品化**

- **首次引导 2.0**：`npm run setup` 变成「你们的第一段对话」，名字/城市/认识方式写入记忆，并完成 18+ 确认（AI 披露默认关闭）；已完成过引导会跳过，`--force` 重设。
- **人设包 v2**：`manifest.json` + `persona.json` + 可选素材/记忆种子；`npm run persona:pack:validate/install/list`，覆盖安装自动备份，种子默认不写库。
- **本地 Web 控制台**：多用户只读切换（默认关，`web_all_owners: true` 开）、单用户 JSON 导出、健康/成本视图；仍只绑本机。
- **真实 QQ 长跑工具**：`npm run qq:watch -- --duration 1800`，只读观察真实回合/延迟/成本/事实/同意并生成本地报告。
- **真机修复**：快速追问不再被随机延迟；AI 披露改为默认关闭（可显式开启）；`/about` 文案支持当前人设名。
- **质量**：67 测试文件 / 679 用例；`tsc` 0、lint 0、行覆盖 54.2%；干净 checkout 复验通过。

**升级提示**：老数据无需迁移；**AI 披露默认关闭**（不在聊天里出现；公开发布/商用可在 `config.yaml` 打开 `ai_disclosure: true`）。**已知限制**见 README「已知限制」：18+ 为自我声明、危机检测为关键词兜底、NapCat 有封号风险、群聊为半成品、无 TTS/图片生成、真语义向量需 Qwen Key。
