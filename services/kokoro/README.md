# Kokoro 中文神经 TTS 服务（v0.9.15）

让她的语音用**开源中文少女音色**，而不是 macOS `say` 的机械音。

- 模型：[hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)（**Apache-2.0**，82M 参数）
- 音色：`zf_xiaoxiao` / `zf_xiaobei` / `zf_xiaoyi`（中文女声，均通过 ASR 可懂度验证；
  `zf_xiaoni` 实测 ASR CER 53%，已从白名单移除）
- 采样率：24kHz，单声道 16-bit PCM
- 实测（M5 Pro，CPU）：RTF **0.16–0.20x**（4.8s 语音合成 ~0.8s），三音色 ASR CER **≤5%**
- 系统 TTS 保留为回退（有 `say` 的 macOS 上 kokoro 失败会自动退回 `say`）

## 安装（一次性）

```bash
# Python 3.12（uv 装的也可以）
~/.local/share/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12 -m venv services/kokoro/.venv
services/kokoro/.venv/bin/pip install -r services/kokoro/requirements.txt -i https://mirrors.aliyun.com/pypi/simple

# 模型（327MB，不入库；hf-mirror 分块下载）
python3 scripts/...   # 见 docs/VOICE_QUALITY.md §5 的下载命令
```

## 启动

```bash
npm run kokoro:start        # 127.0.0.1:18086
npm run kokoro:smoke        # 健康/三音色/可懂度/产品链路/回退 五段验证（零 API 成本）
```

## 接口

- `GET /health` → `{ok, loaded, voices, sr, load_error}`
- `POST /synthesize` body `{text, voice?, speed?}` → `audio/wav`（24k PCM16）
  - 错误：`400 empty_text|text_too_long|voice_not_allowed`、`500 synthesis_failed`

## 启用（默认关）

```bash
KAREN_TTS_BACKEND=kokoro
KOKORO_TTS_URL=http://127.0.0.1:18086   # 默认
KOKORO_TTS_VOICE=zf_xiaoxiao            # 可选 zf_xiaobei / zf_xiaoyi
```

试听样本在 `assets/voice-samples/`（含 `system-tingting-*` 对照）。
