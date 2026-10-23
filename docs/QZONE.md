# QQ 空间动态（Qzone）与热点

## 接口

走 NapCat 扩展 `send_qzone_msg`（不是 OneBot 标准）：

```json
{"action":"send_qzone_msg","params":{"content":"...","ugc_right":64}}
```

- `ugc_right`：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分屏蔽
- 默认 **64 仅自己可见**，先自己验证，再改 1
- 不需要在 Karen 里保存 QQ cookie；登录态由 NapCat 提供
- 纯文字动态已实现；图片数组接口预留，暂不自动配图

## 手动发

```env
KAREN_QZONE=on
KAREN_QZONE_UGC_RIGHT=64
```

QQ 里发送：

```text
/qzone 今天试了一下新的拉花，还是散的
```

## 自动发（默认关）

```env
KAREN_QZONE=on
KAREN_QZONE_AUTO=on
KAREN_QZONE_UGC_RIGHT=1
```

- 每 15 分钟心跳里 15% 概率尝试；
- 每天最多 1 条，只在 10:00–22:00；
- 素材来自已过滤的百度热搜；
- 用她的人设生成 20–50 字第一人称动态；
- 状态存 `data/qzone-state.json`；
- 失败不重试轰炸，下个心跳再试。

**风险**：QQ 空间自动发说是非标准操作，可能触发风控/被联系人看到；默认关闭，建议先用仅自己可见测试。

## 热点

```bash
npm run hot:show          # 人类可读
npm run hot:show -- --json
```

当前来源：百度热搜 top board；会过滤政治/灾难/国际冲突/犯罪类标题。
热榜也会按 1–2 小时门控注入她的聊天上下文。
