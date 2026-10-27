# Karen 角色 identity LoRA 训练（MOSS-Image × kohya sd-scripts）

> 任务：P3 / task-25 —— 用 MOSS-Image-SFT 训练 Karen 角色 identity LoRA，验证一致性是否优于/接近现有基线。
> 状态：**已完成** —— smoke 通过 → 1200 步全量训练（30.5 min）→ base vs LoRA 同 prompt/seed 出图 + ArcFace 评测。核心结果：LoRA 把 eval identity best cosine 从 base **0.250 → 0.673**（+0.423），人工看脸型/发色/画风已明显回归 Karen；但仍低于 task-24 Qwen-Image-Edit 数据集的 0.858（跨模型、生成方式不同，不可直接比）。**未切换生产**。
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
