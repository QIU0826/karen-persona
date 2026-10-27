# 角色一致性 LoRA：数据集、清洗与 ArcFace 基线（P3 前置）

> 状态：2026-10-27 完成准备工作（第二阶段：数据清洗 + 补生成 + 基线复测）。
> 本阶段**未训练 LoRA、未切换生产后端**（`KAREN_SELFIE_BACKEND`/`KAREN_IMAGE_BACKEND` 均未改动），未 commit。
> 数据与模型权重只放本机 `data/character-lora/` 与 GPU 服务器 `/mnt/data0`，不进 git。

## 0. 结论摘要

- 用现有 Qwen-Image-Edit 服务（GPU2）以宣传页角色立绘为参考，生成 38 张多场景角色图：30 张训练 + 8 张评测。
- 第一版训练集发色漂移严重（银白/青绿/蓝绿），ArcFace 初筛 + 人工目检后剔除并补生成；清洗后训练集 **30/30 干净**、评测集 **8/8 干净**（判定标准见 §4）。
- 参考图自身 ArcFace cosine 均值约 **0.708**（不同画法/表情之间本来就有差异），这是后续比较的噪声基线。
- 清洗后生成图 vs 参考图（最像的一张）cosine：训练集 mean **0.826**、评测集 mean **0.858**；与主参考 `character-2.jpg` 的 cosine 偏低（mean≈0.615），原因是 ArcFace 对水彩插画 + 侧脸/特写的相似度本身不稳定。
- 结论：可以进入 LoRA 训练（rank 16–32、1000–1500 步、1024px、batch 1 + 梯度累积），训练后用同一套 ArcFace + contact sheet 做回归门槛；**不达标不切换生产**。

## 1. 目标与范围

- 为 P3「人物一致性」准备可复现的数据集与零样本参考基线：
  1. 30–40 张多场景/服装/角度/光线的角色图，其中 8–10 张作评测集；
  2. ArcFace identity cosine 基线（参考图两两、缓存自拍 vs 参考图、生成图 vs 参考图）；
  3. 训练集清洗（自动初筛 + 人工目检 + 剔除原因记录）与补生成闭环。
- 本阶段不训练 LoRA，不接入 MOSS-Image，不改生产 env。

## 2. 环境与依赖

| 项 | 值 |
| --- | --- |
| Qwen-Image-Edit 服务 | GPU 服务器 podman 容器 `karen-qwen-image-edit`，远端 `127.0.0.1:18110`，Mac 隧道 `http://127.0.0.1:19110` |
| 服务 API | `POST /edit`，JSON `{prompt, simple:true, image_paths:[服务器绝对路径], num_inference_steps:10, seed}` → PNG |
| 服务挂载 | 容器 `/workspace` → 宿主机 `/mnt/data0/lwh/karen-stack`（参考图路径 `/workspace/data/karen-ref-promo/character-{1,2,3}.jpg`） |
| GPU 服务器 | `ssh -p 10236 lwh@118.122.220.72`（`server236`），数据盘 `/mnt/data0/lwh/karen-stack`（2.6TB 可用） |
| 数据集目录 | 本机 `data/character-lora/`（gitignore）；服务器 `/mnt/data0/lwh/karen-stack/datasets/karen-character/`（权限 700） |
| ArcFace 环境 | 服务器 venv `/mnt/data0/lwh/karen-stack/venvs/karen-arcface`：Python 3.12、insightface 2.1、onnxruntime 1.31.1（CPU）、pillow、opencv、scikit-image |
| 模型 | insightface `buffalo_l`（det_10g / w600k_r50 等 5 个 ONNX，288,621,354 B），放在 `$HOME/.insightface/models/buffalo_l/`（该账号 `$HOME=/mnt/data0/lwh`） |
| 不用 GPU 的原因 | GPU7 被 P2 MOSS-Image 部署占用；ArcFace 38 张图 CPU 推理总耗时 <1 分钟，避免抢卡 |

> 模型下载：GitHub release 直连很慢且会断，最终用 `gh-proxy.com` 镜像 8 线程分段下载后合并解压；脚本见附录命令。

## 3. 数据集构建

### 3.1 参考图（9 张，全部复制到 `refs/`）

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `character-1.jpg` / `character-2.jpg` / `character-3.jpg` | `promo/assets/` | 宣传页角色立绘（主身份锚点；character-2 最稳定） |
| `karen-selfie-{cafe,home,night,rain,sea}.jpg` | `assets/photos/` | 线上已使用的缓存自拍，用于基线对照 |
| `selfie-promo-final-20261023.png` | `data/image-samples/` | 已人工批准的终稿，用于基线对照 |

### 3.2 生成方法

- 生成脚本：`scripts/character-dataset.ts`（本机 Node 22 + tsx，调 19110 端口服务，串行，10 steps，超时 300s，失败换 seed 重试 2 次）。
- 场景定义写死在脚本 `SCENES` 数组，共 38 条：训练 10 场景 × 3 变体（服装/角度/光线不同），评测 8 张独立场景（服装/角度/光线均不与训练集重复）。
- 输出：`raw/train/<场景>-<seed>.png`、`raw/eval/...`，每张旁边有 `.json` sidecar（prompt/seed/refs/尺寸/sha256/耗时），汇总 `manifest.json`。
- 单张耗时约 28.5–29.4s；38 张一轮约 19 分钟；补生成按张数线性增加。

**Prompt 模板**（每张由 场景 + 身份 + 服装 + 构图 + 光线 + 画风 + 负向 拼接）：

```
<场景描述>；保持参考图同一个人：24 岁中国女性，齐肩的中蓝色短发（约 #4a6fa5；绝不能变成白色、银色、浅灰或褪色），
灰蓝色眼睛，苍白皮肤，脸型与五官必须与参考图完全一致，轻微腮红，克制的微笑；年龄、气质一致；
发色必须保持参考图的中蓝色（#4a6fa5），不能变浅、变灰、变白或褪色；服装：<outfit>；<构图/角度>；光线：<light>；
身份一致性优先于画风：脸型、五官比例、眼睛形状、发色必须与参考图一致，其次才是水彩画风；
画风与参考图一致：低饱和冷灰蓝色调，细腻铅笔/墨线线条 + 淡彩水彩晕染，轻微纸纹质感，背景简洁但有明确场景氛围，光线自然；
画面中不要出现任何文字、水印、logo、边框；不要出现第二个人；不要出现手、手指、手臂；
不要厚涂、高饱和、油光、3D 渲染、写实照片质感；不要戴帽子或口罩遮挡脸部；
不要银发、白发、浅灰发、灰白发或褪色头发；不要青色、绿色、蓝绿色发色；
头发必须是参考图那种中等饱和的中蓝色（#4a6fa5）；不要纯白或空白的背景区域，背景要完整绘制；
不要改变脸型、眼睛形状、年龄或五官比例
```

### 3.3 场景矩阵

**训练集（30 张，10 场景 × 3 变体）**：咖啡馆窗边、家里沙发、夜晚街头、雨天窗边、海边黄昏、公园长椅、旧书店、地铁站角落、清晨厨房、深夜阳台。
每场景 3 张覆盖不同服装（T恤/针织/衬衫/外套/大衣等）、角度（特写/四分之三/侧脸望窗/回眸）和光线（自然光/霓虹/台灯/阴雨/黄昏逆光）。

**评测集（8 张，场景与训练完全不重叠）**：城市天台黄昏（仰拍）、高铁车窗边（正侧面）、花市门口（四分之三）、深夜便利店（特写）、图书馆楼梯间（四分之三）、清晨海边（回眸）、冬天街道（特写+围巾）、唱片店（侧脸）。

### 3.4 文件布局

```
data/character-lora/
  refs/                     9 张参考图副本 + refs.json（sha256）
  raw/train/<场景>-<seed>.png + .json    最终训练集 30 张
  raw/eval/<场景>-<seed>.png + .json     评测集 8 张
  rejected/                 被剔除的图（保留审计，不进训练）
  qc.json                   自动初筛 + 人工剔除决策明细
  qc-overrides.json         人工 accept/reject 覆盖（含原因）
  manifest.json             数量/场景/文件清单/quality 汇总
  server-out/               服务器回传的 contact sheet、baseline.json/md
  experiments/multiref|singleref/  多参考图 vs 单参考图 5 张对照实验
```

服务器同名目录 `/mnt/data0/lwh/karen-stack/datasets/karen-character/` 保存 raw、refs、contact sheet、baseline（权限 700，不进 git）。

## 4. 清洗与补生成

### 4.1 自动初筛（ArcFace）

- 规则：每张图 `faces==1` 且「与 9 张参考图中最像的一张」的 cosine `>= 0.60`（阈值可调，脚本 `--qc-threshold`）。
- 参考图检测：`buffalo_l` 在 640 检测失败时自动切 1024 重试（`character-1.jpg` 是极端特写，640 检不出，1024 可检出）。
- 生成 38 张全部检出 1 张脸（多脸/无脸为 0）；自动筛的分布与剔除明细见 §4.4 与 `qc.json`。

### 4.2 人工目检标准

在 contact sheet 上逐张检查，出现以下任一即剔除：
1. 发色明显白/银/灰白/青绿/蓝绿（与 `#4a6fa5` 中蓝色不符）；
2. 脸型/眼睛/年龄明显不是同一人，或脸部被遮挡（口罩、手、物体）；
3. 手/手指/四肢/身体结构严重异常，或画面严重穿模/背景空白占比过大；
4. 场景与 prompt 明显不符。

### 4.3 剔除原因分布

第一轮 30 张训练集（采样 character-1/2/3 轮换参考图、弱化 prompt）质量问题：
- 银白/灰白发色：7 张
- 青绿/蓝绿/绿色发色：2 张
- 脸部扭曲/脸明显变小或不是同一人：1 张
合计 10 张剔除（`rejected/draft-rejects.json`），训练集剩 20 张。

补生成策略：
1. 训练集 10 张被剔除图全部用 **character-2 单参考图 + 强化发型/发色/背景负向 prompt + 新 seed** 重生成；
2. 复检后仍有 5 张发色偏青绿/银灰 → 再用**双参考图** `[character-2.jpg, karen-selfie-cafe.jpg]` 重生成（见 §4.5）；
3. 评测集 8 张首轮即全部通过自动+人工标准，未重生成；
4. 重复「初筛 → 目检 → 补生成」直至训练集 ≥24 张且全部干净；最终 30/30 训练、8/8 评测通过。

### 4.4 最终 QC 统计

| 阶段 | 训练 | 评测 | 说明 |
| --- | --- | --- | --- |
| 首轮生成 | 30 | 8 | 单参考图（character-1/2/3 轮换）、通用 prompt |
| 第一轮剔除 | -10 | 0 | 银白/灰白发 7、青绿/绿色发 2、脸部异常 1（详见 `rejected/draft-rejects.json`） |
| 第一次补生成 | +10 | 0 | character-2 单参考图 + 强化发色/背景负向 prompt + 新 seed；仍有 5 张发色偏青绿/银灰 |
| 第二轮剔除 | -5 | 0 | 青绿/蓝绿发 4、银灰发 1 |
| 第二次补生成 | +5 | 0 | 双参考图 `[character-2, karen-selfie-cafe]` + 新 seed（服务偶发 500，重试后成功） |
| **最终** | **30** | **8** | 自动初筛 + 人工目检全部通过；2 张侧脸图自动 cosine < 0.60，按人工 override 接受（下方说明） |

自动初筛（阈值 0.60，`qc.json`）最终 38 张的「与最像参考图 cosine」分布：mean=0.8328、std=0.0907、min=0.5158、max=0.9098；
分桶：≥0.70 34 张、0.65–0.70 1 张、0.60–0.65 1 张、0.55–0.60 1 张、<0.55 1 张。

低于 0.60 的 2 张（均人工复核为「侧脸/高调背景导致 ArcFace 偏低，脸型与发色一致」）：
- `train-cafe-window-b`（cosine 0.5158）：侧脸 + 高亮背景；
- `train-bookstore-b`（cosine 0.5914）：侧脸看窗外。

判定记录：`qc.json` 的 `decisions` 数组（每张图含 `accepted/reason/source/best_cosine`）；人工覆盖在 `qc-overrides.json`。

### 4.5 多参考图对照实验（5 张同 seed 同场景）

`image_paths=[character-2.jpg, karen-selfie-cafe.jpg]` vs 单参考图 `[character-2.jpg]`：

| 指标 | 单参考图 | 双参考图 |
| --- | --- | --- |
| ArcFace vs 最像参考图 mean / std | 0.8788 / 0.0577 | 0.8611 / 0.0310 |
| ArcFace vs character-2 mean | 0.6588 | 0.5500 |
| 发色 | 同 seed 下易漂成银白 | 稳定为中蓝色，肉眼更一致 |
| 服务稳定性 | 稳定（约 23–29s/张） | 不稳定：约一半请求返回 `500 edit failed: index N out of bounds for dimension 0 with size N`，重试 1–2 次才能成功（约 50s/张） |

结论：双参考图能明显修复发色，但服务对多图输入不稳定且与主参考的 ArcFace cosine 更低，所以只用于少数发色失败图补生成；批量生成仍用单参考图。后续若服务修复，可评估双参考图批量生成。

## 5. 训练 / 评测划分

- 训练：30 张（10 场景 × 3 变体）；评测：8 张（独立场景/服装/角度/光线）。
- 划分原则：评测图的场景、服装、构图、光线组合均不出现在训练集中，避免「见过同款」导致基线虚高；训练/评测目录物理隔离，评测集不参与任何训练或调参决策。
- 训练集覆盖：10 个场景、30 套服装、7 种构图、10 类光线；缺全身/多人/复杂手部（数据集刻意不出现手，降低训练噪声）。

## 6. ArcFace 基线（零样本参考）

- 模型：insightface `buffalo_l`（det_10g + w600k_r50），CPU；取图中面积最大的脸，640 检测失败切 1024；embedding 归一化后算 cosine。
- 数据：9 张参考图 + 38 张生成图（30 train + 8 eval）。
- 结果（完整明细见 `baseline.json` / `baseline.md`）：

| 对比 | n | mean | std | min | max |
| --- | --- | --- | --- | --- | --- |
| 参考图两两（9 张参考图全部检出的 36 对） | 36 | 0.7083 | 0.1124 | 0.5094 | 0.9176 |
| 参考立绘之间（character-1/2/3） | 3 | 0.7506 | 0.0263 | 0.7176 | 0.7819 |
| 缓存自拍 vs 参考立绘 | 15 | 0.6176 | 0.0705 | 0.5094 | 0.7846 |
| 缓存自拍之间 | 10 | 0.8002 | 0.0541 | 0.7071 | 0.8711 |
| 已批准终稿 vs 参考立绘 | 3 | 0.6047 | 0.0536 | 0.529 | 0.6441 |
| 生成图（全部 38 张）vs 最像的参考图 | 38 | 0.8328 | 0.0907 | 0.5158 | 0.9098 |
| 生成图（全部）vs character-2 主参考 | 38 | 0.6147 | 0.1046 | 0.3602 | 0.8003 |
| 训练集（30 张）vs 最像的参考图 | 30 | 0.8259 | 0.0981 | 0.5158 | 0.9098 |
| 评测集（8 张）vs 最像的参考图 | 8 | 0.8584 | 0.046 | 0.7557 | 0.9057 |

**参考图明细**（ArcFace 检出与相似度）：

| 参考图 | 检出 | 与其余参考图 mean | min | max |
| --- | --- | --- | --- | --- |
| character-1.jpg | ✅ | 0.6129 | 0.529 | 0.7522 |
| character-2.jpg | ✅ | 0.6755 | 0.5584 | 0.7846 |
| character-3.jpg | ✅ | 0.6592 | 0.5094 | 0.7819 |
| karen-selfie-cafe.jpg | ✅ | 0.7163 | 0.549 | 0.8537 |
| karen-selfie-home.jpg | ✅ | 0.7547 | 0.5768 | 0.8711 |
| karen-selfie-night.jpg | ✅ | 0.7504 | 0.5901 | 0.8521 |
| karen-selfie-rain.jpg | ✅ | 0.6754 | 0.5094 | 0.7842 |
| karen-selfie-sea.jpg | ✅ | 0.7824 | 0.6183 | 0.9176 |
| selfie-promo-final-20261023.png | ✅ | 0.7476 | 0.529 | 0.9176 |

**生成图最差 8 张**（完整 38 张明细见 `baseline.json`）：

| split | scene | seed | faces | best_ref | best cosine |
| --- | --- | --- | --- | --- | --- |
| train | 咖啡馆窗边 | 20265345 | 1 | selfie-promo-final-20261023.png | 0.5158 |
| train | 旧书店 | 20262870 | 1 | karen-selfie-rain.jpg | 0.5914 |
| train | 清晨厨房 | 20264121 | 1 | karen-selfie-rain.jpg | 0.6401 |
| train | 公园长椅 | 20262676 | 1 | selfie-promo-final-20261023.png | 0.6842 |
| train | 雨天窗边 | 20261900 | 1 | selfie-promo-final-20261023.png | 0.7065 |
| eval | 唱片店 | 20361706 | 1 | selfie-promo-final-20261023.png | 0.7557 |
| train | 雨天窗边 | 20261997 | 1 | karen-selfie-rain.jpg | 0.7956 |
| train | 公园长椅 | 20262579 | 1 | karen-selfie-rain.jpg | 0.8002 |

训练集 mean=0.8259 / std=0.0981，评测集 mean=0.8584 / std=0.0460。

**解读**：
- 参考图之间本身就只 mean≈0.71：宣传页立绘是画师风格化插画，ArcFace 训练于真人照片，且 3 张立绘的景别/角度差异很大，所以「同一个角色」的 ArcFace cosine 不能期望接近 1。
- 生成图 vs 最像参考图 mean≈0.826（训练）/0.858（评测），高于参考图之间的 0.708，说明生成图整体保持在该角色的 embedding 邻域内。
- 生成图 vs `character-2` 只有 mean≈0.615：因为生成图更接近镜头/构图相近的自拍参考的 embedding；这再次说明**不能用单一参考的 cosine 作为绝对门槛**，应使用「与参考图集合中最像一张的 cosine + 人工目检」。
- 评测集（8 张独立场景）cosine 与训练集接近甚至略高，说明模型在未见场景上也能保持身份，没有明显过拟合到训练场景。

**局限**：ArcFace 在插画/水彩画风上的有效性与真人照片不同；本基线只用于同管线内相对比较（例如 MOSS 零样本 vs Qwen 基线、LoRA 前后对比），不作为「这是同一个人」的绝对证明。

## 7. LoRA 训练建议（下一步，不在本阶段执行）

1. **数据**：训练集 30 张 1024px 居中裁剪；可以再做水平翻转（可选，注意发色/刘海不对称）；保留 8 张评测集不参与训练。若训练时 MOSS 需要 15–30 张，当前数量足够。
2. **rank/steps**：LoRA rank 16–32（建议先 r=32、alpha=32，同时训 transformer 的 q/k/v/o + MLP，冻结文本编码器）；1000–1500 步，batch 1 + grad accum 4–8，bf16，lr 1e-4（cosine 衰减）；每 200 步采样看 identity。
3. **caption**：短场景句 + 固定身份 token（如「karenxiaoya」或「karen_person」）+ 服装/光线描述；不要放「水彩/插画」风格标签，风格由底模承担。
4. **回归门槛**：训练后用同一 `character-eval.py --mode all` 重算；要求 ArcFace「best-ref」mean 不低于 Qwen 基线（0.826/0.858）太多（如 ≥0.80），评测集不劣化；同时跑 `scripts/image-audit.ts`/人工 contact sheet 检查发色与手部。
5. **缺口**：目前没有全身/手部/强侧光/多人场景；如果产品需要，先补拍/补生成含手图的干净数据（需先解决手部解剖问题）；当前「无手」约束会限制 LoRA 生成含手画面的稳定性。
6. 训练器需自建（MOSS 官方没有训练脚本，`diffusers + peft` 或 ComfyUI MOSS 节点 + LoRA service）；训练失败或不达标就停在零样本参考基线并报告，不把零样本说成微调完成。

## 8. 风险与限制

- **服务稳定性**：Qwen-Image-Edit 单卡串行，多图输入偶发 500；批量生成需重试与断点续跑（脚本已支持跳过已存在文件、`--ids` 定向补生成）。
- **画风/身份 trade-off**：低饱和水彩画风会让发色变浅、脸型略二次元化；ArcFace 对插画不敏感，不能只看 cosine，必须配合人工目检。
- **数据隐私**：角色为 AI 生成虚拟形象，不涉及真人；参考图/训练图/embedding 只存本机与服务器数据盘（700），不入 git。
- **版权**：Qwen-Image-Edit-2511 与参考图由项目方提供，仅内部使用；MOSS/Moss-Image-Edit 许可按其仓库要求执行。
- **数据集泄漏**：补生成会改变 seed/文件名；`manifest.json` + `rejected/` 保留全量审计，训练脚本只读 `raw/train`。
- **评测集漂移**：评测集 8 张是自建小样本，人工 A/B 仍需另做（10 个日常自拍 prompt，≥7/10 不劣于 Qwen）。

## 9. 复现命令

```bash
# 本机（Node 22；路径按仓库根目录）
NODE=.runtime/node22/bin/node
TSX="node_modules/tsx/dist/cli.mjs"

# 1) 参考图副本 + 计划列表
$NODE $TSX scripts/character-dataset.ts --prepare --dry-run

# 2) 生成（可重复执行，默认跳过已有）
$NODE $TSX scripts/character-dataset.ts --only train
$NODE $TSX scripts/character-dataset.ts --only eval

# 3) 定向补生成（例：发色失败的 5 张，双参考图 + 新 seed）
$NODE $TSX scripts/character-dataset.ts --ids cafe-window-b,home-sofa-a,night-street-c,subway-corner-a,seaside-dusk-c \
  --force --seed-base 20265345 \
  --ref-list "/workspace/datasets/karen-character/refs/character-2.jpg,/workspace/datasets/karen-character/refs/karen-selfie-cafe.jpg"

# 4) 把数据推到服务器
rsync -az --delete -e "ssh -p 10236 -i ~/.ssh/karen_gpu" data/character-lora/raw/train/ \
  lwh@118.122.220.72:/mnt/data0/lwh/karen-stack/datasets/karen-character/raw/train/
rsync -az -e "ssh -p 10236 -i ~/.ssh/karen_gpu" data/character-lora/raw/eval/ \
  lwh@118.122.220.72:/mnt/data0/lwh/karen-stack/datasets/karen-character/raw/eval/

# 5) 服务器：contact sheet + ArcFace 基线
ssh -p 10236 -i ~/.ssh/karen_gpu lwh@118.122.220.72 \
  'cd /mnt/data0/lwh/karen-stack/datasets/karen-character && \
   /mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/python character-eval.py \
     --mode all --raw-dir raw --refs-dir refs --out-dir . --providers CPU'

# 6) 本机：把服务器基线做成 QC 报告（自动初筛 + 人工覆盖），写 qc.json 并更新 manifest
$NODE $TSX scripts/character-dataset.ts \
  --qc-report data/character-lora/server-out/baseline.json --qc-threshold 0.60
```

ArcFace 环境从零安装（服务器）：

```bash
python3 -m venv /mnt/data0/lwh/karen-stack/venvs/karen-arcface
/mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/pip install -U pip setuptools wheel
/mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/pip install insightface onnxruntime pillow numpy
# buffalo_l 下载（GitHub 直连慢/断；用镜像 8 线程分段下载后合并）
# 目标目录：$HOME/.insightface/models/buffalo_l/（$HOME=/mnt/data0/lwh）
```

## 10. 附录

### 10.1 脚本与产物

- `scripts/character-dataset.ts`：数据生成/补生成/QC 报告；参数：`--only`、`--ids`、`--ref`、`--ref-list`、`--seed-base`、`--force`、`--out-root`、`--prepare`、`--dry-run`、`--qc-report`、`--qc-threshold`。
- `scripts/character-eval.py`：服务器端 contact sheet（PIL）+ ArcFace 基线（insightface）。
- `data/character-lora/manifest.json`：数量/场景/文件清单 + `quality` 汇总。
- `qc.json`：每张图的 `faces/best_cosine/best_ref/accepted/reason/source` 完整决策。
- `contact-train.jpg` / `contact-eval.jpg`：人工目检用拼图（服务器与 `server-out/` 各一份）。

### 10.2 场景矩阵明细

训练集（每场景 3 张）：咖啡馆窗边、家里沙发、夜晚街头、雨天窗边、海边黄昏、公园长椅、旧书店、地铁站角落、清晨厨房、深夜阳台。
评测集：城市天台黄昏、高铁车窗边、花市门口、深夜便利店、图书馆楼梯间、清晨海边、冬天街道、唱片店。

- 最终数量：总数 38（train 30 / eval 8）；qc accepted=38、rejected=0。
- manifest.quality：threshold=0.6，accepted=38，rejected=0。
- 被剔除图共 15 张（两轮），保留在 `rejected/` 供审计，不参与训练/评测。

### 10.3 已知问题

- Qwen-Image-Edit 对「低饱和水彩 + 蓝色短发」组合会随机把发色洗成银白或偏青绿；prompt 负向只能降低概率，需要自动+人工双重筛选。
- 双参考图（`[character-2, karen-selfie-cafe]`）能修复发色但服务偶发 500（`index N out of bounds`），且生成图与 character-2 的 ArcFace cosine 更低、输出尺寸会在 960×783 / 832×921 间变化。
- `character-1.jpg` 是极端特写，`buffalo_l` 640 尺寸检不出脸，脚本自动切 1024 后可用。
- 评测集 cosines 只覆盖 identity；场景符合度/画风一致性仍需人工 A/B。
