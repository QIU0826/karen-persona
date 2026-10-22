# VoxCPM2 服务（GPU2，48kHz）

> 状态：**2026-10-22 已在 GPU2 上验证**。与 Qwen3-TTS 同卡；GPU3 未使用。

## 构建

依赖本地 `karen-qwen3tts:0.1`（PyTorch 2.8 / CUDA 12.8 / FastAPI）。

```bash
podman build -t karen-voxcpm2:0.1 deploy/gpu-server/voxcpm2
```

## 权重

```text
/mnt/data0/lwh/karen-stack/models/VoxCPM2
```

用 ModelScope 下载：

```bash
modelscope download --model OpenBMB/VoxCPM2 \
  --local_dir /mnt/data0/lwh/karen-stack/models/VoxCPM2
```

## 启动

```bash
podman run -d --name karen-voxcpm2 \
  --device nvidia.com/gpu=2 \
  --restart=unless-stopped \
  -p 127.0.0.1:18102:18102 \
  -e VOXCPM2_MODEL_DIR=/workspace/models/VoxCPM2 \
  -e VOXCPM2_REF_AUDIO=/workspace/data/voice-ref/xiaoya.wav \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-voxcpm2:0.1
```

## 启动（已验证）

```bash
podman run -d --name karen-voxcpm2 \
  --device nvidia.com/gpu=2 \
  --restart=unless-stopped \
  -p 127.0.0.1:18102:18102 \
  -e VOXCPM2_MODEL_DIR=/workspace/models/VoxCPM2 \
  -e VOXCPM2_REF_AUDIO=/workspace/data/voice-ref/xiaoya.wav \
  -e TORCH_COMPILE_DISABLE=1 \
  -e TORCHDYNAMO_DISABLE=1 \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-voxcpm2:0.1
```

> 镜像里没有 gcc；不关 `torch.compile` 会在 Triton 编译阶段报 `Failed to find C compiler`。
> 关闭后 warm 约 **2.0–3.7s**（3.7–5.9s 音频），首请求约 16s。

## 测试

```bash
curl -s http://127.0.0.1:18102/health
curl -s -X POST http://127.0.0.1:18102/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"今天天气真好，我坐在窗边看了一下午的书。"}' \
  -o /tmp/vox.wav
```

`style` 可传自然语言风格，服务会加到文本前面的括号里，例如：

```json
{"text":"今天天气真好。","style":"语气更开心、轻快一点"}
```

## 说明

- 48kHz 输出；零样本克隆先用 8.3s 参考音，后续再用充足样本微调。
- 先测 `load_denoiser=False`；显存约 8GB。
- 服务只绑容器 0.0.0.0:18102，宿主机映射 127.0.0.1:18102，不公网暴露。


## 实测（2026-10-22，GPU2）

- 输出 **48kHz**；模型约 4.7GB；服务加载后 GPU2 总占用约 **11.8GB**（含 Qwen3-TTS 4.9GB）。
- warm 延迟：中性 5.28s 音频约 **3.1s**；开心（style=cheerful）5.12s 音频约 **3.7s**；难过 5.92s 音频约 **3.2s**；生气 3.84s 音频约 **2.2s**。
- ASR 回读：开心/生气/难过基本一致；中性句 ASR 把「一下午」听成「一下我的」，与 Qwen3-TTS 相同，属 ASR 小模型误差。
- `style` 直接拼在文本前括号中，英文风格描述可用；中文风格描述待进一步验证。
- 与 Qwen3-TTS 同卡运行，未使用 GPU3。
