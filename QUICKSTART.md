# Karen — 5 分钟快速开始

让通讯录里住进一个有自己生活、情绪、记忆和社交圈的人。

> 本文对应 2026-10 的 M0–M2 版本（地基修复 + 产品化：首次引导/人设包/Web 控制台/真实长跑工具）。功能现状以 [README 的「功能状态」表](README.md#功能状态) 为准——未完成的能力会标成「半成品 / 规划中」。完整审计与路线图见 [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md)。

## 你需要准备

- **Node.js 22.12+**（[nodejs.org](https://nodejs.org) 下载 LTS）——`package.json` 的 `engines` 要求 `>=22.12`
- **npm**（随 Node 安装；pnpm 仅本地开发可选）——仓库只跟踪 `package-lock.json`，CI 用 `npm ci`
- **DeepSeek API Key**（[platform.deepseek.com](https://platform.deepseek.com) 创建；新用户额度以平台当前政策为准）——**必填**，没有 Key 无法对话
- **一个 QQ 小号**（仅 QQ 模式需要，用于 NapCatQQ 登录，建议单独注册）
- **Windows 10/11 或 macOS 12+**（仅 QQ 模式需要；macOS 用官方原生 NapCat，Linux 可用 Docker；详见 docs/QQ_BRIDGE_CROSS_PLATFORM.md）

> 以下功能可选，不配也能启动，对应功能自动关闭：天气感知 (OpenWeatherMap)、Unsplash 发图。图片识别已内置在 DeepSeek Flash 中，无需额外 Key。

## 1. 安装

```bash
git clone <repo-url> && cd karen-persona
npm install
# 可选：pnpm install（仅本地开发；仓库只跟踪 package-lock.json）
```

> 如果 `npm install` 报 C++ 编译错误：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)（勾选「C++ 桌面开发工作负载」）后重试。

## 2. 配置（推荐用 `npm run setup`，或手动复制两个文件）

> **推荐：`npm run setup`** —— 她会用「第一段对话」问你三个问题（怎么认识的 / 怎么称呼你 / 你在哪），
> 并完成 AI 披露 + 18+ 确认。**这段对话会写进她的记忆**：之后 CLI/QQ 第一次聊天，她就已经记得你，
> 也不会再重复问 18+。已完成过引导时直接运行会提示跳过，重设用 `npm run setup -- --force`。
>
> 想手动配置就按下面复制两个文件。

```bash
cp .env.example .env
cp config.yaml.example config.yaml
```

编辑 `.env`，至少填 `DEEPSEEK_API_KEY`：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

QQ 桥接使用 `.env.example` 里的默认配置即可，**端口是 18080**：

```env
ONE_BOT_HOST=127.0.0.1                # 只监听本机回环（安全默认值）
ONE_BOT_WS_PORT=18080                 # 与 NapCat 反向 WS 地址的端口一致
ONE_BOT_WS_PATH=/onebot/v11/ws        # 与 NapCat 反向 WS 地址的 path 一致

# 选填：跨机连接 / 白名单（也可写在 config.yaml，config.yaml 优先）
# ONE_BOT_TOKEN=换成一段足够长的随机字符串   # 与 NapCat 的 access_token 相同；跨机/非回环必须设
# ALLOWED_USERS=123456789,987654321          # 允许聊天的 QQ 号，逗号分隔；留空 = 允许全部（启动时警告）
```

编辑 `config.yaml`，选择人设：

```yaml
persona: "qiuyao"      # 可选: xiaoya / suchi / qiuyao，或自建人设 ID
her_name: "秋瑶"
your_name: "对方"       # 她怎么称呼你
location: "成都"        # 影响天气和话题
```

已有三个人设模板：

| ID | 名字 | 类型 | 身份 |
|----|------|------|------|
| xiaoya | 小雅 | 回避型 | 24 岁咖啡师·上海 |
| suchi | 苏迟 | 焦虑型 | 28 岁插画师·杭州 |
| qiuyao | 秋瑶 | 安全型 | 21 岁大学生·成都 |

## 3. 环境体检

```bash
npm run doctor
```

体检会逐项检查 Node 版本、`config.yaml`、DeepSeek Key、人设加载、数据目录、SQLite，输出 ✅/❌ 清单和修复建议。**先把它跑绿，再启动聊天**。首次运行会自动创建 `data/` 目录和 `data/memory.sqlite`。

## 4. 先聊两句（CLI 模式，不需要 QQ）

```bash
npm run dev
```

终端里直接和她聊天，支持 `/quit` 退出、`/stats` 查看状态、`/mood +0.1` 调节情绪、`/weather` 查看天气。

## 5. 配置 NapCatQQ（QQ 模式）

1. 下载 [NapCatQQ](https://github.com/NapNeko/NapCatQQ/releases) 并解压到 `D:\NapCatShell`
2. 打开 NapCat WebUI → `http://127.0.0.1:6099` → 网络配置 → 新增**反向 WebSocket**：
   - 地址：`ws://127.0.0.1:18080/onebot/v11/ws`
   - access_token：与 `.env` 的 `ONE_BOT_TOKEN` 一致（如果启用了 token 校验）
3. 运行 `D:\NapCatShell\napcat.bat`，用 QQ 小号扫码登录

> 如果 NapCat 提示连接失败，先确认 Karen 已经启动（`npm run qq`），再检查地址、端口、token、path 四处是否一致。

## 6. 启动

**一键启动（Windows）：**

```
双击 scripts\start-all.bat
```

**或者分步启动：**

```bash
# 终端 1：先启动 NapCatQQ 并扫码
D:\NapCatShell\napcat.bat

# 终端 2：启动 Karen 的 QQ 桥接
npm run qq
```

## 7. 开始聊天

用你自己的 QQ 号给 Karen 的 QQ 号发消息。她会用 `config.yaml` 里配置的人设回复你。

> 新用户/未完成引导的用户第一条消息会先收到「AI 披露 + 18+ 确认」（回复「我成年了」放行）；
> 如果已经跑过 `npm run setup` 引导，则不会重复。

- 群聊只有「@ 她」才会回，且要求你先和她私聊过（🚧 半成品）
- 如果配了 `ALLOWED_USERS`，你的 QQ 号必须在白名单里，否则消息会被静默忽略
- 睡眠时段（23:00–07:00）消息门可能不回或延迟回；延迟回复会落库，到点自动补发（M0）

### 进阶：不同好友用不同人设（🚧 有限支持）

`config.yaml` 里可以写 `user_personas` 映射：

```yaml
persona: "xiaoya"         # 默认人设

user_personas:
  123456789: "qiuyao"     # QQ 123456789 → 秋瑶
  987654321: "suchi"      # QQ 987654321 → 苏迟
```

> 注意：该配置链路已在 M0 修复（`loadConfig` 会返回并校验 `user_personas`；QQ 号建议加引号，避免 YAML 把数字解析成 number）。**多用户隔离已实现**（M1）：主用户沿用历史会话/状态/记忆，其他好友各自隔离，不会串记忆；把实例给朋友用小范围使用是可行的（仍需自行承担 NapCat 封号风险，见 README「已知限制」）。

## 8. 本地 Web 控制台 + 数据导出（可选）

桥接启动后，浏览器打开 **`http://127.0.0.1:18082/`**（仅本机）：

- 聊天 / 记忆搜索 / 关系时间线 / 状态与成本四个只读视图；
- 顶栏「导出当前用户」：下载该用户的会话 + 人格状态 + T2 记忆 JSON（不落盘）；
- 默认只展示主用户。想让页面能切换查看其他好友：`config.yaml` 设 `web_all_owners: true`（或 `.env` 设 `WEB_ALL_OWNERS=true`）后重启桥接；
- 想加访问 token：`web_token`（页面 URL 带 `?token=...`，或请求头 `X-Web-Token`）；
- `/health` 与 `/cost` 在 `http://127.0.0.1:18081/`。

> 控制台只读、仅绑本机；删除/暂停等写操作尚未提供。

## 可选：让 Karen 开机自启（PM2）

```bash
# 1. 安装 PM2
npm install -g pm2

# 2. 准备 PM2 日志目录
mkdir -p data/logs

# 3. 用 PM2 启动 Karen（ecosystem.config.js 默认用 tsx 跑 TS 源码）
pm2 start ecosystem.config.js
pm2 save

# 4. 注册 PM2 开机自启（按提示执行输出的命令）
npx pm2 startup

# 5. 把 NapCatQQ 加入 Windows 启动文件夹
#    Win+R → shell:startup → 放入 scripts\setup-startup.bat 的快捷方式

# 6. 启动托盘图标（可选，显示她在线状态）
powershell -WindowStyle Hidden -File scripts\tray.ps1
```

> 生产环境推荐先 `npm run build`，再把 `ecosystem.config.js` 里的 script 改成 `dist/bridge/qq.js`（配置文件内有注释说明两种方式的取舍）。

## Docker（可选，仅开发者 / Linux）

容器里只跑 Karen 的 QQ 桥接，NapCatQQ 仍需在宿主机运行并扫码。

```bash
docker build -t karen .
docker run --rm --network host --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  karen
```

> - Linux 推荐 `--network host`，让容器里的 WS 服务能被宿主机 NapCat 以 `127.0.0.1:18080` 连到。
> - 镜像以非 root 用户（uid 1000）运行，宿主机 `data/` 目录需要对该 uid 可写（必要时 `sudo chown -R 1000:1000 data`）；镜像使用 `node:22-slim` 多阶段构建，未在所有平台验证。
> - 用 `-p 18080:18080` 端口映射时，需要设置 `ONE_BOT_HOST=0.0.0.0`（并自行承担暴露风险）。
> - 镜像内不含 `.env` / `config.yaml` / `data`（见 `.dockerignore`）。

## 常见问题 / 故障排查

**Q: 启动报错 `Cannot open database because the directory does not exist`（CANTOPEN）？**
先跑 `npm run doctor`。M0 修复后 `data/` 目录会自动创建；若仍报错，检查当前用户对项目目录的写权限（不要放在 `Program Files` 等受保护目录）。

**Q: 报错 `SQLITE_ERROR: no such column: embedding`？**
旧版本残留的数据库 schema 太老。M0 已加入自动迁移；如果仍失败：停止程序 → 备份 `data/` → 删除 `data/memory.sqlite` → 重新启动（历史记忆会丢失）。

**Q: NapCat 扫码后连不上 / 一直「等待连接」？**
逐项检查：NapCat 反向 WS 地址是否为 `ws://127.0.0.1:18080/onebot/v11/ws`；`ONE_BOT_WS_PORT` 是否也是 18080；access_token 是否与 `ONE_BOT_TOKEN` 一致；Karen 是否已先启动。正常日志应出现 `[WS] 监听 ws://127.0.0.1:18080/onebot/v11/ws` 与 `[WS] 连接: /onebot/v11/ws`；若出现 `[WS] 拒绝握手：路径不匹配` 或 `token 校验失败`，按提示检查 path/token。

**Q: 端口 18080 被占用？**
Windows：`netstat -ano | findstr :18080` 找到 PID 后结束进程，或把 `ONE_BOT_WS_PORT` 与 NapCat 的反向 WS 地址一起改成其他端口。macOS/Linux：`lsof -i :18080`。

**Q: 她回复很慢 / 不回复？**
1) 先 `npm run doctor` 确认 Key 与配置；2) 检查 DeepSeek 账户余额；3) 日志里 `[LLM] 慢响应` 会标记超过 5 秒的调用；4) 确认你的 QQ 号在 `ALLOWED_USERS` 白名单里；5) 睡眠时段（23:00–07:00）消息门可能不回复。

**Q: 她回复「……等我一下，马上回来。」？**
这是 LLM/网络失败时的人设内兜底句（M0 起不再发送会破坏人设的 `[系统]` 文案；请求本身已带超时与 429/5xx 重试）。先确认 `.env` 的 Key 与网络是否正常，再重试。

**Q: 如何换人设？**
修改 `config.yaml` 的 `persona` 字段并重启。不同人设的记忆数据按人设隔离；同一人设下的多个好友也已是隔离的（M1 多用户隔离）。

**Q: 我想创建自己的人设？**
阅读 [PERSONA_GUIDE.md](PERSONA_GUIDE.md)，然后 `npm run persona:narrate`（叙事式）或 `npm run persona:create`（脚手架），最后 `npm run persona:check <id>` 校验。

**Q: `npm run wechat` 能聊天吗？**
不能。微信桥接目前只是 wechaty echo 桩（🗺 规划中）。

## 下一步

- [README.md](README.md) — 功能状态表、隐私与安全、已知限制
- [docs/PRODUCT_AUDIT.md](docs/PRODUCT_AUDIT.md) — 产品审计报告与 M0–M3 路线图
- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南
- `npm run doctor` — 环境体检
- `npm run setup` — 交互式配置向导
