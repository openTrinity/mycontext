# LoCoMo evaluation

LoCoMo uses one explicit OmegaConf YAML to run the standard evaluation flow:

```text
Convert (KL only) -> Build -> Ask -> Generate -> Score
```

The supported backends are `kl_graph`, `khoj`, and `ragflow`. Every experiment
value and every output location is declared in YAML; API credentials remain in
environment variables.

## Entry points

Run a complete experiment:

```bash
python -m kl_graph.evaluation.locomo.pipeline \
  --config kl_graph/evaluation/locomo/configs/experiment.example.yaml
```

Validate and print the stage commands without changing data:

```bash
python -m kl_graph.evaluation.locomo.pipeline \
  --config kl_graph/evaluation/locomo/configs/experiment.example.yaml \
  --dry-run
```

Each standard stage can also be run independently. The stage CLI accepts only
`--config` and `--dry-run`:

```bash
python -m kl_graph.evaluation.locomo.convert --config experiment.yaml
python -m kl_graph.evaluation.locomo.kl_graph.build --config experiment.yaml
python -m kl_graph.evaluation.locomo.kl_graph.ask --config experiment.yaml
python -m kl_graph.evaluation.locomo.generate --config experiment.yaml
python -m kl_graph.evaluation.locomo.score --config experiment.yaml
```

For Khoj or RAGFlow, replace the Build and Ask modules with
`locomo.khoj.{build,ask}` or `locomo.ragflow.{build,ask}`. The pipeline chooses
these automatically.

## Configurations

Start from the backend-specific example in `configs/`:

- `experiment.example.yaml`: KL Graph
- `experiment.khoj.example.yaml`: Khoj
- `experiment.ragflow.example.yaml`: RAGFlow

All fields are required unless their YAML value is explicitly nullable. The
schema rejects unknown fields; Python does not supply hidden experiment
defaults.

Common sections:

- `source`: native `locomo10.json`, usually `${oc.env:LOCOMO_SOURCE}`.
- `selection`: conversation selection plus question category/ID/limit filters.
- `run`: Ask output directory, `resume|overwrite`, failure policy, and pipeline
  case concurrency.
- `build`, `ask`, `generate`, `score`: all stage parameters.
- `generate.output_dir` and `score.output_dir`: explicit derived-output paths.

KL Graph also declares `case_set` and `convert`. Khoj and RAGFlow instead use
`artifact_root` for durable remote-build state and add their connection section.

`selection.conversations` accepts exactly one of:

```yaml
all: true
first: 1
cases: [conv-26]
```

`selection.questions` accepts `all: true`, or a combination of `categories`,
`ids`, and `first`.

### Run modes

`run.mode: resume` resumes Ask and Generate from their checkpoints and requires
their existing `run.json` manifests to match the current configuration. Backend
Build state is reused only when its source and build configuration match. Score
is deterministic and inexpensive, so it is recalculated after the resumed
stages complete.

Use `run.mode: overwrite` for a new output path or to intentionally replace a
run. For KL graph construction, database deletion is controlled separately by
`build.fresh`; leaving it `false` reuses compatible physical graphs.

The pipeline writes a credential-free `experiment.resolved.json` in
`run.output_dir`. It records resolved paths, source fingerprint, selected IDs,
and the effective experiment values.

`run.case_concurrency` controls how many complete conversation workers run at
once. Each worker still runs Build -> Ask -> Generate -> Score in order and
passes one explicit `--case-id` to every stage. Stage-level settings remain
useful when a stage is run directly: `build.case_concurrency` controls multiple
Build cases, while `ask.concurrency` controls questions inside one conversation.
During a pipeline run, the maximum Ask request concurrency is therefore roughly
`run.case_concurrency * ask.concurrency`.

## Environment

Typical non-secret values:

```bash
export LOCOMO_SOURCE=/absolute/path/to/locomo10.json
export KL_LLM_BASE_URL=http://127.0.0.1:9999/v1
export KHOJ_BASE_URL=http://127.0.0.1:42112
export RAGFLOW_BASE_URL=http://127.0.0.1:9380
export RAGFLOW_EMBEDDING_MODEL='model@factory@provider'
```

Credentials are not YAML fields:

```bash
export ANTHROPIC_AUTH_TOKEN=...
export KHOJ_API_TOKEN=...       # optional when the server has no auth
export RAGFLOW_API_KEY=...
```

RAGFlow's `embedding_model` selects a model already configured in the RAGFlow
server. The evaluator does not configure or start the embedding service. Build
and Ask run with the Python executable declared in `ragflow.python`, normally
`.venv-ragflow/bin/python`.

## Artifacts

With the example paths, a run has three explicit roots:

```text
run.output_dir/
├── experiment.resolved.json
├── run.json
├── results.jsonl
└── responses/

generate.output_dir/
├── run.json
├── answers.jsonl
└── generation-events.jsonl

score.output_dir/
├── run.json
├── retrieval.jsonl
├── scored.jsonl
└── metrics.json
```

KL Graph's converted `case_set` additionally contains one isolated DWS source,
physical graph, and `build_status.json` per conversation. Khoj/RAGFlow keep
their local build manifests below `artifact_root/cases/<conversation>/`; the
actual document chunks and embeddings remain owned by their servers.

RAGFlow GraphRAG content is available to generation, but graph items do not
occupy vector Top-K and do not contribute to the primary Recall@K. The score
artifact retains graph-only and combined diagnostic metrics.

## Codex runner

Codex remains intentionally outside the YAML pipeline. Its existing CLI and
behavior are preserved under `locomo/codex/`:

```bash
python -m kl_graph.evaluation.locomo --dataset data/locomo-v2 --eval
```

It reuses the converted case set, production KL graph validation, and the
scoring functions in `locomo/score.py`.
