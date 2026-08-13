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
          ├─ Phase 2: ask.py         检索 Top-K
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
- 检索：reranker URL 和模型写在 YAML；API Key 仍通过生产环境变量提供。
- 生成：provider、模型、URL 和请求参数写在 YAML；API Key 只从对应 provider
  的环境变量读取。
- 评分：judge 模型、URL 和请求参数写在 YAML；Key 使用 `OPENAI_API_KEY`、
  `KL_LLM_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。

所有阶段都只读取当前进程环境，不会主动加载 `.env`；因此每个新 shell 都需要先
执行上面的导出命令。

## 一键流水线：pipeline.py

`pipeline.py` 按固定顺序调用现有阶段，不在编排层重新实现任何评估逻辑：

```text
KL Graph: Convert → Build → Ask → Generate → Score
Khoj:               Build → Ask → Generate → Score
```

YAML 流水线通过必填的 `backend: kl_graph|khoj` 选择后端。RAGFlow 尚未接入完整
流水线，只能在自行生成 `hypotheses.jsonl` 后复用下面的 Score 阶段。

推荐通过 OmegaConf YAML 保存实验参数：

```bash
export LONGMEMEVAL_SOURCE=/path/to/longmemeval_s_sample100.json

python -m kl_graph.evaluation.longmemeval.pipeline \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml \
  --dry-run

python -m kl_graph.evaluation.longmemeval.pipeline \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

YAML 支持 `${oc.env:NAME}`，API Key 不进入配置文件。`run.mode: resume` 时流水线
复用 source 指纹和时区匹配的 Convert 结果及完整 Build；Ask 会校验已有 artifact，
Generate 会根据 prompt 指纹只重跑输入发生变化的 case，完整且配置匹配的 Score
也会跳过。完全展开且不含凭证的实验配置会保存到 `run.output_dir` 下的
`experiment.resolved.json`。

YAML 是实验参数的唯一来源。所有字段都必须显式填写；缺字段、未知字段和非法数值
会直接报错，不会回退到代码、环境变量或旧 CLI 默认值。命令行只保留必需的
`--config` 和不会改变实验定义的 `--dry-run`。

Score 的可变运行参数集中在 `score` 配置中；官方 judge prompt、substring `yes`
判分协议和检索 provenance 规则仍固定在代码里：

```yaml
score:
  output: ../../../data/longmemeval/score-results.jsonl
  metrics_output: ../../../data/longmemeval/score-metrics.json
  concurrency: 10
  judge:
    model: ${oc.env:LONGMEM_EVAL_MODEL}
    base_url: ${oc.env:OPENAI_BASE_URL}
    temperature: 0
    max_tokens: 10
    timeout_seconds: 120
    max_retries: 5
  retrieval:
    turn_recall:
      enabled: true
      k: 5
```

这些参数也会写入 Score metrics 和 `experiment.resolved.json`，流水线的 resume
检查会逐项核对，避免参数改变后复用旧分数。

`run.mode: overwrite` 只重跑 Ask、Generate 和 Score，不会删除 case set 或图存储。
替换 Convert 结果和重建图分别需要在 YAML 中显式设置 `convert.reconvert=true`
和 `build.fresh=true`；两者都是破坏性操作。

## 数据准备：convert.py

`convert.py` 将 LongMemEval JSON 数组拆成独立的 case bundle。它使用生产 DWS
chat 数据接口，但只把 `role=user` 的 turn 写入 DWS 并参与索引，以对齐官方
LongMemEval 的检索设置。完整对话（包括 assistant turn）、问题和标准答案保存在
case 的 `evaluation.jsonl` 中，不会进入图。

```bash
python -m kl_graph.evaluation.longmemeval.convert \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

`convert.py` 会直接通过 OmegaConf 读取同一份 YAML 中的 `source`、`case_set`、
`convert.timezone` 和 `convert.reconvert`。相对路径以 YAML 所在目录为基准。
旧的 `INPUT OUTPUT --timezone ...` 调用方式不再支持。

目标目录已存在且 `convert.reconvert: false` 时，转换器拒绝覆盖。确认需要重新生成
全部 case 后，在 YAML 中设置 `convert.reconvert: true`；转换过程采用临时目录，
完成后再整体替换目标目录。

## Phase 1：build.py

`build.py` 为每个 case 启动独立的 `scripts.ingest` 子进程，并设置该 case 的
`KL_DWS_EXPORT_DIR` 和 `KL_DATA_DIR`。消息加载、生产 chunk 策略、embedding、
extraction 和图存储都走生产 ingestion 代码；此脚本本身只负责编排。

推荐运行方式：

```bash
python -m kl_graph.evaluation.longmemeval.build \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

`build.case_concurrency` 控制同时运行多少个独立 case，`build.concurrency` 控制
每个 ingest 子进程内部的 extraction 并发。`build.keep_cache`、
`build.with_improve` 和 `run.keep_going` 也直接控制对应行为，不再有代码默认值。

重复运行会跳过状态完整且配置兼容的图。只有明确设置 `build.fresh: true` 才会向
生产 ingestion 传入 `--fresh-db`，重建 YAML selection 选中的 case。

常用检查命令：

```bash
python -m kl_graph.evaluation.longmemeval.build \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml \
  --dry-run
```

每个 case 的 `build_status.json` 记录编排状态，详细 ingestion 输出在
`build.log`。`build.with_improve: false` 映射为 `--improve-mode off`，设为
`true` 时映射为 `full`。如果 production checkpoint 报告任一 extraction item 失败，该 case
会标记为失败，不会把 partial graph 用于评估。状态文件同时记录构建时的
embedding、vector backend 和 graph backend 配置。

## Phase 2：ask.py

`ask.py` 为每个 case 临时启动一个指向其 `kl_data` 的生产 KL Server，再调用
生产 `kl ask`。检索启用配置好的 reranker，只保留 YAML 配置的 Top-K，并关闭 KL Ask
Phase 2。启动前会检查 build 状态，并拒绝使用 storage backend 或 embedding
模型/维度与构建时不一致的图。

```bash
python -m kl_graph.evaluation.longmemeval.ask \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

`run.mode: resume` 会跳过配置匹配且结构完整的 `ask_top{ask.top_k}.json`，并重新
运行缺失、损坏或 reranker/build 配置不匹配的 case；`overwrite` 则替换所有选中
case 的结果。case 并发、server 启动超时和请求超时分别由
`ask.case_concurrency`、`ask.server_start_timeout_seconds` 和
`ask.request_timeout_seconds` 指定。临时 Server 日志保存在
`results/ask_server.log`。

## Phase 3：generate.py

`generate.py` 读取每个 case 的 `ask.top_k` artifact。对于 Fact 命中，它优先使用
`facts.source_unit_id` 精确定位原始 user turn；只有旧数据库缺少该字段时才回退
到来源 chunk 的全部 message。Chunk/Message 命中仍恢复其包含的全部 user turn。
每个 user turn 都与紧随的 assistant reply 组成独立 round，再按时间顺序组成官方
`flat-turn` prompt。Fact 文本不会放进 prompt，对应官方默认的 fact expansion
`none`。检索历史上限按官方公式
`model_context_tokens - max_tokens - 1000` 计算，超出部分采用 token 前缀截断。
输出遵循 LongMemEval 原生格式：

```json
{"question_id": "...", "hypothesis": "..."}
```

推荐命令：

```bash
python -m kl_graph.evaluation.longmemeval.generate \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

输出路径由根级 `hypotheses` 显式指定。每完成一个 case 都会原子更新文件；
`run.mode: resume` 会同时核对生成配置和每个 case 的 prompt SHA256，Ask 结果变化
时只丢弃并重跑对应的旧回答。`overwrite` 会全部重跑。provider、模型、URL、
temperature、token 上限、上下文窗口、并发、超时和重试次数全部来自 `generate`
段。运行清单保存在 `<hypotheses>.run.json`。

## Phase 4：score.py

`score.py` 基于 LongMemEval 官方 `evaluate_qa.py` 的 answer-check prompt，使用
OpenAI-compatible 异步客户端调用 judge，并额外输出汇总指标。它还会在同一次
Score 中计算 `turn_recall@K`：KL Fact/Chunk 通过数据库来源字段映射原始 user
turn，Khoj chunk 则使用 Ask 已验证并保存的 `source_turn_ids`。第三方来源和许可见
`THIRD_PARTY_LICENSE_LONGMEMEVAL`。

```bash
python -m kl_graph.evaluation.longmemeval.score \
  --config kl_graph/evaluation/longmemeval/experiment.example.yaml
```

`score.py` 从 YAML 的 `source`、`hypotheses`、`selection`、`run` 和 `score` 段读取
reference、答案路径、题目子集、输出路径和全部 judge 参数。启用 turn recall 时，
KL 要求 `case_set`，Khoj 从 `run.output_dir` 读取 Ask artifacts；两者都会校验
`score.retrieval.turn_recall.k <= ask.top_k`。旧的位置参数和评分参数不再支持。
RAGFlow 外部结果仍可通过根级 `hypotheses` 复用最终答案 Score。

逐题和汇总输出路径由 YAML 显式指定，例如：

```text
score-results.jsonl
score-metrics.json
```

`run.mode: resume` 会跳过完整且参数匹配的评分；缺失、部分完成或参数不匹配的
评分会重新执行。`run.mode: overwrite` 始终重新评分。评分期间会持续原子写入已
完成结果，因此中断后的部分文件不会被当作完整结果复用。
逐题文件的 `retrieval` 字段保存 Gold/retrieved/matched turn IDs；聚合文件的
`retrieval.turn_recall@5` 保存有效 case 的均值。abstention 和没有 Gold user
turn 的题不会进入该均值。

使用 Qwen 等 judge 得到的分数适合当前实验内比较，但不能直接当作论文中的官方
GPT-4o judge 分数。需要与官方结果严格对比时，应将 judge endpoint 和
`LONGMEM_EVAL_MODEL` 配置为官方采用的 GPT-4o。

## 产物目录

按示例 YAML 运行时，主要结构如下：

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
├── hypotheses.jsonl.run.json
├── score-results.jsonl
└── score-metrics.json
```

- `manifest.json`：整个 case set 的来源、统计信息和 case 顺序。
- `dws/chat/`：只包含 user turn，是唯一会传给 ingestion 的 benchmark 输入。
- `evaluation.jsonl`：完整源对话、问题和 Gold 数据，仅供生成与评分使用。
- `kl_data/`：该 case 独立的 SQLite、向量库、图数据库和 ingestion checkpoint。
- `ask_top{K}.json`：检索与 rerank 后的配置 Top-K。
- `hypotheses.jsonl`：所有 case 的最终回答，顺序与顶层 manifest 一致。
- `hypotheses.jsonl.run.json`：生成配置、Prompt 指纹和输出指纹。
- `score-results.jsonl`：逐题 judge 结果；`score-metrics.json` 是汇总指标。

## 目录内文件

- `convert.py`：把原始 benchmark 转成“一 case 一图”的 DWS case set。
- `build.py`：通过生产 ingestion 和生产 chunk 策略建图。
- `ask.py`：通过生产 KL Ask 检索、rerank 并保存配置 Top-K。
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

# 使用 RAGFlow 自己的生成流程产出 hypotheses 后，可复用统一 Score
.venv/bin/python -m kl_graph.evaluation.longmemeval.score \
  --config /path/to/ragflow-experiment.yaml
```

默认 build 状态位于 `data/longmemeval-ragflow/cases/QUESTION_ID/ragflow.json`。
单 case 的 ask 默认输出到同一 case 下的
`benchmark/longmemeval-ragflow-ask/{graph|vector}/RUN_TIME/`；多 case ask 则位于
`data/longmemeval-ragflow/benchmark/...`。KL 的 YAML `generate.py` 不接受 RAGFlow
ask run；复用 Score 时需在单独 YAML 中显式设置 `hypotheses`、两个 score 输出路径，
并关闭 KL turn recall。

## 使用 Khoj 跑 LongMemEval

Khoj runner 同样直接读取原生 LongMemEval JSON，不依赖 `convert.py`。每个 case
上传为一个独立的 plaintext Document，内容只包含该 case 的全部 user turn，并保留
session、date 和 turn 标记。客户端不预切 chunk；切块、embedding、持久化和 rerank
都由 Khoj server 负责。

这些 Document 存在同一个 Khoj server/PostgreSQL 中，但 Ask 会使用精确 filename
过滤，每个问题只能检索其对应 case 的 Document。所有实验参数来自同一份 OmegaConf
YAML，API token 仍只从 `KHOJ_API_TOKEN` 读取：

```bash
export LONGMEMEVAL_SOURCE=/path/to/longmemeval_s_sample100.json
export KHOJ_BASE_URL=http://127.0.0.1:42112
export KHOJ_API_TOKEN=optional-bearer-token

# 完整 Build → Ask → Generate → Score
.venv/bin/python -m kl_graph.evaluation.longmemeval.pipeline \
  --config kl_graph/evaluation/longmemeval/experiment.khoj.example.yaml

# 也可以单独运行一个阶段
.venv/bin/python -m kl_graph.evaluation.longmemeval.khoj.build \
  --config kl_graph/evaluation/longmemeval/experiment.khoj.example.yaml
.venv/bin/python -m kl_graph.evaluation.longmemeval.khoj.ask \
  --config kl_graph/evaluation/longmemeval/experiment.khoj.example.yaml
```

Build 状态位于 YAML `artifact_root` 下的 `cases/QUESTION_ID/khoj.json`。Ask run
固定写到 `run.output_dir`，Generate 直接读取其中的 `run.json`、`results.jsonl` 和
`responses/*.json`，生成根级 `hypotheses` 指定的文件，再交给统一 Score。Khoj Ask
还会把每个 server chunk 映射回上传文档中的 `source_turn_ids`；因此 Score 可以和
KL Graph 一样计算 `turn_recall@K`，其中 `K` 不得超过 `ask.top_k`。
