# Qwen3-TTS 最小服务（GPU2）

> 状态：**2026-10-22 已在 8×6000D 的 GPU2 上验证**。只使用 GPU2；服务绑定容器 `0.0.0.0:18101`，宿主机映射 `127.0.0.1:18101`。

## 构建

基础镜像：`pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime`（Blackwell sm_120）。

```bash
podman build -t karen-qwen3tts:0.1 deploy/gpu-server/qwen3tts
```

## 下载权重（ModelScope）

本次已下载到 `/mnt/data0/lwh/karen-stack/models/Qwen3-TTS-12Hz-1.7B-Base`（约 4.3G）。
如需重下，用轻量 Python 容器：

```bash
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  docker.m.daocloud.io/library/python:3.12-slim \
  bash -lc 'pip install -i https://pypi.tuna.tsinghua.edu.cn/simple modelscope && \
    modelscope download --model Qwen/Qwen3-TTS-12Hz-1.7B-Base \
      --local_dir /workspace/models/Qwen3-TTS-12Hz-1.7B-Base'
```

## 参考音

把 8.3s 参考音放到：

```text
/mnt/data0/lwh/karen-stack/data/voice-ref/xiaoya.wav
```

## 启动

```bash
podman run -d --name karen-qwen3tts \
  --device nvidia.com/gpu=2 \
  --restart=unless-stopped \
  -p 127.0.0.1:18101:18101 \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-qwen3tts:0.1
```

## 测试

```bash
curl -s http://127.0.0.1:18101/health
curl -s -X POST http://127.0.0.1:18101/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"今天天气真好，我坐在窗边看了一下午的书。","language":"Chinese"}' \
  -o /tmp/test.wav
```

## 说明

- 当前用 `x_vector_only_mode=True`，不需要参考音文字；音色相似度可能略低于带 `ref_text` 的模式。
- 不接 `instruct`：Qwen3-TTS Base 的微调示例不承诺 instruct；情绪后续用 GPT-SoVITS 情绪参考音或 CustomVoice。
- 服务只监听容器内 `127.0.0.1`，容器端口映射到宿主机 `127.0.0.1:18101`，不公网暴露。


## 实测（2026-10-22，GPU2）

- 模型加载后显存约 **4.9GB**；GPU2 利用率 0% 空闲、合成时 25%。
- 3.4–5.4s 音频：单次 **4.3–5.4s**（同步非流式；4 次请求）。
- ASR 回读：开心/生气文本基本一致；中性句 ASR 把「一下午」听成「一下我的」，属 ASR 小模型误差，需人工听感确认。
- 日志有 `sox: not found`、`flash-attn is not installed` 提示；WAV 合成正常，后续再优化。
- 仍用 `x_vector_only_mode=True`；可补参考音文字提升相似度。
