# QQ 桥接端到端集成测试（mock OneBot + fake DeepSeek）

> 目的：在没有 QQ 账号 / NapCat / 真实模型的情况下，用**真实 bridge 进程**跑通主链路，作为 CI 的回归防线。
> 文件：`src/eval/bridge-e2e.test.ts`；运行：`npm test`（随全量测试）或 `npm run test:e2e`。

## 1. 架构

```
┌─────────────────────────── vitest 测试进程 ───────────────────────────┐
│                                                                        │
│  fake DeepSeek (HTTP)          bridge 子进程 (真实 src/bridge/qq.ts)    │
│  ├─ POST /chat/completions  ←──  async/stream/视觉/事实抽取             │
│  └─ GET  /img.png           ←──  图片下载（vision 用）                  │
│                                    ▲                                   │
│                                    │ OneBot 11 反向 WS（bridge 是服务端）│
│  fake NapCat (ws client) ──────────┘                                   │
│  ├─ 发 message 事件（私聊/群聊/图片）                                    │
│  └─ 收 send_private_msg / send_group_msg，断言内容                      │
└────────────────────────────────────────────────────────────────────────┘
```

- 临时工作区：`config.yaml`（测试专用配置）+ 复制 `personas/`；`KAREN_DATA_DIR` 指向临时目录；
- 随机端口 + `one_bot_token`，不共享真实数据/账号；
- fake DeepSeek 覆盖：普通非流式、SSE 流式、视觉（image_url）、事实抽取 JSON、检索重排 JSON；
- 桥接日志级别压到 warn，失败时错误信息带 bridge 输出尾部，便于定位。

## 2. 覆盖的主链路

1. **新用户**第一条私聊 → AI 披露 + 18+ 年龄门确认请求（不进入角色对话）；
2. 「我成年了」**+ 紧接着一条聊天**（同一 400ms 合并窗口）→ 确认后继续回复后半句（回归用例）；
3. 普通私聊 → 流式回复（SSE 分片 → QQ 消息）；
4. 图片消息 → vision 请求被调用（fake 服务断言 `image_url`）+ 正常回复；
5. 群聊 @ → `send_group_msg` 群回复；
6. 治理命令：`/about`（AI 披露 + 数据去向）、`/age`（已确认状态）；
7. 危机关键词兜底：强制回复 + 专业求助资源（断言消息含 12356）；
8. 多用户隔离 + 群聊合规拦截：第二个 QQ 新用户收到独立披露/年龄门；未确认 18+ 时群聊 @ 不回复（负向断言）；
   确认后私聊正常回复；数据库侧断言两个 owner 的同意记录、两份 `persona_id` 记忆（含 `qq-100000002` 后缀）；
   并断言用户 2 的 prompt 不包含用户 1 的对话内容（跨用户 prompt 泄漏回归）。

## 3. 它抓到过的真实 bug（已修）

| bug | 现象 | 修复 |
| --- | --- | --- |
| 确认年龄 + 下一句被合并吞掉 | 用户回「我成年了」后 400ms 内又说一句，两句被拼成一批；年龄确认分支提前 return，后半句永远没回复 | 确认后剥离确认标记，若还有剩余文本则继续走正常回复（`stripAgeConfirmationMarkers`） |
| 私聊缓冲消费竞态 | 极窄窗口内新消息入队时 `processing=true` 直接 return，而 drain 刚好退出 → 消息卡死不回 | `drainUserBuffer` finally 里再检查一次积压并重新排消费窗口 |
| 动态风格参考跨用户泄漏 | `retrieveStyleReference` 查 `t2_episodes` 时**没有 persona_id 过滤**，第二用户的 system prompt 里出现了第一用户的对话片段（隐私问题） | 查询增加 `persona_id = ?`（必填；缺省不检索），调用方传 `state.storagePersona`；单测断言两人片段互不出现，E2E 断言用户 2 prompt 不含用户 1 内容 |

## 4. 局限（如实）

- 模拟的是 **OneBot 协议层**，不是真实 NapCat：私有图片 URL、真实 QQ 消息格式差异、风控/封号、真实网络抖动都不覆盖；
- fake 模型只验证「桥接是否把消息送进/送出管线」，不验证回复质量（回复质量由长跑/记忆评测负责）；
- 不覆盖真实 QQ 的主动消息/定时心跳长跑（需真机）。
