# SenseVoiceSmall 服务（GPU3，ASR + 情绪 + 音频事件）

> 2026-10-22 已验证：CUDA，8.3s 参考音约 **245ms**；输出 text/emotion/events。
> 它是“语音理解”的第一步，不是完整音频大模型；阴阳怪气仍不可靠。

## 构建/启动

```bash
podman build -t karen-sensevoice:0.1 deploy/gpu-server/sensevoice
podman run -d --name karen-sensevoice \
  --device nvidia.com/gpu=3 --restart=unless-stopped \
  -p 127.0.0.1:18112:18112 \
  -e SENSEVOICE_MODEL_DIR=/workspace/models/SenseVoiceSmall \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-sensevoice:0.1
```

权重：ModelScope `iic/SenseVoiceSmall` → `/mnt/data0/lwh/karen-stack/models/SenseVoiceSmall`。

## 接口

```bash
curl -s -X POST http://127.0.0.1:18112/understand \
  -H 'Content-Type: audio/wav' \
  --data-binary @/mnt/data0/lwh/karen-stack/data/voice-ref/xiaoya.wav
# {"text":"...","emotion":"sad","events":["BGM"],"language":"zh"}
```

## 产品接入

```env
KAREN_ASR_BACKEND=sensevoice
SENSEVOICE_URL=http://127.0.0.1:19112
```

`qq.ts` 把结果拼成 `[语音：文字｜语气：开心｜背景：笑声]`；SenseVoice 失败自动回退
faster-whisper，只给纯文字。

## 实测（2026-10-22）

- 参考音：`sad`，事件 `BGM`，245ms；
- TTS happy 样本：`happy`；
- angry/neutral 样本：仍可能被判 `sad`，**情绪标签只能当参考，不能当事实**；
- 未拿真实唱歌/阴阳怪气样本验证，不能承诺这两项。
