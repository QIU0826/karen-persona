# Hugging Face 模型调研：语音情感、生图与可借鉴的技术栈

> 调研日期：2026-10-22
> 本机：Apple M5 Pro / 48GB 统一内存 / macOS 26.5 / 磁盘余量 ~670GB
> 现状：语音 IndexTTS-2.5（MPS，18088）；生图 SDXL-Turbo（MPS，18084）
> 说明：下面**官方宣称**与**本机实测**分开写；没在本机跑过的都标「未实测」，不把论文/榜单当成本机事实。

---

## 0. 结论先行

### 0.1 为什么现在听起来「机械」

不是单一原因，按影响排序：

1. **参考音只有 8.3s，且是偏中性的同一句话**。IndexTTS-2.5 官方推荐 5–15s，8.3s 在合格范围内但偏下限；零样本克隆主要复制参考音的**音色 + 说话方式**，参考音本身不撒娇/不激动，模型很难凭空长出丰富情绪。
2. **IndexTTS-2.5 的情绪控制是 8 维粗粒度向量**，不是自然语言细控；我们目前只在 `lively/soft/tired` 三种风格下给向量，很多语音走 `natural`（不传向量），听起来就是平叙。
3. **我们只用了「音色参考」**，没有用 IndexTTS 的**独立情绪参考音频**（`emo_audio_prompt`）——这是当前模型最容易被忽略、也最可能立刻改善的一项。
4. **文本层没有笑声/呼吸/哭腔等副语言标记**；IndexTTS 不支持这些标记，而 PilotTTS / Fish S1 支持。
5. **TTS 是最后一步**：回复文本本身如果短、平、书面，语音也很难生动；这是 LLM 文风 + TTS 共同结果。

所以答案是：**样本偏少/偏中性 + 模型能力上限共同造成**，但当前还有明显的“没榨干”空间，不是只能换模型。

### 0.2 如果只选一条路

| 你的优先级 | 建议 | 理由 |
|---|---|---|
| **最快改善、不换模型** | 给 IndexTTS 加独立情绪参考音 + 强制轻情绪 + 试 `use_random` / 更长参考音 | 1 天内可验证，成本最低；可能解决一半问题 |
| **开源、商用友好、中文情绪最对路** | **PilotTTS（Apache-2.0）** | 11 种情绪 + 笑/呼吸/哭/咳 + 14 方言；5.6GB；中文；MPS 待 PoC |
| **情感表现力上限最高** | **Higgs TTS 2（3B+2.2B）** | 官方 EmergentTTS 情感胜率 75.7%；中英；指令控制；11.6GB；社区许可 |
| **最像她、愿意再录 1–3 分钟** | **GPT-SoVITS 微调（MIT）** | 少样本微调后音色/语气最像本人；需要干净录音；训练慢但一次投入 |
| **生图质量 + 角色一致** | **FLUX.2-klein-4B（Apache-2.0）** | 4B、13GB VRAM、多参考图编辑；本机 48GB 可跑；比 SDXL-Turbo 是代际提升 |
| **只追求照片质量、不管角色一致** | **Z-Image-Turbo（Apache-2.0）** | 6B、8 步、照片/中文文字强；但无现成参考图编辑 |

### 0.3 不建议优先投入

- **FireRedTTS3**：Apache、能力很强，但 20.8GB 权重 + `flash_attn`/CUDA 依赖，Mac 移植成本高；等有 NVIDIA 机器再考虑。
- **Fish S1-mini**：情感标记最丰富之一，但 **CC-BY-NC-SA 4.0 非商用**；个人玩可以，不适合作为产品底座。
- **Spark-TTS / F5-TTS**：CC-BY-NC，情绪控制也不是强项，相对 IndexTTS/PilotTTS 没明显优势。
- **MegaTTS3**：Apache，但官方**不提供 WaveVAE encoder**，新参考音需要预提取 latent，实际不可直接用。
- **FLUX.2-dev / Qwen-Image-2.1 / InfiniteYou**：质量/一致性很强，但 32B/20B/超大权重 + 非商用或研究许可，48GB Mac 上性价比低。

---

## 1. 语音 TTS 候选详细对比

> 权重体积按 Hugging Face 仓库实际文件统计；语言/能力来自 model card；「本机」列是判断，不是实测。

| 模型 | 参数 / 权重 | 中文 | 情绪/副语言控制 | 参考音 | 许可 | 本机可行性 | 结论 |
|---|---|---|---|---|---|---|---|
| **IndexTTS-2.5**（当前） | ~0.8B GPT，缓存 13GB | ✅ | 8 维向量（喜/怒/悲/惧/厌/郁/惊/静）；自然语言 instruct2 较弱 | 5–15s | bilibili 模型许可 | ✅ 已实测 MPS：1.94s 音频 5.9s | 基线；先榨干 |
| **PilotTTS** | 两个 checkpoint 各 1.6GB，总 5.6GB（含 Qwen3-0.6B/CosyVoice3/w2v-bert） | ✅ + 14 方言 | **11 情绪** + `<|LAUGH|>`/呼吸/哭/咳 | 零样本 | **Apache-2.0** | 可能 MPS/CPU，未实测 | **中文情感首选 PoC** |
| **Higgs TTS 2** | Llama-3.2-3B + DualFFN 2.2B，11.6GB | ✅（中英德韩） | 自然语言 system/scene 指令；无显式情绪向量 | 零样本 | Boson Community（<100k 年活免费；需署名） | Transformers 可加载；MPS 未实测，预计慢 | **表现力上限最高** |
| **FireRedTTS3** | Base 8.5GB + Instruct 8.5GB + RedAE 3.8GB ≈ 20.8GB | ✅ + 21 方言/24 语言 | Instruct 自然语言声音设计/编辑 | 零样本 | **Apache-2.0** | ❌ 需 `flash_attn`/CUDA，Mac 成本高 | 有 NVIDIA 再上 |
| **Fish S1-mini** | 0.5B | ✅（13 语言） | 50+ 情绪/语气标记 + 笑/哭/叹气/耳语 | 零样本 | **CC-BY-NC-SA 4.0** | MPS 未实测 | 个人可用，商业不可 |
| **GPT-SoVITS** | 小模型（GPT+SoVITS） | ✅ | 参考音/微调决定；可 1 分钟微调 | 少样本/微调 | **MIT** | CPU 可跑，训练慢 | **最像她**的长线方案 |
| **CosyVoice 3** | 0.5B | ✅ | instruct2（我们已接） | 3–10s | Apache-2.0 | ✅ 已实测 CPU | 可回退基线 |
| Spark-TTS | 0.5B | ✅ | 参考音；无强情绪控制 | 零样本 | CC-BY-NC-SA | 未实测 | 不优先 |
| F5-TTS | ~0.3B | ✅ | 参考音；无显式情绪 | 零样本 | CC-BY-NC | 未实测 | 不优先 |
| MegaTTS3 | 0.45B | ✅ | 相似度/表现力权重 | 需预提取 latent | Apache-2.0 | ❌ encoder 未公开 | 不采用 |

### 1.1 IndexTTS-2.5：还能怎么救

- **独立情绪参考音**：`infer(..., emo_audio_prompt=..., emo_alpha=...)` 可以把「音色」和「情绪」拆开；当前服务没暴露这个参数。你视频里有三遍同一句，可以切一段情绪更明显的作为 `emo_audio_prompt`，音色参考仍用现在这段。
- **参考音质量**：8.3s 合格但偏短；如果有 10–20s、语气有起伏的干净录音，克隆的情感范围会明显变大。
- **强制轻情绪**：现在 `natural` 不传向量；可以改成所有语音至少给 `calm/soft` 的小向量，或只在情绪明显的轮次发语音。
- **`use_random=True`**：会增加自然变化，但会降低音色相似度；可作为 A/B 项。
- **先做客观测试**：同一批句子生成后，用 `emotion2vec` 判情绪、Whisper 判可懂度、WavLM 判相似度，再让你盲听。

### 1.2 PilotTTS：为什么值得优先试

- **Apache-2.0**，对本项目最友好；
- 官方明确支持 **11 类情绪**（happy/sad/fear/angry/contempt/serious/surprise/blue/concern/disgust/psychology）+ **4 类副语言**（LAUGH/BREATH/CRY/COUGH）；
- 中文 + 14 方言；零样本克隆；
- 权重总量 5.6GB，本机 48GB 足够；代码在 `AmapVoice/PilotTTS`，但 README 有占位符，属于**早期发布**，需要 1–2 小时踩依赖。
- 风险：`torch<=2.5.1`、`WeTextProcessing`/`conformer` 等依赖在 Mac 上可能卡住；MPS 兼容性未知。建议新建独立 venv，不要污染 IndexTTS 环境。

### 1.3 Higgs TTS 2：情感表现力最强，但更重

- 3B Llama + 2.2B audio FFN，24kHz，11.6GB；
- 官方 EmergentTTS-Eval：情感类对 gpt-4o-mini-tts 胜率 **75.7%**，ESD SIM 86.13；这是**厂商自评**，但方向可信；
- 没有显式 8 维向量，靠 system/scene 指令 + 参考音；对「撒娇/委屈/调侃」这种细腻语气，自然语言指令可能比 8 维向量更灵活；
- 许可：Boson Community（<100k 年活免费，需署名；>100k 需扩展许可）；
- Mac：Transformers 5.3 可直接加载，但 3B 自回归 + 24kHz token 在 MPS 上可能 20–60s/句；需要实测。

### 1.4 GPT-SoVITS：如果你愿意再录 1–3 分钟

- MIT；
- 少量干净录音微调后，**音色和语气最像真人**；中文社区成熟；
- 代价：需要准备 1–3 分钟干净、无背景音乐、情绪自然的录音；Mac 上训练慢（CPU/MPS 可用但耗时）；
- 如果「像她」比「任意好听的少女音」更重要，这是最终方案，不是第一周方案。

### 1.5 参考音到底要多少

- 零样本克隆（IndexTTS / PilotTTS / Higgs / CosyVoice）：**5–15s 可用，10–20s 更稳**；关键不是长度，而是**干净、无混响、无背景音乐、语气有变化**。
- 微调（GPT-SoVITS）：**1–3 分钟**，覆盖不同情绪/语速。
- 你现在的 8.3s：合格，但只有一句话、语气偏平；这既限制音色稳定，也限制情绪模仿。

---

## 2. 生图候选详细对比

> 现状：SDXL-Turbo 1-step，热态 2.6s，能出图但没有角色一致性；适合“随手拍场景”，不适合“每次都是同一个人”。

| 模型 | 参数 / 权重 | 许可 | 角色/参考图能力 | 本机可行性 | 结论 |
|---|---|---|---|---|---|
| **SDXL-Turbo**（当前） | 6.5GB | 开源 | 无原生参考；可加 IP-Adapter | ✅ 已实测 2.6s | 快，但质量/一致性弱 |
| **FLUX.2-klein-4B** | 4B，23.7GB | **Apache-2.0** | **多参考图编辑**（text-to-image + image editing） | ✅ 官方示例支持 mps；13GB VRAM 级 | **首选升级** |
| **Z-Image-Turbo** | 6B，32.9GB | **Apache-2.0** | 文生图；参考编辑需等 Z-Image-Edit | 可能 MPS，16GB VRAM 级 | 照片/中文文字质量强；一致性弱 |
| **Qwen-Image-2.1** | ~20B，33GB | qwen-research（非商用倾向） | 生成 + 编辑 | 48GB 紧张 | 中文文字/编辑强；许可/体量劝退 |
| **Qwen-Image-Edit-2509** | ~20B，57.7GB | **Apache-2.0** | 指令编辑/参考图 | 48GB 很紧，需量化/offload | 最强一致性之一，但太重 |
| **MOSS-Image-SFT** | 参数未核实（权重 27GB） | **Apache-2.0** | 文生图；中文/英文 | 可能 MPS | 黑马，需实测 |
| **FLUX.2-dev** | 32B，177GB 仓库 | 非商用 | 编辑/多参考 | ❌ 48GB 不现实 | 不优先 |
| **InfiniteYou** | FLUX 级，43GB | CC-BY-NC | 身份保持 | 重 | 研究向，不优先 |
| **SDXL + IP-Adapter FaceID / PuLID** | 小增量 | 各自许可 | 人脸/身份保持 | ✅ 现成生态 | 最便宜的“同一个人”补丁 |

### 2.1 推荐

1. **先上 FLUX.2-klein-4B**：Apache、4B、多参考图编辑，能同时解决「质量」和「角色一致」；23.7GB 权重，本机 48GB 内存可跑，预计单张 10–30s（MPS，未实测）。
2. **若只要照片质量、不要角色一致**：Z-Image-Turbo 6B / 8 步，照片和中文文字强；但 33GB，MPS 速度待测。
3. **若 FLUX.2 的参考图一致性不够**：再训练 **角色 LoRA**（10–20 张 Karen 图，diffusers/SimpleTuner），或加 SDXL IP-Adapter；LoRA 是“同一张脸”的最稳方案。
4. **Qwen-Image-Edit-2509** 一致性很强且 Apache，但 20B/57.7GB，48GB Mac 需要量化 + offload；不建议作为第一版。

### 2.2 生图评测指标

- 文本遵循：CLIP-T / 人工 1–5；
- 角色一致：ArcFace/InsightFace 相似度 + 人工“像不像同一个人”；
- 构图/手/文字：人工抽检（SDXL-Turbo 1-step 的弱项）；
- 速度/内存：热态单张、峰值 RSS；
- 版权/安全：生成图不冒充真人，角色素材仅用你提供的。

---

## 3. 其他技术栈里值得借鉴的设计

### 3.1 语音情绪「听得见」

| 模型 | 作用 | 许可 | 建议 |
|---|---|---|---|
| **SenseVoiceSmall** | ASR + 语种 + **语音情绪** + 音频事件（笑/哭/咳嗽/BGM） | model-license | 替换/补充 faster-whisper；把用户语音情绪送进 `emotionVector` |
| **emotion2vec+ large** | 9 类语音情绪分类/表征（300M） | model-license | 评测 TTS 情绪、也可做用户情绪 |
| **Whisper large-v3-turbo** | 更稳的 ASR | MIT | 现有 small 的升级候选 |
| **Silero VAD** | 端点检测 | MIT | 语音消息/实时通话需要 |

这是最值得借鉴的一点：**现在她只“听懂文字”，没“听出语气”**。用户用委屈/开心的声音说话，她仍按文字回复；把 SenseVoice/emotion2vec 的情绪接到状态和 TTS，是“有感情”的另一半。

### 3.2 记忆/检索

| 来源 | 设计 | 可借鉴点 |
|---|---|---|
| **Qwen3-Embedding 4B/8B** | Apache | 现在 0.6B；4B 可提升跨语义召回，代价是内存/延迟 |
| **Qwen3-Reranker 0.6B** | Apache | 本地 cross-encoder 重排，替代现在关闭的 DeepSeek 候选重排 |
| **Graphiti / Zep** | 时序知识图谱 | 事实带 `valid_at/invalid_at`；比“覆盖旧值”更适合换工作/搬家/关系变化 |
| **Mem0** | 抽取式记忆 | ADD/UPDATE/DELETE/NOOP 的显式操作；比每轮追加更干净 |
| **Letta（MemGPT）** | 分层记忆 + 自编辑 | core/recall/archival 三层；sleep-time  consolidation；我们的 working memory 可借鉴 |
| **Hindsight** | 多路召回 + reflect | 语义 + BM25 + 图 + 时序并行召回，再 reflect 综合；注意厂商文章有立场 |
| **Cognee** | 图 + 向量 | 多模态记忆图谱；偏重，不必整体引入 |

建议：**不换 SQLite**，先加“事实有效期 + 关系边 + 本地 reranker”，再考虑 Graphiti。

### 3.3 视觉/OCR

| 模型 | 用途 | 许可 | 建议 |
|---|---|---|---|
| **Qwen3-VL-4B** | 本地多模态理解/截图 OCR | Apache | 离线/隐私场景；API 仍可用 DeepSeek Flash |
| **PaddleOCR-VL** | 文档/截图 OCR | Apache | 截图里文字多时比通用 VLM 稳 |
| **Florence-2 / Moondream2** | 轻量 caption/检测 | 各自 | 表情包打标/图片摘要可用 |

### 3.4 图像角色一致

- **FLUX.2-klein-4B multi-reference**：最省事；
- **Qwen-Image-Edit-2509**：最强编辑，但重；
- **SDXL IP-Adapter FaceID / PuLID**：现有 SDXL 生态，成本最低；
- **LoRA**：用 Karen 的 10–20 张图训练，最稳；注意不要用真人照片冒充。

### 3.5 评测方法（比“感觉”可靠）

- TTS：Whisper CER（可懂度）、emotion2vec 情绪匹配、WavLM/ECAPA 说话人相似度、F0 范围/语速/能量、UTMOS/NISQA（如许可允许）、人工 MOS；
- 生图：CLIP-T、ArcFace 相似度、人工盲评；
- 记忆：LoCoMo / LongMemEval 风格 + 我们自己的 40 条金标；
- 所有模型用**同一批中文句子、同一参考音、同 3 个 seed** 对比，避免“听一耳朵就下结论”。

---

## 4. 推荐实施顺序

### Phase 0（今天，1–2 小时，零下载）

1. 给 IndexTTS 服务加 `emo_audio_prompt`，从你视频里切一段情绪更明显的 3–5s 当情绪参考；
2. 所有语音强制轻情绪（不要 natural 空白），A/B `emo_alpha 0.6/0.8/1.0`；
3. 试 `use_random=True` 与更长参考音（如果你能再录 10–20s）；
4. 记录：`mode`、CER、时长、F0/能量；你盲听 5 条。

> 这一阶段可能直接把“机械感”降一半，再决定要不要换模型。

### Phase 1（1–2 天，TTS PoC）

1. **PilotTTS**：独立 venv，5.6GB；测 10 句 × 6 情绪 + 笑声/呼吸；看 MPS/CPU 速度和显存；
2. **Higgs TTS 2**：独立环境，11.6GB；测同样 10 句；重点听“自然度/情绪”，不只看相似度；
3. 同一参考音、同一文本、3 seed；你盲听投票；
4. 选型：中文情绪优先 PilotTTS；表现力优先 Higgs；两者都不行再考虑 GPT-SoVITS 微调。

### Phase 2（2–3 天，生图）

1. **FLUX.2-klein-4B** 独立服务（diffusers，MPS；23.7GB 下载）；
2. 用现有 10–20 张 Karen 图做多参考编辑测试；与 SDXL-Turbo 同 prompt 对比；
3. 如果一致性不够：SDXL IP-Adapter 或 LoRA（10–20 张图，30–60 分钟级）；
4. 通过后再替换生产 `KAREN_IMAGE_URL`，保留 SDXL 回退。

### Phase 3（可选，1 周）

- SenseVoiceSmall 接语音情绪 → 状态/语音；
- Qwen3-Reranker 0.6B 本地重排 + Qwen3-Embedding 4B 评估；
- Graphiti 风格的“事实有效期/关系边”改造；
- Letta 风格的自编辑记忆块 + idle consolidation。

---

## 5. 按你的目标选

| 你更在意 | 选 |
|---|---|
| 先少折腾、立刻好一点 | Phase 0（IndexTTS 情绪参考 + 强制情绪） |
| 中文、开源、可商用、情绪标签多 | **PilotTTS** |
| 最自然、最会演，许可可接受 | **Higgs TTS 2** |
| 最像她本人 | **GPT-SoVITS 微调**（需 1–3 分钟录音） |
| 生图质量和角色一致都要 | **FLUX.2-klein-4B + LoRA** |
| 只要照片好看 | **Z-Image-Turbo** |
| 不想再装大模型 | 保留 IndexTTS，按 Phase 0 调 |

---

## 6. 主要来源

**TTS**
- IndexTTS-2.5：https://huggingface.co/IndexTeam/IndexTTS-2.5
- PilotTTS：https://huggingface.co/AmapVoice/PilotTTS ；代码 https://github.com/AmapVoice/PilotTTS
- Higgs TTS 2：https://huggingface.co/bosonai/higgs-tts-2-3b-base
- FireRedTTS3：https://huggingface.co/FireRedTeam/FireRedTTS3 ；代码 https://github.com/FireRedTeam/FireRedTTS3
- Fish S1-mini：https://huggingface.co/fishaudio/s1-mini
- Spark-TTS：https://huggingface.co/SparkAudio/Spark-TTS-0.5B
- F5-TTS：https://huggingface.co/SWivid/F5-TTS
- MegaTTS3：https://huggingface.co/ByteDance/MegaTTS3
- GPT-SoVITS：https://huggingface.co/lj1995/GPT-SoVITS
- CosyVoice 3：https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
- Kokoro：https://huggingface.co/hexgrad/Kokoro-82M

**生图**
- FLUX.2-klein-4B：https://huggingface.co/black-forest-labs/FLUX.2-klein-4B
- Z-Image-Turbo：https://huggingface.co/Tongyi-MAI/Z-Image-Turbo
- Qwen-Image-2.1：https://huggingface.co/Qwen/Qwen-Image-2.1
- Qwen-Image-Edit-2509：https://huggingface.co/Qwen/Qwen-Image-Edit-2509
- MOSS-Image-SFT：https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT
- FLUX.2-dev：https://huggingface.co/black-forest-labs/FLUX.2-dev
- InfiniteYou：https://huggingface.co/ByteDance/InfiniteYou
- IP-Adapter FaceID：https://huggingface.co/h94/IP-Adapter-FaceID
- SDXL-Turbo：https://huggingface.co/stabilityai/sdxl-turbo

**其他**
- Qwen3-Embedding：https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Qwen3-Reranker：https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
- Qwen3-VL：https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct
- SenseVoiceSmall：https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- emotion2vec+ large：https://huggingface.co/emotion2vec/emotion2vec_plus_large
- PaddleOCR-VL：https://huggingface.co/PaddlePaddle/PaddleOCR-VL
- Graphiti：https://github.com/getzep/graphiti
- Mem0：https://github.com/mem0ai/mem0
- Letta：https://github.com/letta-ai/letta
- Hindsight：https://github.com/vectorize-io/hindsight
- 记忆框架对比（有厂商立场）：https://vectorize.io/articles/best-ai-agent-memory-systems

---

## 7. 追加：如果全部放到 8×6000D 服务器上（2026-10-22 更新）

> 前提：8×RTX 6000D（中国特供版单卡常见 84GB，国际版 96GB；以 `nvidia-smi` 为准）。
> 结论：服务器让「原先因 Mac 内存/算力排除了的模型」重新进入候选，**但不需要把 8 张卡全用上**。

### 7.1 语音：服务器上更值得先测的模型

| 模型 | 权重/显存 | 许可 | 为什么在服务器上值得试 |
|---|---|---|---|
| **Qwen3-TTS-12Hz-1.7B-Base** | 4.5GB | **Apache-2.0** | 3 秒快速克隆；10 语言；流式；1.7B 很轻；可微调；可能是「自然度 + 音色」综合最优 |
| **Qwen3-TTS-12Hz-1.7B-CustomVoice** | 4.5GB | Apache-2.0 | 9 个预置音色 + **自然语言情绪指令**（“用特别愤怒的语气说”）；适合情绪表达 |
| **Qwen3-TTS-12Hz-1.7B-VoiceDesign** | 4.5GB | Apache-2.0 | 用描述设计声音（年龄/音色/情绪/语速）；可与 Base 组合成「设计参考→克隆」 |
| **FireRedTTS3** | 20.8GB | Apache-2.0 | 24 语言/21 方言 + instruct 语音设计/编辑 + ICL 克隆；CUDA 上可行；中文方言强 |
| **Higgs TTS 3（4B）** | 4B 级 | **研究/非商用许可** | 100 语言、表现力强；个人可用，产品需换许可 |
| **GPT-SoVITS 微调** | 小 | MIT | 1–3 分钟录音微调，最像本人；与 Qwen3-TTS 做 A/B |
| **Fish s2-pro** | 大 | 研究许可 | 83 语言、指令控制；许可不适合直接产品化 |
| **VibeVoice-1.5B** | 1.5B | MIT（但研究限定 + 自动免责声明/水印） | 长播客/多说话人；聊天 TTS 不优先 |
| **Ming-3.0-tts-0.5B** | 0.5B | MIT | 7 语言、克隆；小而新，可作轻量备选 |

**推荐组合**：

1. **Qwen3-TTS-1.7B-Base 微调 Karen 音色**（Apache、轻、自然）——主力；
2. **Qwen3-TTS-CustomVoice / VoiceDesign** 负责「强烈情绪、撒娇、发火」等指令化台词；
3. **GPT-SoVITS 微调**做盲测对照；如果它明显更「像她」，就保留为音色主模型；
4. **FireRedTTS3** 作为中文方言/强克隆对照；**Higgs TTS 3** 只在个人非商用场景试听。

> 这比「只上 GPT-SoVITS」更合理：GPT-SoVITS 音色像，但情感控制仍靠参考音；Qwen3-TTS 原生支持自然语言情绪指令，且 Apache。

### 7.2 图像：服务器上重新进入候选的模型

| 模型 | 权重 | 许可 | 说明 |
|---|---|---|---|
| **Qwen-Image-Edit-2509** | 57.7GB（20B） | **Apache-2.0** | 最强「同一个人 + 场景编辑」开源选项之一；单卡 84GB 可跑 |
| **Z-Image-Turbo** | 32.9GB（6B） | Apache-2.0 | 照片/中文文字质量强；8 步；无参考编辑（Z-Image-Edit 未发布） |
| **FLUX.2-klein-4B** | 23.7GB | Apache-2.0 | 4B、多参考编辑、轻；服务器/本机都友好 |
| **FLUX.2-dev** | 32B（仓库 177GB） | 非商用 | 审美/质量上限高；8 卡可跑，但仅供个人/研究 |
| **FLUX.2-klein-9B** | 9B | 非商用 | 比 4B 质量高，比 32B 轻 |
| **HunyuanImage-3.0** | 80B，168GB | 腾讯社区许可 | 质量强，但 8 卡 + 大权重 + 许可限制，先不优先 |
| **Qwen-Image-2.1** | 20B，33GB | qwen-research | 中文/编辑强；许可偏研究 |
| **MOSS-Image-SFT** | 27GB | Apache-2.0 | 中文/英文、4 步；可作黑马测试 |

**推荐组合**：

- **角色一致性**：Qwen-Image-Edit-2509 + Karen 的 10–20 张参考图 → 训练 LoRA（最稳）；
- **场景/氛围图**：Z-Image-Turbo 或 FLUX.2-klein-4B；
- **只追求审美上限且个人使用**：FLUX.2-dev（非商用）或 HunyuanImage-3.0（需接受许可/显存）；
- 不建议一上来就上 Qwen-Image-2.1 + FLUX.2-dev + Hunyuan 三套，先一套跑通。

### 7.3 其他技术栈的服务器版升级

| 能力 | 当前 | 服务器上更好的选择 |
|---|---|---|
| ASR | faster-whisper small | **Qwen3-ASR-1.7B**（Apache、52 语言/22 方言、流式、1.7B）；Whisper large-v3-turbo 备选 |
| 语音情绪 | 无 | SenseVoiceSmall / emotion2vec+ large；把用户语气接入状态 |
| 视觉 | DeepSeek Flash API | Qwen3-VL-8B/32B（Apache）；PaddleOCR-VL 截图 OCR |
| Embedding | Qwen3-Embedding-0.6B | Qwen3-Embedding-4B/8B（Apache，按延迟选） |
| Rerank | 关闭/DeepSeek | **Qwen3-Reranker-0.6B/4B**（Apache，本地 cross-encoder） |
| 对话 LLM | DeepSeek API | 可选 **Qwen3-235B-A22B**（Apache，8×84GB FP8 可跑）；但 API 仍更省心 |
| 记忆 | SQLite + 向量 + FTS | Graphiti 时序图 / Mem0 抽取操作 / Letta 自编辑记忆（借设计，不必整体替换） |

### 7.4 8 卡怎么分配（建议）

| GPU | 用途 |
|---|---|
| 0 | Qwen3-TTS-1.7B（克隆/情绪） |
| 1 | Qwen-Image-Edit-2509（角色一致性） |
| 2 | Z-Image-Turbo 或 FLUX.2-klein-4B（场景） |
| 3 | Qwen3-ASR-1.7B + Qwen3-VL-8B + embedding/rerank |
| 4–7 | 训练/备胎；GPT-SoVITS 微调、LoRA、A/B 时临时用 |

不需要 8 卡分布式推理；单卡 84GB 对上述模型都足够。

### 7.5 结论

**全放服务器后，模型选择确实更多，但推荐不是“越多越好”：**

- 语音：**Qwen3-TTS-1.7B-Base 微调（主力）+ Qwen3-TTS CustomVoice（情绪）**；GPT-SoVITS 做对照；FireRed/Higgs 做候选。
- 图像：**Qwen-Image-Edit-2509 + LoRA（角色）**；Z-Image-Turbo / FLUX.2-klein 做场景；FLUX.2-dev 仅个人审美上限。
- 其他：Qwen3-ASR、Qwen3-VL、Qwen3-Embedding/Reranker 可以真正跑起来。
- Mac 只保留 QQ 桥接/编排；大模型全部服务器；通过 SSH 隧道接入，别公网暴露。

**下一步**：先给服务器访问方式，我审计 `nvidia-smi`/Docker/磁盘；然后按「Qwen3-TTS + Qwen-Image-Edit」各占一张卡做 PoC，A/B 通过再替换生产。

**追加来源**：
- Qwen3-TTS：https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- Qwen3-TTS CustomVoice：https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- Qwen3-ASR：https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- Higgs TTS 3：https://huggingface.co/bosonai/higgs-tts-3-4b
- VibeVoice：https://huggingface.co/microsoft/VibeVoice-1.5B
- Fish s2-pro：https://huggingface.co/fishaudio/s2-pro
- Ming-3.0-tts：https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B
- HunyuanImage 3.0：https://huggingface.co/tencent/HunyuanImage-3.0
- Qwen3-235B：https://huggingface.co/Qwen/Qwen3-235B-A22B-Instruct-2507
