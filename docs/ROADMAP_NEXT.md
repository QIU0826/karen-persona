# 下一阶段路线：B 站只读世界 + MOSS-Image 一致性升级

> 状态：2026-10-27 立项；与 README 的 v0.9.32 状态对应。
> 原则：先只读、先灰度、每步可回退；模型权重、训练数据、cookie/token 一律不进 git。

## 0. 目标

1. **B 站只读接入**：让 Karen 有“今天刷到的东西”可聊，不登录、不评论、不点赞。
2. **MOSS-Image 上线**：在 GPU 服务器空闲卡部署 MOSS-Image-SFT，替换现有 Z-Image（场景）与 Qwen-Image-Edit（自拍）主路径，旧服务保留回退。
3. **人物一致性**：先用参考编辑 LoRA 做零样本基线，再视评测结果训练 Karen 专属身份 LoRA；不达标不切换。

## 1. 硬件与部署位置

| 项 | 值 |
| --- | --- |
| GPU | RTX 6000D 84GB ×8；优先 **GPU7**（约 78GB 空闲），备用 GPU6 |
| 模型盘 | `/mnt/data0/lwh/karen-stack`（2.6TB 可用） |
| 模型 | `OpenMOSS-Team/MOSS-Image-SFT` 约 27.2GB（5B DiT + Qwen3.5-9B 文本编码器） |
| Mac | 仅客户端；MOSS 官方要求 NVIDIA CUDA，不在 Mac 跑生产推理 |

> 注意：服务器根分区只剩约 9.8GB；模型、HF 缓存、Podman 构建缓存必须放 `/mnt/data0`，构建前先清理旧镜像/缓存。

## 2. B 站只读（P1，1–2 天）

### 范围

- 热门/排行/搜索/视频详情/评论/弹幕（只读）；
- 不登录、不带 cookie、不发评论/弹幕/点赞；
- 用户发 BV 号或链接时：取标题、封面、简介、评论摘要，回复并附链接；不强制下载视频。

### 代码

- 新模块 `src/world/bilibili.ts`：内置 fetch、超时、重试、30–60 分钟缓存、黑名单/去重；
- 注入 `src/impulse/trending.ts` 或 daily-life 的“今天刷到的”话题；
- 配置：`KAREN_BILIBILI=on/off`、缓存 TTL、每日条数；
- 测试：mock fetch 单测 + 3 条真实 smoke + 无 cookie 检查。

### 参考

- `ssamurias/dsh-fish` 的 `lib/bili.js`（MIT）只读客户端思路；保留 attribution，不引 GPL 代码。

## 3. MOSS-Image 服务（P2，1–2 天）

### 服务

- `deploy/gpu-server/moss-image/`：Dockerfile、`server.py`、README；
- 端口：远端 `18114`（`/generate`）、`18115`（`/edit`）；隧道 `19114/19115`；
- API 与现有服务兼容：
  - `/generate`：`prompt/width/height/steps/seed` → PNG；
  - `/edit`：`prompt/image_paths/steps/seed` → PNG；
  - `/health`：loaded/device。
- 加载：bf16、VAE float32、50 步、guidance 3、`uncond_skip_layers=[22]`；尺寸 16 的倍数；单卡并发 1。

### Node 接入

- 新客户端 `src/ai/moss-image.ts`；
- `src/media/comfyui.ts` 增加 `moss-image` 后端；
- `src/media/selfie-generator.ts` 增加 `KAREN_SELFIE_BACKEND=moss-edit`；
- env：`KAREN_IMAGE_BACKEND=moss-image`、`MOSS_IMAGE_URL`、`KAREN_SELFIE_BACKEND=moss-edit`、`MOSS_IMAGE_EDIT_URL`；
- `/health` 增加两个依赖；失败回退 Z-Image/Qwen。

### 切换

1. 10 个场景 + 5 个自拍 prompt 基准；
2. shadow 3 天；
3. 先切场景，再切自拍；每次只改一个 env，可一键回退。

## 4. 人物一致性（P3，3–5 天）

### 4.1 零样本参考基线

- `chinoll/Moss-Image-Edit` 单/多参考图（GPLv3 只作为服务/权重使用，不拷代码进仓库）；
- 参考图：`promo/assets/character-{1,2,3}.jpg` + 5 张缓存自拍；
- 测 identity/guard/人工偏好。

### 4.2 数据集

- 用现有 Qwen-Image-Edit 生成 30–40 张多场景/服装/角度/光线变体，人工筛选；
- 留出 8–10 张评测集；
- 只存服务器 `/mnt/data0`，权限 700，不入 git。

### 4.3 LoRA 微调

- 官方没有训练脚本，需自建最小训练器 `train_lora.py`（diffusers + peft）；
- 冻结文本编码器，只训 transformer LoRA；
- rank 16/32，1024px，bf16，batch 1 + 梯度累积，1000–1500 步；
- 若 custom pipeline 不兼容 PEFT：改用 ComfyUI 原生 MOSS 节点 + LoRA 的 service 封装；
- 训练器不可行时停在参考基线并报告，不把零样本说成微调完成。

### 4.4 评测门槛

- ArcFace identity cosine：先测 Qwen 基线，MOSS 不劣于基线；
- image-guard 通过率不低于基线 5 个百分点以上；
- 人工 A/B 10 个日常自拍 prompt，≥7/10 不劣于 Qwen；
- 延迟 p95 ≤90s（50 步）；不达标用 8-step DMD 或降分辨率后重测。

## 5. 验收

- GitHub `main` 包含 README 宣传页/路线文档，CI 绿；
- B 站真实取到 3 条内容、无登录态、无写操作；
- MOSS `/health` loaded、真实出图、旧后端自动回退；
- 角色一致性评测报告写入 `docs/IMAGE_GEN.md`，达标后才切 `KAREN_SELFIE_BACKEND`。

## 6. 风险

- MOSS 官方无训练代码：先参考基线，再自建 LoRA；不达标不切换。
- 显存/磁盘：GPU7 可用，根分区紧张；模型放 data0。
- B 站 API 变动/限流：缓存 + 超时 + 静默回退。
- 隐私：角色图/训练集/LoRA 只存服务器；生成图人工审核后再发。
- 许可：MOSS Apache-2.0；Moss-Image-Edit 代码 GPLv3，不复制进仓库。
