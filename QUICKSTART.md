# Karen — 5 分钟快速开始

让通讯录里住进一个有自己生活、情绪、记忆和社交圈的人。

## 你需要准备

- **一个 QQ 小号**（用于 NapCatQQ 登录，建议单独注册）
- **DeepSeek API Key**（[platform.deepseek.com](https://platform.deepseek.com) 注册即送额度）
- **Node.js 22+**（[nodejs.org](https://nodejs.org) 下载）
- **Windows 10/11**（macOS/Linux 需要更换 QQ 桥接方案）

> 以下功能可选，不配也能跑：图片识别 (Qwen-VL)、天气感知 (OpenWeatherMap)、Unsplash 发图

## 1. 安装依赖

```bash
cd karen-persona
npm install
```

## 2. 配置 API Key

```bash
copy .env.example .env
```

编辑 `.env`，至少填 `DEEPSEEK_API_KEY`：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

## 3. 选择或创建人设

`config.yaml` 中指定人设：

```yaml
persona: "qiuyao"      # 可选: xiaoya / suchi / qiuyao
your_name: "对方"       # 她怎么称呼你
location: "成都"        # 影响天气和话题
```

已有三个人设模板：
| ID | 名字 | 类型 | 身份 |
|----|------|------|------|
| xiaoya | 小雅 | 回避型 | 24岁咖啡师·上海 |
| suchi | 苏迟 | 焦虑型 | 28岁插画师·杭州 |
| qiuyao | 秋瑶 | 安全型 | 21岁大学生·成都 |

## 4. 配置 NapCatQQ

1. 下载 [NapCatQQ](https://github.com/NapNeko/NapCatQQ/releases) 并解压到 `D:\NapCatShell`
2. 修改 NapCat 的 WebUI 配置，添加反向 WebSocket 客户端：
   - 地址：`ws://127.0.0.1:18080/onebot/v11/ws`
3. 运行 `D:\NapCatShell\napcat.bat`，用 QQ 小号扫码登录

## 5. 启动

**一键启动：**
```
双击 scripts\start-all.bat
```

**或者分步启动：**
```bash
# 终端 1: 先启动 NapCatQQ 并扫码
D:\NapCatShell\napcat.bat

# 终端 2: 启动 Karen
npm run qq
```

## 6. 开始聊天

用你自己的 QQ 号给 Karen 的 QQ 号发消息。她会用你配置的人设回复你。

### 进阶：不同好友用不同人设

如果你有多个 QQ 好友想和 Karen 聊天，你可以让不同的人遇到不同的她。编辑 `config.yaml`：

```yaml
persona: "xiaoya"         # 默认人设（未在下方列出的 QQ 号都用这个）

user_personas:
  123456789: "qiuyao"     # QQ 123456789 → 秋瑶（青梅竹马）
  987654321: "suchi"      # QQ 987654321 → 苏迟（插画师网友）
  # 你自己在这加更多映射
```

每个人设的记忆数据完全隔离——秋瑶不会知道你和小雅聊过什么。

## 可选：让 Karen 开机自启

```bash
# 1. 安装 PM2
npm install -g pm2

# 2. 用 PM2 启动 Karen
pm2 start ecosystem.config.js
pm2 save

# 3. 注册 PM2 开机自启
npx pm2 startup

# 4. 把 NapCatQQ 加入 Windows 启动文件夹
# Win+R → shell:startup → 放入 scripts\setup-startup.bat 的快捷方式

# 5. 启动托盘图标（可选，显示她在线状态）
powershell -WindowStyle Hidden -File scripts\tray.ps1
```

## CLI 模式（不连 QQ，终端聊天）

```bash
npm run dev
```

## Docker（可选，仅限开发者/Linux）

如果你不想在本机装 Node.js，可以用 Docker 只跑 Karen bridge：

```bash
docker build -t karen .
docker run \
  -v ./data:/app/data \
  -v ./.env:/app/.env \
  -v ./config.yaml:/app/config.yaml \
  --network host \
  karen
```

> ⚠️ NapCatQQ 仍需在宿主机运行并扫码登录。`--network host` 让容器能访问宿主机的 `127.0.0.1:18080`。

## 常见问题

**Q: NapCat 扫码后连不上？**
检查 NapCat WebUI 的反向 WS 地址是否配置为 `ws://127.0.0.1:18080/onebot/v11/ws`

**Q: 她回复很慢？**
检查 DeepSeek API 是否欠费。日志中 `[LLM] 慢响应` 会标记超过 5 秒的调用。

**Q: 如何换人设？**
修改 `config.yaml` 的 `persona` 字段，重启即可。不同人设的记忆数据是隔离的。

**Q: 我想创建自己的人设？**
阅读 `PERSONA_GUIDE.md`，然后 `npm run persona:create`。

## 下一步

- [PERSONA_GUIDE.md](PERSONA_GUIDE.md) — 人设创作指南
- [CLAUDE.md](CLAUDE.md) — 项目架构和设计哲学
- `npm run persona:check` — 校验人设文件
- `npm run setup` — 交互式配置向导
