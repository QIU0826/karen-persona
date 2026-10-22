# Qwen-Image-Edit-2511 服务（GPU2）

> 状态：**2026-10-22 已在 GPU2 验证**。20.4B / 约 57.7GB 权重；GPU2 加载后约 68GB（含 VoxCPM2），已接近满；下一模型建议 GPU3。
> 默认已改为 **simple 模式**：只用 2 张无手参考图、896 长边、20 步、胸部以上近景、屏蔽手部；输出再裁到上方 **72%**。

## 构建

基于本地 `karen-voxcpm2:0.1`（PyTorch 2.8 / CUDA 12.8）。

```bash
podman build -t karen-qwen-image-edit:0.1 deploy/gpu-server/qwen-image-edit
```

## 权重

```text
/mnt/data0/lwh/karen-stack/models/Qwen-Image-Edit-2511
```

ModelScope：

```bash
modelscope download --model Qwen/Qwen-Image-Edit-2511 \
  --local_dir /mnt/data0/lwh/karen-stack/models/Qwen-Image-Edit-2511
```

## 参考图

```text
/mnt/data0/lwh/karen-stack/data/karen-ref/
```

当前放 `character-1/2/3.jpg`；服务默认按文件名排序取前 4 张。

## 启动

先把 Qwen3-TTS 停掉释放显存（VoxCPM2 保留）：

```bash
podman stop karen-qwen3tts
```

然后：

```bash
podman run -d --name karen-qwen-image-edit \
  --device nvidia.com/gpu=2 \
  --restart=unless-stopped \
  -p 127.0.0.1:18110:18110 \
  -e QWEN_IMAGE_EDIT_MODEL_DIR=/workspace/models/Qwen-Image-Edit-2511 \
  -e QWEN_IMAGE_EDIT_REF_DIR=/workspace/data/karen-ref \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-qwen-image-edit:0.1
```

## 测试

```bash
curl -s http://127.0.0.1:18110/health
curl -s -X POST http://127.0.0.1:18110/edit \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"把背景换成雨夜街道，人物和衣服保持不变","num_inference_steps":40,"seed":0}' \
  -o /tmp/qwen_edit.png
```

## 说明

- `QwenImageEditPlusPipeline`，多参考图；默认 40 步、true_cfg_scale=4.0。
- 20.4B 权重加载后显存约 58GB；与 VoxCPM2 同卡会到 ~65GB，加激活接近 75–85GB。
- 首次加载/首张图很慢；后续再看是否 OOM。若 OOM，先停 VoxCPM2，只保留图像模型。
- 服务只绑容器 0.0.0.0:18110，宿主机映射 127.0.0.1:18110，不公网暴露。


## 实测（2026-10-22，GPU2）

- 权重约 54GB 落盘；加载后 GPU2 总占用约 **62.7GB**；推理后约 **68GB**，剩余约 **17GB**。
- 第一张 800×1312、40 步：**291s**；第二张 800×1312、20 步：**145s**。
- 质量：同一角色蓝发/白 T 恤/米色毛衣保持一致，雨夜街道与咖啡馆场景正确；20 步已可用。
- 当前 Qwen3-TTS 已停掉以释放显存；VoxCPM2 与图像模型同卡。
- GPU2 已接近满，Z-Image-Turbo 下一步放 GPU3。


## 手部问题处理

默认 `simple=true`：

- 参考图只使用 `character-1.jpg` / `character-2.jpg`（原 `character-3.jpg` 有手部，已从 clean 目录排除）；
- prompt 自动追加「胸部以上近景，不出现手部和手臂」；
- negative prompt 默认包含 bad hands / extra fingers / deformed hands；
- 896 长边、20 步，实测 **97s**；输出裁到上方 72%（832×921），严格质检确认无手/手臂。
- 需要手部姿势时传 `"simple": false`，但要接受 Qwen-Image-Edit 的手部风险，后续可用局部重绘修。
