# MOSS-Image-SFT 服务（GPU7）

> 状态：**2026-10-27 部署**。模型 `OpenMOSS/MOSS-Image-SFT`（5.1B DiT + Qwen3.5-9B text encoder，Apache-2.0，ModelScope 约 27.2GB）。
> 端口：生成 `127.0.0.1:18114`、编辑 `127.0.0.1:18115`（Mac 隧道 `19114/19115`）。单卡 GPU7，单并发。
> 用途：**先 shadow**，替换 Z-Image（场景）/ Qwen-Image-Edit（自拍）之前先做基准与人工抽检；生产默认不变。

## 1. 模型与权重

```text
ModelScope: openmoss/MOSS-Image-SFT（README/权重均 Apache-2.0）
本地路径:   /mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT   ≈ 27.2GB
```

服务器到 HuggingFace / hf-mirror 均不通（`curl` 返回 000），**ModelScope 可用**，因此统一从 ModelScope 下载：

```bash
# 方式 A（本项目实际使用）：按文件清单并发 curl，断点续传，日志落 data0
bash /mnt/data0/lwh/karen-stack/moss-image/download_model.sh

# 方式 B：modelscope CLI（需先在 data0 venv 里 pip install modelscope）
modelscope download --model openmoss/MOSS-Image-SFT \
  --local_dir /mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT
```

下载脚本把 35 个文件（37 个 blob 里 VAE 单文件 250MB 单独先下）放到目标目录；模型目录结构为 diffusers 格式：

```text
model_index.json          # _class_name=MOSSImagePipeline, diffusers 0.38
pipeline_moss_image.py    # 自定义 MOSSImagePipeline/MOSSImageTransformer/MOSSImageScheduler
scheduler/ transformer/ text_encoder/ tokenizer/ vae/
```

> 根分区只有 ~11GB：**模型、HF 缓存、venv、bench 图全部放 `/mnt/data0`**；不要 `podman build` 大镜像。

## 2. Python 环境（/mnt/data0 venv，实跑路径）

官方要求：Python 3.10+、PyTorch 2.9+、`diffusers>=0.38`、`transformers>=5.3`、`accelerate>=1.10`。

服务器已有基础镜像 `localhost/karen-qwen-image-edit:0.1`（Python 3.11.13 / torch 2.8.0+cu128 / diffusers 0.39.0），
为避免重新下载 torch（3GB+）并少占根分区，采用「基础镜像 python + data0 venv（--system-site-packages）」：

```bash
# 1) 用容器里的 python 在 data0 建 venv（继承镜像 site-packages）
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint python localhost/karen-qwen-image-edit:0.1 \
  -m venv /workspace/moss-image/venv --system-site-packages

# 2) 升级 MOSS 必需依赖（装进 data0 venv，不进根分区）
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/pip localhost/karen-qwen-image-edit:0.1 \
  install -U "transformers>=5.3" "diffusers>=0.38" "safetensors>=0.6" "Pillow>=10" "accelerate>=1.10"

# 3) 验证（本机实测）
#    torch 2.8.0+cu128 / diffusers 0.42.0 / transformers 5.21.0 / accelerate 1.15.0
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  -c "import torch,diffusers,transformers;print(torch.__version__,diffusers.__version__,transformers.__version__)"
```

> 已知差异：官方要求 torch>=2.9，实际基础镜像为 **torch 2.8.0+cu128**；本次真实出图验证可用（见 §6）。
> 如未来 pipeline 用到 2.9+ API 再在 venv 里单独装 torch（会多 ~3GB 下载 + ~8GB 磁盘，仍在 data0）。

## 3. 启动 / 停止 / 回退

```bash
# 启动（容器名 karen-moss-image，CDI GPU7，只绑 127.0.0.1）
bash deploy/gpu-server/moss-image/start.sh

# 查看日志 / 健康
podman logs -f karen-moss-image
curl -s http://127.0.0.1:18114/health

# 停止（端口立即释放；模型与 venv 保留）
bash deploy/gpu-server/moss-image/stop.sh

# 回退：停服务 → 生产 env 去掉 KAREN_IMAGE_BACKEND=moss-image / KAREN_SELFIE_BACKEND=moss-edit
#       → 恢复 KAREN_IMAGE_BACKEND=z-image / 不设 SELFIE_BACKEND（默认 qwen）。无需删模型。
```

启动细节（与 `start.sh` 等价）：

```bash
podman run -d --name karen-moss-image \
  --device nvidia.com/gpu=7 \
  -p 127.0.0.1:18114:18114 -p 127.0.0.1:18115:18115 \
  -e MOSS_IMAGE_MODEL_DIR=/workspace/models/MOSS-Image-SFT \
  -e MOSS_IMAGE_HOST=0.0.0.0 \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/python \
  localhost/karen-qwen-image-edit:0.1 /workspace/moss-image/server.py
```

**不要加 `--restart=unless-stopped`**：GPU7 是共享卡，重启机器后不应静默占卡；需要常驻时由人工确认后再加。

## 4. API

### `GET /health`（18114/18115 都有）

```json
{
  "ok": true, "loaded": true, "loading": false,
  "model": "/workspace/models/MOSS-Image-SFT",
  "load_ms": 123456, "load_mode": "pipeline_moss_image.MOSSImagePipeline",
  "device": "cuda",
  "defaults": {"steps":50,"guidance_scale":3.0,"uncond_skip_layers":[22],"multiple":16},
  "generate_count": 4,
  "last_generate": {"elapsed_ms": 24500, "width": 832, "height": 1216, "steps": 50, "peak_allocated_gb": 55.2},
  "gpu": {"name":"NVIDIA RTX 6000D","total_gb":83.0,"free_gb":75.8,"allocated_gb":...}
}
```

模型加载在后台线程，进程先监听端口，`loaded:false`/`loading:true` 表示还在加载；加载失败时 `load_error` 给出原因，`/generate` 返回 503。

### `POST /generate`（18114）

请求：

```json
{"prompt":"傍晚的城市屋顶，暖色天空，手机随手拍，自然光","width":832,"height":1216,"steps":50,"seed":42}
```

可选字段：`guidance_scale`（默认 3.0）、`negative_prompt`（默认空）、`uncond_skip_layers`（默认 `[22]`）。
宽高必须是 16 的倍数且在 `[256, 1536]`；`steps` 收敛到 `[1,100]`（默认 50）。

响应：`image/png`，响应头 `X-Image-Width`、`X-Image-Height`、`X-Image-Steps`、`X-Image-Seed`、`X-Elapsed-Ms`、`X-Gpu-Peak-Gb`。

```bash
curl -s -X POST http://127.0.0.1:18114/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"傍晚的城市屋顶，暖色天空，手机随手拍，自然光","width":832,"height":1216,"steps":50}' \
  -D /tmp/moss.headers -o /tmp/moss.png
```

### `POST /edit`（18115）

当前返回 **501**：MOSS-Image-SFT 只有文生图分支（pipeline 没有 reference image 输入）；
参考图编辑需要另行部署 `Moss-Image-Edit`（GPLv3，只作为服务调用、代码不进仓库）。
客户端 `src/ai/moss-image.ts` 的 `editMossImage()` 已按协议实现，模型就位后无需改客户端。

## 5. 官方参数与截面

| 项 | 值 |
|---|---|
| dtype | transformer/text encoder **bf16**；VAE 与初始噪声 **float32** |
| sampler | Flow-matching Euler（shift=5.0，最近网格） |
| steps | 50 |
| guidance | 3.0（默认两次 transformer forward/step） |
| 负分支跳层 | `uncond_skip_layers=[22]` |
| 尺寸 | **16 的倍数**；本次基准 832×1216 / 1024×1024 |
| 并发 | 单卡并发 1（服务内 threading.Lock） |
| 文本编码器 | Qwen3.5-9B，`max_sequence_length=4096`（官方） |

## 6. 实测基准（真实出图，2026-10-27）

- 服务 `loaded=true`，`load_ms=12072`（权重刚下载完、page cache 热；冷启动待另测）
- torch 常驻 **25.35GB**；单张推理峰值 **28.08GB（832×1216）/ 28.18GB（1024×1024）**
- `nvidia-smi` GPU7：38,381 MiB → 41,457 MiB（含卡上已有 ~6.9GB 与 CUDA context）
- 原图与 headers：`/mnt/data0/lwh/karen-stack/moss-image/bench/`

| # | prompt | 尺寸 | steps | seed | 服务端耗时 | PNG 字节 | 显存峰值 |
|---|---|---|---|---|---|---|---|
| 1 | 傍晚的城市屋顶，暖色天空，手机随手拍，自然光 | 832×1216 | 50 | 42 | **38.45s** | 994,968 | 28.08GB |
| 2 | 雨后的街道，便利店灯光倒映在湿漉漉的地面上，第一人称视角 | 1024×1024 | 50 | 7 | **39.55s** | 1,845,065 | 28.18GB |
| 3 | 咖啡馆窗边自拍，年轻亚洲女性，中蓝色针织衫，柔和午后光，胸部以上近景 | 1024×1024 | 50 | 2026 | **39.55s** | 1,451,170 | 28.18GB |
| 4 | 窗台上的一杯热茶，旁边有一本书，午后阳光，手机随手拍 | 1024×1024 | 50 | 11 | **39.55s** | 1,368,478 | 28.18GB |

- 全部尺寸均为 16 的倍数（832/1024/1216 校验通过）。
- Mac 客户端经隧道实测 3/3 成功：client 39.4s / server 38.4s / peak 28.08GB；`comfyui.generateImage` 分发生效。
- `/edit` 501 实测 **330ms 快速失败**（两次尝试后回退），不会拖住自拍链路。

## 7. 已知风险

- **非官方要求 torch 版本**：torch 2.8 vs 官方 2.9+，本次跑通但升级依赖时需回归。
- **参考编辑未实现**：`/edit` 501；人物一致性仍是 Qwen-Image-Edit 路径。
- **显存**：50 步 + 9B 文本编码器，单卡占用高；与 GPU7 上其它任务共存时需要确认余量。
- **许可**：MOSS-Image-SFT 权重/代码 Apache-2.0；`Moss-Image-Edit` 是 GPLv3，若接入只通过 HTTP 服务调用，不复制代码。
- **根分区**：任何缓存/训练数据/bench 图都不能落在 `/`。

## 8. 人物专用服务（GPU6 18116，MOSS + Karen identity LoRA merged，task-26）

> 与上面的基础服务（GPU7 18114）**完全隔离**：独立容器名、独立模型目录、独立端口，本目录脚本不改动 GPU7。
> 仅供自拍 shadow：生产默认仍 Qwen-Image-Edit；merged v1 identity 弱于 Qwen（结论见 [docs/MOSS_IMAGE.md §9](../../../docs/MOSS_IMAGE.md)）。

### 8.1 合并 LoRA（方案 A，已实测）

```bash
# 服务器（CPU merge，约 88s；产物 9.5GB + 软链 base 大组件）
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  /workspace/moss-image/merge_lora.py \
  --base-model-dir /workspace/models/MOSS-Image-SFT \
  --lora /workspace/models/karen-moss-lora/karen_style_moss_v1.safetensors \
  --out-dir /workspace/models/MOSS-Image-SFT-karen-lora --multiplier 1.0
```

- 实测：252/252 modules 命中、0 缺失、0 形状不匹配、252 个权重变化、0 NaN/Inf；scale=alpha/rank=1/16
  与 sd-scripts `library/lora_utils.py` 一致；产物 `merge-report.json` 记录 max|ΔW| 等。
- 产物目录：`/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT-karen-lora/`（`transformer/` 为 merged，
  `text_encoder/tokenizer/vae` 软链到 base）。

### 8.2 启停与基准

```bash
bash deploy/gpu-server/moss-image/char-start.sh    # karen-moss-character / GPU6 / 127.0.0.1:18116
curl -s http://127.0.0.1:18116/health               # loaded=true, model=...-karen-lora
bash deploy/gpu-server/moss-image/char-benchmark.sh # 5 个自拍 prompt（MOSS）+ contact sheet
bash deploy/gpu-server/moss-image/char-stop.sh
```

- 实测：load 9.4–10.0s；torch 常驻 25.35GB；单张峰值 28.09GB；5 张 832×1216/50 步 **38.39–38.50s/张**。
- 样张：`/mnt/data0/lwh/karen-stack/moss-image/char-bench/moss/`；
  identity/guard 对比图：`char-bench/identity-final/`（merged / offline_lora / offline_base / qwen 四组 contact sheet）。
- 对照（同 5 prompt，refs=character-1/2/3）：merged 服务 **0.4029**、离线 kohya LoRA **0.3931**
  （同 prompt/seed 像素差 mean_abs≈0.8–1.7/255，rain 14.0）、离线 base **0.1612**、Qwen 缓存自拍 **0.6563**；
  guard：merged 3/5 vs Qwen 5/5。
- 回退：`char-stop.sh` + 不设 `KAREN_SELFIE_BACKEND=moss-t2i`；merged 模型保留在 data0，GPU7 服务不受影响。

