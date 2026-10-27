# MOSS-Image-SFT 接入（GPU7，P2）

> 状态：**2026-10-27 已在 GPU7 真实跑通**：`/health` `loaded=true`，4 条基准 prompt 全部落盘 PNG
>（50 步 / 832×1216 与 1024×1024），并且 Mac → SSH 隧道 → Node 客户端真实调用通过。
> 接入方式为 **shadow**：默认不切生产，只在显式配置
> `KAREN_IMAGE_BACKEND=moss-image` / `KAREN_SELFIE_BACKEND=moss-edit` 时生效。
> 服务代码：[deploy/gpu-server/moss-image/](../deploy/gpu-server/moss-image/)；
> 部署/启停/回退细节见该目录 README，实测数字见 §5。

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
| 健康检查 | `src/obs/dependency-health.ts` 按 env 增加 `image-moss-image` / `selfie-moss-edit` 探活 |
| 文档 | 本文件 + `deploy/gpu-server/moss-image/README.md` |

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
