# Windows 部署 NapCatQQ（原生，已验证路径）

> 目标：Windows 10/11 x64 上安装 NapCatQQ，扫码登录 QQ 小号，反向连接本机 Karen 桥接。
> 这是项目原有的验证路径（`scripts/start-all.bat`、`scripts/start-napcat.bat` 按 Windows 编写）。
> 跨平台对比与安全基线见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](../../docs/QQ_BRIDGE_CROSS_PLATFORM.md)。
>
> 当前 NapCat 官方最新版本：**v4.18.38（2026-10-12）**；项目 CLAUDE.md 记录的 Windows 验证版本是 **v4.18.4**。
> 以下链接与日期均为 2026-10-19 核对；两版都可固定使用，升级前先看 release notes。

---

## 1. 前置

- Windows 10/11 **x64**（amd64）。
- 一个**单独的 QQ 小号**（不要用主号；封号风险自担）。
- 本仓库已 `npm install`，`.env` / `config.yaml` 已按第 3 节准备好。
- 从官方安装 QQ NT：https://im.qq.com/ （安装包/OneKey 会自动部署 QQ 的版本以 NapCat 为准）。

---

## 2. 安装 NapCat（二选一）

### 2.1 一键安装（推荐，无需预装 QQ）

1. 打开 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases/latest)，下载 `NapCat.Shell.Windows.OneKey.zip`（当前 v4.18.38）。
2. 解压后运行 `NapCatInstaller.exe`，完成安装进入 `NapCat.XXXX.Shell` 目录。
3. 双击 `napcat.bat` 启动。
   - 想固定目录（脚本默认 `D:\NapCatShell`）：把 `NapCat.XXXX.Shell` 改名/移动到 `D:\NapCatShell`，
     或改 `scripts/start-napcat.bat` / `scripts/start-all.bat` 里的 `NAPCAT_DIR`。

### 2.2 手动安装（已装 QQ）

1. 安装 QQ（Windows 版），下载 `NapCat.Shell.zip` 并解压到任意目录（如 `D:\NapCatShell`）。
2. 双击 `launcher.bat`（Windows 10 用 `launcher-win10.bat`）。
3. 按控制台提示登录 QQ、打开 WebUI。快速登录：`launcher.bat 123456789`。
4. `scripts/start-napcat.bat` 默认指向 `D:\NapCatShell`，不符时修改该脚本。

---

## 3. 配置 Karen（宿主机）

```dotenv
# .env（与 config.yaml 冲突时 config.yaml 优先）
ONE_BOT_HOST=127.0.0.1
ONE_BOT_WS_PORT=18080
ONE_BOT_WS_PATH=/onebot/v11/ws
ONE_BOT_TOKEN=<openssl rand -hex 24 生成的随机串>
ALLOWED_USERS=<你自己的 QQ 号>
```

启动：项目根目录执行 `npm run qq`（或双击 `scripts/start-all.bat`，它会先起 NapCat 再起 Karen）。

---

## 4. 扫码登录 + 反向 WS 配置

1. NapCat 启动后，控制台会输出 WebUI 地址，默认 **http://127.0.0.1:6099/webui**（带 token 参数）。
   丢失时看 NapCat 目录下 `config\webui.json` 的 `port` / `token`。
2. 浏览器打开 WebUI → **QQ 登录 → QRCode** → 手机 QQ 小号扫码。
   - 首次登录可能要求修改 WebUI 密码；WebUI 只在本机使用，不要把 6099 映射到公网。
3. **网络配置 → 新建 → WebSocket 客户端**：

   | 字段 | 值 |
   |---|---|
   | 名称 | `karen` |
   | URL | `ws://127.0.0.1:18080/onebot/v11/ws` |
   | Token | 与 `.env` 的 `ONE_BOT_TOKEN` 一致 |
   | 消息格式 | `array`（默认） |
   | 保存时启用 | ✅ |

4. 顺序：先 `npm run qq`，再让 NapCat 连接（NapCat 会自动重连，顺序反了也会自己连上）。
5. 用你自己的 QQ 给小号发私聊。Karen 日志正常形态：

   ```
   [WS] 监听 ws://127.0.0.1:18080/onebot/v11/ws
   [WS] 连接: /onebot/v11/ws (活跃: 1)
   [收到] 你的昵称 (123456789): 6 字
   [回复] -> 你的昵称: 4 字
   ```

---

## 5. 开机自启（可选）

- 把 `scripts\setup-startup.bat` 的快捷方式放进启动文件夹（`Win+R` → `shell:startup`）。
- 或用 PM2 守护 Karen：`npx pm2 start ecosystem.config.js && npx pm2 save`，再 `npx pm2 startup` 注册开机自启。
- 托盘图标（可选）：`powershell -WindowStyle Hidden -File scripts\tray.ps1`。

> 注意：Karen 的掉线桌面通知（`notifyWindows`）是 Windows 独有的 PowerShell 通知；macOS 没有等价实现。
> 已知：`scripts/start-*.bat` 里的 `D:\NapCatShell` 是硬编码路径，换目录/换机器时要改。

---

## 6. 故障排查

| 现象 | 处理 |
|---|---|
| Karen 一直「等待 NapCatQQ 连接」 | NapCat 是否已扫码登录；URL/端口/path/token 四处是否一致；`netstat -ano \| findstr :18080` 查端口占用 |
| NapCat WebUI 打不开 | 6099 被占用时会自动 +1，看启动日志实际端口；或 `config\webui.json` 改端口 |
| `[WS] 拒绝握手：token 校验失败` | 两侧 token 不一致（WebUI 网络配置 vs `.env`） |
| `[WS] 拒绝握手：路径不匹配` | URL 必须为 `/onebot/v11/ws` |
| 消息发出但没有回复 | 你的 QQ 不在 `ALLOWED_USERS`（静默忽略）；或触发频率限制；或处于 23:00–07:00 睡眠时段延迟回复 |
| QQ 频繁掉线 | 风控/异地登录；按官方安全建议换小号/换网络，更新 NapCat 到适配版本 |
| Windows Defender/防火墙弹窗 | 只允许本机回环即可；**不要**放行公网入站 6099/18080 |

---

## 7. 版本锁定

- 固定 NapCat release（当前 `v4.18.38`），升级前看 release notes 是否适配当前 QQ 版本。
- **不要开 QQ 自动更新**；升级顺序：确认 NapCat 支持 → 升 NapCat → 再升 QQ。
- 升级前备份 `napcat\config\`（含 `onebot11_<QQ号>.json`、`webui.json`）与项目 `data\`。
- 卸载 NapCat：Windows 下删除 NapCat 目录即可（官方安全文档：不会残留、不影响 QQ 更新/卸载）。

---

## 8. 验证状态

- 该路径是项目原有验证路径；本次跨平台改造**未**重新实机验证（本机为 macOS）。
- 免 QQ 链路可用 `node scripts/mock-onebot.mjs` 在启动 NapCat 之前先验证 Karen 侧：
  ```bash
  npm run qq
  node scripts/mock-onebot.mjs --token "<ONE_BOT_TOKEN>" --text "你好呀" --seconds 60
  ```
- 详见 [docs/QQ_BRIDGE_CROSS_PLATFORM.md](../../docs/QQ_BRIDGE_CROSS_PLATFORM.md) 第 8 节。
