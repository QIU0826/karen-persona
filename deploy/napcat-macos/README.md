# macOS 部署 NapCatQQ（Docker 备选路径）

> 目标：在 macOS 上用 Docker 跑 Linux 版 QQ + NapCat，NapCat 反向连接**本机** `npm run qq` 的桥接。
> 前置阅读：[docs/QQ_BRIDGE_CROSS_PLATFORM.md](../../docs/QQ_BRIDGE_CROSS_PLATFORM.md) 第 2、3、7、8 节。
>
> **推荐顺序**：macOS 优先用**原生 NapCat**（官方支持 macOS 12+/Apple Silicon，见跨平台文档第 3 节）。
> 本目录是备选：想隔离 QQ 环境、不想改 `/Applications/QQ.app` 入口时使用。

---

## 1. 前置检查

```bash
# Docker 在跑（Docker Desktop 或 OrbStack 均可；Apple Silicon 原生跑 arm64 镜像）
docker info --format '{{.ServerVersion}} {{.OperatingSystem}} {{.Architecture}}'
# 例：29.8.2 OrbStack aarch64

docker compose version

# 镜像 tag 是否存在（本目录固定 v4.18.38；官方 CI 按 NapCat release tag 推送镜像）
docker manifest inspect mlikiowa/napcat-docker:v4.18.38 > /dev/null && echo "tag ok"
# 若报错/不存在：到 https://hub.docker.com/r/mlikiowa/napcat-docker/tags
# 选最近已发布 tag，改 docker-compose.yml 的 image 后继续。不要长期用 latest。
```

再准备：

- 一个**单独的 QQ 小号**（不要用主号）。
- 宿主机上本项目已就绪：`.env`、`config.yaml`、`npm install` 完成。
- 宿主机 **Karen 先启动**：终端里 `npm run qq` 常驻（NapCat 会连它）。

---

## 2. 首次部署

```bash
cd deploy/napcat-macos

cp .env.example .env
# 编辑 .env：把 WEBUI_TOKEN 换成随机串（至少 32 位）
#   openssl rand -hex 24
# 其他保持默认即可；uid 不是 501 的话改 NAPCAT_UID/NAPCAT_GID

docker compose config          # 只校验配置，不启动；报错先修
docker compose up -d
docker compose logs -f napcat  # 等 WebUI 起好，Ctrl-C 退出日志跟踪
```

启动完成的标志：日志里出现 WebUI 地址/端口（默认 `6099`）。

> **headless / Xvfb**：官方镜像的 entrypoint 内部会启动 `Xvfb :1` 作为虚拟显示，
> 所以 macOS 上不需要额外安装 X11/桌面环境；二维码在 WebUI 页面里显示，不依赖本机窗口。

---

## 3. 扫码登录 QQ 小号（容器内）

1. 浏览器打开 **http://127.0.0.1:6099/webui**（只绑了回环，不要从别的机器访问）。
2. 用 `.env` 里的 `WEBUI_TOKEN` 登录。
3. 进入 **QQ 登录 → QRCode**，用手机上的 QQ 小号扫码。
4. 登录成功后 NapCat 控制台/日志会显示账号在线。
   - 首次登录后 WebUI 可能要求修改密码（按提示操作）。
   - 二维码不刷新/扫码失败：`docker compose restart napcat` 后重试；仍失败时看日志里是否有 `Login Error`。

> 数据都在 `./data/` 三个目录里：登录态 `data/qq`、配置 `data/config`、插件 `data/plugins`。
> **升级/重建容器不会丢**；删 `data/` 等于重置登录。

---

## 4. 配置反向 WebSocket（NapCat → 宿主机 Karen）

本 compose 用 `MODE=reverse_ws` + `ONEBOT_URL=ws://host.docker.internal:18080/onebot/v11/ws`
在**首次启动、配置目录为空时**自动生成配置；之后以 WebUI 为准。

1. 宿主机 `.env` 里设置 token：

   ```dotenv
   ONE_BOT_HOST=127.0.0.1
   ONE_BOT_WS_PORT=18080
   ONE_BOT_WS_PATH=/onebot/v11/ws
   ONE_BOT_TOKEN=<openssl rand -hex 24>
   ALLOWED_USERS=<你自己的 QQ 号>
   ```

2. WebUI → **网络配置**：确认已有 `karen`（WebSocket 客户端）：
   - URL：`ws://host.docker.internal:18080/onebot/v11/ws`
   - **Token：填成与宿主机 `ONE_BOT_TOKEN` 完全一致**
   - 勾选「保存时启用」，保存。
   - （预生成配置的 token 为空，所以这一步**必须手动补**。）
3. 宿主机终端确认 Karen 日志出现 `[WS] 连接: /onebot/v11/ws`。
4. 用你自己的 QQ 给小号发私聊；Karen 日志应出现 `[收到]` 与 `[回复]`。

---

## 5. 常见问题

### Q1：NapCat 日志 `connect ECONNREFUSED 192.168.x.x:18080` / 一直重连

原因：容器访问不到宿主机的 `127.0.0.1:18080`。按顺序排查：

```bash
# 1) Karen 是否真的在监听（宿主机执行）
lsof -nP -iTCP:18080 -sTCP:LISTEN
# 2) 从容器内测试宿主机回环（先确认容器名）
docker exec -it karen-napcat bash -lc 'getent hosts host.docker.internal; timeout 3 bash -c "echo > /dev/tcp/host.docker.internal/18080" && echo TCP_OK || echo TCP_FAIL'
# 3) 宿主机防火墙/安全软件是否拦截 Docker 网段
```

- 若 `host.docker.internal` 解析不到：OrbStack/Docker Desktop 一般内置；老版本 Docker Desktop
  可在 compose 里给 `napcat` 服务加：

  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

- 若仍不通（少数虚拟化网络配置下容器无法访问宿主机回环）：
  - 备选 1（**改回原生路径**）：见跨平台文档第 3 节，最稳。
  - 备选 2：让 Karen 监听 `0.0.0.0`，**必须**同时设置强 `ONE_BOT_TOKEN`，并确认 macOS 防火墙
    只允许 Docker 私有网段访问。仅限本机开发，绝不适用于公网/共享网络。
  - 备选 3：把 Karen 也放进同一个 compose 网络（需要自定义 Dockerfile/挂载，当前任务未包含）。

### Q2：Karen 日志 `[WS] 拒绝握手：token 校验失败`

NapCat 客户端 token 与宿主机 `ONE_BOT_TOKEN` 不一致。改 WebUI 里 `karen` 客户端的 token → 保存并启用。

### Q3：Karen 日志 `[WS] 拒绝握手：路径不匹配`

URL 的 path 必须是 `/onebot/v11/ws`（或与 Karen 的 `ONE_BOT_WS_PATH` 一致）。

### Q4：扫码后 QQ 掉线 / 需要重新扫码

- 看 `docker compose logs --tail=100 napcat` 是否 `Login Error`；
- 风控/异地登录会导致频繁掉线（官方安全文档建议换账号/换设备/换 IP）；
- token 泄露/WebUI 暴露公网会带来账号被接管风险，**永远不要**映射 6099 到公网。

### Q5：更新 NapCat

```bash
# 1) 先看 release notes 是否适配当前 QQ 版本
# 2) 改 docker-compose.yml 的 image tag 为新版本
docker compose pull
docker compose up -d
# 数据卷保留；回滚就是把 tag 改回去再 up -d
```

### Q6：完全卸载

```bash
cd deploy/napcat-macos
docker compose down
rm -rf data/            # ⚠️ 会删除登录态/配置/插件；先确认不再需要
```

---

## 6. 安全清单（逐条打勾）

- [ ] `ports` 只绑 `127.0.0.1:6099`，没有 `0.0.0.0`。
- [ ] `WEBUI_TOKEN` 是随机长串，不是示例值。
- [ ] 宿主机 `ONE_BOT_HOST=127.0.0.1`（默认），`ONE_BOT_TOKEN` 已设置。
- [ ] `ALLOWED_USERS` 只含自己的 QQ 号。
- [ ] 路由器/安全组没有任何指向 6099/18080 的入站规则。
- [ ] 用的是 QQ 小号，且与常用号不在同设备同时登录。

---

## 7. 本仓库验证状态

- `docker compose config` 语法校验：本机执行通过（Docker 29.8.2 / Compose v5.5.0，2026-10-19）；**未实机启动容器/未拉取镜像**。
- 镜像拉取/扫码登录/真实消息链路：**未在本仓库验证**（需要 QQ 小号 + 可用 Docker Hub 网络）。
- 免 QQ 的端到端联调请用 `scripts/mock-onebot.mjs`（见跨平台文档第 8 节）。
