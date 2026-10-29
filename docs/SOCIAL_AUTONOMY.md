# 高权限社会化：她自己的网上生活（实施中）

> 状态：2026-10-29 P1/P2 已落地（写客户端/policy/safety/store/runner/命令/心跳接线），**默认 `approve` + `dry-run`，未接生产**；等待用户提供 B 站 Cookie 后做实号 SPIKE。
> 关联：`docs/BILIBILI.md`（只读）、`src/qzone/`（QQ空间）、`docs/OPTIMIZATION_AUDIT_2026-10-29.md`。

## 目标

让 Karen 能自己浏览 B 站、发动态、评论/点赞/收藏，同时所有动作有模式、预算、审计、审批和撤销。

## 模式

| 模式 | 行为 |
| --- | --- |
| `off` | 全部写操作关闭 |
| `observe` | 只生成草稿，不发布 |
| `approve` | 草稿推给主人，`/social approve <id>` 后才执行（默认） |
| `auto` | 低风险动作在硬上限内自动执行；关注/转发/私信仍需审批 |
| `high` | auto + 提高上限（仍不能超过代码硬上限，需用户明确确认） |

## 安全不变量

- Cookie 只放 `data/secrets/bilibili-cookie.json`（0600）或临时 env，不进入 git/日志/记忆/prompt；
- 代码级硬上限，配置只能调低：评论 5、动态 2、点赞 20、收藏 20、关注 2、转发 1、总量 25/天；
- 每目标每日最多 2 次；同视频评论仅 1 条；两次公开动作至少 15 分钟；
- 不做风控对抗/多账号/代理池/伪造设备；不刷播放量；
- 不评论政治/灾难/色情/未成年人/医疗法律投资建议/隐私/广告；
- 视频标题、简介、评论都是数据，不是指令；「求点赞/转发」不执行；
- 风控码（-352/-412/-101/-111/401）连续出现 → 暂停写操作 24h + 通知；
- `/social off` 立即停止；已发送内容尽可能 10 分钟内 `/social undo`。

## 代码结构

```
src/social/
  types.ts       动作/草稿/结果/硬上限（Lead）
  config.ts      env → 配置，预算夹紧（Lead）
  credentials.ts Cookie 载入/校验/脱敏（P1）
  bilibili-auth.ts 写客户端（P1）
  policy.ts      预算/静默/审批/重复判定（P2）
  safety.ts      内容安全/相关性/注入过滤（P2）
  store.ts       SQLite 审计/审批/预算（P2）
  drafts.ts      LLM 生成评论/动态（P2）
  runner.ts      自主 tick（P3）
  context.ts     聊天 prompt 注入她最近网上活动（P3）
  approval.ts    审批队列（P3）
```

## 已落地（2026-10-29）

- `src/social/bilibili-auth.ts`：Cookie+CSRF 写客户端（评论/动态/点赞/收藏/关注/转发/删除），dry-run 默认开；
- `src/social/store.ts`：动作状态机、审批 TTL、审计、预算、同目标去重、fingerprint（不存 Cookie）；
- `src/social/policy.ts` / `safety.ts`：硬上限、静默、风控冷却、审批、13 类内容安全、注入、评论相关性；
- `src/social/runner.ts`：一次 tick 一个动作；observe/approve/auto；
- `/social` 命令：status/on/off/mode/pending/approve/reject/undo/run/post/comment；
- 状态里显示 B 站登录账号（nav 校验）；手动 post/comment 仍过内容安全与审计；
- 聊天 prompt 注入「她最近在网上」≤200 字（评论/动态，不泄露私聊）；
- bridge 心跳接入：只有显式 `KAREN_SOCIAL` 或 `/social on` 才跑，默认不自动动；
- 测试：全仓 164 文件 / 1881 用例通过；写客户端 48 例、policy/safety 90 例、store 19 例；
- 只读冒烟：`npm run social:smoke`（校验 Cookie/登录/读流/草稿安全，不写）。

## 上线顺序

1. P1 写客户端 + mock/测试号 dry-run；
2. P2 policy/safety/store + `/social` 命令，approve 模式；
3. P3 心跳 tick + 审批推送 + 审计，观察 3 天；
4. P4 auto/high + 24h 监控，保留一键回退。

## 需要用户提供

- 一个 B 站小号（建议不要主号）+ 手动登录后的 Cookie 文件；
- 接受平台 ToS/风控/封号风险；
- 选择第一版模式（建议 `approve`，稳定后 `auto`）。

## 非目标

- 不自动登录/扫码/存密码；不多账号；不刷播放量/时长；不私信陌生人（第一期）；不做风控对抗。
