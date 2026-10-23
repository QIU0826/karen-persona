# 运维与自愈（macOS）

> 状态：2026-10-23 新增（P0-2）。目标：**服务挂了她会告诉你，Mac 重启后她也能自己回来。**
> 备份/恢复见 [BACKUP.md](BACKUP.md)；QQ 桥接排查见 [QQ_BRIDGE_CROSS_PLATFORM.md](QQ_BRIDGE_CROSS_PLATFORM.md)。

## 一眼体检

```bash
npm run health          # 桥接 + TTS/ASR/嵌入/生图；任一不可达退出码 1
npm run health -- --json
curl -s http://127.0.0.1:18081/health | python3 -m json.tool
```

`/health` 新增字段（2026-10-23 起）：

| 字段 | 含义 |
|---|---|
| `status` | `ok` / `degraded`（有已配置依赖不可达，或桥接 120s 后仍无 WS 连接） |
| `dependencies` | 当前 `.env` 实际启用的依赖及探活结果（`up`/`latency_ms`/`error`） |
| `dependencies_checked_at` | 最近一次探活时间（后台每 60s 一次） |
| `degraded` | 具体降级项：`db` / `qq-bridge` / 依赖 `name` |

探测清单按后端推导，不会把没启用的服务算成故障：

| 能力 | 读的配置 | 默认端点 |
|---|---|---|
| TTS | `KAREN_TTS_BACKEND` | voxcpm2→19102 / indextts2→18088 / cosyvoice→18087 / kokoro→18086 |
| ASR | `KAREN_ASR` + `KAREN_ASR_BACKEND` | qwen-omni→19113 / sensevoice→19112 / faster-whisper→18085 |
| 嵌入 | `KAREN_EMBED` | 18083 |
| 生图 | `KAREN_IMAGE_GEN` + `KAREN_IMAGE_BACKEND` | z-image→19111 / qwen-image-edit→19110 / service→18084 / comfyui→8188 |

## 守护与自启（launchd）

```bash
bash scripts/install-launchd.sh all        # 隧道 + 桥接 + 嵌入
bash scripts/install-launchd.sh tunnel     # 只装某一个
bash scripts/install-launchd.sh --uninstall
```

| LaunchAgent | 入口 | 端口/作用 |
|---|---|---|
| `com.karen.persona.tunnel` | `scripts/gpu-tunnel.sh` | 19102/19110/19111/19112/19113 → GPU 服务器 18102/18110/18111/18112/18113 |
| `com.karen.persona.bridge` | `scripts/start-bridge.sh` | 18080 WS / 18081 health / 18082 web |
| `com.karen.persona.embed` | `scripts/start-embed.sh` | 18083 本地语义嵌入 |

- `KeepAlive=true`：崩溃/被杀后 15s 重启；登录后 `RunAtLoad` 启动。
- 日志：`data/logs/{tunnel,bridge,embed}.log`；每日 `scripts/backup.sh` 会把 >5MB 的日志
  copytruncate 成 `.log.1`（保留一份历史，不打断正在写的进程）。
- 隧道依赖 `~/.ssh/config` 的 `karen-gpu`（可用 `KAREN_GPU_SSH_HOST` 覆盖）；服务器上的容器用
  `--restart=unless-stopped`，重启服务器不会丢服务。
- **安装 bridge 前先停掉手动 `npm run qq`**，否则端口冲突会反复重启。

## 降级告警

`/health` 的后台探活检测到「某个依赖从可达变不可达」或「恢复」时：

- 写一条 `health.deps` 日志（只含 name/耗时，不含正文）；
- 通过 `osascript` 弹 macOS 通知；`KAREN_DESKTOP_NOTIFY=off` 可关。

典型通知：「VoxCPM2 语音合成、Z-Image 生图 不可达；她可能在降级运行（旧图库/系统音/听不懂语音）。」

## 手动排查顺序

1. `npm run health` 看是桥接、隧道还是本地服务。
2. 隧道断：`tail -20 data/logs/tunnel.log`；确认 `karen-gpu` 能 `ssh`、本地代理（`~/.ssh/config` 的 ProxyCommand）在跑。
3. 隧道通、服务不通：`ssh karen-gpu 'podman ps'` 看容器；看对应 `deploy/gpu-server/*/README.md` 的 `/health`。
4. 桥接不通：`tail -50 data/logs/bridge.log`、`launchctl print gui/$(id -u)/com.karen.persona.bridge`。
5. 本地嵌入不通：`tail -20 data/logs/embed.log`；`uv` 在 `~/.local/bin/uv`（可用 `UV_BIN` 覆盖）。

## 已知限制

- `data/logs/*.log` 由 `scripts/backup.sh` 每日轮转（>5MB → `.log.1`，只保留 1 份历史）。
- 依赖探活默认只覆盖本机/隧道端点；`KAREN_HEALTH_CLOUD=on` 时额外探测 DeepSeek API 可达性（不带 Key，401 也算可达）。Unsplash 等其余云服务仍看回复失败/日志。
- 桥接没有「NapCat 掉线」的独立回执：WS 连接数为 0 超过 120s 会体现在 `status=degraded`，但不会主动通知（下一步可接）。
