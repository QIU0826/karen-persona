# QQ 桥接跨平台部署（macOS / Windows / Linux）

> 状态：**调研 + 部署资产**。截至 **2026-10-19** 的官方公开信息与本机可复现实验。
> 适用代码：`src/bridge/qq.ts`（OneBot 11 反向 WebSocket **服务端**）+ `src/bridge/onebot.ts`。
> 本文区分三类结论：**已实测**（本仓库可复现）、**官方文档写明**（附链接与日期）、**待核实**。

---

## 1. 先理解方向：谁连谁

```
QQ 客户端（小号）
   │  扫码登录 / 收发消息
   ▼
NapCatQQ（OneBot 11 协议端，扮演 WebSocket **客户端**）
   │  ws://127.0.0.1:18080/onebot/v11/ws   ← 可带 access_token
   ▼
Karen `npm run qq`（WebSocket **服务端**，qq.ts 里的 WebSocketServer）
   │
   ▼
DeepSeek / 本地 data/（记忆、会话）
```

因此：

- **Karen 必须先启动**（或 NapCat 会不断重连），NapCat 反向 WS 地址里的端口/path 必须与 Karen 的配置一致。
- 默认监听 `127.0.0.1:18080`，路径 `/onebot/v11/ws`；token 可选但**跨机/非回环必须设置**。
- 白名单 `allowed_users` 只放你自己的 QQ 号；留空 = 任何 QQ 都能聊（启动会警告）。
- 反向 WS 意味着 **NapCat 不需要暴露任何入站端口**，Karen 也不要把 18080 暴露到公网。

配置优先级：`config.yaml` > 环境变量 > 默认值（`src/data/store.ts` 的 `loadConfig`）。
关键项：`one_bot_ws_host` / `one_bot_ws_port` / `one_bot_ws_path` / `one_bot_token` / `allowed_users`。

---

## 2. 平台矩阵（结论先行）

| 路径 | 平台 | 需要 QQ 客户端？ | 前置条件 | 推荐度 | 主要风险 |
|---|---|---|---|---|---|
| **A. macOS 原生 NapCat** | macOS 12+（Intel / Apple Silicon） | 是，`/Applications/QQ.app` | NapCat-Mac-Installer、允许「App 管理」权限 | ⭐ **推荐**（本机最终态） | 修改 QQ 程序入口；QQ 升级可能失效；封号风险 |
| **B. macOS Docker（Linux 容器）** | macOS + Docker Desktop / OrbStack | 是，容器内 Linux QQ | Apple Silicon 走 arm64 镜像，无需 Rosetta | ⭐ 备选（隔离、不改本机 QQ） | 容器→宿主机回环连通性需按环境验证；镜像 tag 需核实 |
| **C. Linux 虚拟机（UTM/OrbStack machine）** | macOS | 是，虚拟机内 Linux QQ | 虚拟化工具 + Xvfb/桌面 | 不推荐（重） | 资源占用、网络配置复杂 |
| **D. 远程 Windows/Linux + SSH 隧道** | macOS 本地 + 远程主机 | 是，远程主机上 | SSH、远程 NapCat、token | 适合「QQ 在另一台常开机器」 | 隧道断线；远程主机就是你的账号环境 |
| **E. 第三方协议实现（Lagrange 等）** | 跨平台 | 否（不启动 QQ） | 自行编译/部署协议端 + 适配器 | **不推荐**，仅研究 | 协议逆向，封号与随时失效风险更高 |

**macOS 推荐路径 = A（原生 NapCat）+ 本机 Karen**。理由：

1. NapCat 官方文档已单列 **macOS** 章节：支持 **macOS 12+、Intel 和 Apple Silicon**，并维护独立的 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer)（当前 **v1.7，2026-10-10** 发布，Universal 安装包）。
2. NapCat **v4.18.38（2026-10-12 发布）** 的 release notes 明确包含「支持 macOS 设备 GUID 管理…(#2099)」，说明 macOS 是当前在维护的平台，而不是「理论可跑」。
3. 不需要 Docker Desktop、不需要开「入站端口」，数据（记忆/会话）都在本机 `data/`，与项目定位一致。
4. Docker 路径（B）保留为「不想动本机 QQ.app / 想隔离」的备选，见 `deploy/napcat-macos/`。

> Windows 仍是维护者验证最充分的平台（`scripts/start-all.bat` 等按 Windows 编写）：见 `deploy/napcat-windows/README.md`。
> Linux 原生/Docker 都可作为「常开主机」路径，见官方 Shell 文档的 Linux 与 Docker 章节。

---

## 3. macOS 路径 A：原生 NapCat（推荐）

> 官方依据：[NapCat Shell 文档 · macOS](https://doc.napneko.icu/guide/boot/Shell)（页面最后编辑于访问前 2 天，访问日期 2026-10-19）、[NapCat-Mac-Installer README](https://github.com/NapNeko/NapCat-Mac-Installer)。

### A0. 前置

- macOS 12+（Intel/Apple Silicon 均可）。
- 一个**单独注册的 QQ 小号**（不要用主号；官方安全页也建议 Bot 号与常用号分设备/分 IP）。
- 本仓库已能跑：Node 22+、`npm install` 完成、`.env` 与 `config.yaml` 已按第 5 节准备好。
- 从官方渠道安装 QQ Mac 版：https://im.qq.com/macqq/ ，确认安装在 `/Applications/QQ.app`。

### A1. 安装 NapCat（改动 QQ 入口，可逆）

1. 打开 [NapCat-Mac-Installer Releases](https://github.com/NapNeko/NapCat-Mac-Installer/releases)，下载 `NapCatInstaller_arm64.amd64.zip`（Universal，当前 v1.7）。
2. 打开安装器 → 选择 **NapCat 版本（建议 v4.18.38 Shell 资源）** 与下载方式（直连/系统代理/GitHub 加速）→ 安装。
3. 安装器会「备份并修改 QQ 程序入口」：选择 **切换程序入口 → NapCat**，然后启动。
   - 若被系统拒绝：**系统设置 → 隐私与安全性 → App 管理**，允许安装器管理 QQ 后重试。
4. 恢复原版 QQ：同一安装器选择 **切换程序入口 → 原版 QQ**。NapCat 的配置与插件保留在
   `~/Library/Containers/com.tencent.qq/Data/Documents/napcat`（更新不丢；卸载时连同恢复入口一起清理）。

### A2. 启动并扫码登录

1. 启动 NapCat 后看控制台/QQ 窗口，寻找类似
   `[NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=xxxxx` 的日志；
   也可以在 `~/Library/Containers/com.tencent.qq/Data/Documents/napcat/config/webui.json` 找到 `port`/`token`。
2. 浏览器打开 `http://127.0.0.1:6099/webui`（**只在本机访问，不要映射到公网**）。
3. 进入 QQ 登录 → 选择 `QRCode` → 用**手机上的小号 QQ**扫码。
   - 扫码后 WebUI token 会刷新：到手机 QQ 的「我的电脑/自身消息」或 NapCat 控制台查看新 token，再登录。
   - 首次登录会要求修改 WebUI 密码（官方文档：不修改会禁用大部分功能）。
4. 登录成功的标志：NapCat 控制台显示账号在线，Karen 端稍后会出现 `[WS] 连接: /onebot/v11/ws`。

### A3. 配置反向 WebSocket（NapCat 侧）

WebUI → **网络配置 → 新建 → WebSocket 客户端**：

| 字段 | 值 |
|---|---|
| 名称 | `karen`（随意） |
| URL | `ws://127.0.0.1:18080/onebot/v11/ws` |
| Token | 与 `.env` 的 `ONE_BOT_TOKEN` 一致；若 Karen 未设 token 则留空 |
| 消息格式 | `array`（默认即可，Karen 两种都兼容） |
| 重连间隔 | 默认 5000ms |
| 保存时启用 | ✅ 勾选 |

> Token 的传递方式：Karen 同时接受 `?access_token=` 查询参数和 `Authorization: Bearer <token>`（`onebot.ts` 的 `getProvidedToken`）。NapCat 的 WebSocket 客户端配置项 `token` 会用于鉴权；两侧保持一致即可。

### A4. 配置并启动 Karen

```bash
cd karen-persona
cp .env.example .env          # 若还没有
cp config.yaml.example config.yaml

# .env（或 config.yaml，两处冲突时 config.yaml 优先）：
#   ONE_BOT_HOST=127.0.0.1
#   ONE_BOT_WS_PORT=18080
#   ONE_BOT_WS_PATH=/onebot/v11/ws
#   ONE_BOT_TOKEN=<一段足够长的随机串，例如 openssl rand -hex 24>
#   ALLOWED_USERS=<你自己的 QQ 号>

npm run doctor                # 先跑绿
npm run qq                    # 终端 A：桥接常驻
```

另开终端，用**你自己的 QQ** 给小号发一条私聊。成功日志形态：

```
[安全] 白名单已启用：1 个 QQ 号
[WS] 监听 ws://127.0.0.1:18080/onebot/v11/ws
[WS] 等待 NapCatQQ 连接...（已启用 token 校验）
[WS] 连接: /onebot/v11/ws (活跃: 1)
[收到] 你的昵称 (123456789): 6 字
[回复] -> 你的昵称: 4 字
```

失败对照：

| 日志 | 原因 | 处理 |
|---|---|---|
| `[WS] 拒绝握手：token 校验失败` | 两侧 token 不一致 | 核对 `.env` / config.yaml 与 NapCat 客户端 token |
| `[WS] 拒绝握手：路径不匹配` | URL path 不是 `/onebot/v11/ws` | 修改 NapCat URL 或 Karen 的 `one_bot_ws_path` |
| 一直「等待 NapCatQQ 连接」 | 顺序/端口/token；或 NapCat 未登录 | 先起 Karen 再让 NapCat 连接；`lsof -i :18080` 查端口 |
| 没有任何回复但也不报错 | 你的 QQ 不在 `allowed_users` | 白名单是静默忽略，不打印消息正文 |

### A5. 免 QQ 先联调（推荐先做这一步）

在没有扫码之前，可用仓库自带的 mock 客户端验证「握手/token/事件解析/出站 API 调用」：

```bash
# 终端 A：正常启动桥接
npm run qq

# 终端 B：模拟 NapCat 发一条私聊
node scripts/mock-onebot.mjs --token "<与 ONE_BOT_TOKEN 相同>" --text "你好呀" --seconds 60
```

看到 `[API] send_private_msg` 且脚本以退出码 0 结束，说明 Karen 的收发链路（含真实 LLM 调用）是通的。
脚本参数与退出码见 `node scripts/mock-onebot.mjs --help` 和 `scripts/mock-onebot.mjs` 文件头。

---

## 4. 部署路径 B：Docker 跑 NapCat（macOS 备选；附 Linux/Windows 入口）

> 官方依据：[NapCat Shell 文档 · Docker](https://doc.napneko.icu/guide/boot/Shell#docker)（官方给的 compose 示例）、[NapCat-Docker README](https://github.com/NapNeko/NapCat-Docker)、[docker-publish.yml](https://github.com/NapNeko/NapCat-Docker/blob/main/.github/workflows/docker-publish.yml)（镜像 tag 规则）。

镜像：`mlikiowa/napcat-docker`，官方 CI 以 `linux/amd64, linux/arm64` 构建，tag 规则为 **NapCat release tag**（如 `v4.18.38`）+ `latest`。Apple Silicon 直接跑 arm64，无需 `--platform`。

```bash
cd deploy/napcat-macos
cp .env.example .env          # 填 WEBUI_TOKEN（长随机串）
docker compose up -d
docker compose logs -f napcat # 等 WebUI 起来
```

1. 浏览器打开 `http://127.0.0.1:6099/webui`，用 `WEBUI_TOKEN` 登录，扫码登录 QQ 小号（流程同 A2）。
2. WebUI → 网络配置 → 已由 `MODE=reverse_ws` 预生成 `karen` 客户端；**把它的 token 改成与 Karen 的 `ONE_BOT_TOKEN` 一致并保存启用**（compose 预生成配置时不带 token）。
3. 容器里的 URL 要指向**宿主机**上的 Karen：compose 已用 `ws://host.docker.internal:18080/onebot/v11/ws`。
   - Docker Desktop / OrbStack 一般可直接访问宿主机回环服务；若日志报 `ECONNREFUSED`，见 `deploy/napcat-macos/README.md` 的排障与替代方案。
4. Karen 侧**保持 `ONE_BOT_HOST=127.0.0.1`**（默认），token 必须设置。

**为什么不把 Karen 也放进这个 compose？** 当前任务范围是「NapCat 部署资产」；把 Karen 放进容器会额外引入 `data/` 卷、`config.yaml` 挂载与 uid 映射问题，且会绕开 macOS 本机的 `data/` 记忆目录。需要全容器化时，可作为后续 M2 的独立任务。

### 4.1 Linux 作为「常开主机」（简述）

官方对 Linux 的推荐是 Shell 安装或 Docker（[Shell 文档 · Linux / Docker](https://doc.napneko.icu/guide/boot/Shell#linux)）：

```bash
# 官方一键安装（支持 apt/dnf 的 amd64、arm64；装到当前用户 ~/Napcat）
curl -fL --connect-timeout 20 --max-time 1800 \
  -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh &&
bash napcat.sh --docker n --cli y --github-proxy 0
# 安装后运行 napcat 管理服务；系统仓库无 Xvfb 时改用 Docker
```

- Docker 路径：用官方 compose 示例（镜像/端口/数据卷同第 4 节），Linux 上容器访问宿主机回环可用
  `network_mode: host`（Linux 支持），或给容器加 `extra_hosts: ["host.docker.internal:host-gateway"]`
  并把反向 WS 地址改成 `ws://host.docker.internal:18080/...`。
- Karen 与 NapCat 同机时：Karen 监听 `127.0.0.1:18080`，NapCat 反向 WS 填 `ws://127.0.0.1:18080/onebot/v11/ws`；
  若 NapCat 在容器内，注意回环方向（容器内的 `127.0.0.1` 不是宿主机）。
- 长期运行建议 systemd、日志轮转与固定 NapCat 版本；安全基线与 macOS 相同（回环 + token + 白名单）。

### 4.2 Windows 原生（已验证路径）

见 [`deploy/napcat-windows/README.md`](../deploy/napcat-windows/README.md)：NapCat OneKey/Shell + WebUI 6099 + 反向 WS，
配合仓库的 `scripts/start-all.bat` / `scripts/start-napcat.bat` / 可选 PM2 守护。

---

## 5. 项目侧配置（三条路径共用）

`.env`（或 `config.yaml`，优先级更高）：

```dotenv
ONE_BOT_HOST=127.0.0.1
ONE_BOT_WS_PORT=18080
ONE_BOT_WS_PATH=/onebot/v11/ws
ONE_BOT_TOKEN=用 openssl rand -hex 24 生成
ALLOWED_USERS=你的QQ号
```

`config.yaml` 对应项（可选，注释在 `config.yaml.example`）：

```yaml
allowed_users: ["123456789"]     # 换成你自己的 QQ 号；字符串/数字都支持（5-12 位数字）
# one_bot_ws_host: "127.0.0.1"
# one_bot_ws_port: 18080
# one_bot_ws_path: "/onebot/v11/ws"
# one_bot_token: "与 .env 一致"
```

安全基线（必须）：

- `ONE_BOT_HOST` 保持 `127.0.0.1`；**不要**为了「让另一台机器连上」改成 `0.0.0.0`——改用 SSH 隧道（第 6 节）。
- `ONE_BOT_TOKEN` 至少 16 字符随机串；跨机/非回环时**强制**。
- `allowed_users` 只填自己；空白名单会打印显著警告。
- NapCat WebUI（6099）只绑 `127.0.0.1`，用强密码；不要端口映射到公网/路由器。
- 不要用主号；不要同时在同一设备登录 Bot 号与常用号（官方安全页建议）。
- 出站消息已做 CQ 转义与长度切分；日志只打印长度/摘要，但 `orchestrator` 等其他模块仍可能打印片段，注意终端/日志文件权限。

---

## 6. 远程桥接：SSH 隧道（不要暴露 WebSocket）

### 6.1 场景一：NapCat 在远程主机，Karen 在本机 macOS（推荐方向）

反向 WS 的方向是「NapCat 连 Karen」，所以要在远程主机上开一个**回环端口**转发回 macOS：

```bash
# 在 macOS 上执行：把远程主机的 127.0.0.1:18080 转发到本机 18080
ssh -N -R 18080:127.0.0.1:18080 user@远程主机

# 可选：同时把远程 NapCat WebUI 拉到本机管理
ssh -N -L 6099:127.0.0.1:6099 user@远程主机
```

远程主机的 NapCat 反向 WS URL 填 `ws://127.0.0.1:18080/onebot/v11/ws`。此时：

- 远程主机的 18080 **只绑定远程回环**（sshd 默认 `GatewayPorts no`），不会被公网访问。
- Karen 仍监听本机 `127.0.0.1:18080`，`ONE_BOT_HOST` 不用改。
- **token 仍然必须设置**：同机其他进程、以及隧道两端都可能接触这个端口。
- 长期使用建议 `autossh -M 0 -N -R ...` 或 launchd 守护；隧道断开时 NapCat 会自动重连，Karen 侧显示「等待重连」。

### 6.2 场景二：整套服务在远程，macOS 只做管理/联调

```bash
# 本机 18080 → 远程 18080（用于 mock 联调 / 调试）
ssh -N -L 18080:127.0.0.1:18080 user@远程主机
# 本机 6099 → 远程 6099（管理 NapCat WebUI）
ssh -N -L 6099:127.0.0.1:6099 user@远程主机
```

远程的 Karen 监听 `127.0.0.1:18080`，NapCat 同机连接；**不要在远程把 18080 绑 0.0.0.0**，也不要开安全组入站。

### 6.3 明确禁止

- 路由器端口转发 / 安全组放行 18080、6099。
- 用 `ngrok`/`frp` 等把 OneBot WS 或 WebUI 暴露公网（WebUI token 泄露 = 账号被完全接管）。
- 在 napcat 反向 WS URL 里把 token 明文写进公网可访问的配置（如需 query 传 token，至少走回环/隧道）。

---

## 7. 版本锁定与账号风险（重要）

### 7.1 需要锁定的版本

| 组件 | 当前版本（2026-10-19） | 锁定建议 |
|---|---|---|
| NapCatQQ | 官方最新 **v4.18.38**（2026-10-12）；项目 CLAUDE.md 记录的 Windows 验证版本是 **v4.18.4** | 固定到具体 release，不要自动追最新；升级前看 release notes。要与现有 Windows 部署一致可继续用 v4.18.4，新装可用 v4.18.38（同样需真机验证） |
| NapCat-Mac-Installer | **v1.7**（2026-10-10） | 安装后保留安装器版本；更新时配置/插件会保留 |
| NapCat Docker 镜像 | tag 规则 `vX.Y.Z` / `latest` | **固定 tag**，不要用 `latest` 长期运行 |
| QQ NT 客户端 | 以本机安装为准（macOS 从 im.qq.com/macqq 下载） | **不要开自动更新**；升级 QQ 前确认 NapCat 已支持 |
| Karen | 本仓库代码 | 记录 commit；升级时先备份 `data/` |

- macOS 上取 QQ 版本：

  ```bash
  plutil -extract CFBundleShortVersionString raw /Applications/QQ.app/Contents/Info.plist
  plutil -extract CFBundleVersion raw /Applications/QQ.app/Contents/Info.plist
  ```

  更可靠的是看 NapCat 启动日志里打印的 QQ 版本。
- 升级顺序：**先确认 NapCat 支持新 QQ → 再升 NapCat → 最后升 QQ**。NapCat 升级失败可用安装器回退版本；QQ 升级后若协议不兼容，需等 NapCat 适配（这是非官方协议的结构性风险）。
- macOS 注意：NapCat 高级配置文档写明 **macOS 因沙盒无法运行外部程序，FFmpeg 相关音视频处理暂不支持**（Karen 目前不发语音/视频，影响有限）；文档中的 PacketBackend 平台表显示 macOS 仅特定 build（29456）支持部分扩展能力，该表最后更新较早，**升级前需在 NapCat 文档核实**。
- Docker 路径额外注意：容器 tag 必须与 NapCat release 对应；`docker compose pull` 会更新镜像，固定 tag 时不会漂移。

### 7.2 账号风控 / 封号

非官方协议（NapCat）违反 QQ 平台用户协议，**存在封号/限制登录风险**，官方安全页给出的经验：

- Bot 小号与常用账号**不要同 IP/同设备**同时在线；
- 频繁掉线可通过更换账号或设备改善；社交风控解除后通常可恢复；
- 公网部署必须启用 token；
- 本项目自身还有 `message_frequency_limit`（默认 10 条/分钟）与主动消息上限等防刷屏保护，但**不构成对平台风控的保证**。

**风险自担**：本项目不提供 QQ 账号；请使用小号并接受「客户端升级/协议变更可能让桥接失效」的结构性风险（`docs/PRODUCT_AUDIT.md` 4.8 已列为最大产品风险）。

### 7.3 已知限制（macOS / 本桥接）

| 限制 | 说明 |
|---|---|
| 系统通知 | `qq.ts` 的掉线桌面通知是 PowerShell 实现（`notifyWindows`），**仅 Windows**；macOS 只能看日志 |
| 群聊 | 仅 @ 且「私聊过的人」才回复（半成品）；引用/表情可用；图片识别走 DeepSeek Flash 多模态（桥接先下载图片转 base64，兼容 NapCat 私有 URL） |
| 双管线 | QQ 私聊走精简流式管线；部分演化/独白能力只在 CLI/群聊生效（M1 继续统一） |
| 多用户隔离 | 同一人设下多个好友共享会话/记忆，未完成（README 已知限制） |
| Docker 回环 | macOS 容器访问宿主机 `127.0.0.1` 依赖 `host.docker.internal`，不同 Docker 实现行为可能有差异 |
| 真实账号验证 | 本仓库 CI/本机均**未**接入真实 QQ 账号，真实扫码链路由用户侧验证 |

---

## 8. 免 QQ 联调：`scripts/mock-onebot.mjs`

用途：模拟 NapCat 的反向 WS 客户端，在**没有任何 QQ 账号**的 macOS/Linux CI 上验证：

- WS 握手（path 校验、token 校验）；
- `post_type=message` 私聊事件解析、白名单、去重；
- Karen 出站 `send_private_msg` API 调用（含真实 LLM 回复，成本极小）；
- 断线/超时行为。

零新依赖：只用项目已有的 `ws`（`import { WebSocket } from "ws"`），无需安装任何东西。

```bash
# 1) 终端 A：启动桥接（用临时数据目录，避免污染 data/）
KAREN_DATA_DIR=/tmp/karen-mock-data npm run qq

# 2) 终端 B：一条私聊，最多等 60s 的回复
node scripts/mock-onebot.mjs --text "你好呀" --user-id 100000001 --seconds 60

# 指定 token / path / 端口
node scripts/mock-onebot.mjs \
  --token "$ONE_BOT_TOKEN" \
  --port 18080 --path /onebot/v11/ws \
  --user-id 100000001 --text "在吗" --seconds 45

# 测试 token 走 query 参数（Karen 两种都支持）
node scripts/mock-onebot.mjs --token "xxx" --token-in query
```

参数（完整见 `--help`）：`--url`、`--host`、`--port`、`--path`、`--token`、`--token-in header|query|both`、
`--user-id`、`--self-id`、`--nickname`、`--text`、`--seconds`。

退出码：`0` 收到回复 API 调用（联调通过）；`1` 已连接并发出事件但超时无回复；`2` 连接失败；`3` 握手被拒（401/404）；`4` 参数错误。

---

## 9. 实测记录（本仓库，2026-10-19）

- 平台：macOS 26.5.1 / Apple Silicon（arm64）；Node v24.21.0（`.devtools/node-dsh`）。
- 方式：临时 `config.yaml`（`one_bot_ws_port: 18099`、`allowed_users: [100000001]`、`one_bot_token: 本地测试 token`）+ `KAREN_DATA_DIR=/tmp/...` 启动 `src/bridge/qq.ts`，再用 `scripts/mock-onebot.mjs` 连接。
- 结论（详见 Lead 汇总报告）：
  - 错误 token → 握手被拒（HTTP 401），mock 以退出码 3 结束；
  - 错误 path → 握手被拒（HTTP 404），mock 以退出码 3 结束；
  - 正确 token（`Authorization: Bearer`）→ 连接成功、事件被受理、Karen 调用 DeepSeek 并通过 2 条 `send_private_msg` 回复（如「累死了……」「今天店里来了个团建的，一下午没停过」），mock 以退出码 0 结束；
  - 正确 token（`?access_token=` 查询参数）→ 同样通过，回复包含文本与 `[CQ:face,id=55]` 表情，说明 token 两种传递方式与出站 CQ 表情均正常；
  - 未启动 Karen 时 → mock 以退出码 2 结束；非法参数 → 退出码 4；
  - 临时 `config.yaml` 与 `/tmp` 数据目录已清理；未改 `src/`、README、package.json/lock；真实 LLM 成本约几分钱级别。
- **未实测**：真实 QQ 扫码登录、真实 NapCat 反向 WS、Docker 镜像拉取（本机到 Docker Hub 的 registry 连通性受限）——这些需要在用户机器上按本文步骤验证。

---

## 10. 调研来源（均于 2026-10-19 访问）

| 来源 | 用于支撑 | 备注 |
|---|---|---|
| [NapCatQQ Releases（v4.18.38）](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38) | 版本号/日期、macOS GUID 支持 | GitHub API 显示 `published_at: 2026-10-12` |
| [NapCat 文档 · Shell 安装](https://doc.napneko.icu/guide/boot/Shell) | macOS 12+ 原生支持、Docker 官方 compose、Linux 安装 | 页面最后编辑于访问前 2 天 |
| [NapCat 文档 · WebUI 配置](https://doc.napneko.icu/config/basic) | WebUI 6099、扫码登录、反向 WS 配置字段 | |
| [NapCat 文档 · 安全相关](https://doc.napneko.icu/other/security) | WebUI token 机制、账号风控建议 | 页面约 1 年未更新 |
| [NapCat 文档 · 高级配置](https://doc.napneko.icu/config/advanced) | macOS FFmpeg 不支持、PacketBackend 版本表 | 页面约 6 个月未更新，需复核 |
| [NapCat-Mac-Installer v1.7](https://github.com/NapNeko/NapCat-Mac-Installer/releases/tag/v1.7) | macOS 安装器、权限、配置路径 | `published_at: 2026-10-10` |
| [NapCat-Docker README](https://github.com/NapNeko/NapCat-Docker) | 镜像名、环境变量、数据卷、更新方式 | |
| [NapCat-Docker 发布工作流](https://github.com/NapNeko/NapCat-Docker/blob/main/.github/workflows/docker-publish.yml) | 镜像 tag 规则（`vX.Y.Z` + `latest`，amd64/arm64） | tag 是否已推送需核实 |
| [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | 第三方协议实现现状（V2 主推 Milky 协议；V1 已 sunset，接入 OneBot 11 需额外适配器） | 仓库 2026-10-19 仍活跃 |
| [QQ Mac 版下载](https://im.qq.com/macqq/) | macOS QQ 官方安装来源 | |
| [Docker Hub: mlikiowa/napcat-docker](https://hub.docker.com/r/mlikiowa/napcat-docker) | 镜像页面 | 本机网络无法拉取，未实机验证 |

### 待核实（发布/使用前必须确认）

1. **Docker 镜像 tag `v4.18.38` 是否已推送**：`docker manifest inspect mlikiowa/napcat-docker:v4.18.38`；若不存在，到 [Docker Hub tags](https://hub.docker.com/r/mlikiowa/napcat-docker/tags) 选最近已发布 tag 固定。不要长期用 `latest`。
2. **当前 QQ Mac 版本是否在 NapCat v4.18.38 支持范围内**：看 NapCat 启动日志的 QQ 版本；必要时用安装器回退 NapCat 版本或暂缓升级 QQ。
3. **Docker Desktop/OrbStack 容器访问宿主机 `127.0.0.1:18080` 的连通性**：以 `deploy/napcat-macos/README.md` 的排障命令实测为准。
4. **macOS 原生路径的首次扫码**：需要真机 + QQ 小号，本仓库无法替代。
