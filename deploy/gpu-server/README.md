# GPU 服务器部署入口（8×RTX 6000D）

> 状态：**准备阶段**。服务器尚未接入；这里只放只读审计、SSH 隧道和部署约定，不代表已部署。
> 选型与完整配置见 [docs/BEST_STACK_2026-10-22.md](../../docs/BEST_STACK_2026-10-22.md)。

## 1. 先审计，不装东西

```bash
# 方式 A：本机直接跑（需要 SSH 可达）
ssh -p <port> -i ~/.ssh/<key> <user>@<host> 'bash -s' < deploy/gpu-server/audit.sh

# 方式 B：先 scp 再跑
scp -P <port> -i ~/.ssh/<key> deploy/gpu-server/audit.sh <user>@<host>:~/
ssh -p <port> -i ~/.ssh/<key> <user>@<host> 'bash ~/audit.sh'
```

审计只读：`nvidia-smi`、显存/驱动、CUDA、Docker、磁盘、内存、端口、防火墙、HF 连通性。
输出会写到服务器 `~/karen-gpu-audit-*.txt`；请把该文件路径告诉我，或把输出贴回来。

**重点确认：**
- 单卡显存是 84GB 还是 96GB；
- 8 张卡是否都在、是否被别的任务占用；
- 根分区/数据盘可用空间（模型+训练数据建议 ≥1–2TB）；
- Docker + nvidia-container-toolkit 是否可用；
- 18100–18130、7687、7474 是否被占用；
- HuggingFace / hf-mirror 是否能访问。

## 2. 建立 SSH 隧道（Mac 侧）

不要在仓库里写主机/用户名/密钥。用环境变量：

```bash
GPU_HOST=<服务器IP> \
GPU_PORT=<SSH端口> \
GPU_USER=<用户名> \
GPU_KEY=~/.ssh/<私钥> \
bash deploy/gpu-server/tunnel.sh
```

先只打印命令、不执行：

```bash
FORWARD_ONLY=1 GPU_HOST=... GPU_PORT=... GPU_USER=... GPU_KEY=... \
  bash deploy/gpu-server/tunnel.sh
```

隧道建立后，Mac 访问 `127.0.0.1:19080-19090` 即对应服务器 `127.0.0.1:18100-18130`。

## 3. 安全底线

- 模型服务只绑 `127.0.0.1`，不监听 `0.0.0.0`；
- 防火墙默认拒绝入站，只开 SSH；
- 不把 181xx/7687 暴露到公网；
- 不把私钥、密码、`.env`、参考音、LoRA 权重提交进仓库；
- 服务器上的参考音/照片目录权限 700，任务结束可删。

## 4. 部署顺序

见 [BEST_STACK_2026-10-22.md §8](../../docs/BEST_STACK_2026-10-22.md#8-部署顺序拿到-ssh-后按这个走)：

1. Phase 0：审计；
2. Phase 1：FireRedTTS3 零样本 + Qwen3-TTS + Qwen-Image-Edit-2511 + Z-Image-Turbo；
3. Phase 2：GPT-SoVITS / Qwen3-TTS 微调 A/B；
4. Phase 3：图像 LoRA + ASR/VL/Embedding；
5. Phase 4：可选 FLUX.2-dev / 本地 LLM / Graphiti。

## 5. 服务与端口

| 服务 | 远程 | Mac 隧道 |
|---|---|---|
| GPT-SoVITS | 18100 | 19080 |
| Qwen3-TTS Base | 18101 | 19081 |
| Qwen3-TTS CustomVoice | 18102 | 19082 |
| Qwen3-TTS VoiceDesign | 18103 | 19083 |
| FireRedTTS3 | 18104 | 19088 |
| IndexTTS-2.5 回退 | 18105 | —（本地 18088） |
| Qwen-Image-Edit-2511 | 18110 | 19084 |
| Z-Image-Turbo | 18111 | 19085 |
| FLUX.2-dev（可选） | 18112 | 未默认转发 |
| FLUX.2-klein-4B（可选） | 18113 | 未默认转发 |
| Qwen3-ASR | 18120 | 19086 |
| SenseVoice/emotion2vec | 18121 | 未默认转发 |
| Qwen3-VL | 18122 | 19087 |
| Embedding/Reranker | 18123 | 19090 |
| Qwen3-Omni（可选） | 18124 | 未默认转发 |
| Qwen3-Next 本地 LLM（可选） | 18130 | 19089 |
| Graphiti API | 18140 | 未默认转发 |
| Neo4j | 7687/7474 | 未默认转发 |

## 6. 当前不在这里做的事

- 不写 `docker-compose.yml`：等审计确认驱动/CUDA/显存/磁盘后再写，避免拍脑袋。
- 不把主机、用户名、密钥写进任何受版本控制的文件。
- 不在服务器上跑公网端口/面板。
