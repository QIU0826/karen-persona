# MOSS-Image-SFT 接入（GPU7 基础服务 + GPU6 人物 LoRA）

> 状态：**2026-10-27 已在 GPU7 真实跑通基础服务**：`/health` `loaded=true`，4 条基准 prompt 全部落盘 PNG
>（50 步 / 832×1216 与 1024×1024），并且 Mac → SSH 隧道 → Node 客户端真实调用通过。
> **P3 追加（task-26）**：GPU6 另起「人物专用」服务 18116（MOSS + Karen identity LoRA merged），5 张自拍真实出图 +
> 与离线 kohya LoRA/Qwen 的 identity、guard 对比在 **§9**。结论：merge 正确，但 identity 仍弱于 Qwen，**自拍生产继续 Qwen**。
> 接入方式为 **shadow**：默认不切生产，只在显式配置
> `KAREN_IMAGE_BACKEND=moss-image` / `KAREN_SELFIE_BACKEND=moss-t2i`（或 `moss-edit`）时生效。
> 服务代码：[deploy/gpu-server/moss-image/](../deploy/gpu-server/moss-image/)；
> 部署/启停/回退细节见该目录 README，实测数字见 §5/§9。

## 1. 做了什么

| 层 | 内容 |
|---|---|
| 权重 | `OpenMOSS/MOSS-Image-SFT`（5.1B DiT + Qwen3.5-9B 文本编码器，Apache-2.0，约 27.2GB）下载到 `/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT` |
| 推理服务 | `deploy/gpu-server/moss-image/server.py`：FastAPI，GPU7 `/generate`（18114）、`/edit`（18115，暂 501）、`/health` |
| 环境 | 基础镜像 `localhost/karen-qwen-image-edit:0.1`（Python 3.11/torch 2.8+cu128）+ `/mnt/data0` venv（diffusers 0.42 / transformers 5.21 / accelerate 1.15） |
| 隧道 | `scripts/gpu-tunnel.sh` 新增 `19114→18114`、`19115→18115`（原有 19102/19110–19113 不变） |
| Node 客户端 | `src/ai/moss-image.ts`：`generateMossImage()` / `editMossImage()` / 尺寸收敛 / 失败返回 null |
| 生图后端 | `src/media/comfyui.ts` 新增 `KAREN_IMAGE_BACKEND=moss-image`（失败回退链不变） |
| 自拍后端 | `src/media/selfie-generator.ts` 新增 `KAREN_SELFIE_BACKEND=moss-edit`（默认 qwen，不切换） |
| 健康检查 | `src/obs/dependency-health.ts` 按 env 增加 `image-moss-image` / `selfie-moss-edit` / `selfie-moss-character` 探活 |
| 人物服务（P3） | `deploy/gpu-server/moss-image/{merge_lora.py,char-start.sh,char-stop.sh,char-benchmark.sh}`；merged 模型 `/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT-karen-lora/`；GPU6 18116 |
| 人物自拍（P3） | `src/ai/moss-image.ts` 新增 `generateMossCharacterImage()`；`KAREN_SELFIE_BACKEND=moss-t2i` 分支（默认仍 qwen，失败回退 Qwen→图库） |
| 隧道（P3） | `scripts/gpu-tunnel.sh` 新增 `19116→18116` |
| 文档 | 本文件（§9 人物 LoRA）+ `deploy/gpu-server/moss-image/README.md` + `docs/CHARACTER_LORA_TRAINING.md §9` |

## 2. 官方参数（与实现一致）

| 项 | 值 |
|---|---|
| dtype | transformer / text encoder **bf16**；VAE 与初始噪声 **float32** |
| sampler | Flow-matching Euler（scheduler shift=5.0） |
| steps | **50** |
| guidance | **3.0**（默认两次 transformer forward/step） |
| 负分支跳层 | **`uncond_skip_layers=[22]`** |
| 尺寸 | **16 的正整数倍**；验证用 832×1216 与 1024×1024 |
| 并发 | 单卡并发 1（服务内锁） |
| 文本编码 | Qwen3.5-9B，`max_sequence_length=4096` |

来源：[模型 README（ModelScope/HF 同源）](https://modelscope.cn/models/openmoss/MOSS-Image-SFT)、
官方代码库 [OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)、
技术报告 [arXiv:2610.23374](https://arxiv.org/abs/2610.23374)。

## 3. 网络/磁盘约束（踩坑记录）

- 服务器 **HuggingFace / hf-mirror 均不通**（curl 返回 000），**ModelScope 可用**；权重统一从 ModelScope 拉。
- 根分区只剩 ~11GB，**模型/venv/bench 图都必须放 `/mnt/data0`**；本部署没有构建新镜像（用已有基础镜像 + data0 venv）。
- 下载用 aria2c 多连接（`-j4 -x8`）比 4 个 curl 更稳（有断连），下载后必须**按远端 Size 校验每个文件**，避免截断文件被当成完整。

## 4. Node 接入与配置

### 4.1 客户端

```ts
import { generateMossImage, editMossImage } from "./src/ai/moss-image.js";

const image = await generateMossImage("傍晚的城市屋顶，暖色天空，手机随手拍", {
  width: 832, height: 1216, steps: 50, seed: 42,
});
// image?.png / image?.width / image?.height / image?.serverElapsedMs / image?.gpuPeakGb
```

- 默认参数：50 步 / guidance 3.0 / `uncond_skip_layers=[22]`；
- 宽高自动收敛到 16 的倍数、`[256,1536]`；
- 失败（超时/非 200/非 PNG/服务未起）返回 `null`，不抛异常；
- `/edit` 目前返回 501（见 §7），`editMossImage()` 已按协议实现，可提前接入等模型就位。

### 4.2 env 矩阵

| 变量 | 默认 | 作用 |
|---|---|---|
| `KAREN_IMAGE_GEN` | off | 生图总开关（沿用） |
| `KAREN_IMAGE_BACKEND` | `service` | 设为 `moss-image` 才走 MOSS 场景/照片 |
| `MOSS_IMAGE_URL` | `http://127.0.0.1:19114` | Mac 侧隧道地址 |
| `MOSS_IMAGE_TIMEOUT_MS` | 300000（等价默认） | 单张生成超时，收敛 [30s, 600s]；50 步实测约 39s，可不动 |
| `KAREN_SELFIE_BACKEND` | `qwen` | 设为 `moss-edit` 才走 MOSS 自拍编辑（当前会因 /edit 501 回退） |
| `MOSS_IMAGE_EDIT_URL` | `http://127.0.0.1:19115` | 自拍编辑隧道地址 |
| `KAREN_SELFIE_STEPS` | qwen 10 / moss-edit 50 | 自拍步数 |

生产默认不动：`.env.example` 里新增项全部是注释，仓库默认仍是 `service` / `qwen`。

### 4.3 shadow 流程（建议）

1. Mac 上 `bash scripts/gpu-tunnel.sh`（新增 19114/19115 映射）或手工 `ssh -N -L 19114:127.0.0.1:18114 -L 19115:127.0.0.1:18115 ...`；
2. 临时 env（不改 `.env`）跑通客户端：`MOSS_IMAGE_URL=http://127.0.0.1:19114`；
3. 影子对比：同一批 prompt 分别走 Z-Image 与 MOSS，人工抽检后再决定是否把 `KAREN_IMAGE_BACKEND` 切到 `moss-image`；
4. 切场景图时把 `KAREN_PHOTO_SHARE_TIMEOUT_MS` 从 12s 调大（MOSS 50 步远慢于 Z-Image 9 步），否则流式发图会超时回退；
5. 自拍等 `Moss-Image-Edit` 部署后再切 `KAREN_SELFIE_BACKEND=moss-edit`，不要提前切。

## 5. 真实基准（GPU7，2026-10-27 实测）

**服务**：`http://127.0.0.1:18114`（Mac 隧道 `19114`），`/health` 返回 `loaded=true`；
**加载**：`load_ms=12072`（约 12.1s；注：此时权重刚下载完、page cache 热，冷启动会明显更慢，**待另测**）；
**显存**：加载后 torch 常驻 **25.35GB**；单张推理峰值 **28.08GB（832×1216）/ 28.18GB（1024×1024）**；
`nvidia-smi` GPU7 从 38,381 MiB → 41,457 MiB（含卡上已有 ~6.9GB 其它进程与 CUDA context）。
**并发**：服务内锁，单并发。

| # | prompt | 尺寸 | steps | seed | 服务端耗时 | 客户端实测 | PNG 字节 | 显存峰值 | 尺寸 16 倍数 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 傍晚的城市屋顶，暖色天空，手机随手拍，自然光 | 832×1216 | 50 | 42 | **38.45s** | wall 39.05s | 994,968 | 28.08GB | ✅ |
| 2 | 雨后的街道，便利店灯光倒映在湿漉漉的地面上，第一人称视角 | 1024×1024 | 50 | 7 | **39.55s** | wall 39.97s | 1,845,065 | 28.18GB | ✅ |
| 3 | 咖啡馆窗边自拍，年轻亚洲女性，中蓝色针织衫，柔和午后光，胸部以上近景 | 1024×1024 | 50 | 2026 | **39.55s** | wall 40.11s | 1,451,170 | 28.18GB | ✅ |
| 4 | 窗台上的一杯热茶，旁边有一本书，午后阳光，手机随手拍 | 1024×1024 | 50 | 11 | **39.55s** | wall 40.16s | 1,368,478 | 28.18GB | ✅ |

- 原图与响应头：服务器 `/mnt/data0/lwh/karen-stack/moss-image/bench/`
  （`rooftop/rain-street/cafe-selfie/teacup-20261027-081023.png` + `.headers` + `benchmark-20261027-081023.txt`）；
  另有 warmup（`warmup.png`，38.45s）。
- **Mac 客户端真实链路**（`scripts/gpu-tunnel.sh` 新增的 19114/19115 + `generateMossImage()`）：
  3/3 成功，`client_ms=39,379 / 39,380 / 39,442`，`server_ms=38,465 / 38,439 / 38,432`，`gpu_peak_gb=28.08`。
- **`comfyui.generateImage` 后端分发**：`KAREN_IMAGE_BACKEND=moss-image` + 注入质检桩 → `INTEGRATION_OK`
  （39,374ms，PNG 994,968 字节）。
- **`KAREN_SELFIE_BACKEND=moss-edit`**：`/edit` 501 → `ok:false, reason=moss_failed`，两次尝试共 **330ms** 即回退，
  不阻塞、不抛异常（符合 shadow 预期）。
- 观察：50 步在 6000D 上稳定 ~38–40s/张，**不适合流式即时发图**（Z-Image 8–9 步约 5s，Qwen-Edit 约 22s）；
  MOSS 更适合「异步/低频高质量」或后续 8-step DMD 蒸馏路径。

## 6. 回退

```bash
# 1) 生产 env 去掉 MOSS：KAREN_IMAGE_BACKEND 恢复 z-image（或 service），不设 KAREN_SELFIE_BACKEND
# 2) 停服务释放 GPU7：
bash deploy/gpu-server/moss-image/stop.sh
# 3) 模型/venv 保留在 /mnt/data0，随时可再起；不需要回退时删目录即可
```

## 7. 已知限制与风险

- **`/edit` 501**：MOSS-Image-SFT 只有文生图分支；参考图编辑要另部署 `Moss-Image-Edit`（GPLv3，只作为服务调用、代码不进仓库）。因此「人物一致性」提升本阶段未完成，仍走 Qwen-Image-Edit。
- **torch 版本差异**：官方要求 torch>=2.9，实际基础镜像 torch 2.8.0+cu128；本次真实出图可用（见 §5），但升级依赖时需回归。
- **速度**：50 步实测 **38–40s/张**（832×1216 与 1024×1024 基本一致），远慢于 Z-Image 8–9 步（约 5s），
  不适合作为流式发图默认后端；要用需把 `KAREN_PHOTO_SHARE_TIMEOUT_MS` 调大到 ≥45s 或改异步发图。
- **显存**：50 步 + 9B 文本编码器单卡占用高；GPU7 是共享卡，与其它任务共存时需先确认余量。
- **许可**：MOSS 权重/代码 Apache-2.0；`Moss-Image-Edit` GPLv3 仅服务调用。
- **模型注册表未更新**：`scripts/models.ts`（`npm run models:status`）当前不包含 MOSS，属后续小改。

## 8. 实测命令记录（可复现）

```bash
# 模型下载（服务器）
bash /mnt/data0/lwh/karen-stack/moss-image/download_model.sh
python3 /mnt/data0/lwh/karen-stack/moss-image/verify_model.py   # 必须 checked total_gb=27.23 mismatched=0

# 启动（服务器）
bash deploy/gpu-server/moss-image/start.sh
curl -s http://127.0.0.1:18114/health

# 基准（服务器）
bash deploy/gpu-server/moss-image/benchmark.sh

# Mac 客户端（隧道后）
MOSS_IMAGE_URL=http://127.0.0.1:19114 npx tsx /tmp/moss-e2e.ts
```

## 9. 人物专用服务：MOSS-Image-SFT + Karen identity LoRA（GPU6 18116，task-26）

> 目标变更（Lead 确认）：**场景图继续 Z-Image 不动**，只把「人物/自拍」搬到 MOSS + identity LoRA 做 shadow。
> **结论先行**：merge 已校验正确（与离线 kohya LoRA 同 prompt/seed 的输出几乎一致），但 identity 仍明显弱于
> 现有 Qwen-Image-Edit（**0.4029 vs 0.6563**，guard **3/5 vs 5/5**）→ **自拍生产继续用 Qwen；moss-t2i 仅 shadow，
> 不切 `.env` 默认**。merged v1 没有 NaN/脸崩，不需要 Plan B。

### 9.1 merged 模型（方案 A）

- 合并脚本：`deploy/gpu-server/moss-image/merge_lora.py`
  （kohya sd-scripts → diffusers `MOSSImageTransformer`，纯 CPU 合并约 88s）。
- 映射：kohya `lora_unet_layers_0_proj_ffn_down` ↔ diffusers `layers.0.proj.ffn_down.weight`；
  用「目标 module 的 `.`→`_`」反查，避免 `ffn_down` / `ffn_up_gate` 含下划线被错误拆开。
- **实测统计：252/252 modules 命中、0 缺失、0 形状不匹配、252 个权重变化、0 NaN/Inf**；
  `max|ΔW| = 0.001794`（`layers.41.proj.ffn_up_gate`）；另 1 个 `rope.bands` 差 1.8e-4 属 bf16 重序列化，非 LoRA。
- 缩放：`scale = alpha/rank = 1/16`（rank16 / alpha1）× multiplier 1.0；与 sd-scripts
  `library/lora_utils.py` 的 `scale = alpha / dim`、以及同一套 `.`→`_` key 匹配规则完全一致。
- 产物：`/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT-karen-lora/`
  （transformer 约 9.5GB；`text_encoder/tokenizer/vae` 软链到 base 不重复占盘；`merge-report.json` 记录统计）。

```bash
# 合并（服务器，容器内 CPU）
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  /workspace/moss-image/merge_lora.py \
  --base-model-dir /workspace/models/MOSS-Image-SFT \
  --lora /workspace/models/karen-moss-lora/karen_style_moss_v1.safetensors \
  --out-dir /workspace/models/MOSS-Image-SFT-karen-lora --multiplier 1.0
```

### 9.2 服务（GPU6 18116，独立于 GPU7）

```bash
bash deploy/gpu-server/moss-image/char-start.sh    # karen-moss-character / GPU6 / 127.0.0.1:18116
curl -s http://127.0.0.1:18116/health               # loaded=true, model=...-karen-lora
bash deploy/gpu-server/moss-image/char-stop.sh
```

- 实测：`load_ms=9988`（首次）/ `9428`（重启）；torch 常驻 **25.35GB**；单张推理峰值 **28.09GB**；
  GPU6 整卡 `nvidia-smi` 约 40GB（含卡上已有 ~13GB 其它任务）。单并发。

### 9.3 5 个自拍基准（832×1216 / 50 步，prompt/seed 固定，见 `char-benchmark.sh`）

| 场景 | 服务端耗时 | wall | PNG |
|---|---|---|---|
| 咖啡馆 | 38.48s | 39.04s | 1,230,863B |
| 家/沙发 | 38.48s | 39.06s | 1,313,770B |
| 夜街 | 38.50s | 39.19s | 1,089,192B |
| 雨窗 | 38.42s | 38.98s | 1,089,222B |
| 海边 | 38.39s | 38.98s | 1,197,216B |

原图：服务器 `/mnt/data0/lwh/karen-stack/moss-image/char-bench/moss/`；
contact sheet：`identity-final/contact-merged.jpg`。

### 9.4 identity 对比（ArcFace buffalo_l，refs=character-1/2/3，同一批 5 个自拍 prompt）

| 组 | n | 检出脸 | best mean | std | min | max |
|---|---|---|---|---|---|---|
| **merged 服务（diffusers + merged 权重）** | 5 | 5 | **0.4029** | 0.0866 | 0.2594 | 0.5001 |
| **离线 kohya LoRA**（sd-scripts `--lora_weight`，同 prompt/seed） | 5 | 5 | **0.3931** | 0.0821 | 0.2625 | 0.4998 |
| 离线 kohya base（无 LoRA，同 prompt/seed） | 5 | 5 | 0.1612 | 0.0567 | 0.0943 | 0.2655 |
| Qwen-Image-Edit 缓存自拍（线上已用，见 §9.7） | 5 | 5 | **0.6563** | 0.0804 | 0.5702 | 0.7846 |

- **base→LoRA +0.2317**（0.1612→0.3931），LoRA 在自拍 prompt 上确定有效；
- **merged ≈ 离线 kohya LoRA**（Δ +0.0098，小于 std）→ **merge 实现正确**；
- Qwen 仍比 MOSS merged 高 **+0.2534**，且 guard 更稳（§9.8）。

### 9.5 merge 正确性：直接 A/B（同 prompt / 同 seed / 同分辨率）

| 场景 | merged vs 离线 kohya mean_abs（0–255） | max |
|---|---|---|
| cafe | 1.134 | 107 |
| home | 1.653 | 186 |
| night | 0.965 | 193 |
| rain | 14.048 | 239 |
| sea | 0.757 | 150 |

4/5 平均像素差 <2，**两处实现生成的图基本一致**；rain 偏高来自两条推理栈的采样/attention 数值路径差异
（diffusers pipeline vs sd-scripts 自研 sampler），不是 merge 错误——两者 ArcFace 相同、目检同一个人。

### 9.6 为什么训练文档的 0.6731 ≠ 本次 0.4029（不是矛盾）

| 口径 | prompt/分辨率 | refs | 结果 |
|---|---|---|---|
| 训练文档 §5（离线 kohya） | 8 个未见 eval 场景 / 832×912 | 9 张（含缓存自拍） | LoRA 0.6731 / base 0.2503 |
| 本次任务（merged/离线） | 5 个自拍 prompt / 832×1216 | 3 张立绘 | merged 0.4029 / 离线 0.3931 / base 0.1612 |
| 交叉验证（同一 refs3 复算离线 eval 图） | 8 个 eval 场景 / 832×912 | 3 张立绘 | LoRA 0.4566 / base 0.1491 |

→ 绝对分数随 refs 数量/构图变化；**同条件 A/B（base→LoRA、merged vs 离线）都证明 LoRA 与 merge 有效**。

### 9.7 Qwen 对照样本说明（如实）

- 原计划用同一批 5 个 prompt 重新生成 Qwen 基线，但 GPU2 的 `karen-qwen-image-edit`（18110）同时被 task-27
  v2 数据集生成占用，连续返回 **500**（响应体 `{"detail":"edit failed: index 11 is out of bounds for dimension 0 with size 11"}`）。
- 按 Lead 指示**不再新增 Qwen 请求**，对照改用线上已使用的缓存自拍
  `datasets/karen-character/refs/karen-selfie-{cafe,home,night,rain,sea}.jpg`（Qwen-Image-Edit 生成、task-24 已批准）。
- 注意：这 5 张**同场景但 prompt/seed 非严格同条件**，因此 0.6563 vs 0.4029 只作量级/方向参考；
  待 18110 空闲后可补严格同条件基线。

### 9.8 Guard（真实 DeepSeek Flash 多模态，requireNoHands + expectCharacter）

| 组 | pass | 说明 |
|---|---|---|
| merged v1 | **3/5** | home 判「手臂/袖子入镜 + 结构穿模」；night 返回 pass=false（理由文字偏正面，按 raw 记录） |
| Qwen 缓存自拍 | **5/5** | 5 张全部通过 |

### 9.9 视觉结论（contact sheet + 逐张目检）

- merged 5/5 都是「蓝发 bob + 齐刘海 + 灰蓝眼」的 Karen 脸，场景正确，**无 NaN/脸崩**；
- 但整体比宣传页**更幼、更 anime/pastel**，发色更艳；Qwen 组更接近宣传页的铅笔水彩低饱和画风；
- 结论：identity/style 方向可用，但**不足以替代 Qwen**；仅保留 shadow 与离线高质量出图场景。

### 9.10 Node 接入（shadow，默认仍 qwen）

| env | 默认 | 说明 |
|---|---|---|
| `KAREN_SELFIE_BACKEND` | `qwen` | 设 `moss-t2i` 才走人物 LoRA 服务；`KAREN_SELFIE_GEN=off` 仍优先关闭 |
| `MOSS_CHARACTER_URL` | `http://127.0.0.1:19116` | Mac 隧道地址（隧道脚本已加 19116→18116） |
| `KAREN_SELFIE_STEPS` | qwen 10 / moss-t2i 50 | MOSS 默认 50 步 |

- 客户端：`src/ai/moss-image.ts` 新增 `generateMossCharacterImage()`；
- 自拍：`src/media/selfie-generator.ts` 新增 `moss-t2i` 分支，prompt 固定
  `karen_style` + 身份（中蓝 bob #4a6fa5/灰蓝眼）+ 铅笔水彩画风锚点 + 场景/服装/光线；
  **失败或 guard 不过 → 回退 Qwen-Image-Edit → 再失败由调用方回退本地自拍**（`backend`/`fallbackUsed` 可观测）；
- 健康检查：`src/obs/dependency-health.ts` 在 `KAREN_SELFIE_BACKEND=moss-t2i` 时探活 `selfie-moss-character`；
- 真实验证（Mac 经隧道）：`CHAR_CLIENT_OK 832×1216 / 39.08s / peak 28.09GB`；
  `generateSelfie` 命中 `backend=moss-t2i`、attempts=1、39.53s；无网络注入测试覆盖
  「moss 失败→Qwen 兜底（fallbackUsed=true）」与「无 Qwen→moss_t2i_failed」。

### 9.11 回退与风险

```bash
# 回退自拍到 Qwen：不设 KAREN_SELFIE_BACKEND=moss-t2i（生产 .env 本次未改）
# 停人物服务释放 GPU6：
bash deploy/gpu-server/moss-image/char-stop.sh
# merged 模型保留在 /mnt/data0，随时可再起；GPU7 基础服务（18114）本次未动
```

- 速度 **38–40s/张**（50 步）远慢于 Qwen-Edit（约 22–25s），也不适合流式即时发图；
- GPU6 为共享卡，人物服务常驻约 25–27GB；
- 训练数据分布偏「幼/近景」，LoRA 也学到画风；multiplier 仅测 1.0，未做 1.25/1.5 扫描；
- Qwen 对照样本为「同场景非严格同条件」；fresh baseline 待 18110 空闲补；
- **Plan B 未启用**（sd-scripts `MossImage` + 动态 LoRA 持久化服务）：merge A/B 已证明等价于离线 kohya，
  无需引入第二套推理栈；若未来要做 multiplier 动态扫描/多 LoRA 切换，再评估 Plan B。

