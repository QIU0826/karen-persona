# karen 本地向量服务

P1（v0.5）用的本地 embedding / rerank 服务。**独立进程**，Node 侧只走 HTTP，不引入原生 npm 依赖。

## 为什么独立进程

- 主仓库 `.npmrc` 设了 `ignore-scripts=true`（避免 better-sqlite3 的 node-gyp），
  带 postinstall 的原生包容易装不上；Python 侧用 `uv` 管理依赖，干净、可清理。
- 模型只在这里加载；服务挂掉时 Node 侧自动降级回字符 n-gram（聊天永不阻塞）。

## 目录约定（便于清理）

| 内容 | 位置 | 清理 |
|---|---|---|
| Python 依赖 | `uv` 缓存（`~/Library/Caches/uv`） | `uv cache clean` |
| 模型权重 | `KAREN_MODELS_DIR`（默认 `~/Library/Application Support/karen/models`） | `npm run models:purge` |
| 本服务代码 | 仓库 `services/embed/`（很小） | 直接删 |

## 启动

```bash
# 首次会自动下载模型（bge-m3 ≈ 1.2GB ONNX / Qwen3-Embedding-0.6B ≈ 0.6GB）
cd services/embed
uv run --with fastapi --with uvicorn --with fastembed server.py
# 默认监听 127.0.0.1:18083
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `KAREN_EMBED_PORT` | 18083 | 监听端口（只绑 127.0.0.1） |
| `KAREN_EMBED_MODEL` | `BAAI/bge-m3` | 也可填 `Qwen/Qwen3-Embedding-0.6B` |
| `KAREN_MODELS_DIR` | `~/Library/Application Support/karen/models` | 模型缓存根目录 |
| `KAREN_EMBED_DIM` | 0（模型默认） | 强制输出维度（配合 MRL 截断） |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, model, dim, device}` |
| POST | `/embed` | `{"texts":["..."]}` → `{"vectors":[[...]], "dim":768}` |
| POST | `/rerank` | `{"query":"...","candidates":["..."]}` → `{"scores":[0.9,...]}` |

## 状态

- 这是 **P1 骨架**：接口与目录约定已定，Node 侧客户端（`src/data/local-embed.ts`）在 v0.5 实现。
- 模型选型（bge-m3 vs Qwen3-Embedding-0.6B）在 P1 第一天用 40 条记忆金标做 spike 决定：
  维度是否要 1024（需重建 `t2_vec`）还是 768（零迁移）。
