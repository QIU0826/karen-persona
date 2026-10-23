# Qwen2.5-Omni-7B 音频理解服务（GPU3）

> 状态：部署脚本就绪（2026-10-22）。用于 transcript + tone/emotion/singing/sarcasm/background。
> 它是音频大模型，不是绝对准确的“读心术”；不确定项要求模型返回 uncertain。

## 权重

```bash
modelscope download --model Qwen/Qwen2.5-Omni-7B \
  --local_dir /mnt/data0/lwh/karen-stack/models/Qwen2.5-Omni-7B
```

## 构建 / 启动

```bash
podman build -t karen-qwen-omni:0.1 deploy/gpu-server/qwen-omni
podman run -d --name karen-qwen-omni \
  --device nvidia.com/gpu=3 --restart=unless-stopped \
  -p 127.0.0.1:18113:18113 \
  -e QWEN_OMNI_MODEL_DIR=/workspace/models/Qwen2.5-Omni-7B \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-qwen-omni:0.1
```

## 接口

```bash
curl -s -X POST http://127.0.0.1:18113/understand \
  -H 'Content-Type: audio/wav' \
  --data-binary @/mnt/data0/lwh/karen-stack/data/voice-ref/xiaoya.wav
```

产品：

```env
KAREN_ASR_BACKEND=qwen-omni
QWEN_OMNI_URL=http://127.0.0.1:19113
```

失败自动回退 SenseVoice → faster-whisper。

## 实测（2026-10-22/23）

- 权重 21GB；GPU3 加载后约 51.5GB（与 Z-Image/SenseVoice 同卡）。
- 8.3s 参考音：首请求 15.6s；transcript 正确；tone/emotion uncertain；singing=no；sarcasm=uncertain；background music。
- TTS happy 3.68s：1.2s，tone/emotion=happy，confidence 1.0。
- TTS angry 3.84s：0.9s，tone/emotion=angry，confidence 0.8。
- 未用真实唱歌/阴阳怪气样本验证；这两项只作“可能/不确定”展示。
- 当前 QQ/NapCat 未运行，bridge ws_connections=0；Omni 服务本身健康。
