# VoxCPM2 产品接入（2026-10-22）

## 结论

本机聊天语音已从 IndexTTS-2.5 切到 **VoxCPM2（GPU2，48kHz）**，作为主音色；
IndexTTS-2.5 保留为服务级回退（代码未删），Kokoro / `say` 仍是最后回退。

## 环境变量

```env
KAREN_TTS_BACKEND=voxcpm2
VOXCPM2_TTS_URL=http://127.0.0.1:19102   # Mac SSH 隧道 -> 服务器 18102
VOXCPM2_TIMEOUT_MS=60000
# 可选：VOXCPM2_CFG_VALUE=2.0 / VOXCPM2_STEPS=10
```

## 链路

`src/bridge/qq.ts` → `synthesizeSpeech()` → `src/ai/voxcpm2-tts.ts` → `/synthesize` → 48kHz WAV →
`silk-wasm` 编码 → QQ `record` 段。

- 语气风格由 `tts-style.ts` 的 `natural/soft/lively/tired` 映射成 VoxCPM2 风格描述；
- Vox 失败自动继续尝试 IndexTTS（若启用）→ Kokoro → `say`，不阻塞聊天；
- 单次文本上限仍是 60 字，避免语音过长。

## 实测（2026-10-22，本机全链路）

- 文本：`今天天气真好，我坐在窗边看了一下午的书。`
- 结果：**ok=true**；音频 **5.28s**；SILK **22,437 bytes**；端到端 **3.24s**（含服务合成 + SILK 编码）
- 服务 `/health`：VoxCPM2，48kHz，GPU2

## 注意

- 当前参考音是 8.3s 的 `xiaoya.wav`；不是 full fine-tune，等 30–60 分钟样本再做 SFT。
- Qwen3-TTS 服务当前停着；Vox 失败时不会自动切 Qwen3-TTS（尚未接适配器），会走 IndexTTS（若开）/Kokoro。
- Mac 隧道 `19102 -> 18102` 断掉时，Vox 会被判失败并回退；建议 autossh 守护。
