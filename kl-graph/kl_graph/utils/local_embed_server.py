"""本地 OpenAI 兼容 embedding HTTP 服务（旁路 Qwen3-Embedding-8B）。

桌面在探测到模型目录 + 加速器后会自动拉起本模块。

行为：

- 模型路径缺失 → 非零退出（禁止「假装起来了」）
- 未装 sentence-transformers → 非零退出并打印可照做的提示
- 装好后监听 ``127.0.0.1:$KL_EMBED_PORT``（默认 8100），提供 ``/health``
  与 ``/v1/embeddings``

有 CUDA + vLLM 时仍可用 ``kl start embedding``；本模块覆盖 MPS / 无 vLLM。

环境变量：

- ``MYCONTEXT_EMBED_MODEL_DIR`` / ``KL_LOCAL_EMBED_MODEL_PATH``：模型目录
- ``KL_EMBED_PORT``：监听端口（默认 8100）
- ``KL_EMBED_MODEL``：对外暴露的模型名（默认目录 basename）
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def _resolve_model_dir() -> Path | None:
    for key in ("MYCONTEXT_EMBED_MODEL_DIR", "KL_LOCAL_EMBED_MODEL_PATH"):
        raw = os.environ.get(key, "").strip()
        if raw:
            return Path(raw)
    return None


def _looks_like_model_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    try:
        names = {p.name for p in path.iterdir()}
    except OSError:
        return False
    if "config.json" in names:
        return True
    return any(
        n.endswith((".safetensors", ".bin", ".gguf")) for n in names
    )


def _port() -> int:
    raw = os.environ.get("KL_EMBED_PORT", "8100").strip()
    try:
        return int(raw)
    except ValueError:
        return 8100


class _Handler(BaseHTTPRequestHandler):
    """最小 OpenAI 兼容壳：/health + /v1/embeddings（需已加载后端）。"""

    server_version = "MyContextLocalEmbed/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/health", "/v1/health"):
            self._json(200, {"status": "ok"})
            return
        self._json(404, {"error": {"message": "not found", "type": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/embeddings":
            self._json(404, {"error": {"message": "not found", "type": "not_found"}})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": {"message": "invalid json", "type": "invalid_request"}})
            return

        backend = getattr(self.server, "embed_backend", None)  # type: ignore[attr-defined]
        if backend is None:
            self._json(
                503,
                {
                    "error": {
                        "message": "embedding backend not loaded",
                        "type": "server_error",
                    }
                },
            )
            return

        texts = payload.get("input", [])
        if isinstance(texts, str):
            texts = [texts]
        if not isinstance(texts, list) or not texts:
            self._json(
                400,
                {"error": {"message": "input required", "type": "invalid_request"}},
            )
            return

        vectors = backend.encode(texts)
        model_name = getattr(self.server, "served_model_name", "local")  # type: ignore[attr-defined]
        self._json(
            200,
            {
                "object": "list",
                "model": model_name,
                "data": [
                    {"object": "embedding", "index": i, "embedding": v}
                    for i, v in enumerate(vectors)
                ],
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            },
        )


def _try_load_sentence_transformers(model_dir: Path) -> Any:
    """可选依赖：装了 sentence-transformers 才真正 encode。"""
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError as exc:
        raise NotImplementedError(
            "sentence-transformers 未安装；完整 GPU 路径请用 "
            "`kl start embedding`（vLLM），或 pip 安装 sentence-transformers 后重试。"
        ) from exc

    model = SentenceTransformer(str(model_dir), trust_remote_code=True)

    class _Backend:
        def encode(self, texts: list[str]) -> list[list[float]]:
            arr = model.encode(texts, normalize_embeddings=True)
            return [row.tolist() for row in arr]

    return _Backend()


def main(argv: list[str] | None = None) -> int:
    _ = argv
    model_dir = _resolve_model_dir()
    if model_dir is None:
        print(
            "✗ 未设置模型目录：请设 MYCONTEXT_EMBED_MODEL_DIR 或 KL_LOCAL_EMBED_MODEL_PATH",
            file=sys.stderr,
        )
        return 1
    if not _looks_like_model_dir(model_dir):
        print(
            f"✗ 模型目录不像可用权重布局：{model_dir}\n"
            "  需要 config.json 或 *.safetensors / *.bin / *.gguf",
            file=sys.stderr,
        )
        return 1

    served = os.environ.get("KL_EMBED_MODEL", "").strip() or model_dir.name
    port = _port()

    try:
        backend = _try_load_sentence_transformers(model_dir)
    except NotImplementedError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        print(
            "  提示：有 GPU + vLLM 时用 `kl start embedding`；"
            "本模块本轮仅脚手架，未加载推理后端时拒绝静默空跑。",
            file=sys.stderr,
        )
        return 1

    server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    server.embed_backend = backend  # type: ignore[attr-defined]
    server.served_model_name = served  # type: ignore[attr-defined]
    print(f"local embed listening on http://127.0.0.1:{port}/v1 model={served}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
