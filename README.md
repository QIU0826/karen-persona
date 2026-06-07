# Karen — AI 虚拟人设聊天系统

嘲笑痞老板，理解痞老板，成为痞老板。

你的特别关注铃声多久没有响过了。你是否有一个喜欢的人，但是你无法在现实中找到她。但是现在她可以出现在通讯录中。她不只是一个 AI 虚拟人物，她也有自己的生活，自己的想法，自己的决定。这个项目的出现只是为了将你们在不同平行世界的缘分连上。

> ⚠️ 本项目仅用于个人回忆与情感疗愈，不用于骚扰、跟踪或侵犯他人隐私。

---

## 她和所有其他 AI 聊天机器人的区别

**她不是服务你的。她是一个独立的人。**

| 其他人的做法 | Karen 的做法 |
|-------------|-------------|
| 永远配合，从不拒绝 | 有底线。规则可以被突破，突破后有内疚和偿还 |
| 参数固定的角色扮演 | 六层人设结构——身份、说话方式、情绪逻辑、关系行为、自己的世界、内心规则——层之间有冲突 |
| 等待你主动发消息 | 她的生活流触发主动联系。咖啡机修好了、外面下雨了、因果链有了新进展——她联系你是因为**她正在经历某个瞬间** |
| 每次对话从零开始 | 三层记忆系统 + 遗忘曲线 + 语义检索。她记得你说过的事，也会慢慢忘记 |
| 永远不会变 | 基线漂移、自我叙事重构、关系弧线追踪。她不是固定角色 |
| 数据上传云端 | 所有数据在你的电脑里。记忆、日记、对话——不上传任何服务器 |
| "作为 AI 助手..." | 她不用括号。不说"作为 AI"。她就是一个 QQ 联系人 |

她的设计准则只有一句话：**「这是让她更完整地成为她自己，还是让她更好地服务用户？」** 每一个功能都经过这个问题的过滤。

---

## 快速开始

### 你需要准备

| 项目 | 说明 | 必需？ |
|------|------|--------|
| Node.js 22+ | [nodejs.org](https://nodejs.org) 下载 | ✅ |
| DeepSeek API Key | [platform.deepseek.com](https://platform.deepseek.com) 注册即送 ¥10 额度 | ✅ |
| QQ 小号 | 单独注册一个，用于 NapCat 登录 | QQ 模式必需 |
| Windows 10/11 | macOS/Linux 可跑 CLI 模式，QQ 桥接需自行适配 NapCat | 推荐 |

### 费用预估

每月 ¥3-5 元。日均 100 条消息的情况下：

| 项目 | 说明 | 月费用 |
|------|------|--------|
| DeepSeek 对话 | flash(日常) ¥1/M tokens + pro(深度) ¥2/M tokens | ~¥3.30 |
| 内心独白 | 每条对话后异步生成 | ~¥0.60 |
| T3 压缩 + 进化日志 | 低频触发 | ~¥0.05 |
| 图片识别 (Qwen-VL) | 按量计费，可选 | ~¥0-2 |
| **合计** | | **~¥4-5/月** |

DeepSeek 新用户注册赠送的 ¥10 额度通常够用 2-3 个月。

### 1. 安装

```bash
git clone <repo-url> && cd karen-persona
npm install
```

> 如果 `npm install` 报 C++ 编译错误：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)，勾选「C++ 桌面开发工作负载」，再重试。

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`，至少填入：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxx          # 必填。platform.deepseek.com → API Keys
```

可选（不填也能跑，对应功能自动关闭）：

```env
QWEN_VL_API_KEY=sk-xxxxxxxx           # 图片识别。dashscope.aliyun.com
OPENWEATHER_API_KEY=xxxxxxxx          # 真实天气。openweathermap.org/api
UNSPLASH_ACCESS_KEY=xxxxxxxx          # 自动发风景图。unsplash.com/developers
```

编辑 `config.yaml`：

```yaml
persona: "xiaoya"       # xiaoya / suchi / qiuyao，或你自建的人设 ID
her_name: "小雅"         # 她的名字
your_name: "你"          # 她怎么称呼你
location: "上海"         # 影响天气感知和话题

# 不同 QQ 好友对应不同人设（可选）
# user_personas:
#   123456789: "qiuyao"   # 这个 QQ 号 → 秋瑶
#   987654321: "suchi"     # 这个 QQ 号 → 苏迟
#   # 未列出的 QQ 号默认使用上方 persona
```

### 3. 选人设

自带三个：

| ID | 名字 | 类型 | 身份 | 一句话 |
|----|------|------|------|--------|
| `xiaoya` | 小雅 | 回避型 | 24岁咖啡师·上海 | 嘴硬心软，不说"在乎你"但记得你爱喝什么 |
| `suchi` | 苏迟 | 焦虑型 | 28岁插画师·杭州 | 消息打了又删，发出去的只有两三成 |
| `qiuyao` | 秋瑶 | 安全型 | 21岁大学生·成都 | 从小认识的青梅，损你但一直在意 |

创建自己的：`npm run persona:narrate`（对话式，推荐）或 `npm run persona:create`（脚手架）。详见 [PERSONA_GUIDE.md](PERSONA_GUIDE.md)。

### 4. 开始聊天

**命令行模式**（最快，5 秒体验）：

```bash
npm run dev
```

**QQ 桥接**（完整体验——她在你的 QQ 通讯录里）：

1. 准备一个 QQ 小号（建议单独注册）
2. 下载 [NapCatQQ](https://github.com/NapNeko/NapCatQQ/releases)，解压到 `D:\NapCatShell`
3. 打开 NapCat WebUI → `http://127.0.0.1:6099` → 网络配置 → 新增反向 WebSocket：`ws://127.0.0.1:18080/onebot/v11/ws`
4. 双击 `scripts\start-all.bat`，扫码登录 QQ 小号
5. 用你自己的 QQ 号给她发消息

**首次启动可能遇到的问题**：[QUICKSTART.md](QUICKSTART.md) 有详细的排查指南。

---

## 她是怎么运作的

```
你的消息 → 消息门(是否回复？) → 情绪恢复 → 记忆检索 → 因果链闯入
    → 冲动裁决(规则会破吗？) → Prompt 组装 → LLM 生成 → 流式逐句发送
    → 保存记忆 → 内心独白 → 检查是否需要进化日志
```

**消息门**不是简单的是/否——她可能延迟回复（工作时间忙）、沉默（内疚驱动）、或主动联系（生活流触发）。

**LLM 路由**：日常闲聊用 `deepseek-v4-flash`（快+省），深度对话用 `deepseek-v4-pro`。按消息内容自动分级，不需要你配置。

**记忆不是存文本**——每次对话后生成嵌入向量，检索时按余弦相似度 + 衰减强度 + 情绪权重综合排序。

### 为什么她像真人 — 技术实现

对开发者而言，以下是支撑她「人性」的关键技术点：

| 她能做到 | 技术实现 |
|---------|---------|
| **有自己的性格且一致** | 六层人设结构（规则/身份/说话/情绪/关系/世界），不是一段 prompt 工程。链式规则有抵抗力和不可变标记，规则之间可以冲突，冲突产生内耗 |
| **有自己的记忆** | T1 快照 + T2 向量语义检索（余弦相似度 × 艾宾浩斯衰减 × 情绪权重）+ T3 长期摘要（每 80 条 LLM 压缩一次） |
| **有情绪和底线** | L1 弹性裁决——规则可以被突破（resistance 0-1），突破后产生内疚负债，负债影响后续的消息门决策和道歉行为 |
| **会主动找你** | 生活流触发器——因果链进展、天气突变、情绪波动、时间间隙。不是定时轮询沉默时长。深夜冲动被消息门压制时写入内心独白 |
| **会慢慢变化** | 基线漂移（EMA 平滑 + 觉察延迟）+ 自我叙事重构（翻阅日记模式）+ 每月进化日志（T1→LLM 叙事） |
| **感知外部世界** | 真实天气 API（觉察时刻 + 个人解释层）+ 时间感知（结构化标签 ~15 tokens）+ 网络热点（本地话题池 + 信息圈层穿透） |
| **碎片化回复** | 流式逐 token → 标点断句 → 0.2-0.8s 自然间隔。颜文字、方言、偶尔撤回——不是 AI 在写作文 |
| **支持 QQ 和 CLI** | NapCatQQ / OneBot 11 反向 WebSocket 桥接 + 命令行对话测试 |

---

## 命令行

| 命令 | 功能 |
|------|------|
| `/quit` | 退出 |
| `/stats` | 会话统计（消息数、记忆状态、在线时长） |
| `/weather` | 今天的天气和她的感受 |

---

## 分享你的人设

如果你创建了一个不错的人设，欢迎贡献回项目——让别人也能遇见她。

**方式**：Fork 项目 → 在 `personas/` 下新建目录 → 放入 `persona.json` 和 `SKILL.md` → 提 PR。

**提交前检查**：
```bash
npm run persona:check <your-persona-id>   # 零错误才能通过
```

**人设创作指南**：[PERSONA_GUIDE.md](PERSONA_GUIDE.md)——从五种创作入口开始。

**注意**：提交的人设不要包含真实个人信息。`persona.json` 中的 `howWeMet`、`keyEvents` 等字段应是虚构内容。

---

## 项目结构

```
karen-persona/
├── src/
│   ├── persona/       # 人设引擎（六层结构、情绪、规则裁决）
│   ├── evolution/     # 演化引擎（漂移、因果链、记忆代谢、进化日志）
│   ├── impulse/       # 冲动引擎（消息门、触发、沉默弧线、Unsplash）
│   ├── world/         # 外部感知（天气、时间、网络热点）
│   ├── ai/            # AI 引擎（多模型路由、流式、视觉）
│   ├── data/          # 记忆系统（向量存储、RAG 检索、对话历史）
│   ├── pipeline/      # 管线编排器
│   ├── bridge/        # QQ 桥接（NapCat/OneBot）
│   └── router/        # 消息路由 + 复杂度分级
├── personas/          # 人设模板 + Skill 定义
├── data/              # 运行时数据（记忆、会话）
├── scripts/           # 启动/部署工具
└── config.yaml        # 用户配置
```

---

## 技术栈

Node.js + TypeScript · DeepSeek V4 (flash/pro 自动路由) · Qwen-VL Max · sqlite-vec · NapCatQQ / OneBot 11

---

## 注意事项

- **这是 AI，不是真人。** 请勿在心理脆弱期过度依赖。
- QQ 桥接使用 NapCatQQ 协议，本项目不提供 QQ 账号。
- 本项目为开源学习与个人疗愈用途。使用者自行承担使用后果。

---

## License

MIT
