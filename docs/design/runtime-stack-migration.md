# Runtime Stack Migration Design

> 状态：已拍板（2026-08-29）  
> 配套计划：`docs/superpowers/plans/2026-08-29-runtime-stack-migration.md`

## 目标

四条运行时链路替换，产品 UI / IPC 契约尽量不动：

| #   | 从                         | 到                                                      |
| --- | -------------------------- | ------------------------------------------------------- |
| 1   | Python `litellm`           | 直连 OpenAI / Anthropic 兼容 HTTP（`httpx` + 薄适配层） |
| 2   | spawn `opencode` + ACP     | `@cursor/sdk`（只换对话/工具循环）                      |
| 3   | 自管 `resources/bin/dws-*` | `dingtalk-workspace-cli`（npm / 全局 `dws`）            |
| 4   | 远程 `text-embedding-v4`   | **旁路资源**内置 `Qwen3-Embedding-8B` + GPU             |

## 已确认决策

- **钉钉**：无独立 Node SDK；官方包即 `dingtalk-workspace-cli`（`npm install -g dingtalk-workspace-cli`）。运行时解析 PATH / 全局 / 包内 bin；保留 `MYCONTEXT_DWS_SOURCE` 覆盖。
- **Agent**：**主用 Cursor 订阅**（`@cursor/sdk` + Agent API Key）；**Fallback** 为设置里的 **OpenAI 兼容网关**（`LlmClient` / 搜索归纳）。只换实现；`ChatItem` / IPC 形状稳定。
- **传输（kl-graph）**：`litellm` → `http_llm`（httpx）；建图/查询 LLM 与远程 embedding 走兼容口。
- **Cursor runtime（A3）**：设置里可选 **local / cloud**，默认 **local**；需 `CURSOR_API_KEY`。
- **Embedding（B2）**：模型作**安装包旁路资源**（不进 git）；有 GPU 加速（CUDA，Mac 可试 MPS）；无可用加速器则禁用建图并明示，禁止静默空跑。

## 非目标（本轮不做）

- 重做搜索/分身 UI
- 把 kl-graph 算法语义改掉（只换传输与 embedding 后端）
- 把 dws 能力改成开放平台 HTTP（能力面会缩水）
- 把 8B 权重量进 git

## 风险与约束

- **商标 / 文案**：用户可见与新注释避免堆第三方产品名；技术标识（包名、env）不可避免处保持中性描述（仓库 `check:trademarks`）。
- **打包体积**：去掉 opencode（~140MB）与自管 dws（~22MB）；旁路 embedding 模型另计数 GB，发版流程要单独产物。
- **ABI / 平台**：本地 embedding 依赖 CUDA 或 MPS；Windows/macOS/Linux 旁路布局要文档化。
- **kl-graph 上游同步**：改 `kl-graph/` 会与 `sync:kl-graph` 冲突——改动集中在 `utils/http_llm.py`（新）+ `embedder` + 调用点去 litellm import，方便日后 rebase。

## 验收总览

1. `requirements` / venv 无 `litellm`；建图与查询 LLM/embed 仍通。
2. 搜索/分身对话流式正常；无 opencode 二进制；设置可切 local/cloud。
3. 未跑 `prepare:bin` 拷 dws 时，全局/`dingtalk-workspace-cli` 仍能鉴权采集。
4. 旁路模型就位 + GPU 可用 → 本地 embed；缺失或本地服务失败 → **回落 OpenAI 兼容向量 API**（明示）；皆无 → UI/日志明示不可建图。

## 落地进度（2026-08-29）

- Phase 1–4 主路径已接：`http_llm`、Cursor SDK、dws npm/PATH、本地 embed 自动起 + 远程 Fallback。
- 打包不再钉 `opencode-ai` / 不再 `prepare-bin` 拷 opencode。
- 用户可见降级文案与默认 harness 标识已切到 Agent Key / `cursor-agent`；`buildOpencodeSpawn` 仅留外部实测与遗留 harness。
