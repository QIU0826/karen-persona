# 本地生图（v0.7）

> 目标：让她的照片不总是那 15 张图库——大约 20% 的照片由本机生成（"她此刻拍的"），其余仍用图库。
> 代码：`src/media/comfyui.ts`（客户端 + 提示词构造）、`src/media/generated-store.ts`（生成物治理）、`src/impulse/unsplash-trigger.ts`（接入照片链路）。

> **2026-10-22 复验**：本机 `npm run image:start` 后，`image:smoke` 全过（真出图 / PNG 合法 / 可复现 / 落盘），热态单张 **2.6s**（832×1216，MPS）；服务 `/health` loaded=true。

## 1. 为什么不是 ComfyUI 而是 diffusers

原计划用 ComfyUI（GitHub 140k★，GPL-3.0，进程外调用）。实测**本机到 GitHub 只有 ~17KB/s**，
`git clone` 一晚上都下不完；而同线路 PyPI 有 **2MB/s**、HuggingFace 峰值 **31MB/s**（间歇可用）。

于是改成：**`services/image/` + diffusers + PyTorch MPS**，自己暴露一个极简 HTTP 接口。
效果等价（本机出图、无 API Key），依赖走 PyPI，模型走 HF。

| 方案 | 结论 |
|---|---|
| ComfyUI（GitHub clone） | ❌ 克隆 17KB/s，不可行（代码保留兼容后端，`KAREN_IMAGE_BACKEND=comfyui` 可切回去） |
| **diffusers 服务（采用）** | ✅ torch 2.14.1 + MPS 可用、diffusers 0.41.0 装好；模型下载受 HF 间歇性影响，见 §5 |
| 云端 API | 未采用（用户选了本机） |

## 2. 目录约定（你要求的"好清理"）

| 内容 | 位置 | 清理方式 |
|---|---|---|
| Python 环境 | `services/image/.venv/`（约 2–3GB） | 删目录 |
| 模型缓存 | `$KAREN_MODELS_DIR/hf`（默认 `~/Library/Application Support/karen/models/hf`） | `npm run models:purge` 或删目录 |
| 生成图 | `$KAREN_DATA_DIR/generated/YYYY-MM-DD/` | 30 天自动清理；`npm run media:purge -- --images --yes` |

`npm run media:status` 会打印：开关、服务地址、程序/模型/生成图各自占用、uv 是否可用。

## 3. 开关

```bash
# 启用生成（默认关：只用图库）
KAREN_IMAGE_GEN=on
# 后端（默认 service=diffusers；comfyui 为兼容保留）
KAREN_IMAGE_BACKEND=service
# diffusers 服务地址（默认 127.0.0.1:18084）
KAREN_IMAGE_URL=http://127.0.0.1:18084
```

生成失败（服务没起/超时/太大/模型没加载）**一律静默回退图库**，不会阻塞聊天。

## 4. 行为

- 普通聊天里约 **20%** 的照片由生成；**用户点名要照片时不赌概率**，直接尝试生成（他要看"现在的"）。
- 提示词由 `buildScenePrompt` 拼：场景标签（晚霞/咖啡/雨/猫…）→ 具体画面 + 时段光线 + 情绪色调 +
  **手机随手拍质感**；刻意不放 `masterpiece/best quality` 这类 AI 味词。
- 负面提示词压制：文字水印、多余手指、卡通/3D 感。
- 生成图写在 `data/generated/日期/`，30 天后自动清理。

## 5. 当前状态（2026-10-21 v0.8.23：已跑通）

- ✅ 代码、测试、目录治理、接入照片链路、降级路径全部完成；
- ✅ `torch 2.14.1` + MPS、`diffusers 0.41.0`、服务 `/health` 正常；
- ✅ **模型已下载并可真实出图**（`stabilityai/sdxl-turbo` fp16，832×1216）；
- ✅ `scripts/image-smoke.ts` 真实链路冒烟全过：PNG 合法 / 同 seed 可复现 / 换 seed 不同图 /
  落盘与清理正常 / 产品路径 `trySharePhoto` 返回 `source=generated`；
- ✅ mock 桥接长跑（6 轮，真实 DeepSeek）里**真的发出 2 张生成图**（报告 §4b 可查）。

### 实测性能（M5 Pro，MPS）

| 场景 | 耗时 |
|---|---|
| 服务首次请求（含加载模型） | ≈12s |
| 热态单张（1 step / 832×1216） | **2.1–2.2s** |
| 单张体积 | 1.6–1.8MB（上限 4MB） |

### 模型下载（本机可复现的方法）

直连 HuggingFace 不通、`huggingface_hub` 默认走 **Xet CDN（us.aws.cdn.hf.co）也不可达**；
`hf-mirror.com` 可用但**单连接会被限速**（约 0.3–0.7MB/s，5GB 要 2 小时以上）。

最终做法（已写进 `docs/IMAGE_GEN.md` 顶部「为什么不是 ComfyUI」同一思路）：

1. **只下载配置文件与 fp16 小权重**：`HF_ENDPOINT=https://hf-mirror.com snapshot_download(... allow_patterns=['*.json','*.txt','*fp16*'])`
   （Xet 只影响大文件；小文件走 HTTP 正常）。
2. **unet fp16（5.14GB）用分块并发 curl 下载**：每块 128MB、4 路并发、失败重试，
   实测聚合 ~2–4MB/s，约 40 分钟；写完按顺序拼进本地模型目录。
3. 把配置/编码器/VAE/分词器从 HF 快照**解引用复制**到本地模型目录
   `~/Library/Application Support/karen/models/sdxl-turbo/`（1.7GB）。
4. 用本地目录启动服务（`npm run image:start`）：显式 `KAREN_IMAGE_MODEL=<本地目录>` +
   `HF_HUB_OFFLINE=1`，避免回源卡住。

下载脚本可参考本轮记录（`/tmp/dl-unet-par.py` 思路）；核心是 **禁用 Xet + 短连接分块**。

### 启用

```bash
# .env
KAREN_IMAGE_GEN=on
KAREN_IMAGE_BACKEND=service
KAREN_IMAGE_URL=http://127.0.0.1:18084

# 启动服务（首次请求加载模型约 10s）
npm run image:start

# 验证真实链路（会真的出图、落盘、并走一遍产品路径）
npm run image:smoke
```

服务没起/模型没加载/超时 → **静默回退图库**，不影响聊天。

## 6. 局限

- 没有角色一致性（未接 IP-Adapter / 参考图），所以生成图多为"场景/氛围照"，不放正脸；
  要拍到"她本人"需要后续接参考图条件（v0.8 之后再评估）。
- 实测单张 **2.1–2.2s**（热态，MPS，832×1216），首次请求含加载 ≈12s；代码上限 25s，超时回退。
- 服务需手动启动（`npm run image:start`）；未启动/加载失败时**静默回退图库**，聊天不受影响。
- GPU 只有 MPS（M5 Pro），并发下会互相拖慢；因此一次只生成一张，不做批量。

## 7. 本地图库扩充：用本机生图补场景（v0.9.11）

长期问题是本地图库只有 15 张、同类场景重复。v0.9.11 用本机 SDXL-Turbo 生成 5 张补高频场景
（无人物/无文字/无水印，已逐张目检）：

| 文件 | 场景 | prompt（seed 42, 800×600, steps 4） |
|---|---|---|
| `latte-tulip.jpg` | 拉花特写 | a tulip latte art in a ceramic cup on a wooden cafe counter, warm morning sunlight, slight film grain, phone photo, no people, no text |
| `cafe-quiet.jpg` | 空店午后 | interior of a small cozy coffee shop in the afternoon, empty wooden tables, plants by the window, soft daylight, film photo, no people, no text |
| `cat-sunbeam.jpg` | 猫晒太阳 | an orange tabby cat lying in a warm sunbeam on a wooden floor, cozy home, slight film grain, phone photo, no text |
| `rainy-street.jpg` | 雨夜街头 | a rainy evening street seen from under an umbrella, wet pavement with warm shop light reflections, phone photo, first person view, no people visible, no text |
| `book-iced-coffee.jpg` | 周末书+冰咖啡 | an open book and a glass of iced coffee on a window seat, lazy weekend afternoon, soft light, film grain, photo, no people, no text |
| `seaside.jpg` | 海边傍晚 | calm seaside beach in the late afternoon, gentle waves on the sand, a few distant seagulls, soft warm light, film grain, photo, no people, no text |
| `breakfast.jpg` | 早餐 | a simple homemade breakfast on a wooden table: toast with egg, a cup of coffee, morning sunlight, cozy, phone photo, no people, no text |
| `late-night-noodles.jpg` | 夜宵面 | a bowl of steaming noodles on a kitchen table late at night, warm lamp light, chopsticks, cozy, phone photo, no people, no text |
| `bubble-tea.jpg` | 奶茶 | a cup of bubble tea with tapioca pearls on a cafe table, soft afternoon light, phone photo, no text |

生成命令（服务已在跑）：

```bash
curl -s -X POST http://127.0.0.1:18084/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"...","width":800,"height":600,"steps":4,"seed":42}' \
  -o /tmp/out.png
sips -s format jpeg -s formatOptions 82 /tmp/out.png --out assets/photos/xxx.jpg
```

注意：服务返回的是**原始 PNG 字节**（不是 JSON），早期脚本按 JSON 解析会报 `utf-8 codec` 错误。

## 8. 场景匹配与配文一致性（v0.9.12，`npm run photo:scene-eval`）

**问题**：用户说「拍张晚霞」，照片却是一杯咖啡、配文还写「天这样了」。

**根因**：用户话里的场景词 → 图库标签（如「咖啡」→ cafe/coffee/warm）；
如果图库没有对应标签，选图会回退到全库随机；而旧代码**只要检测到场景词就用场景配文**，
于是配文声称的场景和图片内容对不上。

**修法**：`chooseLocalPhotoShare()` 纯函数把选图+配文收敛到一处，
场景配文只在**照片本身带该场景标签**时使用，否则用照片自带的「今天/昨天/以前」配文。

**实测（14 条话术 × 200 次确定性抽样）**：

| 指标 | 旧逻辑 | 新逻辑 |
|---|---|---|
| 平均配文不一致率 | **22%** | **0%** |
| 平均场景命中率 | 100% | 100% |
| 场景词覆盖 | — | 13/14 |

旧逻辑逐场景不一致率：咖啡 56%、山 69%、花 73%、雨 33%、店 52%——「标签含多个近义词、
选到的图只匹配其中一个」就会翻车。

**缺口现状（v0.9.13）**：「海边/早餐/夜宵/奶茶」四个原本没有图的场景已补齐，
`photo:scene-eval` 的场景词覆盖从 13/14 提升到 **100%**（17/17 条话术都能匹配到图），
平均配文不一致率保持 **0%**。
