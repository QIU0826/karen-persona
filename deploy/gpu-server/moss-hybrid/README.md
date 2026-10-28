# MOSS v2 + Qwen 修脸「混合自拍」（task-29，shadow）

> 目标：验证「MOSS v2（identity LoRA ckpt1250）生成 + Qwen-Image-Edit 修脸」能否同时满足
> 「人物由 MOSS 生成」与「identity 接近 Qwen」。**不切生产**，默认自拍仍 Qwen-Image-Edit。
> 结论与数字见 [docs/HYBRID_SELFIE.md](../../../docs/HYBRID_SELFIE.md)；本文件是部署/接口说明。

## 1. 组成

| 文件 | 作用 |
|---|---|
| `wrapper_server.py` | FastAPI 服务端 wrapper：MOSS 生成 base → 临时落盘 → Qwen `/edit` 修脸 → PNG；端口 18118（**只绑 127.0.0.1**） |
| `start.sh` / `stop.sh` | podman 启停（`--network host` 复用宿主机回环访问 18116/18110；wrapper 本身不占 GPU） |
| `wrapper-smoke.sh` | 5 个场景经 wrapper 出图 + 耗时记录 |
| `contact_sheet.py` | 三/四列对照 contact sheet（MOSS base / Qwen direct / hybrid） |
| `../moss-image/merge_lora.py` | 复用：把 kohya LoRA merge 进 diffusers transformer → `MOSS-Image-SFT-karen-lora-v2-c1250/` |

依赖（均在 GPU 服务器常驻）：
- GPU6 `127.0.0.1:18116`：MOSS-Image-SFT + Karen identity LoRA **v2 ckpt1250** merged（`models/MOSS-Image-SFT-karen-lora-v2-c1250/`，252/252 modules merged，0 NaN）；
- GPU2 `127.0.0.1:18110`：Qwen-Image-Edit-2511（生产自拍同款）；
- 参考图：`/workspace/data/karen-ref-promo/character-2.jpg`（主参考）；`karen-selfie-cafe` 为**可选**第二参考（默认关：3 张参考会让 Qwen 改画幅、破坏「保持构图」）。

## 2. 启动 / 停止 / 健康

```bash
# 服务器
bash /mnt/data0/lwh/karen-stack/moss-hybrid/start.sh    # 默认 HYBRID_FIX_STEPS=15
curl -s http://127.0.0.1:18118/health | python3 -m json.tool
bash /mnt/data0/lwh/karen-stack/moss-hybrid/stop.sh
# Mac 隧道（scripts/gpu-tunnel.sh 已含 19118→18118）
ssh -N -L 127.0.0.1:19118:127.0.0.1:18118 <karen-gpu>
curl -s http://127.0.0.1:19118/health
```

安全基线：`ss -ltn | grep 18118` 必须只显示 `127.0.0.1:18118`（已在代码/start.sh 固定 `HYBRID_HOST=127.0.0.1`）。
容器使用 `--network host` 仅为访问同机 18116/18110；wrapper 不暴露其它端口。

## 3. HTTP API

### `GET /health`

```json
{"ok":true,"loaded":true,"service":"moss-hybrid",
 "moss":{"up":true,"latency_ms":10,"loaded":true},
 "qwen":{"up":true,"latency_ms":4,"loaded":true},
 "refs":["/workspace/data/karen-ref-promo/character-2.jpg"],
 "busy":false,"defaults":{"moss_steps":50,"fix_steps":15,"width":832,"height":1216}}
```

### `POST /selfie`（推荐）

```json
{"prompt":"咖啡馆窗边，午后暖光，穿着浅色牛仔外套，自拍",
 "width":832,"height":1216,"seed":4319,"fix_steps":15}
```

- wrapper 按关键词把中文/英文 prompt 映射到训练 caption 场景（咖啡馆/家/夜街/雨窗/海边/公园…），
  拼 `karen_style` + 身份（中蓝 bob #4a6fa5、灰蓝眼）+ 铅笔水彩画风，再调 18116 生成 832×1216 base（50 步）；
- 然后把 `[base, character-2]` 作为 `image_paths` 调 Qwen `/edit`，prompt 只修脸/五官，
  明确「保持构图/场景/服装/发型/水彩画风不变」；`fix_steps` 收敛 8–30（默认 15）；
- 返回 PNG，响应头：`X-Backend: moss-hybrid`、`X-Total-Ms`、`X-Moss-Ms`、`X-Fix-Ms`、`X-Qwen-Attempts`、`X-Image-Width/Height`；
- 单并发（`busy=true` 时返回 503）；临时 base 图落 `/workspace/data/tmp/hybrid-wrapper/`，每次请求 finally 删除，启动/请求时清理 >1h 残留。

### `POST /edit`（兼容现有 MOSS edit 客户端）

字段同 `src/ai/moss-image.ts` 的 `editMossImage()`：`prompt/image_paths/width/height/steps/seed`。
`image_paths` 里真实存在的服务器路径会作为 Qwen 的额外参考图；`steps` 用作修脸步数（8–30）。
因此**无需改 Node 代码**即可用 `KAREN_SELFIE_BACKEND=moss-edit` + `MOSS_IMAGE_EDIT_URL=http://127.0.0.1:19118` 接入；
本任务同时新增了更明确的 `KAREN_SELFIE_BACKEND=moss-hybrid` 分支（见 §5）。

## 4. 实验脚本与产物

```bash
# 5 个场景对照（MOSS base / Qwen direct / hybrid），产物在 data0
bash scripts/hybrid-selfie-bench.sh        # 仓库脚本；服务器上 scp 到 moss-hybrid/ 后运行
bash moss-hybrid/wrapper-smoke.sh          # wrapper 5 张 + 耗时
```

产物目录（服务器）：`/mnt/data0/lwh/karen-stack/data/tmp/hybrid/`
（`moss-base/`、`qwen-direct/`、`qwen-direct-v2/`、`hybrid/`、`identity-*/`、`contact-hybrid.jpg`）；
wrapper 测试：`data/tmp/hybrid-wrapper-test/`。

## 5. Node 接入（shadow）

| env | 默认 | 说明 |
|---|---|---|
| `KAREN_SELFIE_BACKEND` | `qwen` | 设 `moss-hybrid` 才走 wrapper；`KAREN_SELFIE_GEN=off` 仍优先关 |
| `MOSS_HYBRID_URL` | `http://127.0.0.1:19118` | Mac 隧道地址 |
| `KAREN_SELFIE_STEPS` | qwen 10 / hybrid 15 | hybrid 下是 Qwen 修脸步数（8–30） |

- `src/ai/moss-image.ts` 新增 `generateMossHybridImage()`（POST `/selfie`）；
- `src/media/selfie-generator.ts` 新增 `moss-hybrid` 分支：失败/guard 不过 → Qwen-Image-Edit → 本地图库；
  `backend`/`fallbackUsed` 可观测；
- `src/obs/dependency-health.ts` 增加 `selfie-moss-hybrid` 探活；
- `scripts/gpu-tunnel.sh` 增加 `19118→18118`。

## 6. 回退

```bash
# 生产不切：不设 KAREN_SELFIE_BACKEND=moss-hybrid（默认 qwen）
bash /mnt/data0/lwh/karen-stack/moss-hybrid/stop.sh   # 只停 wrapper；18116/18110 不受影响
```

## 7. 已知限制

- **总延迟**：MOSS ≈39–44s + Qwen 修脸 ≈55–72s（15 步/2 参考）→ **单张约 95–115s**；Qwen 偶发 500 重试时最坏 ~145s；远高于 Qwen 单跑（约 22–48s）。
- **单并发**：wrapper 单锁串行；并发请求直接 503。
- **Qwen 服务竞争**：18110 被其它任务占用时会 500，wrapper 内 3 次退避重试（5/10/30/60s 档）。
- **修脸增量有限**：hybrid identity 与 MOSS v2 单跑几乎一致（见 docs/HYBRID_SELFIE.md），主要收益是 Qwen 对局部画面的重绘；是否值得多花 ~70s 取决于产品取舍。
- 不产出 text/水印保证仅靠 prompt + guard；guard 仍有 2/5 失败场景（与 MOSS base 相同）。
