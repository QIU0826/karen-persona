# IndexTTS-2.5 本机接入（v0.9.31）

> 最后更新：2026-10-22
>
> 结论：**本机已切换成功**。`KAREN_TTS_BACKEND=indextts2`，服务 `127.0.0.1:18088`；
> 参考音仍是用户视频里的 8.3s `data/voice-ref/xiaoya.wav`；产品冒烟通过。
> 模型/venv 在仓库外（`~/玩具/index-tts`），**不影响新装用户**（代码默认仍是 Kokoro）。

## 为什么换

- CosyVoice 3 的零样本克隆音色可以，但只靠 8.3s 中性参考音 + instruct2，情绪仍然偏平；
- IndexTTS-2.5 原生支持 **8 维情绪向量**（高兴/愤怒/悲伤/害怕/厌恶/忧郁/惊讶/平静）+
  时长因子，情绪控制更直接；
- 本机 MPS 可用，热态约 **3x RTF**（比 CosyVoice CPU 略快），代价是首次加载 / 内存。

## 本机安装位置（不在仓库）

| 项 | 路径 |
|---|---|
| 代码 + venv | `~/玩具/index-tts`（uv / Python 3.11） |
| 模型权重 | `~/玩具/index-tts/checkpoints`（约 13GB，含 w2v-bert / semantic codec / BigVGAN） |
| 服务包装 | `services/indextts2/server.py` + `run.sh`（本仓库） |
| 参考音 | `karen-persona/data/voice-ref/xiaoya.wav`（本地，gitignore） |

许可：模型使用 bilibili Model Use License（个人/研究可用；商用/超大规模需另行授权），
见 `index-tts/LICENSE`。参考音为用户提供素材，仅本机使用。

## 启动

```bash
# 服务（首次调用才加载模型，建议先 warmup）
npm run indextts:start        # 18088
npm run indextts:smoke        # 健康 + 直接合成 + 产品 SILK

# 切后端（本机 .env）
KAREN_TTS_BACKEND=indextts2
INDEXTTS_TTS_URL=http://127.0.0.1:18088
INDEXTTS_REF_WAV=/absolute/path/to/data/voice-ref/xiaoya.wav
```

健康检查：

```bash
curl -s http://127.0.0.1:18088/health
# {"ok":true,"loaded":true,"device":"mps",...,"ref_wav":".../xiaoya.wav"}
```

## 情绪映射

`src/ai/indextts-tts.ts` 把 v0.9.30 的 `SpeechStyle` 映射为 8 维向量：

| 风格 | 8 维向量（H/A/S/F/D/M/Su/C） | emo_alpha | duration_factor |
|---|---|---|---|
| lively | 高兴 0.6–0.85 + 平静 0.05–0.12 | 0.7–0.85 | 0.92 |
| soft | 悲伤 0.35–0.55 + 忧郁 0.2–0.3 + 平静 0.3 | 0.65–0.8 | 1.08 |
| tired | 悲伤 0.2 + 忧郁 0.4–0.55 + 平静 0.4 | 0.65–0.8 | 1.15 |
| natural | 不传向量（保留参考音语调） | — | 1.0 |

`tts.ts` 仍会先把语气润色文本（语气词/停顿，去掉 macOS `[[...]]` 命令）喂给模型。

## 实测（2026-10-22）

- 服务 `/health`：loaded=true，device=mps；
- 直接合成：2.31s 音频 / 7.1s；产品 `synthesizeSpeech`：1.94s 音频 / **5.9s**（含 SILK）；
- ASR：中性/温柔样本识别正确；开心样本「店里」被 small ASR 听成「天理」（模型发音/ASR 误差，非静音）；
- 试听样本（本地不入库）：`data/voice-samples/xiaoya-indextts-{happy,soft,neutral}-20261022.wav`。

## 限制

- **首次调用加载 10–30s**：`/health` 在加载前 `loaded=false`，第一次语音会等；服务常驻后热态约 4–6s/句；
- MPS 内存占用较高（指南约 8GB；本机进程 RSS 不含 MPS 分配），换回 CosyVoice 前记得停服务；
- 参考音仍是 8.3s，情绪上限受参考音限制；换更长的情感参考音会更好；
- 服务手动启动，不自启；服务挂了自动回退 Kokoro → say。

## 回滚

```bash
# .env 改回 cosyvoice（需先 npm run cosyvoice:start），或 kokoro（默认）
KAREN_TTS_BACKEND=cosyvoice
```
