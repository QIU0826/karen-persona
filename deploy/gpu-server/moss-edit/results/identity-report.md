# Karen MOSS-Image identity LoRA —— 评测报告（自动生成）

- 生成时间（UTC）：2026-10-27T11:21:59Z
- ArcFace：insightface `buffalo_l`（providers: CPU）
- 参考图：3 张（检出 3）

## 各目录 identity cosine（vs 9 张参考图，取最像）

| 目录 | 图片数 | 检出脸 | best mean | std | min | max | primary mean |
|---|---|---|---|---|---|---|---|
| moss-edit | 5 | 5 | 0.122 | 0.07 | 0.023 | 0.2221 | 0.0742 |
| qwen | 5 | 3 | 0.8224 | 0.0347 | 0.7914 | 0.8709 | 0.738 |
| qwen-cached | 5 | 5 | 0.6563 | 0.0804 | 0.5702 | 0.7846 | 0.6521 |

## 同 prompt / 同 seed 的 moss-edit → qwen 提升

| # | seed | moss-edit best | qwen best | Δ |
|---|---|---|---|---|
| 2 | None | 0.2221 | 0.8049 | +0.5828 |
| 4 | None | 0.1138 | 0.7914 | +0.6776 |
| 5 | None | 0.023 | 0.8709 | +0.8479 |

Δ 统计：n=3，mean=0.7028，std=0.1097，min=0.5828，max=0.8479

## 同 prompt / 同 seed 的 qwen → qwen-cached 提升

| # | seed | qwen best | qwen-cached best | Δ |
|---|---|---|---|---|
| 2 | None | 0.8049 | 0.6512 | -0.1537 |
| 4 | None | 0.7914 | 0.5702 | -0.2212 |
| 5 | None | 0.8709 | 0.6997 | -0.1712 |

Δ 统计：n=3，mean=-0.182，std=0.0286，min=-0.2212，max=-0.1537

## 产物

- contact sheet（moss-edit）：`/mnt/data0/lwh/karen-stack/moss-edit/results/identity-report.md/contact-moss-edit.jpg`
- contact sheet（qwen）：`/mnt/data0/lwh/karen-stack/moss-edit/results/identity-report.md/contact-qwen.jpg`
- contact sheet（qwen-cached）：`/mnt/data0/lwh/karen-stack/moss-edit/results/identity-report.md/contact-qwen-cached.jpg`
- 原始指标：`/mnt/data0/lwh/karen-stack/moss-edit/results/identity-report.md/metrics.json`

## 判读注意

- ArcFace cosine 对角度/遮挡/侧脸敏感；侧脸、回眸、近景构图会天然降低分数。
- 单张图不达标不代表 LoRA 无效；看均值、逐图 Δ 与 contact sheet 的人工观感。
- 若 lora 组检出脸数下降，优先检查脸部崩坏/遮挡，而不是只看 cosine。
