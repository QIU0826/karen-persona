# 语音识别（ASR，v0.9.0）

> 目标：**她能听懂你发的语音**。此前用户发来的 QQ 语音条一直只是 `[语音]` 占位——
> 她只能发语音、不能收语音，这是"像真人"最后一个明显短板。

## 1. 方案：本机 faster-whisper（CPU int8）

| 方案 | 结论 |
|---|---|
| 云端 ASR API | 未采用：隐私优先 + 额外费用 |
| macOS Speech 框架 | 不可从 Node/Python 简单调用，且需要系统授��� |
| **faster-whisper（采用）** | CTranslate2 后端，CPU int8，`small` 模型中文可接受；M 系列单条 1–3s 语音约 **0.9–1.5s** |
| whisper.cpp | 需要编译 + ggml 模型；效果相近，但依赖链更多 |

模型：`Systran/faster-whisper-small`（~484MB），中文输出经 **OpenCC t2s** 统一转简体
（whisper 常输出繁体「天氣／吃飯」）。

## 2. 目录与清理

| 内容 | 位置 | 清理 |
|---|---|---|
| Python 环境 | `services/asr/.venv/`（约 250MB） | 删目录 |
| 模型权重 | `services/asr/models/faster-whisper-small/`（465MB） | 删目录 |
| 运行数据 | 无（不落盘音频；仅内存处理） | — |

## 3. 启动与开关

```bash
npm run asr:start     # 启动服务（默认 127.0.0.1:18085）

# .env
KAREN_ASR=on
KAREN_ASR_URL=http://127.0.0.1:18085
```

服务没起/超时/解码失败 → **静默回退 `[语音]` 占位**，聊天不受影响（和生图一致）。

## 4. 链路

```
QQ 语音条(SILK) → 桥接下载(url) → silk-wasm decode → PCM16
  → 包 WAV 头 → POST /transcribe（本地 faster-whisper）
  → 简体文本 → 注入对话（[语音：...]）
```

隐私：日志只记字符数与耗时，**不打印识别正文**。

## 5. 模型下载（本机可复现，和生图同一套问题）

HF 直连不通、hf_hub 默认走 Xet CDN 也不可达；`hf-mirror.com` 可用但单连接限速。
做法：

1. 小文件（config/tokenizer/vocabulary）直接 `curl` 镜像 resolve；
2. `model.bin`（484MB）用 **64MB/块、4 路并发 curl** 下载后按序拼接（约 2–4MB/s）。

## 6. 实测（v0.9.0）

| 场景 | 耗时 | 结果 |
|---|---|---|
| 文本→TTS SILK→ASR（约 4s 语音） | 1414ms | 「今天天气不错,我们晚上一起去吃饭吧。」 |
| 纯 WAV（say 生成，1.6s） | 962ms | 「明天下午3点开会。」 |
| 垃圾字节 / 不支持格式 | — | 明确失败并回退，不抛异常 |
| 桥接 E2E（假 ASR 服务） | — | 转写文本真的进入模型 prompt ✅ |

## 7. 局限（如实）

- 只有中文（`language="zh"` 固定）；中英混说可能丢英文词；
- `small` 模型对口音/远场/背景噪声会错字，长句可能断句；
- 语音条需要 NapCat 提供可下载 URL；没有 URL 时回退占位；
- CPU 推理，和生图（MPS）不抢同一算力，但同时高负载时会变慢；
- **不做说话人识别**（群里谁的语音分不出来，群聊语音仍不支持）。
