> **2026-10-22 晚些时候**：本机已再切到 **VoxCPM2（GPU2，48kHz）**；产品接入/实测见 [VOXCPM2_PRODUCT.md](VOXCPM2_PRODUCT.md)。IndexTTS-2.5 保留回退。
# 声音克隆方案：Fun-CosyVoice 3.0 可信性核验（v0.9.16）

> 目标：把她的语音从「开源通用音色」升级为**可指定参考音的零样本克隆**（3–10s 参考音频），
> 采用阿里 FunAudioLLM 的 **Fun-CosyVoice3-0.5B-2512**。
> 本文只记录**可核验的事实**；厂商宣称、第三方博客、我的实测分开写，不混在一起。
>
> **2026-10-22 晚些时候**：本机已改用 **IndexTTS-2.5**（8 维情绪向量），接入步骤/实测/回滚见 [docs/INDEXTTS2.md](INDEXTTS2.md)；本文的 CosyVoice 实验数据仍保留，作为可回退方案。
>
> **2026-10-22 本机更新（用户提供参考音）**：用户提供视频 `ScreenRecording_10-22-2026 11-23-31_1.MP4`（22.9s，同一句说了三次），
> 剪 `0.35–8.65s`（8.3s）作为参考音，文本按 ASR + 人耳校正为「又讨厌我了，那怎么办？我想办法让你再喜欢我。」；
> 已写入 `data/voice-ref/xiaoya.wav` + `xiaoya.json`（**只在本机，data/ 已 gitignore，不提交**）。
> 本机 `.env` 已切 `KAREN_TTS_BACKEND=cosyvoice` + `COSYVOICE_VOICE_ID=xiaoya`；`cosyvoice:smoke` 的
> 健康 / 克隆 / ASR 复核 / 产品 SILK 全过。**代码默认仍是 Kokoro**（别人 clone 仓库不会自动用这段声音），
> 且 CosyVoice 服务没起/失败时会回退 Kokoro → say。参考音来源为用户提供素材，仅本机使用。

## 1. 采用的版本（官方来源）

| 项 | 值 | 来源 |
|---|---|---|
| 模型 | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` | [HuggingFace 模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) / [ModelScope](https://www.modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) |
| 论文 | CosyVoice 3: Towards In-the-wild Speech Generation via Scaling-up and Post-training（arXiv:2505.17589） | [arXiv](https://arxiv.org/abs/2505.17589) |
| 代码 | `cosyvoice/cli/cosyvoice.py`（`CosyVoice3` 类）、`third_party/Matcha-TTS` | 官方 HF Space `FunAudioLLM/Fun-CosyVoice3-0.5B`（Apache-2.0 头声明） |
| 许可 | **apache-2.0**（模型卡 YAML front matter + 代码 LICENSE 头） | 已核实 |

## 2. 宣称 vs 核验状态

| # | 宣称 | 状态 | 说明 |
|---|---|---|---|
| 1 | Apache-2.0 | ✅ 已核实 | 模型卡 `license: apache-2.0`；app.py 头为 Apache-2.0 |
| 2 | 9 语种 | ✅ 已核实 | 模型卡 `language:` 字段列出 zh/en/fr/es/ja/ko/it/ru/de |
| 3 | 18 种中文方言/口音 | ⚠️ 部分核实 | 论文摘要写 "18 Chinese dialects"；**代码 `instruct_list` 实际 17 条**方言指令（广东/东北/甘肃/贵州/河南/湖北/湖南/江西/闽南/宁夏/山西/陕西/山东/上海/四川/天津/云南）。少 1 条，口径可能含"口音" |
| 4 | 零样本跨语种克隆 | ⏳ 待实测 | 代码有 `frontend_zero_shot` / `frontend_cross_lingual` 路径 |
| 5 | 3–10s 参考音可用 | ⏳ 待实测 | 官方未写死最短时长；app.py 对 prompt 音频有长度上限（见 §3） |
| 6 | 双向流式、150ms 延迟 | ❌ 本机不可得 | 需 GPU + 流式管线；本机只有 CPU 路径 |
| 7 | ≥8GB 显存 | ⚠️ 第三方说法 | 非官方；本机实测内存占用见 §4 |
| 8 | 1M 小时训练 / 0.5B→1.5B 模型 | ⚠️ 需区分 | 论文的 1.5B 是内部/评测模型；**开源权重是 0.5B**，不能把 1.5B 的数字直接套到开源版 |
| 9 | Instruct 控制（方言/情感/语速/音量） | ✅ 代码存在 | `instruct_list` 含方言 17 + 音量 2 + 语速 2 条指令；实际效果待实测 |
| 10 | 音质/相似度 SOTA | ⏳ 待实测 | 模型卡有评测表，但那是官方自测基准；独立复现见 §5 |

## 3. 硬件与代码现实（已核实）

- **设备选择**：`cosyvoice/cli/model.py`、`frontend.py` 只用 `cuda if available else cpu`，**无 MPS 分支**
  → Mac 上只能 CPU 推理（或有 CUDA 的机器/租 GPU）。
- **依赖体积**：权重合计 **≈5.4GB**（llm.pt 2.02GB + flow.pt 1.33GB + speech_tokenizer_v3.onnx 0.97GB +
  CosyVoice-BlankEN 0.99GB + hift.pt 83MB + campplus.onnx 28MB）；可选 `llm.rl.pt` 再 +2.0GB（不用）。
- **运行内存**：权重 fp32 常驻 ≈5.4GB + 激活；本机 24GB 统一内存可行（实测见 §4）。
- **spk2info.pt 缺失但不影响**：`frontend.py` 里 `if os.path.exists(spk2info)`，零样本路径不需要预置说话人。
- **参考音**：官方 Space 自带 `zero_shot_prompt.wav`（334KB，仅用于功能验证；语音授权未注明，**不做产品素材**）。
- **Python 依赖**：官方 requirements 钉 `torch==2.10.0 / torchaudio==2.10.0 / transformers==4.51.3 / funasr==1.2.0 / wetext==0.0.4`；
  CUDA 相关（tensorrt/onnxruntime-gpu）在 macOS 上用 `onnxruntime` 替代（requirements 里有 darwin marker → 官方考虑过 macOS）。

## 4. 本机实测（M5 Pro，24GB，CPU；2026-10-21）

| 指标 | 结果 | 门槛 | 结论 |
|---|---|---|---|
| 模型加载 | **2.8–4.3s**（5.4GB 权重） | ≤60s | ✅ 远好于预期（mmap 加载） |
| 合成 RTF | **1.86–3.50x**（4–18s 音频） | ≤2.5x | ⚠️ 偏慢（Kokoro 是 0.16–0.20x，慢 10–20 倍） |
| 峰值内存（RSS） | **8.3GB**（部分运行 5.7–7.7GB） | ≤12GB | ✅ 可跑，但占掉 24GB 的 1/3 |
| 中文 CER（本机 ASR 反验） | **0.0%**（官方参考音 + 7.3s 参考音的稳定样本） | ≤5% | ✅ |
| 说话人相似度（campplus cosine） | **0.76**（官方 demo 参考）/ **0.87**（10.9s 合成参考） | ≥0.70 | ✅ |
| 3–10s 参考音 | 3.48s / 7.28s / 10.9s 都试过 | 可用 | ⚠️ **越短越不稳**（见 §5.1） |
| 长文本（两句 18 字） | 正常（RTF 1.90x，无复读） | — | ✅ |

**稳定性（最重要发现）**：同一句「今天店里人不多…拉花歪了」在同一个参考音下，
5 次随机种子输出时长 5.96 / 6.00 / 8.16 / 8.44 / **18.40s**（18.4s 是明显复读）；
换官方真人参考音后同句完全正常（4.44s、ASR 全对）。
→ **合成音当参考音不可靠；真人 8–10s 参考音才稳**。

## 5. 本机适配补丁与已知问题

上游代码按「有 CUDA 的 Linux」写，Mac CPU 直跑有 4 个硬编码问题（已打补丁，均在 vendored 代码里注释）：

1. `CosyVoiceModel.load()` 里 `self.device = 'cuda'` → 改为 CUDA 可用才用 CUDA；
2. `flow.py` / `hifigan` 里 `.cuda()` 调用 → 仅 CUDA 可用时调用；
3. `load_wav()` 用 `torchaudio.load`（torchaudio≥2.9 依赖 torchcodec/ffmpeg）→ 改用 `soundfile` 解码；
4. `third_party/Matcha-TTS/matcha/utils/__init__.py` 会连带导入 wandb/gradio/rootutils 等训练依赖 → 置空（推理只用 pylogger）。

依赖坑：`onnxruntime==1.18` 与 numpy 2.x 二进制不兼容（`_ARRAY_API not found`）→ 实测用
`onnxruntime==1.22` + `numpy 2.2.6` 可用；`ruamel.yaml` 必须 <0.18；`setuptools<81`（Matcha 用 pkg_resources）。

**其他已知问题**：
- 没有 MPS 分支（上游只写 cuda/cpu），Mac 只能 CPU；
- 参考音用合成音时容易出现"变慢/复读"；真人参考音正常；
- 150ms 流式延迟在本机不可得（需 GPU + vLLM/TensorRT，未接）；
- 0.5B 开源权重 ≠ 论文 1.5B 旗舰模型，官方评测数字不能直接套用。

## 6. 伦理与合规（克隆语音必须处理）

1. **参考音授权**：必须使用自有录音或明确可商用/可改编的授权音源；不能用明星/网红/动漫角色音。
   官方 demo 的 `zero_shot_prompt.wav` 来源未注明 → 只做功能测试，不进产品。
2. **声音权/肖像权**：中国大陆《民法典》第 1023 条对自然人声音参照肖像权保护；欧盟 AI Act 对深度合成有透明度要求。
3. **AI 披露**：本项目默认关闭聊天内 AI 披露（用户明确要求），但**语音克隆产物在对外发布/商用场景应显著标注**。
4. **数据流向**：CosyVoice 本机推理，参考音与合成音频不会上传第三方（与云端 TTS 的关键差异）。
5. **误用防护**：不做"伪造他人语音"功能；参考音入库前记录来源与授权声明。

## 7. 集成方案（已实施，v0.9.16）

```
文本 → (可选) CosyVoice3 零样本克隆（参考音=用户在设置里指定的 3–10s 音频）
     → 24kHz WAV → silk-wasm → QQ 语音条
失败/超时/内存不足 → 回退 Kokoro（v0.9.15） → 再回退 macOS say
```

- 开关：`KAREN_TTS_BACKEND=cosyvoice`（**代码默认仍 kokoro**；本机 2026-10-22 已用用户提供的 8.3s 参考音切到 cosyvoice）
- 服务：`services/cosyvoice/server.py`（18087），`/health` + `/voices` + `/synthesize`
- 参考音管理：`data/voice-ref/<id>.wav` + `<id>.json`（ref_text/来源/授权/时长/sha256），不入库
- **导入工具**：`npm run voice:ref:add -- --input <录音> [--id xiaoya] [--text 逐字稿]`
  支持 mp3/m4a/aac/wav/aiff，自动转 24k、>10s 截断、ASR 识别参考文本
- Node 客户端：`src/ai/cosyvoice-tts.ts`；`tts.ts` 回退链 **cosyvoice → kokoro → say**
- **防复读守卫**（`server.py`）：时长合理性检查（CJK 字数估算 0.55–1.8x）+
  本机 ASR 复核（CER ≤0.25，默认开）+ 最多 3 个种子重试；全失败返回 500 → Node 回退
- 验证：`npm run cosyvoice:start` / `npm run cosyvoice:smoke`（健康/克隆/独立ASR/产品SILK/回退链）

## 8. 结论（可信度评级）

**总评：可以采用的实验性方案，但不是现在就能替换 Kokoro 的默认方案。**

| 维度 | 评级 | 依据 |
|---|---|---|
| 许可合规 | **A（可信）** | 模型/代码均 Apache-2.0（已核实）；参考音授权需用户自行保证 |
| 功能真实性 | **A（可信）** | 零样本克隆、9 语言、方言指令在代码中真实存在；本机端到端跑通 |
| 硬件宣称 | **B（部分可信）** | 内存 8.3GB 实测（"≥8G"基本成立，但那是 RAM；官方没写 VRAM）；CPU 可用但慢 10–20 倍 |
| 质量宣称 | **B（需打折）** | 相似度 0.76–0.87、CER 0% 在稳定样本上成立；但**合成参考音会复读**，稳定性依赖参考音与种子 |
| 流式/延迟宣称 | **C（本机不可得）** | 150ms 需 GPU+流式管线，本机 CPU 单句 13–40s |
| 生产就绪度 | **C（实验性）** | 需真人参考音、需防复读守卫、内存占用高、无 MPS |

**给产品的结论**：
1. 保留 Kokoro 作为**代码默认**（快 10–20 倍、稳定、内存 1GB）；
2. CosyVoice 作为**可选克隆后端**（`KAREN_TTS_BACKEND=cosyvoice`）；本机已用用户提供的 8.3s 视频参考音启用，
   参考音只在本机 `data/voice-ref/`，没有进仓库；
3. 在有 CUDA 的机器上它才是"产品级"（150ms 流式、RTF<1），本机只能算"可用但慢"。

**对"3–10 秒参考音"的核验**：3.48s 官方参考可用；但**合成参考音 4.85s 会不稳/复读**、
7.28s 部分句子不稳、10.9s 稳定（相似度 0.87）。→ 建议生产用 **8–10s 真人参考音**，而不是 3s 极限值。
