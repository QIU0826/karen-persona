# M2 产品化方案（待拍板）

> 日期：2026-10-20
> 状态：**方案稿，未开发**。M0 地基与 M1 核心闭环已完成（测试 59 文件 / 634 用例、桥接 mock E2E 覆盖主链路）。
> 原则：先定方向再动工；每个方向都给「能验收的最小版本」，不一次做全。

## 0. 一句话结论

M1 把「她真的会变化、会记得、像个活人」做通了；M2 要决定**卖给谁、怎么交付**：

| 方向 | 核心价值 | 成本估计 | 依赖 | 风险 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **A. 首次引导 2.0** | 降低新用户流失：安装 → 第一次对话 ≤ 5 分钟，且她记得这段对话 | 2–3 天 | 无外部依赖 | 低 | ✅ **先做** |
| **B. 人设包 v2** | 让「人设」成为可安装/可分享的资产（UGC 生态入口） | 2–3 天 | 需定义格式与校验 | 中（内容质量/版权） | 第二 |
| **C. 多租户 Web 控制台** | 从单机玩具 → 可交付给多个用户的本地服务 | 3–5 天 | 需要 A/B 稳定后再做 | 高（隐私/鉴权/并发） | 第三 |
| D. 真实 QQ 长跑 | 发现真机才有的问题（NapCat 私有 URL、风控、夜间补发） | 需要你参与 | 你的 QQ | — | 与 A 并行 |

> 说明：**真语义向量**（Qwen Key / 本地 embedding）是可选增强，不建议作为 M2 主线；当前 DeepSeek 重排已把 T2 recall@1 从 55% 提到 95%（见 `docs/SEMANTIC_BOOST_EVAL.md`）。

---

## 1. 现状盘点（M2 起点）

| 能力 | 现状 | M2 缺口 |
| --- | --- | --- |
| 安装引导 | `npm run setup`：选人设卡片 → 3 个对话式问题（怎么认识的/称呼/城市）→ 可选标签 → QQ 端口/白名单 → 写 config.yaml | 引导过程本身没有「被记住」；无「第一次启动即聊天」的入口；出错要重跑整个向导 |
| 人设 | `personas/<id>/persona.json` + `SKILL.md`，`npm run persona:create` 只生成骨架 | 无安装/版本/依赖/素材约定；分发给别人要手动拷目录 |
| Web 控制台 | 本地只读 MVP（`127.0.0.1:18082`）：聊天/记忆/时间线/状态成本；`?owner=` 只读查其他用户 | 无 owner 列表/切换；无写操作（删号/导出/暂停）；鉴权只有本机 token |
| 多用户 | owner=`qq:<id>`/`cli:local`，会话/状态/T2/T1 按 owner 隔离；E2E 验证过隔离 + prompt 不串 | 无「管理多个用户」的界面与服务端能力；无邀请/开通流程 |
| 合规 | 首次对话 AI 披露 + 18+ 年龄门（自我声明）+ 危机兜底 + `/about` `/age` | 无「删除我的数据」自助；无监护人/未成年人独立流程 |
| 成本 | `/cost` 按天/模型/用途（旁路已计入） | 无多用户成本分摊/预算告警 |
| 测试 | 59 文件 / 634 用例；桥接 mock E2E 11 个场景；长跑/记忆金标 | 无 setup 交互自动化测试；无多租户 Web E2E |

---

## 2. 方向 A：首次引导 2.0（建议先做）

### 2.1 目标 / 非目标

**目标**
1. 新用户从 clone 到「和她聊上第一句」≤ 5 分钟，中途失败可续跑。
2. 引导过程本身是一段**真实对话**（符合项目哲学：「Setup 是她和你的第一段对话，不是配置表单」）。
3. 这段对话**进入她的记忆**：之后她会自然记得「我们是怎么认识的 / 你叫什么 / 你在哪个城市」。
4. 明确披露 AI/18+/数据去向，并写入 `user_consent`，不靠重复提示。

**非目标**
- 不做图形安装器（保持 CLI + 浏览器宣传页）；
- 不做 QQ 扫码自动登录（NapCat 由用户自己配）；
- 不引入云端账号体系（那是方向 C）。

### 2.2 体验流程（目标态）

```
npm run setup
├─ 0. 环境自检（复用 npm run doctor）：Node/依赖/Key 缺失 → 给出可复制的修复命令
├─ 1. 「遇见她」：人设卡片（保留现有自述式卡片）
├─ 2. 「第一段对话」（由 her 人设驱动，不是问卷）
│    · 她：嘿，你是从哪知道我的？
│    · 她：那我该叫你什么？
│    · 她：我在上海，你呢？
│    · （可选）她：最近在忙什么？
├─ 3. 安全与知情：AI 身份 / 数据去向 / 18+ 确认（一次输入，写 consent）
├─ 4. QQ 桥接（端口/白名单/token）——可直接回车跳过，先用 CLI 试聊
├─ 5. 收尾：把这段对话写入会话与事实层 + 打印「怎么开始聊」三条命令
└─ 6. 可选：立刻 `npm run dev` 进入 CLI 试聊（她记得刚才的对话）
```

### 2.3 技术方案（尽量小改）

| 改动 | 说明 | 文件 |
| --- | --- | --- |
| 引导状态机 | 把 `setup.ts` 的问答流程抽成纯函数/状态机（步骤、默认值、校验、可回退），CLI 只负责 IO | `src/setup.ts` → `src/setup/flow.ts` + `src/setup.ts` |
| 引导结果落库 | 新增 `src/setup/onboarding.ts`：把「第一段对话」写成 3–6 条会话消息 + `user_facts`；`consent.confirmAge/ackDisclosure` 预置 | `src/setup/onboarding.ts`、`src/data/history.ts`、`src/data/user-facts.ts` |
| 首次启动识别 | `initConversation` 读到「onboarding 已完成」标记时，不重复发首次披露/年龄门 | `src/setup/onboarding.ts`、`src/bridge/qq.ts` |
| 失败可续 | 已写 config.yaml 的字段作为默认值；支持 `npm run setup -- --resume` | `src/setup/flow.ts` |
| 测试 | 状态机纯函数单测（10+ 条）；scripted stdin 的端到端引导测试（模拟输入 → 断言 config/consent/会话文件） | `src/setup/flow.test.ts`、`src/setup/onboarding.test.ts` |

**数据模型**：不新增数据库表；复用已有东西：
- 会话：`loadSession(persona, "")` + `addMessage` 写入「第一段对话」；
- 事实：`upsertUserFacts("qq:<id>"/"cli:local", {name, city, how_we_met})`；
- 同意：`confirmAge(owner)`、`ackDisclosure(owner)`；
- 引导标记：`data/onboarding.json`（`{ version, personaId, owner, completedAt }`，原子写）。

### 2.4 验收标准

- [ ] 全新目录 `npm run setup` 全程 ≤ 5 分钟，任意一步 Ctrl+C 后重跑不重复问已完成项；
- [ ] 完成后 `npm run dev` 第一句她就能叫出你的名字/城市（有测试断言）；
- [ ] 不会重复发「AI 披露/18+ 确认」（consent 已写）；
- [ ] 引导对话在 Web 控制台「聊天」里可见；
- [ ] 单测 + scripted E2E 全绿，`tsc`/lint/覆盖率阈值不退化。

### 2.5 成本与风险

- 估计 **2–3 天**（含测试与文档）；
- 风险：CLI 交互测试跨平台（Windows 换行）→ 用状态机纯函数 + 注入 IO 规避；`persona` 自述驱动需要读人设字段，缺字段时要有兜底文案。

---

## 3. 方向 B：人设包 v2

### 3.1 包格式（草案）

```
my-persona/
├─ manifest.json        # id/version/name/schemaVersion/minEngineVersion/author/license
├─ persona.json         # 现有六层人设结构
├─ SKILL.md             # 可选：她的自述
├─ assets/              # 可选：头像/贴纸/生活照（≤ 10MB，检查图片类型）
├─ memories/seed.jsonl  # 可选：记忆种子（3–20 条，安装时写入 T2，可关闭）
└─ README.md            # 可选：安装说明
```

### 3.2 能力

- `npm run persona:pack:validate <dir>`：schema/素材/体积/敏感字段检查；
- `npm run persona:pack:install <zip|dir>`：校验 → 复制到 `personas/<id>` → 可选写入记忆种子（临时 personaId）；
- `npm run persona:pack:list`：本地已装人设（版本/作者/是否可升级）；
- 版本迁移：`schemaVersion` 升级时自动跑 `loader` 迁移（现有 `CURRENT_SCHEMA_VERSION` 机制）。
- 分发：先支持「本地 zip / Git 仓库 URL」，不上市场（M3）。

### 3.4 交付记录（2026-10-20）

已实施最小可用版本：

- `src/persona/pack.ts`：manifest/素材/记忆种子校验（id 规则、语义化版本、personaSchemaVersion、minEngineVersion、素材大小/类型/数量、seed JSONL 解析与条数限制）+ 安装（拒绝覆盖；`--force` 备份到 `personas/.backups/`）+ 列表（legacy 标记）；
- `src/persona/pack-cli.ts` + npm 脚本：`persona:pack:validate` / `persona:pack:install`（`--force` / `--with-seeds`）/ `persona:pack:list`；
- 规范与示例：[docs/PERSONA_PACK.md](PERSONA_PACK.md)（含 manifest/seed 示例）；
- 测试：9 条（校验/安装/备份/种子/CLI 子进程）；全仓 63 文件 / 658 用例。

**未做**：zip/tar 解压安装、素材自动接入头像/贴纸路径、分发审核（M3）。

### 3.3 验收 / 成本 / 风险

- [ ] 生成一个示例包并安装、聊天、卸载；校验失败给出可读错误；
- [ ] 安装不会覆盖已有同 id 人设（需 `--force`）；
- [ ] 测试：manifest 校验、zip/目录安装、版本不兼容、素材超限；
- 成本 **2–3 天**；风险：UGC 内容质量/版权/NSFW 内容 → 包校验只做结构检查，上线分发前需人工审核（M3）。

---

## 4. 方向 C：多租户 Web 控制台

### 4.1 范围（本地多用户，不做云托管）

- 服务端：`/api/owners`（已聊天过的 owner 列表）、`/api/owner/<owner>/session|timeline|facts|export`、写操作（`/api/owner/<owner>/pause`、`/api/owner/<owner>/delete`）；
- 鉴权：保留 `web_token`；新增「owner scope」概念：默认只展示主用户，`--all-owners` 才展示全部；跨 owner 操作需 `admin token`；
- 前端：owner 下拉 + 现有四视图按 owner 过滤 + 删除/导出按钮（确认弹窗）；
- 数据：复用现有 owner 隔离（`owner.ts`），不新增表；
- 合规：`delete` 真正删除该 owner 的会话/状态/T2/T1/facts/consent/pending 队列，并写审计日志（脱敏）。

### 4.4 交付记录（2026-10-20，最小只读版）

- `src/web/owner-view.ts`：owner↔storageKey/persona 映射、扫描会话文件 + facts/consent 汇总已知 owner；
- `/api/owners`：返回 owner 列表（默认只回主用户；`web_all_owners: true` 才全量）；
- `?owner=` 作用域：`/api/overview|session|timeline|memory|memory-probe` 支持只读切换；未开启时跨 owner 返回 403，非法 owner 400；`/api/facts?owner=` 保持历史只读行为；
- 前端：顶栏 owner 下拉（>1 用户且开启才显示），切换后所有面板按 owner 重查；
- 配置：`web_all_owners`（config.yaml / `WEB_ALL_OWNERS`，默认 false）；桥接注入 primaryOwner。
- 测试：owner 映射/汇总 4 条、多用户 API（200/400/403/页面选择器）2 条、dashboard 渲染 1 条。

**已追加：单 owner 导出（2026-10-20）**——`GET /api/export?owner=` 直接下载 JSON（会话/人格状态/T2 记忆），不落盘；ASCII 安全文件名；默认仅主用户，`web_all_owners` 开启后可导出其他 owner；前端「导出当前用户」按钮。

**未做**：删除/暂停等写操作、admin token 区分、跨人设映射（`user_personas` 不同好友不同人设的 Web 展示）。

### 4.2 验收 / 成本 / 风险

- [ ] 两个 QQ 用户的数据在控制台可切换、互不串；删除用户 A 不影响 B；
- [ ] 未带 admin token 的请求不能跨 owner；
- [ ] 导出 JSON 与 `/export` 一致；
- 成本 **3–5 天**；风险：本地单进程 SQLite 并发、误删、token 泄露 → 删除需二次确认 + 审计；不建议在公网暴露。

---

## 5. 推荐顺序与理由

1. **A（首次引导 2.0）**：直接提升新用户成功率，改动集中、可测试，不依赖 QQ 真机；
2. **B（人设包 v2）**：把「她是产品」变成「人设是可流通资产」，为 M3 市场铺路；
3. **C（多租户 Web）**：在 A/B 稳定后做，否则会在会变的地基上加管理界面；
4. **D（真实 QQ 长跑）**：与 A 并行——你每次发消息/隔夜观察都能暴露真机问题（年龄门已就绪，下一条消息回「我成年了」即可）。

---

## 6. 决策记录（2026-10-20）

- **目标场景**：个人自用 + 朋友小范围（优先体验与惊喜感，工程/合规做到够用）。
- **第一方向**：**A 首次引导 2.0**（下一步直接开工）。
- 暂缓：B 人设包 v2、C 多租户 Web（等 A 完成且体验稳定后再评估）；D 真实 QQ 长跑与 A 并行（用户随时发消息即可）。

---

## 7. 方向 A 交付记录（2026-10-20）

已按本方案落地最小可用版本：

- `src/setup/flow.ts`：纯函数（标签/端口校验、config 合并保留扩展字段、第一段对话生成、事实生成、跳过判断）；
- `src/setup/onboarding.ts`：把引导对话写入会话 + `user_facts` + `user_consent`，原子写 `data/onboarding.json`（0600）；主用户与 CLI 共用 legacy 会话时只写一遍；
- `src/setup.ts`：新增知情/18+ 确认步骤；已完成引导直接跳过；`npm run setup -- --force` 重设；引导成功后打印「她记住了第一段对话」；
- 效果：CLI/QQ 首次聊天不再重复 AI 披露/年龄门，且她记得「怎么认识的 / 你叫什么 / 你在哪」；
- 测试：`flow.test.ts`（10）、`onboarding.test.ts`（4）、`setup-e2e.test.ts`（真实子进程 driver，1）；全仓 62 文件 / 649 用例。

**未做（后续）**：图形引导、QQ 扫码自动配置、对「引导后新增白名单用户」的自动补写（新用户仍走自己的披露/年龄门）。

---

## 8. 原始待拍板问题（已作答，保留备查）

1. **目标场景**：先按「个人自用 + 朋友小范围」打磨（A/B 优先），还是一开始就按「对外交付/收费」做（C 优先）？
2. **第一个 M2 方向**：A / B / C / D（真实 QQ 长跑）——如果没有偏好，我默认先做 A。
3. **交付形态**：CLI + `start-all.bat` 的本地安装包（现状），还是需要 Docker/一键脚本/桌面托盘？

> 回答后我会把对应方向拆成任务（含验收清单）直接开工；未回答时按默认「A 先行 + 你随时发 QQ 消息做 D」推进。
