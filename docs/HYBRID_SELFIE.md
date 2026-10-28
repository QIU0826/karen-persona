# 混合自拍：MOSS v2 生成 + Qwen-Image-Edit 修脸（task-29 实验报告）

> 日期：**2026-10-27**｜状态：**实验完成 + shadow wrapper 已部署（18118/19118）**，**不切生产默认**。
> 目标：在「人物一致性优先」前提下，验证 **MOSS v2（identity LoRA ckpt1250）生成** + **Qwen-Image-Edit 只修脸/五官** 的混合路线，
> 看能否接近 Qwen 单参考自拍的 identity（Lead 给的判定：hybrid ≥ Qwen 同条件 −0.02 **或** ≥0.82）。
> 服务代码：[deploy/gpu-server/moss-hybrid/](../deploy/gpu-server/moss-hybrid/)｜实验脚本：[scripts/hybrid-selfie-bench.sh](../scripts/hybrid-selfie-bench.sh)

---

## 1. 结论摘要（先看这里）

1. **按 refs9（9 张参考图，与 task-27 评测口径一致）**：hybrid **0.8052** vs 同批 Qwen 20 步 **0.7812**
   → hybrid **+0.024**（通过「≥ Qwen 同条件 −0.02」），距历史 Qwen 单参考 0.839 差 **0.0338（≤0.05）**。
2. **按 refs3（character-1/2/3，task-26/28 口径）**：hybrid **0.5429** vs Qwen 20 步 **0.6867** → hybrid **−0.144**，
   **不满足**「≥ Qwen−0.02」，也远低于 0.82。两个口径差异很大（见 §4.3），必须并列，不能只挑一个。
3. **修脸增量几乎为零**：hybrid ≈ MOSS v2 单跑（refs9 0.8052 vs 0.8018，**+0.0034**；refs3 0.5429 vs 0.5430，**−0.0001**）；
   guard 也相同（moss-base 3/5、hybrid 3/5）。即 **identity 的主要来源是 MOSS v2 LoRA，不是 Qwen 修脸**。
4. **延迟代价大**：单张 = MOSS **39–44s** + Qwen 修脸 **55–72s**（15 步/2 参考）→ **约 110s**；
   Qwen 撞 500 重试时最坏实测 **143s**。Qwen 单跑约 22–48s，MOSS v2 单跑约 40s。
5. **产品建议**：
   - **自拍生产继续 Qwen-Image-Edit**（不切 `.env`、不改默认）；
   - hybrid 作为 **shadow 能力**保留（wrapper 已可接入，Node `KAREN_SELFIE_BACKEND=moss-hybrid`）；
   - 如果用户能接受 MOSS 画风，**直接用 MOSS v2（~40s）比 hybrid 更划算**（多花 ~70s 只换来 +0.003 identity）；
   - 只有在「必须由 MOSS 出图 + 需要 Qwen 局部重绘/修补」时才值得 hybrid，且要接受 ~110s 延迟与单并发。

---

## 2. 实验设置

| 项 | 值 |
|---|---|
| MOSS | GPU6 `18116`，MOSS-Image-SFT + Karen identity LoRA **v2 ckpt1250**（`models/MOSS-Image-SFT-karen-lora-v2-c1250/`；rank32/alpha32 → merge scale 1.0；252/252 modules、0 NaN） |
| Qwen | GPU2 `18110`，Qwen-Image-Edit-2511（生产同款；默认 2 张 clean 参考 + simple） |
| 提示词 | 5 场景：咖啡馆 / 家·沙发 / 夜街 / 雨窗 / 海边；MOSS 用训练 caption 风格（`karen_style`+中蓝 bob+铅笔水彩）；Qwen 用生产中文自拍 prompt |
| seed | MOSS 4319/4308/4252/4328/4316；Qwen direct 同 seed 偏移 |
| 分辨率/steps | MOSS 832×1216 / 50 步；Qwen direct 10 步与 20 步两组；hybrid 修脸 15 步、2 参考（base + character-2） |
| 参考图 | refs9 = `datasets/karen-character/refs`（character-1/2/3 + 5 缓存自拍 + promo final）；refs3 = character-1/2/3 |

产物（服务器）：`/mnt/data0/lwh/karen-stack/data/tmp/hybrid/{moss-base,qwen-direct,qwen-direct-v2,hybrid}/`，
contact sheet `contact-hybrid.jpg`，指标 `identity-all-refs9/`、`identity-all-refs3/`。

---

## 3. 结果（ArcFace buffalo_l，best mean）

### 3.1 refs9（9 张参考图）

| 组 | n | 检出脸 | best mean | std | min–max |
|---|---|---|---|---|---|
| MOSS v2 base（c1250） | 5 | 5 | **0.8018** | 0.0173 | 0.7722–0.8157 |
| Qwen direct（10 步，弱 prompt） | 5 | 5 | 0.6712 | 0.1402 | 0.4017–0.8031 |
| **Qwen direct（20 步，身份保持 prompt）** | 5 | 5 | **0.7812** | 0.0594 | 0.6907–0.8502 |
| **Hybrid（MOSS v2 + Qwen 修脸）** | 5 | 5 | **0.8052** | 0.0224 | 0.7769–0.8301 |

### 3.2 refs3（3 张立绘）

| 组 | best mean | std | min–max |
|---|---|---|---|
| MOSS v2 base | 0.5430 | 0.0550 | 0.4734–0.6014 |
| Qwen direct（10 步） | 0.5734 | 0.1837 | 0.2430–0.8031 |
| **Qwen direct（20 步）** | **0.6867** | 0.1675 | 0.3882–0.8359 |
| **Hybrid** | **0.5429** | 0.0277 | 0.5147–0.5769 |

### 3.3 判定

| 判定项 | 结果 | 说明 |
|---|---|---|
| hybrid ≥ Qwen 同条件 −0.02（refs9） | ✅ **+0.024** | hybrid 0.8052 vs Qwen20 0.7812 |
| hybrid ≥ 0.82（refs9） | ❌ **0.8052** | 差 0.0148 |
| hybrid 距历史 Qwen 单参考 0.839 ≤0.05 | ✅ **0.0338** | Lead 认可的口径 |
| hybrid vs Qwen（refs3 口径） | ❌ **−0.144** | 0.5429 vs 0.6867；不能证明优于 Qwen |
| guard（真实 DeepSeek Flash） | ❌ 3/5（Qwen 缓存自拍 5/5） | hybrid 与 MOSS base 失败场景相同 |

**为什么两个 refs 口径差异这么大**：MOSS v2 输出是「铅笔水彩插画脸」，与 refs9 里的 5 张 Qwen 缓存自拍照风格/构图更接近，
而与 refs3 的 3 张宣传立绘差异更大；ArcFace 对画风/角度敏感，绝对分数强烈依赖参考集。**任务判定应以「同条件 A/B」为主**：
同 prompt/seed/refs 下 hybrid 与 Qwen 的差值在 refs9 为正、refs3 为负，说明 hybrid 并未稳定优于 Qwen。

### 3.4 Qwen 500 与重试

实验期间 Qwen（18110）与其它任务竞争，多次随机 500（`index N out of bounds for dimension 0 with size 11`）；
脚本/ wrapper 均带退避重试（hybrid benchmark 5/5 最终成功；wrapper 实测 `X-Qwen-Attempts` 出现过 2）。

---

## 4. 延迟与资源

| 环节 | 耗时 |
|---|---|
| MOSS v2 生成（18116，832×1216/50 步） | **39.3–43.8s**（服务端计时），显存峰值 28.09GB |
| Qwen 修脸（18110，15 步，2 参考） | **71.1s**（hybrid benchmark 同批） |
| Qwen direct（20 步） | 95.0s / 张（GPU2 高负载时） |
| **Hybrid 总延迟（实测 wrapper）** | **约 110s**（MOSS 39s + Qwen 71s）；Qwen 重试时最坏 **143s** |
| 并发 | wrapper 单锁串行；并发 503 |

资源：MOSS 占 GPU6（常驻 25.35GB，峰值 28.09GB）；Qwen 占 GPU2（高负载时其单张 20 步达 95s）。
Z-Image 场景路径（GPU3）与 GPU7 基础 MOSS 服务（18114）未改动。

---

## 5. 视觉与 guard（人工 + DeepSeek Flash）

- **构图/场景/服装/发型保持良好**：hybrid 5/5 与 MOSS base 同一场景、同一构图、同一水彩画风；
  唯一变化是画幅从 832×1216 → 832×1280（Qwen 输出尺寸按 latent 对齐）；
- **脸的变化很小**：contact sheet 目检与 moss-base 基本同一张脸（这也是 identity 仅 +0.003 的原因）；
- **guard（requireNoHands + expectCharacter）**：MOSS base **3/5**、hybrid **3/5**、Qwen 缓存自拍 **5/5**；
  失败点相同：家（手臂入镜/结构异常）、夜街（raw pass=false）、海边（右下角手臂/穿模）；
  **Qwen 修脸没有改善这些失败**（因为它被要求「只修脸、不动构图/身体」）。

---

## 6. Shadow 接入：wrapper（已部署）

- 服务：`deploy/gpu-server/moss-hybrid/wrapper_server.py`，GPU 服务器 `127.0.0.1:18118`，Mac 隧道 **19118**；
  **只绑 127.0.0.1**（`ss -ltn | grep 18118` 已确认），不暴露公网；
- 流程：`POST /selfie {prompt,width,height,seed,fix_steps}` → MOSS 18116 生成 base（服务端拼 `karen_style` 身份/画风）
  → base 临时落盘 → Qwen 18110 `/edit`（`image_paths=[base, character-2]`，只修脸 prompt）
  → 返回 PNG（`X-Total-Ms`/`X-Moss-Ms`/`X-Fix-Ms`/`X-Qwen-Attempts`/尺寸）；临时文件 finally 清理；
- 兼容 `POST /edit`（现有 `editMossImage` 协议），也可用 `KAREN_SELFIE_BACKEND=moss-edit` + `MOSS_IMAGE_EDIT_URL=http://127.0.0.1:19118` 接入；
- Node 新增 `KAREN_SELFIE_BACKEND=moss-hybrid`（默认仍 qwen）：失败/guard 不过 → Qwen → 本地图库；
  `KAREN_SELFIE_STEPS` 在 hybrid 下是修脸步数（8–30，默认 15）；
- 隧道：`scripts/gpu-tunnel.sh` 已加 `19118→18118`；健康检查 `src/obs/dependency-health.ts` 增加 `selfie-moss-hybrid`。

### 6.1 Node 真实链路（2026-10-28 补验）

- `generateMossHybridImage()` 经 Mac 隧道 `19118` 实测成功：`ok=true`；
- 本次 MOSS 生成 **38.96s** + Qwen 修脸 **165.75s** = **204.9s**（当时 Qwen 18110 高负载；文档 §4 的 110s 是空闲时基线）；
- 输出 PNG 832×1280，构图/蓝发/水彩风格保持；guard 未额外通过（与实验组一致 3/5）；
- 结论不变：hybrid 延迟与单并发代价过高，**不切生产**；Node 分支默认 qwen。

---

## 7. 生产切换建议（不切）

| 问题 | 结论 |
|---|---|
| 现在切生产自拍吗？ | **不切**。默认 `KAREN_SELFIE_BACKEND` 保持不设（qwen）；`.env` 未改 |
| hybrid 可切换条件 | 用户接受 **~110s/张** 延迟 + 单并发 + MOSS 画风；且仅当确实需要 MOSS 出图时 |
| 若切，怎么切（回退简单） | 设 `KAREN_SELFIE_BACKEND=moss-hybrid` + `MOSS_HYBRID_URL=http://127.0.0.1:19118`；回退=删这两行（默认回 qwen）；wrapper 停=`moss-hybrid/stop.sh` |
| 更划算的替代 | 如果接受 MOSS 画风，直接 `KAREN_SELFIE_BACKEND=moss-t2i`（MOSS v2 单跑 ~40s，identity refs9 0.8018 ≈ hybrid 0.8052） |
| 若坚持 Qwen | 维持现状；MOSS 全部 shadow |

**延迟代价**：hybrid 比 Qwen 单跑（~22–48s）慢 **~2–5×**；比 MOSS v2 单跑慢 **~2.8×**，但 identity 只多 0.003。
因此从产品 ROI 看：**Qwen（现状）或 MOSS v2 单跑** 都比 hybrid 合理；hybrid 只保留为 shadow/实验能力。

---

## 8. 风险与后续

- **单并发 + 双服务依赖**：wrapper 串行且同时依赖 18116/18110；任一挂掉即失败（Node 会回退 Qwen/图库）。
- **Qwen 500**：并发/负载下随机 500，wrapper 重试 3 次；最坏 143s。
- **refs 口径敏感**：refs3 下 hybrid 明显低于 Qwen20（0.5429 vs 0.6867），不能用 refs9 单口径对外宣称「超过 Qwen」。
- **修脸增量≈0**：若目标是 identity，修脸步骤可去掉；若目标是局部瑕疵修补，需要重新设计 prompt/步骤并单独评测 guard。
- 后续若要继续：① 固定 refs 口径统一评测（建议 refs9 为主 + refs3 附录）；② 扫 fix_steps（8/12/20）与参考图组合；
  ③ 对 guard 失败场景（家/夜街/海边）做定向修图 prompt；④ 若 Qwen 服务空闲，补严格同条件 Qwen 基线。
