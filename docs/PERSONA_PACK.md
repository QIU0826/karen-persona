# 人设包 v2（Persona Pack）

> 状态：**可用**（M2-B，2026-10-20）。目录格式，暂不支持 zip（避免引入解压依赖）。
> 目标：让「她是谁」成为可校验、可安装、可分享的资产；记忆种子可选。

## 1. 包结构

```
my-persona/
├─ manifest.json          # 必需：包元信息
├─ persona.json           # 必需：六层人设（schemaVersion 必须匹配当前引擎）
├─ SKILL.md               # 可选：她的自述
├─ persona.md             # 可选：历史格式说明
├─ assets/                # 可选：头像/贴纸/生活照
│  ├─ avatar.png
│  └─ ...
└─ memories/
   └─ seed.jsonl          # 可选：记忆种子（3–20 条；安装时 --with-seeds 才写入 T2）
```

## 2. manifest.json

```json
{
  "id": "my-persona",
  "version": "1.0.0",
  "name": "我的她",
  "personaSchemaVersion": 1,
  "minEngineVersion": "0.1.0",
  "author": "你的名字",
  "license": "CC-BY-4.0",
  "description": "一句话介绍"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 安装目录名：小写字母/数字/下划线/短横线，≤64；安装到 `personas/<id>` |
| `version` | ✅ | 语义化版本（如 1.0.0） |
| `name` | 可选 | 展示名（缺省读 persona.json 的 name） |
| `personaSchemaVersion` | ✅ | 必须等于当前引擎 `CURRENT_SCHEMA_VERSION`（当前 1），否则拒绝安装 |
| `minEngineVersion` | 可选 | 最低引擎版本；当前 0.1.0，低于它拒绝安装 |
| `author` / `license` / `description` | 可选 | 展示/分发信息 |

## 3. 素材（assets/）

- 允许：`png / jpg / jpeg / webp / gif / mp4`；其他类型只给 warning（安装后不会自动使用）；
- 单文件 ≤ 10MB，总大小 ≤ 40MB，文件数 ≤ 30；
- 素材不会被代码自动引用（当前引擎的头像/贴纸路径仍来自 `assets/` 仓库目录）；包里素材主要用于分发/后续版本接入。

## 4. 记忆种子（memories/seed.jsonl）

每行一个 JSON 对象，安装时**默认不写库**，加 `--with-seeds` 才写入 T2（persona_id = 包 id）：

```jsonl
{"content":"用户说他叫林哲","source":"chat","emotionalWeight":0.2}
{"content":"用户养了一只橘猫叫团子","source":"chat"}
{"content":"用户最近在做的项目是咖啡包装","source":"event"}
```

- `content`（必需）：一段可被检索的记忆（建议写成自然片段，≤500 字）；
- `source`（可选）：`chat / event / causal_chain / user_trace / internal_monologue`，缺省 `chat`；
- `emotionalWeight`（可选）：0–1，缺省 0；
- 条数：3–20（<3 警告，>20 拒绝）。这是为了避免「安装一个人设就污染你的记忆库」，且安装的人设在不同 owner 下共享记忆前请自行评估隐私。

## 5. 命令

```bash
# 校验（不写任何文件；exit 0=通过，1=失败）
npm run persona:pack:validate -- ./my-persona

# 安装到 personas/<id>（默认不覆盖、不写种子）
npm run persona:pack:install -- ./my-persona

# 覆盖已安装版本（旧目录备份到 personas/.backups/），并写入记忆种子
npm run persona:pack:install -- ./my-persona --force --with-seeds

# 列出已安装人设（legacy = 没有 manifest 的历史人设）
npm run persona:pack:list
```

安装后：把 `config.yaml` 的 `persona` 改成包 id（或重跑 `npm run setup` 时选择），并重启 bridge 生效。

## 6. 做一个人设包（最小步骤）

1. 复制一个现有人设作为底模：`cp -R personas/xiaoya my-persona`；
2. 改 `persona.json`（id 不必等于目录名，manifest.id 才是安装名）；
3. 在根目录新增 `manifest.json`（见上）；
4. 可选：放 `assets/`、`memories/seed.jsonl`；
5. `npm run persona:pack:validate -- ./my-persona` 直到通过；
6. 分享目录（或打 tar/zip 由对方解压后安装）。

## 7. 已知限制（如实）

- 只支持目录安装，zip/tar 解压未做；分发需对方自己解压；
- 校验只保证**结构/引擎兼容**，不判断人设质量、版权、NSFW 内容；公开分发前的审核属 M3；
- 素材不会自动接进头像/贴纸/图库路径；
- 安装只写 `personas/`（可选写 T2 种子）；不会自动改 `config.yaml`；
- 多用户场景下，人设是「她的身份」，记忆仍按 owner 隔离（安装的人设不会共享用户记忆）。
