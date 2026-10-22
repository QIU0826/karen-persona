# Karen 最佳配置单：8×RTX 6000D（2026-10-22）

> 状态：**选型定稿，服务器尚未接入**。本文里的「官方数据」与「待实测」严格分开；没有在 8×6000D 上跑过的，一律不写成已实现。
> 目标：语音更像她、情绪更生动；生图更像同一个人；Mac 只保留 QQ 桥接与编排，模型全部放服务器。
> 硬件假设：8×RTX 6000D，单卡按 **84GB** 保守规划（国际版 96GB 会更宽裕）；以 `nvidia-smi` 为准。
> Excel 版：[KAREN_BEST_STACK_2026-10-22.xlsx](KAREN_BEST_STACK_2026-10-22.xlsx)（9 个 sheet：总览/语音/图像/感知记忆/GPU/端口/数据/验收/许可）。

---

## 0. 一句话结论

**不要押单一模型。效果最好的组合是「三语音引擎 + 双图像引擎 + 一套感知/记忆」：**

- **语音主力（像她）**：GPT-SoVITS v2Pro 微调（MIT）+ 6 种情绪参考音
- **语音自然度 A/B**：Qwen3-TTS-12Hz-1.7B-Base 微调（Apache，官方支持单说话人 SFT）
- **零样本/方言/声音设计**：FireRedTTS3 Base + Instruct（Apache，24 语言/21 中文方言）
- **情绪指令/非 Karen 音色**：Qwen3-TTS-1.7B-CustomVoice（Apache，9 个预置音色 + 自然语言 instruct）
- **图像一致性**：Qwen-Image-Edit-2511（Apache，20.4B；比 2509 更强一致性，已内置部分 LoRA 能力）+ Karen LoRA
- **图像场景/中文文字**：Z-Image-Turbo（Apache，6.15B，8 步）
- **感知/记忆**：Qwen3-ASR-1.7B + Qwen3-VL-30B-A3B + Qwen3-Embedding-8B / Reranker-4B + Graphiti
- **主对话**：继续 DeepSeek API；Qwen3-Next-80B-A3B 只做本地兜底
- **效果上限（个人非商用）**：可加 FLUX.2-dev；不作为主配置

**核心只占 2–5 张卡；8 张卡不是让你全堆上去，而是给 A/B、微调、LoRA 和可选项留余量。**

---

## 1. 为什么不是「只选一个最强 TTS」

公开榜单上没有一个模型同时赢四件事：

| 能力 | 当前最强候选 | 代价/限制 |
|---|---|---|
| 零样本最像（Seed-TTS-eval SIM/WER） | **FireRedTTS3**（SIM 78.8 / WER 3.04 平均） | README 把零样本克隆限定为**学术研究用途**；官方未提供微调脚本 |
| 自然度 + 低延迟 + 可微调 | **Qwen3-TTS-1.7B-Base**（SIM 74.5 / WER 3.07；97ms 流式） | 微调后官方示例走 `generate_custom_voice`，**不承诺 explicit instruct** |
| 最像本人（少样本微调） | **GPT-SoVITS v2Pro**（MIT；1–3 分钟） | 情绪主要靠参考音/数据；没有公开同口径 SIM 榜单 |
| 情绪指令 + 预置音色 | **Qwen3-TTS-CustomVoice**（9 音色 + instruct） | 不是 Karen 音色；不能直接克隆 |
| 中文方言/声音设计 | **FireRedTTS3-Instruct**（21 方言 + 语音编辑） | 同样有克隆用途声明；不做 Karen 专属微调 |

> 数据来源：FireRedTTS3 model card 的 Seed-TTS-eval 对比表（其中列出 Qwen3-TTS / IndexTTS2 的数据）；不同评测实现的绝对值不要直接横比，只能当“谁值得先测”。

**结论：**
1. **Karen 本人音色**：GPT-SoVITS 微调优先，Qwen3-TTS Base 微调做 A/B；谁在盲测里赢，谁做默认。
2. **情绪**：不要只靠模型“自己长”。录 6 类情绪参考音，GPT-SoVITS 用对应情绪的 reference；Qwen3-TTS Base 微调负责自然度，Qwen3-TTS CustomVoice 负责非 Karen 的强情绪台词。
3. **零样本/方言**：FireRedTTS3 先上，能在**不训练**的情况下立刻和 IndexTTS-2.5 对比；如果它已经明显更好，微调前的过渡期就用它。

---

## 2. 主配置总表（推荐直接照这个上）

> 许可列只写仓库声明的许可证；语音克隆还需要**声音本人授权**，见 §10。

| 层 | 角色 | 模型 | 版本/仓库 | 参数/权重 | 许可 | GPU | 远程端口 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| 语音 | Karen 音色主力 | **GPT-SoVITS v2Pro** | `20250606v2pro` | 小模型，约 1GB 级 | **MIT** | GPU0 | 18100 | P0 |
| 语音 | 自然度 A/B / 长句 | **Qwen3-TTS-12Hz-1.7B-Base** | HF `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 1.93B / 4.5GB | **Apache-2.0** | GPU0 | 18101 | P0 |
| 语音 | 情绪指令 / 预置音色 | **Qwen3-TTS-12Hz-1.7B-CustomVoice** | HF 同名 | 1.92B / 4.6GB | **Apache-2.0** | GPU0 | 18102 | P1 |
| 语音 | 声音设计 | **Qwen3-TTS-12Hz-1.7B-VoiceDesign** | HF 同名 | 1.7B / 4.5GB | **Apache-2.0** | GPU0 | 18103 | P2 |
| 语音 | 零样本/方言/设计 | **FireRedTTS3 Base + Instruct** | HF `FireRedTeam/FireRedTTS3` | 20.8GB（8.5+8.5+3.8） | **Apache-2.0**（克隆用途声明见 §10） | GPU1 | 18104 | P0 |
| 语音 | 回退/对照 | IndexTTS-2.5（当前） | 本机已装 | ~0.8B GPT，缓存 13GB | bilibili 模型许可 | GPU0 | 18105 | 回退 |
| 图像 | Karen 一致性/编辑 | **Qwen-Image-Edit-2511** | HF `Qwen/Qwen-Image-Edit-2511` | 20.4B / 57.7GB | **Apache-2.0** | GPU2 | 18110 | P0 |
| 图像 | 场景/氛围/中文文字 | **Z-Image-Turbo** | HF `Tongyi-MAI/Z-Image-Turbo` | 6.15B / 约 33GB 加载 | **Apache-2.0** | GPU3 | 18111 | P0 |
| 图像 | 轻量多参考/本机应急 | FLUX.2-klein-4B | HF `black-forest-labs/FLUX.2-klein-4B` | 3.88B / 23.7GB | **Apache-2.0** | GPU3/4 | 18113 | P2 |
| 图像 | 审美上限（个人） | FLUX.2-dev | HF `black-forest-labs/FLUX.2-dev` | 32.2B / 仓库 177GB | **非商用** | GPU4+5（或 FP8 单卡） | 18112 | P2 |
| 感知 | ASR | **Qwen3-ASR-1.7B** | HF `Qwen/Qwen3-ASR-1.7B` | 2.35B / 4.7GB | **Apache-2.0** | GPU1 | 18120 | P0 |
| 感知 | 语音情绪/音频事件 | SenseVoiceSmall 或 emotion2vec+ large | HF `FunAudioLLM/SenseVoiceSmall` / `emotion2vec/emotion2vec_plus_large` | ~1GB | 模型许可（商用前核对） | GPU1 | 18121 | P1 |
| 感知 | 视觉/OCR | **Qwen3-VL-30B-A3B-Instruct** | HF 同名 | 31.1B / 62.1GB | **Apache-2.0** | GPU4 | 18122 | P1 |
| 检索 | Embedding | **Qwen3-Embedding-8B** | HF 同名 | 7.6B / 15GB | **Apache-2.0** | GPU5 | 18123 | P1 |
| 检索 | Reranker | **Qwen3-Reranker-4B** | HF 同名 | 4.0B / 8GB | **Apache-2.0** | GPU5 | 18123 | P1 |
| 记忆 | 时序知识图谱 | Graphiti + Neo4j | `getzep/graphiti` + Neo4j Community | CPU/内存 | Apache-2.0 / GPLv3 | CPU | 18140 | P1 |
| 对话 | 主 LLM | DeepSeek API（现有） | 不部署 | API | 服务条款 | — | — | P0 |
| 对话 | 本地兜底（可选） | Qwen3-Next-80B-A3B-Instruct | HF 同名 | 81B / FP8≈81GB；BF16≈163GB | **Apache-2.0** | GPU6+7（TP=2） | 18130 | P2 |
| 音频理解 | 情绪/场景（可选） | Qwen3-Omni-30B-A3B-Instruct | HF 同名 | 35.3B / 70.5GB | 仓库 license 标 other，卡内写 apache-2.0（商用前核对） | GPU4/5 | 18124 | P2 |

**「主配置」= P0/P1 行。P2 是增强项，不影响第一版跑通。**

---

## 3. 语音路由：什么时候用哪个

| 场景 | 引擎 | 输入 |
|---|---|---|
| Karen 日常短句 | GPT-SoVITS v2Pro | Karen 参考音 + 文本 |
| Karen 开心/难过/生气/温柔/惊讶 | GPT-SoVITS v2Pro | **对应情绪的 Karen 参考音**（同一人、同一麦克风） |
| Karen 长句、需要更自然的停顿/语调 | Qwen3-TTS Base 微调 | 文本；由 A/B 决定是否设为默认 |
| 方言、临时新角色、不想训练 | FireRedTTS3 Base | 5–10s 参考音 + 文本；方言用方言参考音 |
| 非 Karen 的 9 个预置音色、强情绪台词 | Qwen3-TTS CustomVoice | `speaker` + `instruct`（如“用特别愤怒的语气说”） |
| 声音设计（先设计、再复用） | Qwen3-TTS VoiceDesign → Base 克隆 | 自然语言描述 → 参考音 → 克隆 |
| 服务异常/快速回退 | IndexTTS-2.5 | 现有参考音 + 8 维情绪向量 |

**关键点：**
- Qwen3-TTS Base 微调后，官方 quickstart 用 `generate_custom_voice(text, speaker)`；**不要假设它还能像 CustomVoice 一样吃 `instruct`**。情绪要么靠文本语义，要么靠 GPT-SoVITS 的情绪参考音。
- FireRedTTS3 的 ICL 克隆会继承参考音的说话风格；**想要什么情绪，就给什么情绪的参考音**，不要给中性参考却要求它“愤怒”。
- 现有 8.3s 参考音只够零样本；**微调必须补录 1–3 分钟**。

---

## 4. 图像路由：不要一张模型打天下

| 场景 | 引擎 | 输入/做法 |
|---|---|---|
| Karen 换场景、换衣服、合影、保持同一张脸 | **Qwen-Image-Edit-2511 + Karen LoRA** | 3–5 张参考图 + 编辑指令；LoRA 用 15–30 张训练 |
| 新场景、氛围图、中文海报/文字 | **Z-Image-Turbo** | 文生图，8 步；适合先出草稿 |
| 需要多参考图融合/多人一致 | Qwen-Image-Edit-2511 | 支持多图输入；比 2509 更稳 |
| 审美上限、个人非商用 | FLUX.2-dev | 32B；建议 2 卡或 FP8；不放进产品主路径 |
| 轻量/本机应急 | FLUX.2-klein-4B | 3.88B，Apache；Mac 48GB 也能跑（慢） |

**推荐工作流：**
1. 先用 **Z-Image-Turbo** 出 2–3 张构图/光线草稿（快、便宜）；
2. 选中的草稿 + Karen 参考图交给 **Qwen-Image-Edit-2511** 做身份/细节修正；
3. 只有个人审美图才用 **FLUX.2-dev** 重绘最后一遍；
4. 对外发布的图保留“AI 生成”说明。

**为什么不是 2509：** 2511 是 2509 的增强版，官方明确写了更好的角色一致性、缓解 image drift、内置部分 LoRA 能力；同样 Apache-2.0、同样 20.4B/57.7GB。**没有理由再选 2509。**

---

## 5. 8 张卡怎么分

> 按 84GB/卡；如果实际是 96GB，所有余量更宽裕。不要把 8 张卡做分布式推理，单卡足够。

| GPU | 用途 | 预估占用 |
|---|---|---|
| GPU0 | GPT-SoVITS + Qwen3-TTS Base/CustomVoice/VoiceDesign + IndexTTS 回退 | 约 15–25GB |
| GPU1 | FireRedTTS3（20.8GB）+ Qwen3-ASR（4.7GB）+ SenseVoice/emotion2vec（~1GB） | 约 27–35GB |
| GPU2 | Qwen-Image-Edit-2511 | 约 58GB 权重，留 15–20GB 激活 |
| GPU3 | Z-Image-Turbo；可选 FLUX.2-klein-4B（不同时加载） | 约 33GB |
| GPU4 | Qwen3-VL-30B-A3B（62GB）；可选 Qwen3-Omni（70GB，二选一） | 约 62–75GB |
| GPU5 | Qwen3-Embedding-8B（15GB）+ Qwen3-Reranker-4B（8GB） | 约 23–30GB |
| GPU6+7 | 可选 Qwen3-Next-80B-A3B（TP=2，FP8/BF16）；不跑本地 LLM 时用于微调/LoRA/A/B | 约 81–163GB |
| （可选） | FLUX.2-dev 需要 GPU4+5 或 2 张空闲卡；不跑时 GPU4/5 正常 | 约 64–112GB |

**最小跑通组合（2 张卡）：**
- GPU0：GPT-SoVITS + Qwen3-TTS；
- GPU1：Qwen-Image-Edit-2511；
- 其他先不启，确认链路后再加。

---

## 6. 端口、隧道与环境变量

### 6.1 远程端口（全部只绑 `127.0.0.1`）

| 服务 | 远程端口 |
|---|---|
| GPT-SoVITS | 18100 |
| Qwen3-TTS Base（微调后） | 18101 |
| Qwen3-TTS CustomVoice | 18102 |
| Qwen3-TTS VoiceDesign | 18103 |
| FireRedTTS3 | 18104 |
| IndexTTS-2.5 回退 | 18105 |
| Qwen-Image-Edit-2511 | 18110 |
| Z-Image-Turbo | 18111 |
| FLUX.2-dev（可选） | 18112 |
| FLUX.2-klein-4B（可选） | 18113 |
| Qwen3-ASR | 18120 |
| SenseVoice/emotion2vec | 18121 |
| Qwen3-VL | 18122 |
| Embedding/Reranker | 18123 |
| Qwen3-Omni（可选） | 18124 |
| Qwen3-Next 本地 LLM（可选） | 18130 |
| Graphiti API | 18140 |
| Neo4j | 7687/7474（只本机） |

### 6.2 Mac 本地隧道端口（避免和现有 1808x 冲突）

| 本地 | 远程 | 用途 |
|---|---|---|
| 19080 | 18100 | GPT-SoVITS |
| 19081 | 18101 | Qwen3-TTS Base |
| 19082 | 18102 | Qwen3-TTS CustomVoice |
| 19083 | 18103 | Qwen3-TTS VoiceDesign |
| 19088 | 18104 | FireRedTTS3 |
| 19084 | 18110 | Qwen-Image-Edit-2511 |
| 19085 | 18111 | Z-Image-Turbo |
| 19086 | 18120 | Qwen3-ASR |
| 19087 | 18122 | Qwen3-VL |
| 19089 | 18130 | 本地 LLM（可选） |
| 19090 | 18123 | Embedding/Reranker |

### 6.3 Mac `.env` 目标形态（示例，不写真实主机/密钥）

```bash
# 语音：主用 GPT-SoVITS；A/B 时切 qwen3-tts；应急切 indextts2
KAREN_TTS_BACKEND=gpt-sovits
GPTSOVITS_URL=http://127.0.0.1:19080
QWEN3_TTS_URL=http://127.0.0.1:19081
QWEN3_TTS_CUSTOM_URL=http://127.0.0.1:19082
FIREREDTTS_URL=http://127.0.0.1:19088
INDEXTTS_TTS_URL=http://127.0.0.1:18088   # 本地回退保留

# 图像：Qwen-Image-Edit 主，Z-Image 草稿
KAREN_IMAGE_GEN=on
KAREN_IMAGE_BACKEND=qwen-image-edit
QWEN_IMAGE_EDIT_URL=http://127.0.0.1:19084
ZIMAGE_URL=http://127.0.0.1:19085

# 感知
KAREN_ASR=on
QWEN_ASR_URL=http://127.0.0.1:19086
QWEN_VL_URL=http://127.0.0.1:19087

# 检索
KAREN_EMBED=on
QWEN_EMBED_URL=http://127.0.0.1:19090
QWEN_RERANK_URL=http://127.0.0.1:19090

# 可选本地 LLM 兜底（主路径仍 DeepSeek）
# KAREN_LLM_FALLBACK=local
# KAREN_LOCAL_LLM_URL=http://127.0.0.1:19089/v1
```

> 这些环境变量名是**目标接口**，代码适配在部署时按实际服务补齐；不要先写进 `.env` 就不管。

### 6.4 隧道命令（本机执行）

```bash
ssh -N \
  -p <SSH端口> \
  -i ~/.ssh/<你的服务器私钥> \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -L 19080:127.0.0.1:18100 \
  -L 19081:127.0.0.1:18101 \
  -L 19082:127.0.0.1:18102 \
  -L 19083:127.0.0.1:18103 \
  -L 19088:127.0.0.1:18104 \
  -L 19084:127.0.0.1:18110 \
  -L 19085:127.0.0.1:18111 \
  -L 19086:127.0.0.1:18120 \
  -L 19087:127.0.0.1:18122 \
  -L 19089:127.0.0.1:18130 \
  -L 19090:127.0.0.1:18123 \
  <用户名>@<服务器IP>
```

**安全底线：**
- 服务器防火墙默认拒绝入站，只开 SSH；
- 模型服务全部 `127.0.0.1`，不监听 `0.0.0.0`；
- 不把 181xx/7687 暴露到公网；
- 不把私钥、密码、`.env` 提交进仓库。

---

## 7. 需要你准备的数据（这是“效果上限”的真正瓶颈）

### 7.1 录音：1–3 分钟只是微调门槛，3–5 分钟更好

| 项 | 要求 |
|---|---|
| 时长 | 至少 1–3 分钟；推荐 3–5 分钟 |
| 格式 | WAV，48kHz，单声道；不要混响/背景音乐/降噪过度 |
| 环境 | 同一房间、同一麦克风、同一距离；关空调/风扇 |
| 内容 | 自然说话，不要朗读腔；每句 3–10 秒 |
| 情绪 | 中性/开心/难过/生气/温柔/惊讶 各 4–6 句 |
| 转写 | 每句对应准确文字；不要有错别字 |
| 授权 | 确认声音本人同意用于 AI 合成；对外发布标注 AI 生成 |

**建议录音清单（30 句，约 4 分钟）：**

| 情绪 | 句数 | 示例 |
|---|---|---|
| 中性 | 8 | 今天店里人不多，我坐在窗边看了一下午的书。 |
| 开心 | 5 | 哈哈，你今天怎么这么会说话，我都被你逗笑了。 |
| 难过 | 5 | 其实我今天有点累，不太想说话，你陪我一会就好。 |
| 生气 | 4 | 你再说一遍？我刚才真的有点生气了。 |
| 温柔 | 5 | 好啦，别急，慢慢说，我听着呢。 |
| 惊讶 | 3 | 真的假的？你居然还记得这件事！ |

> 当前只有 8.3s 中性参考音：**只够零样本，不够 GPT-SoVITS / Qwen3-TTS 微调**。补录后效果提升会比换模型更明显。

### 7.2 图片：15–30 张 Karen 照片

| 项 | 要求 |
|---|---|
| 数量 | 零样本 3–5 张；LoRA 15–30 张 |
| 内容 | 正脸/侧脸/半身/不同表情/不同光线/不同衣服 |
| 质量 | 清晰、无重度滤镜、无遮挡、1024px 以上 |
| 授权 | 确认肖像使用授权；对外发布标注 AI 生成 |
| 用途 | Qwen-Image-Edit-2511 参考图 + Karen LoRA 训练 |

### 7.3 评测集

- 语音：30 句 × 6 情绪，固定文本，盲测；
- 图像：20 条指令（换场景/换衣服/合影/表情/光线/文字），人工 A/B；
- 端到端：QQ 语音回复延迟、图片回复延迟、失败回退。

---

## 8. 部署顺序（拿到 SSH 后按这个走）

### Phase 0：审计（30 分钟，只读）
1. `nvidia-smi`、`nvidia-smi topo -m`、驱动/CUDA；
2. Docker + nvidia-container-toolkit；
3. 磁盘（至少 1–2TB NVMe 可用）、内存、CPU；
4. 端口占用、防火墙、Python/ffmpeg/git-lfs；
5. HuggingFace / hf-mirror 连通性；
6. 确认单卡显存是 84GB 还是 96GB。

### Phase 1：先跑通两条最短链路（当天）
1. **FireRedTTS3 零样本**：用现有 8.3s 参考音，和 IndexTTS-2.5 盲测；如果明显更好，微调前先用它；
2. **Qwen3-TTS Base + CustomVoice**：零样本克隆 + instruct 情绪各跑 10 句；
3. **Qwen-Image-Edit-2511**：用 3 张 Karen 图做换场景/换衣服，记录身份保持；
4. **Qwen-Image-Edit-2511 + Z-Image-Turbo**：跑 10 张文生图草稿；
5. 通过 SSH 隧道接回 Mac，先不改生产 `.env`，用独立 smoke 脚本验证。

### Phase 2：微调 A/B（1–2 天）
1. 补录 1–3 分钟（最好 3–5 分钟）情绪录音；
2. GPT-SoVITS v2Pro 微调；
3. Qwen3-TTS-1.7B-Base 单说话人 SFT（官方 `prepare_data.py` + `sft_12hz.py`，示例 batch 2 / lr 2e-5 / 3 epochs，按数据量调）；
4. 30 句 × 6 情绪盲测：相似度、情绪准确率、自然度、延迟；
5. 赢者做默认，输者保留 A/B 开关。

### Phase 3：图像 LoRA + 感知（2–3 天）
1. Qwen-Image-Edit-2511 Karen LoRA（15–30 张，rank 16–32）；
2. Qwen3-ASR 替换 faster-whisper small；
3. Qwen3-VL-30B-A3B 接截图/OCR；
4. Qwen3-Embedding-8B + Reranker-4B 替换本地 0.6B；
5. Graphiti + Neo4j 接时序记忆（先只读/旁路，不直接改主链路）。

### Phase 4：可选增强（1 周内）
1. FireRedTTS3 方言/声音设计；
2. FLUX.2-dev 个人审美图（非商用）；
3. Qwen3-Next-80B-A3B 本地 LLM 兜底；
4. Qwen3-Omni 音频情绪/场景；
5. 全链路延迟/成本/回退演练。

---

## 9. 验收指标（不靠“感觉”）

| 维度 | 指标 | 目标 |
|---|---|---|
| 音色相似 | CAM++/WavLM speaker similarity（同一参考音） | ≥0.82；GPT-SoVITS 微调目标 ≥0.85 |
| 可懂度 | Qwen3-ASR CER/WER | 中文 CER ≤5%；英文 WER ≤5% |
| 情绪 | 6 类情绪分类准确率 + 人工盲测 | ≥70%；人工“明显有情绪”≥4/5 |
| 自然度 | 人工盲测 1–5 | ≥4.0 |
| 延迟 | 单句 TTS P95 | ≤2.0s（服务器热态）；流式首包 ≤300ms（若接流式） |
| 图像身份 | ArcFace cosine（与参考图） | ≥0.75；LoRA 后目标 ≥0.80 |
| 图像指令 | 人工 A/B / 指令遵循 | ≥4/5 |
| 端到端 | QQ 语音回复 / 图片回复 | 语音 ≤4s；图片 ≤15s（非阻塞） |
| 回退 | 任一服务挂掉 | 自动回退本地 IndexTTS/SDXL/Kokoro，不阻塞聊天 |

**A/B 方法：** 固定 30 句、6 情绪、3 个随机种子；同一参考音；盲测时隐藏模型名；记录相似度/情绪/自然度/延迟；不要只凭一次试听拍板。

---

## 10. 许可、隐私与风险

| 模型/组件 | 许可 | 备注 |
|---|---|---|
| GPT-SoVITS | **MIT** | 代码/权重友好；声音克隆需本人授权 |
| Qwen3-TTS Base/CustomVoice/VoiceDesign | **Apache-2.0** | 可微调；仍需声音授权 |
| FireRedTTS3 | **Apache-2.0** | README 明确把零样本克隆限定为**学术研究用途**；商用/公开产品前需法务确认或替换 |
| Qwen-Image-Edit-2511 | **Apache-2.0** | 图像生成需注意肖像/版权 |
| Z-Image-Turbo | **Apache-2.0** | 同上 |
| FLUX.2-dev | **FLUX 非商用许可** | 只放个人/研究路径，不放进产品默认 |
| Qwen3-ASR / Qwen3-VL / Qwen3-Embedding / Qwen3-Reranker / Qwen3-Next | **Apache-2.0** | 可商用（仍受各自使用条款约束） |
| SenseVoiceSmall / emotion2vec+ | 模型许可（非 Apache） | 商用前逐项核对；可先用 Qwen3-Omni 替代做情绪理解 |
| IndexTTS-2.5 | bilibili 模型许可 | 仅作本地回退，不扩大使用 |
| Graphiti | Apache-2.0 | Neo4j Community 为 GPLv3，部署时注意分发方式 |

**隐私：**
- 参考音、照片、LoRA、微调权重都是敏感数据；服务器上加密/限权，任务结束可删；
- 目标架构里 TTS/图像全本地；若仍保留 DeepSeek 视觉，图片会发给 DeepSeek，需按现状声明；
- 对外发布语音/图片标注 AI 合成；
- 确认声音本人和肖像本人授权；不要用他人声音做未授权克隆。

---

## 11. 不选/降级清单（避免反复纠结）

| 候选 | 结论 | 原因 |
|---|---|---|
| Qwen-Image-Edit-2509 | **降级为 2511** | 2511 同许可、同规模，官方明确更好一致性 |
| HunyuanImage-3.0 | 不选 | 80B/168GB、社区许可、8 卡也重；收益不匹配 |
| Qwen-Image-2.1 | 不选主路径 | 研究许可；Qwen-Image-Edit-2511 已够 |
| FLUX.2-dev | 仅个人可选 | 非商用；32B 重；不作为产品默认 |
| FLUX.2-klein-9B | 不选 | 非商用；4B 是 Apache，9B 不是 |
| Higgs TTS 3 / Fish s2-pro / VibeVoice | 不选主路径 | 研究/非商用/水印限制；情绪强但不适合作为产品底座 |
| Qwen3-TTS 25Hz | 暂不选 | 目前发布的是 12Hz；25Hz 只在论文/榜单出现，等正式权重 |
| IndexTTS-2.5 继续当主力 | 不选 | 8.3s + 8 维情绪已到瓶颈；保留回退 |
| Qwen3-235B-A22B | 暂不选 | 235B/470GB，占 3–4 卡；DeepSeek API 质量/成本更优 |
| 8 卡分布式推理 | 不选 | 单卡足够；分布式只增加故障面 |

---

## 12. 下一步：我需要你给什么

1. **服务器访问**：`host`、SSH 端口、用户名、**本机私钥路径**（例如 `~/.ssh/karen_gpu`）。
   - 不要把私钥内容/密码直接贴在聊天里；
   - 如果只有密码：先用密码登录一次，把公钥装到服务器，或把密码写进本机 600 权限文件后告诉我路径。
2. **确认是不是这台**：本机 `~/.ssh/known_hosts` 里已有一条 GPU 服务器记录；如果就是它，给我用户名 + 密钥路径即可。主机/IP/端口不写进仓库。
3. **录音**：按 §7.1 录 1–3 分钟（最好 3–5 分钟），放到 `data/voice-ref/` 或告诉我路径。
4. **照片**：15–30 张 Karen 图，放到一个目录并告诉我路径。
5. **授权确认**：声音/肖像本人同意用于 AI 合成；是否只个人使用（决定 FLUX.2-dev 是否启用）。

拿到 1/2 后我先做**只读审计**，不装东西、不改配置；审计通过再按 Phase 1 部署。所有密钥只在本机/服务器，不写入仓库。

---

## 13. 官方来源

- Qwen3-TTS Base：<https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base>
- Qwen3-TTS 微调：<https://github.com/QwenLM/Qwen3-TTS/blob/main/finetuning/README.md>
- Qwen3-TTS CustomVoice：<https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice>
- Qwen3-TTS VoiceDesign：<https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign>
- FireRedTTS3：<https://huggingface.co/FireRedTeam/FireRedTTS3>
- GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>（v2Pro release `20250606v2pro`）
- Qwen-Image-Edit-2511：<https://huggingface.co/Qwen/Qwen-Image-Edit-2511>
- Z-Image-Turbo：<https://huggingface.co/Tongyi-MAI/Z-Image-Turbo>
- FLUX.2-dev：<https://huggingface.co/black-forest-labs/FLUX.2-dev>
- FLUX.2-klein-4B：<https://huggingface.co/black-forest-labs/FLUX.2-klein-4B>
- Qwen3-ASR：<https://huggingface.co/Qwen/Qwen3-ASR-1.7B>
- Qwen3-VL-30B-A3B：<https://huggingface.co/Qwen/Qwen3-VL-30B-A3B-Instruct>
- Qwen3-Embedding-8B：<https://huggingface.co/Qwen/Qwen3-Embedding-8B>
- Qwen3-Reranker-4B：<https://huggingface.co/Qwen/Qwen3-Reranker-4B>
- Qwen3-Next-80B-A3B：<https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct>
- Qwen3-Omni：<https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct>
- Graphiti：<https://github.com/getzep/graphiti>
