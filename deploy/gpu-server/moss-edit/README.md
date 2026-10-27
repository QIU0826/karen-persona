# MOSS-Image-Edit 参考编辑服务（GPU6，端口 18117 / 隧道 19117）

> 状态：**2026-10-27 部署中 → 见 docs/MOSS_EDIT.md 的最终结论与实测**。
> 目标：给现有自拍链路加一条「MOSS-Image-Edit 参考图编辑」shadow 路线，与 Qwen-Image-Edit-2511
> 在**同参考图 / 同 prompt / 同 seed**下对比人物一致性；**默认不切生产**。
> 不碰 GPU7 的 18114/18115（MOSS-Image-SFT）与 GPU6 的 18116（人物 LoRA shadow）。

## 1. 组成

| 组件 | 位置 | 说明 |
|---|---|---|
| ComfyUI（nightly，含原生 MOSS-Image 支持） | `data0/comfyui`（git clone，2026-10-26 v0.43.0） | 只在容器内 `127.0.0.1:18118`，不暴露宿主 |
| MOSS-Image-Edit workflow | `moss-edit/workflows/moss_edit_native.api.json`（仓库内自写 JSON） | 用 ComfyUI v0.43.0 **原生** MOSS-Image Edit 节点，不需要 GPL 插件 |
| ComfyUI 格式权重 | `data0/comfyui/models/` | 从 ModelScope `Comfy-Org/MOSS-Image` 下载（HF 在服务器不通） |
| `/edit` HTTP 代理 | 本目录 `edit_server.py`（容器内 18117） | 兼容现有 `selfie-generator` 的 `KAREN_SELFIE_BACKEND=moss-edit` |
| 评测 | 复用 `scripts/moss-lora-eval.py`（`karen-arcface` venv） | ArcFace cosine + contact sheet |

## 2. 权重（ModelScope，2026-10-27 实际大小）

```text
models/diffusion_models/moss_image_sft_int8_convrot.safetensors   5,413,698,958
models/text_encoders/qwen3.5_9b_int8_convrot.safetensors          9,748,121,532
models/vae/flux2-vae_small.safetensors                              249,521,340
models/loras/moss_image_edit_lora_rank_64_bf16.safetensors          297,382,216
```

下载：`bash download_models.sh`（幂等；日志 `data0/logs/moss-edit-download.log`）。
来源：<https://www.modelscope.cn/models/Comfy-Org/MOSS-Image>（HF 模型 `chinoll/Moss-Image-Edit` 的 ComfyUI 重打包）。

## 3. 服务器部署步骤（全部在 data0，根分区 / 仅剩 ~13GB）

```bash
STACK=/mnt/data0/lwh/karen-stack
cd $STACK

# 1) ComfyUI（已 clone；若重来）
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui

# 2) venv：复用基础镜像的 python/torch（--system-site-packages），避免重装 torch
podman run --rm -v $STACK:/workspace --entrypoint python \
  localhost/karen-qwen-image-edit:0.1 -m venv /workspace/venvs/comfyui --system-site-packages
# 核心依赖（跳过 3 个纯前端包；它们是 Web UI 资源，API 不需要）
grep -v -E "^(comfyui-frontend-package|comfyui-workflow-templates|comfyui-embedded-docs)==" \
  comfyui/requirements.txt > /tmp/req-core.txt
podman run --rm -v $STACK:/workspace -v /tmp:/tmp \
  --entrypoint /workspace/venvs/comfyui/bin/pip \
  localhost/karen-qwen-image-edit:0.1 install -r /tmp/req-core.txt

# 3) 权重 + 插件 + workflow
bash moss-edit/download_models.sh
bash moss-edit/fetch_workflow.sh   # 只部署/校验原生 workflow（无 GPL 插件）

# 4) 启动 / 健康 / 停止
bash moss-edit/start.sh
curl -s http://127.0.0.1:18117/health | python3 -m json.tool
bash moss-edit/stop.sh
```

> 本机实际处理：`comfyui-frontend-package` 需装（`pip install --no-deps comfyui-frontend-package==1.57.4`）；
> `comfyui-workflow-templates` / `comfyui-embedded-docs` 缺失只影响 Web UI（API 服务可正常运行）。
> 另：ModelScope 下载的 4 个权重必须用 sha256 校验（本次首次下载因断点续传混入旧分片出现全零区域，
> 已按 ModelScope 官方 sha256 重新下载并校验；详见 docs/MOSS_EDIT.md）。

## 4. HTTP API

### `GET /health`

```json
{
  "ok": true, "service": "moss-edit", "comfy_ok": true, "workflow_ok": true,
  "moss_edit_node_ready": true, "gpu": "NVIDIA RTX 6000D",
  "models": {"UNETLoader": "moss_image_sft_int8_convrot.safetensors", "...": "..."}
}
```

### `POST /edit`（兼容 Qwen 客户端）

请求：

```json
{
  "prompt": "保持人物外貌和身份完全不变，把背景换成安静的咖啡馆，下午暖光，手机自拍近景，不出现手部",
  "image_paths": ["/workspace/data/karen-ref/character-2.jpg"],
  "steps": 30,
  "seed": 42
}
```

也接受 `num_inference_steps`（Qwen 字段）、`negative_prompt`、`simple`（忽略）、
`width/height`（忽略，输出跟随参考图宽高比 ~1MP）、`reference_max_edge`（默认 512）、`megapixels`（默认 1.0）。

响应：`image/png`，响应头 `X-Image-Width`、`X-Image-Height`、`X-Image-Steps`、`X-Image-Seed`、
`X-Elapsed-Ms`、`X-Prompt-Id`、`X-Backend: moss-image-edit`。

错误：`400` 参考图/参数问题；`503` ComfyUI 不可用或节点未加载；`504` 出图超时；`500` 执行失败。

## 5. 与现有 Node 客户端接入（默认不改 .env、不切生产）

`src/media/selfie-generator.ts` 已支持 `KAREN_SELFIE_BACKEND=moss-edit`，客户端
`src/ai/moss-image.ts` 使用 `MOSS_IMAGE_EDIT_URL`（默认 `http://127.0.0.1:19115`）。要 shadow 到本服务：

```bash
# 只在当前 shell / PM2 环境显式设置，不写 .env
export KAREN_SELFIE_BACKEND=moss-edit
export MOSS_IMAGE_EDIT_URL=http://127.0.0.1:19117
```

失败时 `editMossImage()` 返回 null，自拍链路会回退（见 selfie-generator 的 fallback 逻辑）。

## 6. 隧道（Mac）

```bash
GPU_HOST=<server> GPU_PORT=10236 GPU_USER=lwh GPU_KEY=~/.ssh/karen_gpu \
  bash deploy/gpu-server/moss-edit/tunnel.sh
# 然后：curl -s http://127.0.0.1:19117/health
```

生产隧道 `scripts/gpu-tunnel.sh`（launchd）未改；本脚本只额外开 19117。

## 7. 回退 / 风险

- 回退：`bash stop.sh`；生产不设 `KAREN_SELFIE_BACKEND`/`MOSS_IMAGE_EDIT_URL` 即完全不受影响。
- 不停止既有服务：GPU6 的 18116、GPU7 的 18114/18115 均不动；本服务是独立容器 `karen-moss-edit`。
- 风险：ComfyUI nightly 与 MOSS 原生支持的兼容性、int8 量化质量、参考图 512 上限导致的构图变化、
  首次请求模型加载慢（wrapper 超时 900s）、GPU6 与 18116 同卡可能 OOM（启动前看 `nvidia-smi`）。
- 许可：ComfyUI（GPL-3.0，仅作为服务器侧服务运行）、MOSS-Image 权重（Apache-2.0）、
  Moss-Image-Edit LoRA（以 HF 模型卡为准）。**本仓库不包含 ComfyUI/插件源码**；
  最初参考的 Chenkin-x 插件（GPLv3）因与 ComfyUI v0.43.0 不兼容已弃用，未复制其代码。

## 8. 实测结果（2026-10-27 首轮）

完整报告见 [docs/MOSS_EDIT.md](../../../docs/MOSS_EDIT.md) 第 5 节。

| 项 | MOSS-Edit | Qwen-Edit（同批） |
|---|---|---|
| ArcFace best mean（refs=character-1/2/3） | **0.122**（n=5，检出 5） | **0.822**（n=5，检出 3） |
| image-guard pass | **0/5** | **3/5** |
| 单张耗时（832×1216，30 步） | 37–81s（warm） | ~50–100s（20 步，含服务抖动） |

**结论：服务可用，但 identity 与 Qwen 差距 ≈0.70（目标 ≤0.05 量级），不切生产。**
主要阻塞：参考图为插画风格、int8 + torch 2.8/cu128 下 comfy-kitchen CUDA int8 算子不可用（需 torch≥2.9/cu130）、
单参考弱约束。后续可试：torch cu130、多参考（character-2 + 缓存自拍）、更高 image_strength、identity LoRA v2。
