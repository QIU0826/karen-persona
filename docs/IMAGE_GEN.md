# 本地生图（v0.7）

> 目标：让她的照片不总是那 15 张图库——大约 20% 的照片由本机生成（"她此刻拍的"），其余仍用图库。
> 代码：`src/media/comfyui.ts`（客户端 + 提示词构造）、`src/media/generated-store.ts`（生成物治理）、`src/impulse/unsplash-trigger.ts`（接入照片链路）。

## 1. 为什么不是 ComfyUI 而是 diffusers

原计划用 ComfyUI（GitHub 140k★，GPL-3.0，进程外调用）。实测**本机到 GitHub 只有 ~17KB/s**，
`git clone` 一晚上都下不完；而同线路 PyPI 有 **2MB/s**、HuggingFace 峰值 **31MB/s**（间歇可用）。

于是改成：**`services/image/` + diffusers + PyTorch MPS**，自己暴露一个极简 HTTP 接口。
效果等价（本机出图、无 API Key），依赖走 PyPI，模型走 HF。

| 方案 | 结论 |
|---|---|
| ComfyUI（GitHub clone） | ❌ 克隆 17KB/s，不可行（代码保留兼容后端，`KAREN_IMAGE_BACKEND=comfyui` 可切回去） |
| **diffusers 服务（采用）** | ✅ torch 2.14.1 + MPS 可用、diffusers 0.41.0 装好；模型下载受 HF 间歇性影响，见 §5 |
| 云端 API | 未采用（用户选了本机） |

## 2. 目录约定（你要求的"好清理"）

| 内容 | 位置 | 清理方式 |
|---|---|---|
| Python 环境 | `services/image/.venv/`（约 2–3GB） | 删目录 |
| 模型缓存 | `$KAREN_MODELS_DIR/hf`（默认 `~/Library/Application Support/karen/models/hf`） | `npm run models:purge` 或删目录 |
| 生成图 | `$KAREN_DATA_DIR/generated/YYYY-MM-DD/` | 30 天自动清理；`npm run media:purge -- --images --yes` |

`npm run media:status` 会打印：开关、服务地址、程序/模型/生成图各自占用、uv 是否可用。

## 3. 开关

```bash
# 启用生成（默认关：只用图库）
KAREN_IMAGE_GEN=on
# 后端（默认 service=diffusers；comfyui 为兼容保留）
KAREN_IMAGE_BACKEND=service
# diffusers 服务地址（默认 127.0.0.1:18084）
KAREN_IMAGE_URL=http://127.0.0.1:18084
```

生成失败（服务没起/超时/太大/模型没加载）**一律静默回退图库**，不会阻塞聊天。

## 4. 行为

- 普通聊天里约 **20%** 的照片由生成；**用户点名要照片时不赌概率**，直接尝试生成（他要看"现在的"）。
- 提示词由 `buildScenePrompt` 拼：场景标签（晚霞/咖啡/雨/猫…）→ 具体画面 + 时段光线 + 情绪色调 +
  **手机随手拍质感**；刻意不放 `masterpiece/best quality` 这类 AI 味词。
- 负面提示词压制：文字水印、多余手指、卡通/3D 感。
- 生成图写在 `data/generated/日期/`，30 天后自动清理。

## 5. 当前状态与已知阻塞（如实）

- ✅ 代码、测试（18 条）、目录治理、接入照片链路、降级路径全部完成。
- ✅ `torch 2.14.1` + `MPS` 可用；`diffusers 0.41.0` 已装；服务 `/health` 正常。
- ❌ **模型下载受网络阻塞**：`stabilityai/sdxl-turbo`（6.9GB）与 `segmind/tiny-sd`（约 1GB）
  在本机多次尝试都卡住/报 `LocalEntryNotFoundError`（HF 连接间歇性中断；此前下 Qwen 向量模型时
  一度跑满 31MB/s，说明是链路波动而非配置问题）。
- 因此 `KAREN_IMAGE_GEN` 默认仍是 **off**：生图链路就绪但没启用，照片继续走图库。

**手动补模型（任一网络更稳的时候）**：

```bash
# 1) 下载模型（会存到 KAREN_MODELS_DIR/hf）
KAREN_MODELS_DIR="$HOME/Library/Application Support/karen/models" \
HF_HOME="$KAREN_MODELS_DIR/hf" \
services/image/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('stabilityai/sdxl-turbo', allow_patterns=['*.json','*.txt','*.safetensors','*.fp16.safetensors'])"

# 2) 起服务
KAREN_MODELS_DIR="$HOME/Library/Application Support/karen/models" services/image/.venv/bin/python services/image/server.py

# 3) 冒烟（应返回 PNG）
curl -X POST http://127.0.0.1:18084/generate -H 'Content-Type: application/json' \
  -d '{"prompt":"warm sunset over rooftops, smartphone photo","seed":42}' -o /tmp/test.png

# 4) 打开开关并重启桥接
#    .env 里加 KAREN_IMAGE_GEN=on
```

若只想先用小模型验证：把 `KAREN_IMAGE_MODEL=segmind/tiny-sd`（质量一般但快）。

## 6. 局限

- 没有角色一致性（未接 IP-Adapter / 参考图），所以生成图多为"场景/氛围照"，不放正脸；
  要拍到"她本人"需要后续接参考图条件（v0.8 之后再评估）。
- 单张预期耗时未在真机上验证（模型没下完），代码里上限 25s、超时回退。
- GPU 只有 MPS（M5 Pro），并发下会互相拖慢；因此一次只生成一张，不做批量。
