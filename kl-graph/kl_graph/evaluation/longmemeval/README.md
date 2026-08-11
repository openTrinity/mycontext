# LongMemEval evaluation

这个目录用于用 KL Graph 跑 LongMemEval。当前采用“一条 LongMemEval case
对应一张独立图”的方案：每个 case 都有自己的 `KL_DATA_DIR`，SQLite、Qdrant、
LadybugDB 和 ingestion checkpoint 不会在 case 之间共享。

完整流程由一次数据准备和四个评估阶段组成：

```text
LongMemEval JSON
    │
    └─ convert.py        数据准备：拆分 case，生成 DWS 输入
          │
          ├─ Phase 1: build.py       建图
          ├─ Phase 2: ask.py         检索 Top-5
          ├─ Phase 3: generate.py    生成回答
          └─ Phase 4: score.py       评估回答
```

这里的 Phase 1–4 是评估流水线的阶段，不是 KL Ask 内部的 Phase 1/Phase 2。
其中 `ask.py` 只运行 KL Ask Phase 1（检索、RRF、rerank），并明确关闭 KL Ask
Phase 2 的回答合成。

## 准备环境

以下命令都应在仓库根目录执行。运行前需要将模型、embedding、reranker 等生产
配置导出到当前 shell；如果配置保存在项目 `.env` 中，可以执行：

```bash
set -a
source .env
set +a
```

主要环境变量包括：

- 建图：`KL_LLM_*`、`KL_EMBED_*`、`ANTHROPIC_AUTH_TOKEN`，以及生产
  ingestion 所需的其他配置。
- 检索：`KL_RERANK_BASE_URL`、`KL_RERANK_MODEL`、`KL_RERANK_API_KEY`。
- 生成：`KL_LLM_MODEL`、`KL_LLM_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`；通常可将
  token 设置为与 `KL_LLM_API_KEY` 相同的值。
- 评分：`LONGMEM_EVAL_MODEL`、`OPENAI_BASE_URL`，以及
  `OPENAI_API_KEY` 或 `KL_LLM_API_KEY`。

所有阶段都只读取当前进程环境，不会主动加载 `.env`；因此每个新 shell 都需要先
执行上面的导出命令。

## 数据准备：convert.py

`convert.py` 将 LongMemEval JSON 数组拆成独立的 case bundle。它使用生产 DWS
chat 数据接口，但只把 `role=user` 的 turn 写入 DWS 并参与索引，以对齐官方
LongMemEval 的检索设置。完整对话（包括 assistant turn）、问题和标准答案保存在
case 的 `evaluation.jsonl` 中，不会进入图。

```bash
python -m kl_graph.evaluation.longmemeval.convert \
  /path/to/longmemeval_s_sample100.json \
  data/longmemeval
```

目标目录已存在时，转换器默认拒绝覆盖。确认需要重新生成全部 case 后，添加
`--overwrite`；转换过程采用临时目录，完成后再整体替换目标目录。

## Phase 1：build.py

`build.py` 为每个 case 启动独立的 `scripts.ingest` 子进程，并设置该 case 的
`KL_DWS_EXPORT_DIR` 和 `KL_DATA_DIR`。消息加载、生产 chunk 策略、embedding、
extraction 和图存储都走生产 ingestion 代码；此脚本本身只负责编排。

推荐运行方式：

```bash
python -m kl_graph.evaluation.longmemeval.build \
  data/longmemeval \
  --all \
  --case-concurrency 3 \
  --keep-going
```

`--case-concurrency` 控制同时运行多少个独立 case；`--concurrency` 控制每个
ingest 子进程内部的 extraction 并发，默认是 8。当前 `build.py` 的 case 并发
默认值是 4，但本次 100-case 实测中 3 更稳定，4 曾触发上游容量限制。

build 没有单独的 `--resume` 参数。中断后可以用相同命令重新运行，已有
`kl_data` 会交给生产 ingestion 的 checkpoint/cache 增量处理；也可以用
`--case QUESTION_ID` 只重跑失败的 case。不要加 `--fresh`，除非确实要清空并
重建所选 case 的存储。

常用检查命令：

```bash
python -m kl_graph.evaluation.longmemeval.build --first 1 --dry-run
python -m kl_graph.evaluation.longmemeval.build --case 00ca467f
```

每个 case 的 `build_status.json` 记录编排状态，详细 ingestion 输出在
`build.log`。

## Phase 2：ask.py

`ask.py` 为每个 case 临时启动一个指向其 `kl_data` 的生产 KL Server，再调用
生产 `kl ask`。检索启用配置好的 reranker，只保留 Top-5，并关闭 KL Ask
Phase 2。

```bash
python -m kl_graph.evaluation.longmemeval.ask \
  data/longmemeval \
  --all \
  --resume \
  --case-concurrency 3 \
  --keep-going
```

`--resume` 会跳过配置匹配且结构完整的 `ask_top5.json`，并重新运行缺失、损坏
或 reranker 配置不匹配的 case。`--overwrite` 则强制替换所有选中 case 的已有
结果。单个 case 的检索结果保存在 `results/ask_top5.json`，临时 Server 日志在
`results/ask_server.log`。

## Phase 3：generate.py

`generate.py` 读取每个 case 的 Top-5。对于 fact 命中，它先定位来源 chunk；
然后根据 chunk 的原始 message ID，从 `evaluation.jsonl` 恢复被检索到的 user
turn 及其紧随的 assistant reply，按时间顺序组成官方 RAG 风格 prompt，最后
异步调用生成模型。输出遵循 LongMemEval 原生格式：

```json
{"question_id": "...", "hypothesis": "..."}
```

推荐命令：

```bash
python -m kl_graph.evaluation.longmemeval.generate \
  data/longmemeval \
  --all \
  --resume \
  --concurrency 10
```

默认输出是 `data/longmemeval/hypotheses.jsonl`。每完成一个 case 都会原子更新
文件；`--resume` 会跳过其中已有的 question ID，因此中断后可继续。需要全部
重新生成时使用 `--overwrite`。脚本默认并发为 5，上面的 10 是本次评估采用的
运行值。

## Phase 4：score.py

`score.py` 基于 LongMemEval 官方 `evaluate_qa.py` 的 answer-check prompt，使用
OpenAI-compatible 异步客户端调用 judge，并额外输出汇总指标。第三方来源和许可
见 `THIRD_PARTY_LICENSE_LONGMEMEVAL`。

```bash
python -m kl_graph.evaluation.longmemeval.score data/longmemeval
```

judge 模型由 `LONGMEM_EVAL_MODEL` 指定，默认评分并发是 10。输出文件名会带上
judge 模型，例如：

```text
hypotheses.jsonl.eval-results-qwen3.7-flash
hypotheses.jsonl.eval-results-qwen3.7-flash.metrics.json
```

score 当前没有 `--resume`：输出已存在时会拒绝覆盖，使用 `--overwrite` 可重新
评估。虽然评分期间会持续写入已完成结果，但中断后仍需带 `--overwrite` 重跑。

使用 Qwen 等 judge 得到的分数适合当前实验内比较，但不能直接当作论文中的官方
GPT-4o judge 分数。需要与官方结果严格对比时，应将 judge endpoint 和
`LONGMEM_EVAL_MODEL` 配置为官方采用的 GPT-4o。

## 产物目录

默认 `data/longmemeval/` 的主要结构如下：

```text
data/longmemeval/
├── manifest.json
├── cases/
│   └── QUESTION_ID/
│       ├── manifest.json
│       ├── evaluation.jsonl
│       ├── dws/chat/
│       ├── kl_data/
│       ├── build.log
│       ├── build_status.json
│       └── results/
│           ├── ask_top5.json
│           └── ask_server.log
├── hypotheses.jsonl
├── hypotheses.jsonl.eval-results-MODEL
└── hypotheses.jsonl.eval-results-MODEL.metrics.json
```

- `manifest.json`：整个 case set 的来源、统计信息和 case 顺序。
- `dws/chat/`：只包含 user turn，是唯一会传给 ingestion 的 benchmark 输入。
- `evaluation.jsonl`：完整源对话、问题和 Gold 数据，仅供生成与评分使用。
- `kl_data/`：该 case 独立的 SQLite、向量库、图数据库和 ingestion checkpoint。
- `ask_top5.json`：检索与 rerank 后的 Top-5。
- `hypotheses.jsonl`：所有 case 的最终回答，顺序与顶层 manifest 一致。
- `*.eval-results-*`：逐题 judge 结果；对应的 `*.metrics.json` 是汇总指标。

## 目录内文件

- `convert.py`：把原始 benchmark 转成“一 case 一图”的 DWS case set。
- `build.py`：通过生产 ingestion 和生产 chunk 策略建图。
- `ask.py`：通过生产 KL Ask 检索、rerank 并保存 Top-5。
- `generate.py`：恢复 assistant 上下文并异步生成 hypotheses。
- `score.py`：使用官方 LongMemEval judge prompt 异步评分。
- `__init__.py`：无副作用的 Python package 初始化文件。
- `THIRD_PARTY_LICENSE_LONGMEMEVAL`：本地评分实现所依据官方代码的 MIT 许可。

## 使用 RAGFlow SDK 跑 LongMemEval

RAGFlow runner 直接读取 LongMemEval 原生 JSON，不需要先运行 `convert.py`。每个
question case 对应一个独立 RAGFlow Dataset；该 case 的所有 `role=user` turn 按
session/date/turn 标记拼成一个 TXT，问题、Gold answer 和 assistant turn 都不会
上传。Dataset 固定使用 `naive`、换行 delimiter 和 `chunk_token_num=512`，切块、
embedding 与 GraphRAG 都由 RAGFlow 服务负责。

由于官方 `ragflow-sdk==0.26.4` 需要 Python 3.13，build/ask 使用独立环境；生成和
评分继续使用 KL 主环境。该依赖不加入 KL Graph 的 `pyproject.toml`，安装方式为：

```bash
uv venv --python 3.13 .venv-ragflow
uv pip install --python .venv-ragflow/bin/python ragflow-sdk==0.26.4
```

运行方式：

```bash
# 一 case 一 Dataset，parse 后构建 GraphRAG
.venv-ragflow/bin/python -m \
  kl_graph.evaluation.longmemeval.ragflow.build \
  /path/to/longmemeval_s_sample100.json \
  --case 00ca467f --graph

# 每个问题只调用一次 retrieve；--rerank-id 也可由 RAGFLOW_RERANK_ID 提供
.venv-ragflow/bin/python -m \
  kl_graph.evaluation.longmemeval.ragflow.ask \
  /path/to/longmemeval_s_sample100.json \
  --case 00ca467f --use-kg --rerank-id RERANK_MODEL_ID

# 直接使用 ask responses 中的 chunk/graph content 生成答案
.venv/bin/python -m kl_graph.evaluation.longmemeval.generate \
  --ragflow-ask-dir /path/to/ASK_RUN \
  --resume --concurrency 10

# 显式 reference+hypotheses 模式只评分 hypotheses 中出现的合法 ID 子集
.venv/bin/python -m kl_graph.evaluation.longmemeval.score \
  --reference /path/to/longmemeval_s_sample100.json \
  --hypotheses /path/to/ASK_RUN/hypotheses.jsonl
```

默认 build 状态位于 `data/longmemeval-ragflow/cases/QUESTION_ID/ragflow.json`。
单 case 的 ask 默认输出到同一 case 下的
`benchmark/longmemeval-ragflow-ask/{graph|vector}/RUN_TIME/`；多 case ask 则位于
`data/longmemeval-ragflow/benchmark/...`。`generate.py` 的 RAGFlow 模式默认把
`hypotheses.jsonl` 写入对应 ask run 目录。

## 使用 Khoj 跑 LongMemEval

Khoj runner 同样直接读取原生 LongMemEval JSON，不依赖 `convert.py`。每个 case
上传为一个独立的 plaintext Document，内容只包含该 case 的全部 user turn，并保留
session、date 和 turn 标记。客户端不预切 chunk；切块、embedding、持久化和 rerank
都由 Khoj server 负责。

这些 Document 存在同一个 Khoj server/PostgreSQL 中，但 ask 会使用精确 filename
过滤，每个问题只能检索其对应 case 的 Document：

```bash
# 上传全部 case；已有匹配状态由 --resume 校验并复用
.venv/bin/python -m kl_graph.evaluation.longmemeval.khoj.build \
  /path/to/longmemeval_s_sample100.json \
  --all --resume --keep-going --case-concurrency 3

# 一个 case 一次 Khoj search，服务端启用 rerank，保存 Top-5
.venv/bin/python -m kl_graph.evaluation.longmemeval.khoj.ask \
  /path/to/longmemeval_s_sample100.json \
  --case 00ca467f \
  --max-concurrent 4

# 直接使用 Khoj 返回的 chunk content 生成原生 hypotheses.jsonl
.venv/bin/python -m kl_graph.evaluation.longmemeval.generate \
  --khoj-ask-dir /path/to/ASK_RUN \
  --resume --concurrency 10

# 继续复用官方 judge prompt，只评分 hypotheses 中包含的 case 子集
.venv/bin/python -m kl_graph.evaluation.longmemeval.score \
  --reference /path/to/longmemeval_s_sample100.json \
  --hypotheses /path/to/ASK_RUN/hypotheses.jsonl
```

默认 build 状态位于 `data/longmemeval-khoj/cases/QUESTION_ID/khoj.json`。单 case
ask 默认输出到该 case 的
`benchmark/longmemeval-khoj-ask/all/RUN_TIME/`；多 case ask 位于
`data/longmemeval-khoj/benchmark/longmemeval-khoj-ask/all/RUN_TIME/`。
`generate.py` 默认把 `hypotheses.jsonl` 写入对应 ask run。
