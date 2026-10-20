# 检索增强评测：DeepSeek 重排（2026-10-20）

> 目的：DeepSeek 没有 embeddings 接口，验证「用 DeepSeek 做检索层文本增强」是否值得接入生产。
> 结论：**查询改写不值得（反而降精度）；只加一次候选重排收益极大，已接入生产（默认开启，可关闭/超时降级）。**
> 本文件只记录实验过程与数字；实现见 `src/data/retrieval-boost.ts`。

## 0. 结论摘要

| 方案 | recall@1 | recall@3 | recall@8 | 每轮额外成本/延迟 | 是否采用 |
| --- | ---: | ---: | ---: | --- | --- |
| 基线（n-gram + FTS5 OR → RRF） | 55% | 80% | 85% | — | 兜底 |
| 仅查询改写 | 50% | 80% | 90% | 1 次调用 ~794ms | ❌ 不采用（降精度） |
| 仅候选重排（top12 → 8） | **95%** | **95%** | **95%** | 1 次调用 ~664ms，~¥0.00025/轮 | ✅ **生产默认** |
| 改写 + 重排 | 90% | 90% | 90% | 2 次调用 ~1.5s | ❌ 不采用（比只重排差） |

一句话：**在 20 条记忆金标上，只加一次 DeepSeek 重排，T2 recall@1 从 55% → 95%、recall@8 从 85% → 95%；多一次改写没有额外收益。**

## 1. 背景：为什么不是 embedding

- DeepSeek 官方 API 没有 `/embeddings`（项目实测 404），拿不到真语义向量；
- 真向量需要外部 embedding：Qwen/DashScope（便宜，需 Key）、SiliconFlow 等免费额度、或本地开源模型（bge-small-zh / BGE-M3 / Qwen3-Embedding，见 `docs/TECH_RADAR_AI.md` §2.4）；
- 在决定是否加一个 embedding 依赖/Key 之前，先验证「纯文本增强」能拿到多少收益——本次实验就是回答这个问题。

## 2. 方法

- 数据：`src/eval/memory-gold.json`（20 条中文金标，7 类，direct 8 / indirect 12），与 `docs/MEMORY_EVAL_REPORT.md` 同一套；
- 环境：临时 `KAREN_DATA_DIR`，真实 DeepSeek Flash，`EMBEDDING_PROVIDER=ngram`（无 Qwen Key 的生产降级路径）；
- 脚本：`src/eval/semantic-boost-eval.ts`（**只做评测，不接生产**）；
- 四组对照同一批 probe：
  1. **基线**：生产当前检索（`retrieveRelevantMemories`，n-gram + FTS5 OR → RRF，top8）；
  2. **仅改写**：Flash 把问句改写成「关键词串」→ 用关键词串检索 top8；
  3. **仅重排**：基线 top12 候选 → Flash 重排 → 取 top8；
  4. **改写+重排**：基线候选与改写检索候选合并 top12 → Flash 重排 → top8；
- 判定：expect 子串是否出现在候选内容里，及排名（recall@{1,3,8}）。

## 3. 结果

### 3.1 指标（20 条）

| 方案 | recall@1 | recall@3 | recall@8 | 名次变化用例数 |
| --- | ---: | ---: | ---: | ---: |
| 基线 | 55% | 80% | 85% | — |
| 仅改写 | 50% | 80% | 90% | 9 |
| **仅重排** | **95%** | **95%** | **95%** | 8 |
| 改写+重排 | 90% | 90% | 90% | 7 |

典型提升（`仅重排`）：原来基线排第 5 的「名字」记忆 → 重排第 1；原来 T2 没召回的「家乡/名字间接问法」→ 重排后进入第 1（重排池扩到 12 条，把原来 @8 之外的候选捞回来）。

### 3.2 延迟与成本（生产实测）

- 重排平均 **664ms**（评测 20 次）；生产 smoke 实测 467–544ms；
- 每次重排 prompt ≈ 230–240 tokens、completion 3 tokens（simple 档）；
- `llm_usage` 实测单次成本 **¥0.000243–0.000245**；
- 整轮延迟：开启重排的回合 1.29–1.37s；关闭（`KAREN_SEMANTIC_BOOST=off`）同场景 0.78s。

### 3.3 生产 E2E（临时目录 + 真实模型）

3 轮：`今天好累啊` / `你还记得我在做什么项目吗` / `我的猫叫啥来着`：

```
=== 你还记得我在做什么项目吗
时长 1368ms | 回复: 咖啡包装啊 / 你上次说的
检索日志: [检索+] DeepSeek 重排 4→4（544ms，模式 rerank）

=== 我的猫叫啥来着
时长 1291ms | 回复: 团子啊 / 橘猫那只
检索日志: [检索+] DeepSeek 重排 4→4（467ms，模式 rerank）

=== [off] 我在做什么项目（关闭开关对照）
时长 776ms | 回复: 咖啡包装啊 / 你今天是不是没睡醒
检索日志: (无)
```

## 4. 实现与降级

`src/data/retrieval-boost.ts`：

1. 先用现有混合检索取 top12 候选；
2. `chat()`（带 usage 记账/超时重试）让 Flash 输出相关编号 JSON；
3. 取前 8 条，其余按原顺序补位（重排不会导致漏召）；
4. **任何异常都降级为原顺序**：模型输出非法 JSON、调用报错、超时（默认 2.5s，`KAREN_SEMANTIC_BOOST_TIMEOUT_MS` 可调）、候选 ≤1 条、输入 <2 字；
5. 关闭开关：`KAREN_SEMANTIC_BOOST=off`（或 0/false/disable），完全恢复旧行为、零额外调用；
6. 三条日志：`[检索+] DeepSeek 重排 12→8（Nms，模式 rerank）` / `[检索+] 重排无有效输出，保留原顺序` / `[检索+] 重排降级: …`。

测试：`src/data/retrieval-boost.test.ts`（7 条，mock chat）：顺序生效、非法输出/异常/超时降级、off 不调模型、短输入跳过。

## 5. 边界与风险（如实）

- **不是真语义**：重排依赖 LLM 对「问句 vs 记忆摘要」的判断，仍以字面/语义兼容为输入；同义词改写大幅超越基线的场景没有验证到（改写反而降精度）。
- **样本小**：20 条金标、单次运行、temperature=0；换更大/更真实的对话样本需要复跑，不能把 95% 当对外承诺。
- **延迟与成本**：每轮多一次 flash 调用（~0.5–0.7s、~¥0.00025）；对「回复很快」敏感的场景可用开关关闭。
- **隐私**：命中的记忆片段（最多 12 条、每条截断 90 字）会随重排请求发给 DeepSeek；与「对话本来就会发给 DeepSeek」同一信任边界，但数据范围更大，README 隐私表已如实补充。
- **重排器可能过度自信/出错**：已用「未选中候选按原顺序补位」保住 recall@8；但逐条排序无法保证。
- **Qwen/本地 embedding（B/C 方案）仍未做**：真向量对「同义表达、跨语言、长记忆」的上限更高；本次只是先以零新依赖拿到大部分收益。

## 6. 复现

```bash
# 实验（20 条金标 × 4 组，约 60 次 flash 调用，成本约 ¥0.01）
.runtime/node22/bin/node node_modules/tsx/dist/cli.mjs src/eval/semantic-boost-eval.ts --live

# 生产开关对照：关掉后检索回到基线
KAREN_SEMANTIC_BOOST=off .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs src/bridge/qq.ts

# 单元测试（不联网）
.runtime/node22/bin/node node_modules/vitest/vitest.mjs run src/data/retrieval-boost.test.ts
```
