# Karen 角色 identity LoRA 训练（MOSS-Image × kohya sd-scripts）

> 任务：P3 / task-25 —— 用 MOSS-Image-SFT 训练 Karen 角色 identity LoRA，验证一致性是否优于/接近现有基线。
> 状态：**v1 已完成；v2（rank32 + 半身/全身扩充）已完成** —— v2 best ckpt=step1250、multiplier 1.0，eval best mean **0.7664**（v1 0.6731 / base 0.2503）；仍低于 Qwen 单参考 0.8389（差 0.072>0.05）→ **暂不替换自拍，继续 Qwen，MOSS 仅保留 shadow**（详见 §9）。
> v1 记录：smoke 通过 → 1200 步全量训练（30.5 min）→ base vs LoRA 同 prompt/seed 出图 + ArcFace 评测。核心结果：LoRA 把 eval identity best cosine 从 base **0.250 → 0.673**（+0.423），人工看脸型/发色/画风已明显回归 Karen；但仍低于 task-24 Qwen-Image-Edit 数据集的 0.858（跨模型、生成方式不同，不可直接比）。**未切换生产**。
> 约束：训练与数据全部放 GPU 服务器 `/mnt/data0`；不 commit、不改生产默认、不切 `KAREN_SELFIE_BACKEND`。
> 相关：[docs/MOSS_IMAGE.md](MOSS_IMAGE.md)（P2 推理服务）、[docs/CHARACTER_LORA.md](CHARACTER_LORA.md)（task-24 数据集与 ArcFace 基线）、`scripts/moss-lora-prepare.ts`、`scripts/moss-lora-eval.py`。

---

## 1. 结论速览（TL;DR）

| 项 | 结果 |
|---|---|
| 训练方式 | kohya-ss/sd-scripts `moss_image_train_network.py`，DiT-only LoRA（`networks.lora_generic`，rank 16，alpha 1，lr 1e-4，bf16，gradient checkpointing，TE 冻结） |
| smoke（40 步） | ✅ loss 0.387 → 0.42x 平稳；1.53 s/it；训练 61s / 含缓存 121s；GPU6 整卡峰值 28,214 MiB；LoRA 141.84MB，仅 `lora_unet_*`（TE 未训练） |
| 完整训练 | ✅ 1200 步（30 张 × 40 epoch），**29:45 / 1.49 s/it**，wall ≈ 30.5 min；每 200 步存 checkpoint（200…1200 共 6 个 + final），每个 141.84MB |
| loss | 首步 0.387；全程 `avr_loss` 2400 个采样 mean 0.409 / min 0.364 / max 0.454，平稳无发散（flow-matching loss 不用追求单调下降） |
| 显存 | GPU6 整卡峰值 **28,214 MiB**（训练前同卡已有他人 12.3GB；训练自身约 +16GB），远低于 83GB，未使用 INT8/block swap |
| 评测（8 张未见场景） | base best cosine mean **0.2503** → LoRA **0.6731**（Δ **+0.4228**，8/8 全部提升）；检出脸 8/8。人工看发色/脸型/铅笔水彩风格已回归 Karen（§5） |
| checkpoint 选择 | 800/1000/1200 步两点抽测：1200 步最好（0.8337/0.5403 vs 0.8085/0.5025 vs 0.7668/0.5018），**最终选 1200 步** |
| 生产 | **未切换**。MOSS 推理服务当前不支持动态加载 LoRA，接入生产需要服务端改造或 merge 方案（§7） |

---

## 2. 环境与资源

### 2.1 服务器与 GPU 分配

| 项 | 值 |
|---|---|
| GPU 服务器 | `ssh -i ~/.ssh/karen_gpu -o IdentitiesOnly=yes -o BatchMode=yes -p 10236 lwh@118.122.220.72` |
| 训练卡 | **GPU6**（`--device nvidia.com/gpu=6`；训练期间整卡约 26–28GB / 83GB，不影响 GPU7） |
| GPU7 | 保留给 MOSS-Image 推理服务（18114，常驻约 28GB），本任务未占用、未停止 |
| 数据盘 | `/mnt/data0/lwh/karen-stack`（2.6TB 可用）；根分区仅 ~13GB，**所有 venv/数据/产物都在 data0** |
| 容器 | `localhost/karen-qwen-image-edit:0.1`（Python 3.11.13 / torch 2.8.0+cu128，podman CDI 挂 GPU） |

### 2.2 目录布局（服务器）

```text
/mnt/data0/lwh/karen-stack/
├── models/
│   ├── MOSS-Image-SFT/                     # 26GB diffusers 格式（transformer 3 shards / text_encoder 4 shards / vae / tokenizer）
│   └── karen-moss-lora/                    # 训练产物（safetensors）
├── training/
│   ├── sd-scripts/                         # kohya-ss/sd-scripts clone（含 moss_image_train_network.py）
│   ├── venv/                               # 训练 venv（容器 base image + --system-site-packages）
│   └── logs/                               # pip / smoke / full 训练日志
└── datasets/
    ├── karen-lora/                         # 本任务：训练/评测数据 + TOML + prompt + 报告
    │   ├── train/ (30 png + txt)  eval/ (8 png + txt)
    │   ├── dataset_train.toml
    │   ├── eval-prompts.txt / eval-prompts.meta.json
    │   ├── run_smoke.sh / run_full.sh      # host 侧 podman 封装
    │   └── eval-out/ (base|lora)  eval-report/   # 生成图与评测报告（训练后产生）
    └── karen-character/                    # task-24 原始数据/refs/baseline.json
```

### 2.3 Python 环境（实际版本）

| 包 | 版本 | 说明 |
|---|---|---|
| Python | 3.11.13 | 来自容器 base image（不用宿主 3.12） |
| torch | 2.8.0+cu128 | 镜像自带，GPU capability (12,0) 验证可用 |
| transformers | **5.17.0** | sd-scripts requirements pin；Qwen3.5-9B 文本编码器需要 |
| diffusers | **0.40.0** | sd-scripts requirements pin |
| accelerate | 1.15.0 | |
| tokenizer | 本地 `MOSS-Image-SFT/tokenizer`（Qwen2Tokenizer，248077 vocab） | 服务器 HF 不通，`--tokenizer_cache_dir` 指向本地目录 |
| 优化器 | torch `AdamW` | 见 §2.4 偏离说明 |
| triton | 3.4.0（torch 自带） | 未用 ConvRot INT8，无需额外装 |

### 2.4 安装踩坑与偏离（重要）

1. **不重建镜像，用「容器 python + data0 venv --system-site-packages」**：镜像里已有 torch 2.8+cu128（3GB+），重建会浪费下载与根分区。venv 建在 `/mnt/data0/lwh/karen-stack/training/venv`，venv 内安装的 transformers/diffusers 优先于镜像 site-packages。
2. **`pip install -r requirements.txt` 不要无脑跑**：服务器到 PyPI 镜像带宽有限，`opencv-python`(62MB) 下载卡死 27 分钟；且 `bitsandbytes` 对 Blackwell（sm_120）有额外风险。改为**精简安装**：
   ```bash
   # 关键依赖（pypi 官方源或清华源均可；tokenizers 在官方源解析不到版本时改用清华源）
   pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
     accelerate==1.15.0 transformers==5.17.0 diffusers==0.40.0 ftfy==6.3.1 \
     einops==0.7.0 safetensors==0.8.0 toml==0.10.2 voluptuous==0.15.2 \
     huggingface-hub==1.32.0 imagesize==1.4.1 rich==14.1.0 sentencepiece==0.2.1 tqdm
   pip install -e /workspace/training/sd-scripts
   ```
   未装的包都不影响本训练路径：`opencv-python` 有 sd-scripts 自带的 Pillow/NumPy stub 兜底；`bitsandbytes` 仅 AdamW8bit 需要；`tensorboard` 只在 `--log_with` 时用；lion/prodigy 等优化器未使用。
3. **优化器偏离**：官方示例用 `AdamW8bit`；本次用 torch `AdamW`（避免 bitsandbytes 依赖/兼容风险）。LoRA 可训练参数很少，8bit 的显存/速度收益可忽略，loss 曲线正常（§4）。
4. **HF 离线**：所有 podman 命令设置 `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`；tokenizer 走本地目录，text encoder 走本地 shards，不会触发联网。
5. **文本编码器冻结**：`--network_train_unet_only` + `--cache_text_encoder_outputs`；产物 756 keys 全部 `lora_unet_*`，无 `lora_te_*`（已核验）。

---

## 3. 数据准备

### 3.1 数据集（task-24 最终版）

- 来源：`data/character-lora/raw/train/`（30 张）+ `raw/eval/`（8 张），每张同名 `.json` 带 scene/outfit/angle/light/seed/prompt。
- 严格分离：train/eval 按 **sha256 去重**，eval 集不参与训练，也不写入训练 TOML。
- 场景：train 覆盖 10 个场景（公园长椅/咖啡馆窗边/地铁站角落/夜晚街头/家里沙发/旧书店/海边黄昏/深夜阳台/清晨厨房/雨天窗边，各 3 张）；eval 为 8 个未见场景（冬天街道/唱片店/图书馆楼梯间/城市天台黄昏/深夜便利店/清晨海边/花市门口/高铁车窗边）。
- 图片尺寸：832×921（主）与少量 960×783；不是 16 的倍数，训练时由 kohya bucket（`bucket_reso_steps=16`）缩放/裁切到 1024 档 bucket。

### 3.2 Caption 规则（英文，固定触发词 `karen_style`）

每张 caption 由「触发词 + 固定身份 + 固定画风 + 场景/服装/角度/光线」拼成单一英文行：

```text
karen_style, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5),
gray-blue eyes, pale skin, <scene>, wearing <outfit>, <angle>, <light>,
soft pencil and watercolor illustration style, low-saturation cool gray-blue palette,
fine pencil and ink linework with light watercolor wash, subtle paper texture,
clean background with a clear scene atmosphere, single person, no text, no watermark, no border
```

- 身份/画风短语在**每张** caption 中逐字固定 → identity LoRA 的稳定锚点；
- 场景/服装/光线来自 `.json`（中→英映射表内置在准备脚本里；新增未收录值会保留中文并写入 `prepare-report.json.untranslated`，不阻塞）；
- 使用单行 caption（未启用 `enable_multiline_caption`，避免多候选复杂度）。

### 3.3 准备脚本与产物

```bash
# 本地（仓库根）：生成 staging + rsync 到服务器
.runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/moss-lora-prepare.ts
# 仅本地检查：--dry-run / --skip-upload / --out /tmp/karen-lora-prepared
# 可调参数：--gpu 6 --smoke-steps 40 --full-steps 1200 --save-every 200 --resolution 1024
```

产物（先写系统临时目录，rsync 后删除；`--keep` 可保留）：

| 文件 | 说明 |
|---|---|
| `train/` | 30 png + 30 `.txt` caption（训练用） |
| `eval/` | 8 png + 8 `.txt`（**只用于出图评测，不进训练 TOML**） |
| `dataset_train.toml` | kohya 数据集配置（见 §3.4） |
| `eval-prompts.txt` | MOSS minimal inference 批量 prompt（8 行，含 `--w 832 --h 912 --s 50 --l 3.0 --fs 5.0 --d <seed>`） |
| `eval-prompts.meta.json` | eval prompt ↔ 原始图片/场景/seed 映射 |
| `run_smoke.sh` / `run_full.sh` | host 侧 podman 封装（GPU 默认 6；smoke 40 步 / full 1200 步） |
| `prepare-report.json` | 数量、尺寸、sha256、未翻译词、warnings |

上传目标：`/mnt/data0/lwh/karen-stack/datasets/karen-lora/`（train/、eval/、TOML、prompt、run 脚本、本 eval 脚本）。

### 3.4 训练 TOML（`dataset_train.toml`）

```toml
[general]
enable_bucket = true
bucket_reso_steps = 16        # MOSS 要求 16 的倍数（官方）
min_bucket_reso = 512
max_bucket_reso = 1536
caption_extension = ".txt"

[[datasets]]
resolution = 1024
batch_size = 1
caption_dropout_rate = 0.05   # 配合官方空 negative prompt 的 CFG
enable_bucket = true

[[datasets.subsets]]
image_dir = "/workspace/datasets/karen-lora/train"
num_repeats = 1
caption_extension = ".txt"
```

---

## 4. 训练

### 4.1 参数与依据

| 参数 | 值 | 依据 |
|---|---|---|
| 模型 | MOSS-Image-SFT（本地 26GB） | task-23 已部署，官方 Apache-2.0 |
| 训练器 | `moss_image_train_network.py` | sd-scripts 官方 MOSS 指南 `docs/moss_image_train_network.md` |
| LoRA | `networks.lora_generic`，dim 16，alpha 1 | 官方推荐命令 |
| 训练范围 | `--network_train_unet_only`（DiT 252 modules） | 冻结 Qwen3.5 文本编码器（官方建议；也省显存/时间） |
| lr / scheduler | 1e-4 / constant | 官方示例 |
| timestep | `truncated_logit_normal`, logit_mean -1.09, logit_std 0.95, shift 1.0 | 官方：复现 MOSS 预训练 timestep 分布 |
| 精度/显存 | bf16 + gradient_checkpointing；cache_latents / cache_text_encoder_outputs（to_disk） | 官方推荐；GPU6 显存充足，未用 INT8/block swap |
| 步数 | smoke 40；full 1200（30 图 × 40 epoch），每 200 步存 checkpoint | 任务建议 1000–1500 步；便于按 checkpoint 选优 |
| 优化器 | torch AdamW（偏离官方 AdamW8bit，见 §2.4） | |
| 数据 | 30 张，bucket 1024，batch 1 | |

> 大模型路径（训练器要求「首 shard」）：
> - DiT：`/workspace/models/MOSS-Image-SFT/transformer/diffusion_pytorch_model-00001-of-00003.safetensors`
> - Text Encoder：`/workspace/models/MOSS-Image-SFT/text_encoder/model-00001-of-00004.safetensors`
> - VAE：`/workspace/models/MOSS-Image-SFT/vae/diffusion_pytorch_model.safetensors`
> - Tokenizer：`/workspace/models/MOSS-Image-SFT/tokenizer`（本地目录，离线）

### 4.2 Smoke（40 步，已完成）

```bash
# 服务器
bash /mnt/data0/lwh/karen-stack/datasets/karen-lora/run_smoke.sh
# 日志：/mnt/data0/lwh/karen-stack/training/logs/smoke-*.log
```

| 指标 | 结果 |
|---|---|
| loss | step 1 = 0.387 → 40 步 `avr_loss` ≈ 0.425（0.413–0.454 区间，平稳无发散） |
| 速度 | **1.53 s/it** |
| 耗时 | 训练 61s；含首次 text encoder / VAE 缓存 + 加载总 wall **121s** |
| 显存 | GPU6 整卡 `memory.used` 峰值 **28,214 MiB**（该卡另有他人约 12.3GB；训练自身约 +15.9GB） |
| 产物 | `karen_style_moss_smoke.safetensors`：141.84MB，756 keys，全部 `lora_unet_*`；metadata dim16/alpha1/bf16/AdamW/30 images |
| 缓存 | 训练目录已生成 30 个 `_moss_te.npz` + 30 个 `_moss.npz`，全训复用 |

### 4.3 完整训练（1200 步）

```bash
# 服务器后台启动（已执行）
cd /mnt/data0/lwh/karen-stack/datasets/karen-lora
nohup setsid bash run_full.sh > /mnt/data0/lwh/karen-stack/training/logs/full-<ts>.log 2>&1 &
```

| 指标 | 结果（实测） |
|---|---|
| 步数 | 1200（30 图 × 40 epoch），每 200 步存 checkpoint |
| 实测速度 | ≈ 1.5 s/it |
| 预计耗时 | 启动前估计 32–35 min；实际 30.5 min（1200 × 1.49s），符合预期 |
| 训练 loss | 首步 0.387；里程碑 0.395(200) / 0.432(600) / 0.408(1000) / 末次显示 0.425；2400 个 `avr_loss` 采样 mean **0.409**、min **0.364**、max **0.454**，无发散 |
| 总耗时 | **29:45**（1.49 s/it）；含加载/缓存复用 wall ≈ 30.5 min（08:43 启动 → 09:13 保存完成） |
| 显存峰值 | 运行中采样整卡 24.7–28.2GB（含同卡他人 12.3GB；训练自身约 +16GB），无 OOM |
| 产物 | `karen_style_moss_v1.safetensors`（final，sha256 `6463d38f…c6326`，148,731,592 B）+ `*-step00000200/400/600/800/1000/1200.safetensors` |
| metadata | dim16 / alpha1 / bf16 / AdamW / `truncated_logit_normal` / steps=1200 / epoch=40 / 30 images / 756 keys 且无 `lora_te_*` |
| 日志 | `/mnt/data0/lwh/karen-stack/training/logs/full-20261027-084314.log` |

---

## 5. 验证（base vs LoRA + ArcFace）

### 5.1 方法

1. **同模型 A/B**：用 sd-scripts `moss_image_minimal_inference.py`（支持加载并 merge LoRA）对同一批 eval prompts / 同一 seed 生成两组图：
   - `base`：不加载 LoRA；
   - `lora`：加载训练出的 LoRA（multiplier 1.0）。
2. **ArcFace cosine**：insightface `buffalo_l`（服务器 `venvs/karen-arcface`，CPU），取图中最大脸；计算每张生成图 vs 9 张参考图（character-1/2/3 + 5 张缓存自拍 + 已批准终稿）的 cosine，统计 best / mean / primary（character-2）。
3. **base → LoRA 逐图 Δ**：同 prompt/同 seed 配对，衡量 LoRA 是否真的把脸拉近参考图。
4. **人工检查**：contact sheet 检查脸型/发色/手/风格/构图；结合 ArcFace 判读。
5. **基线对照**：task-24 `baseline.json` 的 eval best mean（0.8584）是 **Qwen-Image-Edit 模型**生成图与参考图的相似度，**跨模型，只能作量级参考**；真正的提升看 base→LoRA Δ。

### 5.2 评测命令

```bash
# (1) 生成（训练容器内，GPU6；base 与 lora 各跑一遍）
podman run --rm --device nvidia.com/gpu=6 -v /mnt/data0/lwh/karen-stack:/workspace \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e PYTHONUNBUFFERED=1 \
  --entrypoint /workspace/training/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  /workspace/datasets/karen-lora/moss-lora-eval.py generate \
  --sdscripts /workspace/training/sd-scripts --model-dir /workspace/models/MOSS-Image-SFT \
  --prompts /workspace/datasets/karen-lora/eval-prompts.txt \
  --out /workspace/datasets/karen-lora/eval-out/base --label base

# 再跑 LoRA（只多 --lora / --label / --out 三个参数，其余完全一致）
podman run --rm --device nvidia.com/gpu=6 -v /mnt/data0/lwh/karen-stack:/workspace \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e PYTHONUNBUFFERED=1 \
  --entrypoint /workspace/training/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  /workspace/datasets/karen-lora/moss-lora-eval.py generate \
  --sdscripts /workspace/training/sd-scripts --model-dir /workspace/models/MOSS-Image-SFT \
  --prompts /workspace/datasets/karen-lora/eval-prompts.txt \
  --out /workspace/datasets/karen-lora/eval-out/lora --label lora \
  --lora /workspace/models/karen-moss-lora/karen_style_moss_v1.safetensors

# (2) 指标（host，ArcFace venv）
/mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/python \
  /mnt/data0/lwh/karen-stack/datasets/karen-lora/moss-lora-eval.py metrics \
  --refs /mnt/data0/lwh/karen-stack/datasets/karen-character/refs \
  --dirs base=/mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-out/base \
         lora=/mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-out/lora \
  --baseline-json /mnt/data0/lwh/karen-stack/datasets/karen-character/baseline.json \
  --out /mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-report
```

### 5.3 结果（实测，2026-10-27）

生成：8 张 × 2 组（base / lora final），832×912，50 步，同 prompt、同 seed；base 233.4s、lora 236.6s（含加载）。
ArcFace：insightface buffalo_l（CPU），refs 9/9 检出。

| 目录 | n | 检出脸 | best mean | std | min | max | mean（9 refs 平均） | primary mean（character-2） |
|---|---|---|---|---|---|---|---|---|
| **base（无 LoRA）** | 8 | 8 | **0.2503** | 0.1031 | 0.0939 | 0.4344 | 0.1634 | 0.0851 |
| **lora（1200 步）** | 8 | 8 | **0.6731** | 0.1119 | 0.5403 | 0.8337 | 0.5524 | 0.4397 |
| task-24 baseline（Qwen-Edit 生成图，跨模型参考） | 8 | 8 | 0.8584 | 0.046 | 0.7557 | 0.9057 | — | — |

**base → LoRA 逐图 Δ（best cosine）**：8/8 全部提升，mean **+0.4228**、std 0.0841、min +0.3193、max +0.5790。

| # | seed | base best | lora best | Δ |
|---|---|---|---|---|
| 1 | 20361609 | 0.4344 | 0.8337 | +0.3993 |
| 2 | 20361706 | 0.2210 | 0.5403 | +0.3193 |
| 3 | 20361415 | 0.1787 | 0.7577 | +0.5790 |
| 4 | 20361027 | 0.2326 | 0.6262 | +0.3936 |
| 5 | 20361318 | 0.3044 | 0.8208 | +0.5164 |
| 6 | 20361512 | 0.1773 | 0.5766 | +0.3993 |
| 7 | 20361221 | 0.3603 | 0.6836 | +0.3233 |
| 8 | 20361124 | 0.0939 | 0.5458 | +0.4519 |

**checkpoint 抽测（前 2 条 eval prompt，limit=2）**：

| checkpoint | prompt1 | prompt2 |
|---|---|---|
| step 800 | 0.7668 | 0.5018 |
| step 1000 | 0.8085 | 0.5025 |
| **step 1200（final）** | **0.8337** | **0.5403** |

→ 1200 步在两个探针上都最好，直接采用 final；无需退回到早期 checkpoint。

**怎么看这组数字**（task-24 已给出的同画风标尺：参考图两两 mean 0.7083、缓存自拍 vs 立绘 0.6176、已批准终稿 vs 立绘 0.6047）：
- LoRA eval mean **0.6731 > 已批准终稿 0.6047 / 自拍 vs 立绘 0.6176**，已进入「同一个人的正常波动范围」；
- 参考图两两之间也只有 0.708，说明 ArcFace 对水彩插画的上限本来就有限；
- task-24 的 0.858 是 **Qwen-Image-Edit 拿参考图直接编辑**得到的图 vs 参考图的相似度，与「文生图 + LoRA 记忆身份」不是同一任务，**不能直接当门槛**；真正的 A/B 是 base→LoRA（+0.423）。

产物：
- contact sheet：`/mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-report/contact-{base,lora}.jpg`
- 指标原始文件：`eval-report/metrics.json`；自动报告：`eval-report/report.md`
- eval 图：`/mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-out/{base,lora}/01…08-*.png`（生成脚本 `generate.log` / `generate-manifest.json` 同目录）

### 5.4 人工检查结论（contact sheet + 逐张目检）

- **身份/脸型**：LoRA 组 8/8 都是「齐肩 bob + 齐刘海 + 灰蓝眼 + 微腮红」的 Karen 脸，与 character-2 参考图明显同一个人；base 组则是偏成熟的长直蓝发、无刘海，身份完全不对。
- **发色**：LoRA 组保持中蓝（#4a6fa5 区间），没有出现第一版数据集那种银白/青绿漂移；个别图高光偏浅属正常水彩高光。
- **画风**：铅笔/墨线 + 淡彩水彩、低饱和冷灰蓝，与宣传页角色立绘一致；比 base 更柔和。
- **硬伤**：8 张均为头肩/近景构图，未出现明显手部；未发现文字/水印/多余人脸；02（唱片店侧脸）和 06（清晨海边侧脸）因侧脸/遮挡 cosine 偏低（0.54–0.58），但目检无崩坏，属构图导致的 ArcFace 波动。
- **泛化**：eval 的 8 个场景（冬天街道/唱片店/图书馆楼梯间/城市天台黄昏/深夜便利店/清晨海边/花市门口/高铁车窗边）训练时没见过，LoRA 仍能保持同一张脸 + 合理场景，说明不是简单记场景。
- **小瑕疵**：LoRA 组整体比参考立绘更「幼/圆」一点（数据集 image 本身偏 soft anime + 水彩），且近景偏多；如果追求宣传页的 24 岁成熟感，需要补更多半身/全身、低角度/侧身样本，并考虑降一点学习率或步数（但本批 800/1000 步抽测更差，说明不是过训问题，是数据分布问题）。
- **结论**：identity/style 目标基本达成，可用于「离线生成/异步高质量自拍」的 shadow 验证；**不切换生产**（服务端尚不支持动态 LoRA，且 50 步推理 ~40s/张，实时性不足）。

### 5.5 判读注意

- ArcFace cosine 对角度/遮挡/侧脸敏感：`profile`/`lookBack`/`lowAngle` 构图天然低分，单张不达标不代表 LoRA 无效；
- 若 LoRA 组检出脸数下降，优先看崩坏/遮挡，而不是只看 cosine；
- eval 图统一 832×912（原数据 832×921 不是 16 的倍数，MOSS 要求 16 倍数；横向构图基本不变）；
- 50 步推理每张约 40s，8 张/组 ≈ 6–8 min（含加载）。

---

## 6. 交付物与复现

| 类型 | 路径 |
|---|---|
| 准备脚本（本地仓库） | `scripts/moss-lora-prepare.ts` |
| 评测脚本（本地仓库） | `scripts/moss-lora-eval.py` |
| 训练数据/TOML/prompt（服务器） | `/mnt/data0/lwh/karen-stack/datasets/karen-lora/` |
| smoke LoRA | `/mnt/data0/lwh/karen-stack/models/karen-moss-lora/karen_style_moss_smoke.safetensors` |
| 最终 LoRA | `/mnt/data0/lwh/karen-stack/models/karen-moss-lora/karen_style_moss_v1.safetensors` |
| 训练日志 | `/mnt/data0/lwh/karen-stack/training/logs/{pip-*,smoke-*,full-*}.log` |
| 评测图/报告 | `/mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-out/`、`eval-report/` |

复现顺序：`scripts/moss-lora-prepare.ts`（生成本地 staging + 上传）→ `run_smoke.sh`（验证）→ `run_full.sh`（后台）→ `moss-lora-eval.py generate`（base/lora）→ `moss-lora-eval.py metrics`（ArcFace + 报告）。

---

## 7. 风险、限制与后续

### 7.1 已识别风险

1. **线上服务不支持动态 LoRA**：当前 MOSS 推理服务（task-23）是 diffusers pipeline 直接加载 bf16 权重；sd-scripts LoRA 是 `lora_unet_*` 格式，需要服务端实现 LoRA 加载/merge（或离线 merge 成新 checkpoint 再起服务）。**因此本任务只产出 LoRA 与评测，不切换生产**。
2. **数据集规模小（30 张 / 10 场景）**：identity 泛化到新场景/新服装可能有限；eval 是 8 个未见场景，正好检验泛化。
3. **风格与身份耦合**：caption 同时固定了身份和画风，LoRA 可能同时学到风格；如果后续要「身份不变、风格可换」，需要把风格词与身份词分离或训练风格 LoRA 单独控制。
4. **ArcFace 对低质量/侧脸敏感**：个别构图分数低属正常；需结合 contact sheet 人工判断，并关注“检出脸数”是否下降。
5. **训练数据来自 Qwen-Image-Edit 生成**：数据集本身有生成模型的风格先验；LoRA 会把该先验进一步固化（宣传页风格一致性是目标，但换模型/换服务时需注意）。
6. **MOSS 推理慢（50 步 ~40s/张）**：即使 LoRA 可用，即时发图体验也依赖后续 8-step DMD 蒸馏/加速方案；P3 阶段只验证一致性。
7. **成本**：GPU6 训练 30–40 分钟、评测 15–20 分钟，均为自建服务器电力/占用成本，无 API 费用。

### 7.2 后续建议

- 服务端加 LoRA 加载（diffusers `load_lora_weights` 或 merge 脚本），并做 shadow 对比；
- 用 checkpoint 扫描（200/400/…/1200）挑最优步数，必要时用 1200–1500 步、rank 32 二次实验；
- 若风格漂移明显：把画风词从 caption 移除或降低权重（LoRA 只学身份）；
- 增加 eval 场景/多人/手部构图，补充人工评分；
- 与 task-24 基线一起纳入回归资产（数据 + LoRA + 报告），但不进 git 大文件区。

---

## 8. 关键参数速查（cheat sheet）

```text
GPU:        --device nvidia.com/gpu=6（不要占 GPU7）
镜像:       localhost/karen-qwen-image-edit:0.1
venv:       /workspace/training/venv（Python 3.11.13 / torch 2.8.0+cu128 / transformers 5.17.0 / diffusers 0.40.0）
sd-scripts: /workspace/training/sd-scripts/moss_image_train_network.py
数据:       /workspace/datasets/karen-lora/train（30 张 + txt）
TOML:       /workspace/datasets/karen-lora/dataset_train.toml
输出:       /workspace/models/karen-moss-lora/
训练:       rank16 / alpha1 / lr1e-4 / bf16 / grad-ckpt / cache TE+latents / AdamW / 1.5s/it
推理:       moss_image_minimal_inference.py（--lora_weight <safetensors>，50 步，832×912）
评测:       ArcFace buffalo_l CPU，refs 9 张，best/mean/primary + base→LoRA Δ
```

---

## 9. 训练后接入：merge 到 diffusers 推理服务（task-26 实测，2026-10-27）

> 目的：把本文件训练的 kohya LoRA 用到 GPU6 的「人物专用」MOSS 服务（18116），供自拍 shadow。
> 结论：**merge 实现正确（与离线 kohya 等价）**；**merged v1 identity 仍明显低于现有 Qwen-Image-Edit**，
> 因此自拍生产继续用 Qwen，`KAREN_SELFIE_BACKEND=moss-t2i` 仅 shadow。详细数据见
> [docs/MOSS_IMAGE.md §9](MOSS_IMAGE.md)。

### 9.1 合并实现与校验

- 脚本：`deploy/gpu-server/moss-image/merge_lora.py`（kohya `lora_unet_*` → diffusers `MOSSImageTransformer`，
  CPU merge 约 88s，产物 `models/MOSS-Image-SFT-karen-lora/`）。
- 映射：目标 module 的 `.`→`_` 反查 kohya module 名（避免 `ffn_down`/`ffn_up_gate` 被错误拆分）。
- 统计：**252/252 命中、0 缺失、0 形状不匹配、252 个权重变化、0 NaN/Inf**；
  `max|ΔW|=0.001794` @ `layers.41.proj.ffn_up_gate`；`rope.bands` 1.8e-4 为 bf16 重序列化。
- 缩放：`scale = alpha/rank = 1/16`（rank16/alpha1）× multiplier 1.0；与 sd-scripts
  `library/lora_utils.py` 的 `scale = alpha / dim` 与同款 key 匹配规则一致。

### 9.2 直接 A/B：merged 服务 vs 离线 kohya（同 prompt/seed/分辨率）

| 场景 | merged vs 离线 LoRA mean_abs（0–255） |
|---|---|
| cafe | 1.134 |
| home | 1.653 |
| night | 0.965 |
| rain | 14.048 |
| sea | 0.757 |

4/5 差异 <2（基本同一张图）；rain 偏高是 diffusers vs sd-scripts 采样数值路径差异，不是 merge 错误。

### 9.3 identity 对比（同一批 5 个自拍 prompt，refs=character-1/2/3）

| 组 | best mean | std | min–max |
|---|---|---|---|
| merged 服务（diffusers） | **0.4029** | 0.0866 | 0.2594–0.5001 |
| 离线 kohya LoRA（sd-scripts） | **0.3931** | 0.0821 | 0.2625–0.4998 |
| 离线 kohya base（无 LoRA） | 0.1612 | 0.0567 | 0.0943–0.2655 |
| Qwen-Image-Edit 缓存自拍（同场景，非严格同条件） | **0.6563** | 0.0804 | 0.5702–0.7846 |

- base→LoRA **+0.2317**；merged ≈ 离线 kohya（Δ+0.0098）→ merge 生效且正确；
- Qwen 仍高 **+0.2534**；guard：merged **3/5** vs Qwen **5/5**；视觉上 merged 更幼/anime，Qwen 更贴近宣传页画风。

### 9.4 与 §5 的 0.6731 为什么不矛盾

§5 是「8 个未见 eval 场景 / 832×912 / 9 张 refs（含缓存自拍）」；本次是「5 个自拍 prompt / 832×1216 / 3 张立绘 refs」。
用同一 refs3 复算 §5 的离线 eval 图：LoRA **0.4566** / base **0.1491**，与训练结论方向一致。
→ 绝对分数随 refs/prompt 变化；判断 LoRA 是否有效要看同条件 A/B。

### 9.5 产物与用法（shadow）

| 项 | 路径/命令 |
|---|---|
| merged 模型 | `/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT-karen-lora/` |
| 服务 | `bash deploy/gpu-server/moss-image/char-start.sh`（GPU6，127.0.0.1:18116；`/health` loaded=true） |
| 基准/样张 | `bash deploy/gpu-server/moss-image/char-benchmark.sh`；图在 `/mnt/data0/lwh/karen-stack/moss-image/char-bench/` |
| Node 接入 | `KAREN_SELFIE_BACKEND=moss-t2i` + `MOSS_CHARACTER_URL`（默认 19116）；默认仍 qwen |

### 9.6 结论与后续

- **不替换自拍生产**：Qwen identity/guard/风格仍更强；merged v1 仅 shadow（失败自动回退 Qwen→图库）。
- 若要把 MOSS 自拍提上来：优先 (1) 补 15–30 张半身/全身/侧身/多光线训练数据（当前偏幼/近景），
  (2) multiplier 1.25/1.5 扫描，(3) 严格同条件 Qwen 基线（18110 空闲后），(4) 8-step 蒸馏降低 39s 延迟；
- **Plan B（sd-scripts `MossImage` 动态 LoRA 持久化服务）暂不需要**：merge 已与离线 kohya 等价；
  将来要做多 LoRA/multiplier 动态切换再评估。


---

## 9. v2 实验（rank32 + 半身/全身数据扩充 + Qwen 对照）

> 动机：v1（rank16、1200 步、全头肩近景数据）identity 已大幅提升但**偏幼圆、近景偏多**；用户明确「人物一致性/更像同一张脸优先，现有 Qwen 更强」。v2 目标：补 半身/四分之三身/全身/低角度/侧脸/不同服装，rank 32、1500 步，并与 Qwen-Image-Edit 同 prompt 基线正面对比。
> 写作用域内产物：本节 + `scripts/moss-lora-prepare.ts`（新增 `--caption-profile v2` / `--network-dim/alpha` / `--output-name` / `--container-dataset-dir`）+ `scripts/moss-lora-eval.py`（新增 `--multiplier`、多目录逐对 Δ）。数据/LoRA 只放 `data/character-lora/v2/` 与 `/mnt/data0`。

### 9.1 数据扩充与清洗

- 生成器：Qwen-Image-Edit-2511（服务器 18110），`simple=false`（**关键**：服务默认 simple=true 会追加「胸部以上近景」并把画面裁到 72%，这正是 task-24 数据近景偏多的原因），参考 character-1+character-2，10 步，输出 832×1280。
- 候选矩阵 32 张：半身 8 / 四分之三身 8 / 全身 8 / 低角度 4 / 侧脸 4；prompt 强化「中蓝 #4a6fa5，不能银白/白/浅灰/浅蓝/青绿/褪色」并复用身份/画风描述；负向词含发色漂移 + 手部畸形。
- 串行 + 500/超时退避重试（15/20s，最多 2 次额外尝试）。原批次 27/32 成功、5 个 500；抓到的服务端错误体为：
  `{"detail":"edit failed: index 11 is out of bounds for dimension 0 with size 11"}`（多参考图 pipeline 内部索引越界，非 OOM；换 seed 重试即成功）。
- 质检：ArcFace best-ref cosine + 逐张 contact sheet 人工目检；剔除 噪点图 3 张、伪影 1 张、脸太小 1 张、发色过浅 1 张、身份过淡 1 张，并对被剔除项全部重新生成。
- **最终：新增 29 张 + 原 30 张 = train 59 张；eval 8 张不变**（train/eval 场景分离）。记录：`data/character-lora/v2/qc-v2.json`。

### 9.2 Caption profile v2（降低风格-身份耦合）

MOSS 的文本编码器是 Qwen3.5（LLM），sd-scripts 的 `(word:1.2)` CLIP 权重语法对它不生效；因此用**结构 + 顺序**给身份词加权：

```text
karen_style, the fixed character identity, a 24-year-old Chinese woman with shoulder-length
medium-blue bob hair (#4a6fa5), gray-blue eyes, pale skin, slim build; her face, hairstyle and
hair color must stay exactly the same across images, <scene>, wearing <outfit>, <framing>,
<light>, art style: soft pencil and watercolor illustration, muted cool tones, subtle paper texture,
clean background..., single person, no text/watermark/border
```

- 身份描述放最前、写具体（含 `fixed character identity` / `must stay exactly the same` / slim build）；
- 风格压缩到最后一句（去掉 fine linework/paper texture 等长串细节），避免压过身份；
- v1 caption profile 保留默认（`--caption-profile v1`），可复现旧实验。

### 9.3 v2 训练

```bash
# 本机：准备并上传（59 train / 8 eval，rank32/alpha32，1500 步）
.runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/moss-lora-prepare.ts \
  --raw-root data/character-lora/v2/raw --caption-profile v2 \
  --network-dim 32 --network-alpha 32 --full-steps 1500 --save-every 250 \
  --output-name karen_style_moss_v2 \
  --remote-dir /mnt/data0/lwh/karen-stack/datasets/karen-lora-v2
# 服务器：smoke → full（GPU6，podman 容器 + venv）
bash /mnt/data0/lwh/karen-stack/datasets/karen-lora-v2/run_smoke.sh
nohup setsid bash /mnt/data0/lwh/karen-stack/datasets/karen-lora-v2/run_full.sh \
  > /mnt/data0/lwh/karen-stack/training/logs/v2-full-<ts>.log 2>&1 &
```

| 指标 | smoke（40 步） | full（1500 步） |
|---|---|---|
| loss | 0.439→0.445 平稳 | sample mean **0.4275** / min 0.331 / max 0.461（3000 采样，无发散）；末尾 `avr_loss=0.429` |
| 速度 | 1.49–1.52 s/it | **1.50 s/it** |
| 耗时 | 训练 60s；含首次缓存 wall 133s | **37:23**（1500 步；含加载/缓存复用） |
| 显存 | GPU6 整卡峰值 56.1GB（同卡他人约 40GB，训练自身约 +16GB） | 同量级（无 OOM） |
| 产物 | `karen_style_moss_v2_smoke.safetensors` | `karen_style_moss_v2(-step00000250/500/750/1000/1250/1500).safetensors`；final 297,370,320 B（rank32） |
| metadata | — | dim32 / alpha32 / bf16 / AdamW / steps=1500 / epoch=26 / 59 images / 756 keys 且无 `lora_te_*` |

### 9.4 评测设计（四组同 prompt/seed）

| 组 | 来源 | 说明 |
|---|---|---|
| base | `/mnt/data0/.../datasets/karen-lora/eval-out/base` | MOSS-Image-SFT 无 LoRA（task-25 已生成） |
| v1 | `/mnt/data0/.../datasets/karen-lora/eval-out/lora` | v1 LoRA（rank16/1200 步，task-25 已生成） |
| v2 | `datasets/karen-lora-v2/eval-out/v2` | v2 LoRA（rank32/1500 步，multiplier 1.0） |
| v2-m115 | `datasets/karen-lora-v2/eval-out/v2-m115` | v2 + multiplier 1.15 |
| Qwen（同 prompt 上限） | `datasets/karen-lora-v2/eval-out/qwen-en` | Qwen-Image-Edit，同 8 条 v1 eval-prompts + 同 seed，参考 character-2 + 自拍 |
| Qwen 参考组（中文原 prompt） | `.../eval-out/qwen`、`.../qwen-1ref` | task-24 原始 prompt 条件，用来校准「Qwen 真实上限」（跨 prompt，仅参考） |

- 所有 MOSS 组与 Qwen 同 prompt 组都用 `datasets/karen-lora/eval-prompts.txt`（8 条未见场景，同 seed）；
- 指标：ArcFace best/mean/primary、检出脸数、逐图 base→v1→v2 Δ、contact sheet、人工看脸/发色/风格/手；
- 判据（按最新优先级）：v2 以「接近 Qwen 同 prompt 基线」为准；若 best mean 差 >0.05，结论为「MOSS 暂不替换自拍，继续 Qwen，MOSS 仅保留 shadow」。

### 9.5 评测结果（实测，2026-10-27）

**四组同 prompt/seed（8 条未见场景 eval-prompts，832×912，50 步）ArcFace（vs 9 张参考图，取最像）：**

| 组 | best mean | std | min | max | primary mean | 检出脸 |
|---|---|---|---|---|---|---|
| base（MOSS 无 LoRA） | 0.2503 | 0.1031 | 0.0939 | 0.4344 | 0.0851 | 8/8 |
| v1（rank16/1200 步） | 0.6731 | 0.1119 | 0.5403 | 0.8337 | 0.4397 | 8/8 |
| **v2 best（rank32/1500 步，ckpt1250，multiplier 1.0）** | **0.7664** | **0.0342** | **0.7314** | **0.8505** | 0.5096 | 8/8 |
| v2 ckpt1250 + multiplier 1.15 | 0.7639 | 0.0675 | 0.6303 | 0.849 | 0.5152 | 8/8 |
| v2 ckpt1500（对照） | 0.7250 | 0.0585 | 0.6183 | 0.8196 | 0.4749 | 8/8 |
| Qwen 双参考（character-2 + 自拍，中文原 prompt） | 0.7463 | 0.0955 | 0.616 | 0.9008 | 0.5657 | 8/8 |
| **Qwen 单参考（character-2，task-24 同款，中文原 prompt）** | **0.8389** | 0.0877 | 0.6334 | 0.9057 | 0.6706 | 7/8* |
| task-24 原基线（Qwen-1ref 原始数据集图） | 0.8584 | 0.046 | 0.7557 | 0.9057 | — | 8/8 |

\* Qwen 单参考组 1 张生成失败（噪点图，无脸），已排除在均值外；该组还包含 1 张发色过浅图（0.6334），因此 0.8389 仍略低于原基线 0.8584。

**逐组 Δ（同 prompt/同 seed 配对，best cosine）：**

| 对比 | mean Δ | std | min | max |
|---|---|---|---|---|
| base → v1 | +0.4228 | 0.0841 | +0.3193 | +0.5790 |
| v1 → v2（ckpt1250） | **+0.0933** | 0.1094 | -0.0833 | +0.2224 |
| v2 → v2-m115 | **-0.0025** | 0.0519 | -0.1134 | +0.0664 |

**checkpoint 选择：**

| ckpt | 2 条探针 mean | 全 8 条 mean | 结论 |
|---|---|---|---|
| step1000 | 0.7492 | — | |
| step1250 | 0.7566 | **0.7664**（std 0.0342） | ✅ 采用 |
| step1500 | 0.719（同 2 条） | 0.7250（std 0.0585） | 过训迹象，弃用 |

**人工目检（contact sheets）：**
- v2 8/8 都是稳定的「齐肩 bob + 齐刘海 + 中蓝发色 + 灰蓝眼 + 水彩铅笔」Karen 脸；8 张全检出发色未漂白、无文字/水印/多余人脸；
- 相比 v1：v2 的跨场景一致性明显更稳（std 0.112→0.034，min 0.54→0.73），近景偏「幼圆」的问题改善有限但构图更接近参考立绘；
- 与 Qwen 单参考组相比：Qwen 更「成熟/精细」、单张最高分更高（0.87–0.91），但 Qwen 双参考配置会漂移出长发/银蓝发（其 std 0.096），稳定性反而低于 v2；
- multiplier 1.15 无收益（mean -0.0025，且 seed 8 掉到 0.63）→ 推荐 multiplier **1.0**。

**结论（按最新优先级）：**
- v2 相对 v1 显著提升（mean +0.093、最差图 min +0.19、稳定性翻倍），是当前 MOSS-Image 下最好的 identity LoRA：推荐 **ckpt `karen_style_moss_v2-step00001250.safetensors` + multiplier 1.0**。
- 但 v2 best mean 0.7664 与 **Qwen 单参考 0.8389 差 0.0725 > 0.05**，未达到「接近最强 Qwen」的门槛 → **自拍/人物图暂不替换 Qwen，继续 Qwen 产出；MOSS v2 仅保留 shadow / 离线高质量候选**，不为替换而替换。
- 备注：若只与 Qwen 双参考（0.7463）比，v2 略高（+0.020）且稳定得多，可作为「多参考 Qwen 的更稳候选」记录，但不改变上面结论。

### 9.6 v2 产物清单

| 类型 | 路径 |
|---|---|
| v2 数据集（本机，gitignore） | `data/character-lora/v2/raw/{train,eval}`（59/8）、`candidates/`（32 张候选）、`qc-v2.json`（接受/拒绝与原因） |
| v2 数据集（服务器） | `/mnt/data0/lwh/karen-stack/datasets/karen-lora-v2/`（train 59 / eval 8 / TOML / eval-prompts / run_*.sh / moss-lora-eval.py） |
| v2 LoRA（best） | `/mnt/data0/lwh/karen-stack/models/karen-moss-lora/karen_style_moss_v2-step00001250.safetensors`（rank32，multiplier 1.0） |
| v2 LoRA（final / 对照） | `.../karen_style_moss_v2.safetensors`（1500 步）、`..._step00000250/500/750/1000/1500.safetensors`、`..._smoke.safetensors` |
| v2 eval 图 | `datasets/karen-lora-v2/eval-out/{v2-c1250,v2-c1250-m115,v2,v2-m115}/01…08-*.png` |
| Qwen 对照图 | `.../eval-out/{qwen,qwen-1ref,qwen-en}/`（中文原 prompt 2ref/1ref；英文同 prompt 组因服务 500 未完成） |
| v2 评测报告/contact sheet | `datasets/karen-lora-v2/eval-report-final/{report.md,metrics.json,contact-{base,v1,v2,v2-m115}.jpg}` |
| checkpoint 抽选 | `.../eval-report-c1250/`（1250 vs 1500 全 8 条）、`.../eval-report-triage/`（1000/1250 探针） |
| Qwen 参考组报告 | `.../eval-report-qwen-ref/`（qwen_zh_2ref vs qwen_zh_1ref）、`.../eval-report-qwen-only/`、`.../eval-report-qwen1ref/` |
| 训练/生成日志 | `/mnt/data0/lwh/karen-stack/training/logs/{v2-smoke-*,v2-full-*,v2-gen-*,qwen*-*}.log` |
