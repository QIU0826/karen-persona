# MOSS-Image-Edit 参考编辑（人物一致性路线）

> 状态：**2026-10-27 已部署并完成首轮对照评测——服务可用，但 identity 未达标，不切生产**。
> 任务：task-28 / P3。目标：MOSS-Image-Edit（参考图编辑）与现有 Qwen-Image-Edit-2511 在
> 同参考/同 prompt/同 seed 下对比人物一致性；达标才考虑 shadow，**生产默认仍 Qwen**。
> 服务器：GPU6，`127.0.0.1:18117`（Mac 隧道 `19117`）。既有 GPU7 `18114/18115`、GPU6 `18116` 均未改动。
> 评测产物：[deploy/gpu-server/moss-edit/results/](../deploy/gpu-server/moss-edit/results/)。

---

## 0. 结论（一句话）

**服务部署成功（ComfyUI 原生 MOSS-Image Edit + 自写 `/edit` 代理，真实出图），但人物一致性未达到目标：
ArcFace best mean 0.122 vs 同批 Qwen 0.822（差距 ≈0.70，目标 ≤0.05），guard 通过 0/5 vs Qwen 3/5。
因此 MOSS-Edit 只能作为离线/异步的风格化编辑实验，不切换自拍生产；继续调参或等 identity 方案成熟。**

| 项 | 结果 |
|---|---|
| ComfyUI 原生 MOSS-Image Edit | ✅ 跑通（v0.43.0，`TextEncodeMOSSImageEdit` + `LoraLoaderModelOnly` + 原生 reference latents） |
| `/edit` 服务（18117 / 隧道 19117） | ✅ 健康；真实出图 832×1216，30 步 warm **37–81s/张** |
| 同 prompt/seed/参考的 5 场景对比 | ✅ 完成（咖啡馆/家/夜街/雨窗/海边） |
| ArcFace identity（vs character-1/2/3） | **MOSS 0.122±0.07 vs Qwen 0.822±0.035**；同批 Qwen 缓存自拍 0.656±0.08 |
| image-guard（DeepSeek Flash 多模态） | **MOSS 0/5，Qwen 3/5**（Qwen 少数场景也因手/瑕疵未过） |
| 是否切生产 | **否**；`KAREN_SELFIE_BACKEND=moss-edit` 仅 shadow（默认不设） |
| GPL 插件 | 计划中的 `Chenkin-x/ComfyUI-Moss-Image-Edit`（GPLv3）与 ComfyUI v0.43.0 **不兼容**（依赖旧版 `model.pe_embedder`）；已弃用并改用 ComfyUI **原生** MOSS edit 节点，仓库不含 GPL 代码 |

---

## 1. 背景与目标

- 现有生产自拍 = **Qwen-Image-Edit-2511**（GPU2 `18110`，隧道 `19110`），identity 明显更强；
- MOSS-Image-SFT 文生图 + identity LoRA v1 的 identity 只有 0.403 vs Qwen 0.656
  （[docs/CHARACTER_LORA_TRAINING.md](CHARACTER_LORA_TRAINING.md)），v2 训练中；
- 本任务改走 **MOSS-Image-Edit 参考图编辑**：输入 `character-2` 参考图 + 编辑指令，
  让 MOSS 在保留参考人脸/身份的前提下改场景；
- 硬约束：不登录、不写生产 `.env`、不 commit、不切生产；GPU6/7 既有服务不停；
  根分区小（~13GB 剩余），模型/venv/ComfyUI 全放 `/mnt/data0`。

---

## 2. 部署（服务器，全部 data0）

组件与脚本见 [deploy/gpu-server/moss-edit/README.md](../deploy/gpu-server/moss-edit/README.md)。摘要：

| 组件 | 位置 |
|---|---|
| ComfyUI v0.43.0（含原生 MOSS/MOSS-Edit 支持） | `/mnt/data0/lwh/karen-stack/comfyui` |
| `/edit` HTTP 代理（FastAPI，标准库 HTTP 调 ComfyUI API） | `deploy/gpu-server/moss-edit/edit_server.py`（容器内 18117） |
| 原生 workflow（自写 JSON，无 GPL） | `deploy/gpu-server/moss-edit/workflows/moss_edit_native.api.json` |
| 权重（ModelScope `Comfy-Org/MOSS-Image`） | `comfyui/models/{diffusion_models,text_encoders,vae,loras}` |
| 启动/停止/下载/校验/隧道 | `deploy/gpu-server/moss-edit/*.sh` |

**权重（已按 ModelScope 官方 sha256 校验，2026-10-27）**：

| 文件 | 大小 | sha256 校验 |
|---|---|---|
| `moss_image_sft_int8_convrot.safetensors` | 5,413,698,958 | ✅ `b4d1475b…` |
| `qwen3.5_9b_int8_convrot.safetensors` | 9,748,121,532 | ✅ `32e37874…` |
| `flux2-vae_small.safetensors` | 249,521,340 | ✅ `d8d52ba0…` |
| `moss_image_edit_lora_rank_64_bf16.safetensors` | 297,382,216 | ✅ `17a48b8c…` |

> 踩坑：首次用 aria2 `-c` 断点续传（复用了之前被中断的 `.aria2` 控制文件）导致文件大小正确但内容出现
> **全零区域**（`comfy_attention.config` 解码失败、URE 无效）；改为新文件完整下载 + sha256 校验后解决。
> **以后所有 ModelScope 权重要么整文件下载 + sha256，要么不要复用旧控制文件。**

---

## 3. 服务与 API

### 3.1 健康检查

```bash
# Mac（隧道 19117）或服务器本机 18117
curl -s http://127.0.0.1:19117/health | python3 -m json.tool
```

实测返回（节选）：

```json
{
  "ok": true, "service": "moss-edit",
  "comfy_ok": true, "workflow_ok": true, "moss_edit_node_ready": true,
  "workflow": "/workspace/moss-edit/workflows/moss_edit_native.api.json",
  "models": {
    "UNETLoader": "moss_image_sft_int8_convrot.safetensors",
    "CLIPLoader": "qwen3.5_9b_int8_convrot.safetensors",
    "VAELoader": "flux2-vae_small.safetensors",
    "LoraLoaderModelOnly": "moss_image_edit_lora_rank_64_bf16.safetensors"
  },
  "gpu": "cuda:0 NVIDIA RTX 6000D",
  "defaults": {"steps":30,"cfg":4.0,"reference_megapixels":0.25,"output":[832,1216],"timeout_s":900}
}
```

### 3.2 `POST /edit`（兼容现有 Qwen 客户端）

```bash
curl -s -X POST http://127.0.0.1:19117/edit \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"保持人物外貌和身份完全不变，把场景换成安静的咖啡馆，下午暖光，手机自拍近景，不出现手部",
       "image_paths":["/workspace/data/karen-ref/character-2.jpg"],
       "width":832,"height":1216,"steps":30,"seed":42}' \
  -D /tmp/moss.headers -o /tmp/moss-edit.png
```

请求字段：`prompt`（必填）、`image_paths`（服务器路径，支持 `/workspace/...` 或相对 `/workspace`）、
`width/height`（输出 latent 尺寸，16 对齐）、`steps`/`num_inference_steps`、`seed`、`negative_prompt`、
`megapixels`（参考图缩放，默认 0.25）；`simple` 字段接受但忽略（MOSS 不裁剪）。
响应：`image/png` + `X-Image-Width/Height/Steps/Seed/Elapsed-Ms/Prompt-Id/Backend`。
错误：400 参数/参考图；503 ComfyUI/节点未就绪；504 超时（默认 900s）；500 执行失败。

**实现要点**：把参考图复制进 `ComfyUI/input` → patch 原生 workflow（模型名、参考图、prompt、seed/steps、
输出尺寸）→ `POST /prompt` → 轮询 `/history/{id}` → `/view` 取 PNG；单并发锁；所有失败返回明确 HTTP 错误。

---

## 4. 对照评测方法

- **参考图**：服务器 `data/karen-ref/character-2.jpg`（MOSS 单参考）。Qwen 服务当前**显式传单张 `image_paths` 会 500**
  （`index out of bounds`，既有服务限制），因此 Qwen 用**生产默认配置**（2 张 clean 参考 + simple 裁剪），
  两者参考输入不完全等价，文档如实标注；另加 **Qwen 缓存自拍**（`datasets/karen-character/refs/karen-selfie-*.jpg`，
  生产同款 5 场景）作为历史基线对照；
- **5 个场景**：咖啡馆 / 家 / 夜街 / 雨窗 / 海边；prompt 均含「保持人物外貌/身份不变」「手机自拍近景」「不出现手部」；
- **固定 seed=42**；MOSS 30 步 / Qwen 20 步（Qwen 服务在并发/负载下会随机 500，脚本自动重试，最终 5/5 成功）；
- **指标**：
  1. ArcFace identity cosine（insightface `buffalo_l` CPU，复用 `scripts/moss-lora-eval.py metrics`；
     参考集 `data/karen-ref`（character-1/2/3），取 best 与 primary=character-2）；
  2. 人工 contact sheet（脸型/发色/构图/手/画风）；
  3. `src/ai/image-guard.ts`（DeepSeek Flash 多模态）逐张质检 pass/fail；
- 复现：`GPU_HOST=<server> GPU_PORT=10236 GPU_USER=lwh GPU_KEY=~/.ssh/karen_gpu bash scripts/moss-edit-bench.sh`

---

## 5. 结果

### 5.1 ArcFace identity（同批生成，refs=3）

| 目录 | 图片数 | 检出脸 | best mean | std | min | max | primary mean |
|---|---|---|---|---|---|---|---|
| **MOSS-Edit（本次）** | 5 | 5 | **0.122** | 0.070 | 0.023 | 0.222 | 0.074 |
| **Qwen-Edit（本次，生产配置）** | 5 | 3（2 张未检出脸） | **0.822** | 0.035 | 0.791 | 0.871 | 0.738 |
| Qwen 缓存自拍（历史基线，非本次生成） | 5 | 5 | 0.656 | 0.080 | 0.570 | 0.785 | 0.652 |

- 同图配对 Δ：moss→qwen **+0.70**（n=3，Qwen 0.79–0.87 vs MOSS 0.02–0.22）；
- 结论：**MOSS-Edit 的 identity 远低于目标（差距 0.70，目标 ≤0.05 量级）**；
- 调参小实验（1 张）：参考图 1MP + `image_strength=2.0` 把该图从 0.075 提到 0.158，仍远低于 Qwen；
- 人工看：MOSS 保留了**蓝发/发型/服装色系/场景/自拍构图**，但脸不是同一张脸；
  海边场景连发色都漂移（0.023，基本丢失参考）。

### 5.2 image-guard（DeepSeek Flash 多模态，逐张）

| 后端 | 通过 | 明细 |
|---|---|---|
| MOSS-Edit | **0/5** | 咖啡馆/家/夜街/雨窗/海边 全部 FAIL（脸与参考不一致、构图/手部问题） |
| Qwen-Edit | **3/5** | 家 / 雨窗 / 海边 PASS；咖啡馆 / 夜街 FAIL（手部/画面瑕疵） |

### 5.3 产物与样张

- contact sheet（已在仓库）：[contact-moss-edit.jpg](../deploy/gpu-server/moss-edit/results/contact-moss-edit.jpg)、
  [contact-qwen.jpg](../deploy/gpu-server/moss-edit/results/contact-qwen.jpg)；
- 完整报告：[identity-report.md](../deploy/gpu-server/moss-edit/results/identity-report.md)、
  guard 明细：[guard.tsv](../deploy/gpu-server/moss-edit/results/guard.tsv)；
- 原图（服务器，不入库）：`/mnt/data0/lwh/karen-stack/moss-edit/results/{moss,qwen}/01-cafe.png … 05-seaside.png`。

### 5.4 性能与资源

- 单张 832×1216 / 30 步：**warm 37–81s**（同批实测 37/49/60/81s 等；响应头 `X-Elapsed-Ms` 可查）；
- 首次执行含模型加载（TE 9.3GB staged + DiT int8 5.4GB + VAE + LoRA），冷启动约 1–3 分钟；
- GPU6：加载/生成期间占用约 55–72GB（与 18116 shadow 同卡），余量 22–28GB；本服务空闲时 ~0.6–1GB。

---

## 6. 为什么没达标（诊断与阻塞）

1. **参考图域差异**：`character-2.jpg` 是宣传页插画风格；MOSS-Edit 偏「保留画风/发色/服装」，
   对插画人脸的身份锁定弱于 Qwen-Image-Edit（Qwen 明显更接近参考脸）；
2. **量化与运行环境**：ComfyUI 启动警告 `pytorch with cu130 or higher` 才启用优化 CUDA 算子；
   当前 torch 2.8+cu128 下 `comfy_kitchen` CUDA int8 attention 不可用（`disabled: True`），
   int8 convrot 走回退路径，可能进一步削弱编辑/身份保真；
3. **原生路径 vs 插件路径**：原计划 GPL 插件（`ModelPatchLoader` + 自定义 `edit_forward`）与
   ComfyUI v0.43.0 不兼容（旧 `model.pe_embedder` API）；原生 `TextEncodeMOSSImageEdit` 可用，
   但缺少插件里针对旧 ComfyUI 的 attention 补丁细节（该插件已弃用，未复制代码）；
4. **单参考 + 0.25MP 参考缩放**：发布者默认 512 长边，对插画脸可能不足；小实验提到 1MP/strength=2
   只从 0.075→0.158，说明不是主因；
5. **Qwen 服务本身也不稳**：并发请求下会随机 500（`index out of bounds`），本次靠重试拿到 5/5；
   生产若遇并发需串行/队列（与本文 MOSS 无关，但影响对照公平性）。

---

## 7. 接入方式（shadow，不切生产）

`src/media/selfie-generator.ts` 已支持 `KAREN_SELFIE_BACKEND=moss-edit`；客户端 `src/ai/moss-image.ts`
用 `MOSS_IMAGE_EDIT_URL`（默认 19115）。接入 19117：

```bash
# 仅当前进程/环境显式设置，不写 .env、不 commit
KAREN_SELFIE_BACKEND=moss-edit MOSS_IMAGE_EDIT_URL=http://127.0.0.1:19117 npm run dev
```

- 失败时 `editMossImage()` 返回 null，自拍链路按现有逻辑回退（qwen / 图库）；
- **不切生产**：不设置上述变量即完全不受影响；回退：`bash deploy/gpu-server/moss-edit/stop.sh`。

---

## 8. 风险与后续

| 风险/后续 | 说明 |
|---|---|
| identity 不达标 | 当前路线不适合生产自拍；继续用 Qwen-Image-Edit |
| int8 + torch cu128 | 若继续 MOSS-Edit 路线，下一步应升级 ComfyUI venv 到 torch 2.9+/cu130（下载 ~3GB，受服务器带宽限制）以启用 comfy-kitchen CUDA int8 算子，重测 identity |
| 多参考 | 尝试 `character-2 + karen-selfie-cafe` 双参考 + 更高 `image_strength`；本文只做单参考（原生 autogrow 支持多图，未测） |
| MOSS identity LoRA v2 | 并行路线（训练中），可能与 Edit 路线叠加评估 |
| 参考域 | 改用更「真人自拍」的参考（缓存自拍）而非宣传插画，可能显著改善 ArcFace（未验证） |
| 许可 | ComfyUI GPL-3.0 仅服务器服务形态；MOSS-Image Apache-2.0；Edit LoRA 许可以 HF 模型卡为准；本仓库无 GPL 代码 |
| 平台/网络 | ModelScope 下载慢（~1MB/s）且易断；权限仅内网回环；服务单并发，HTTP 请求排队 |

---

## 附录 A：部署命令速查

```bash
STACK=/mnt/data0/lwh/karen-stack

# 首次/重建
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $STACK/comfyui
podman run --rm -v $STACK:/workspace --entrypoint python localhost/karen-qwen-image-edit:0.1 \
  -m venv /workspace/venvs/comfyui --system-site-packages
grep -v -E "^(comfyui-frontend-package|comfyui-workflow-templates|comfyui-embedded-docs)==" \
  $STACK/comfyui/requirements.txt > /tmp/req-core.txt
podman run --rm -v $STACK:/workspace -v /tmp:/tmp --entrypoint /workspace/venvs/comfyui/bin/pip \
  localhost/karen-qwen-image-edit:0.1 install -r /tmp/req-core.txt
podman run --rm -v $STACK:/workspace --entrypoint /workspace/venvs/comfyui/bin/pip \
  localhost/karen-qwen-image-edit:0.1 install --no-deps "comfyui-frontend-package==1.57.4"
bash $STACK/moss-edit/download_models.sh
bash $STACK/moss-edit/fetch_workflow.sh

# 日常
bash $STACK/moss-edit/start.sh          # GPU6, 18117
curl -s http://127.0.0.1:18117/health
bash $STACK/moss-edit/stop.sh
```

Mac 隧道：

```bash
GPU_HOST=<server> GPU_PORT=10236 GPU_USER=lwh GPU_KEY=~/.ssh/karen_gpu \
  bash deploy/gpu-server/moss-edit/tunnel.sh      # 19117 -> 18117
```

## 附录 B：文件清单

| 文件 | 说明 |
|---|---|
| `deploy/gpu-server/moss-edit/edit_server.py` | `/edit` `/health` HTTP 代理（ComfyUI API → PNG） |
| `deploy/gpu-server/moss-edit/workflows/moss_edit_native.api.json` | 自写原生 MOSS edit workflow（UNET/CLIP/VAE/LoRA/SLG/文本编码/K采样） |
| `deploy/gpu-server/moss-edit/start.sh` / `stop.sh` / `start_inside.sh` | 容器启动/停止/ComfyUI+wrapper 启动 |
| `deploy/gpu-server/moss-edit/download_models.sh` | ModelScope 权重下载（幂等；需配 sha256 校验） |
| `deploy/gpu-server/moss-edit/fetch_workflow.sh` | 部署/校验原生 workflow（无 GPL 插件） |
| `deploy/gpu-server/moss-edit/tunnel.sh` | Mac 侧 19117 隧道 |
| `deploy/gpu-server/moss-edit/README.md` | 部署说明 |
| `deploy/gpu-server/moss-edit/results/` | 评测报告、contact sheet、guard 明细（PNG 原图在服务器） |
| `scripts/moss-edit-bench.sh` | 5 场景对照生成 + ArcFace + contact sheet + guard |
