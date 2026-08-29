"""Embedder：按 8192 主动切窗 mean-pool。"""

from __future__ import annotations

from kl_graph.ingest.embedder import Embedder


class _FakeResp:
    def __init__(self, n: int = 1, dim: int = 4, leaf: str = ""):
        # encode leaf length into first component for assertions
        base = float(len(leaf) or 1)
        self.data = [{"embedding": [base, 2.0, 3.0, 4.0]} for _ in range(n)]
        self.usage = None


def test_estimate_is_char_upper_bound() -> None:
    assert Embedder._estimate_tokens("中" * 100) == 100


def test_proactive_split_before_http(monkeypatch) -> None:
    emb = Embedder(batch_size=1, max_retries=0, max_input_tokens=8192)
    seen: list[int] = []

    def fake_retry(kwargs):
        text = kwargs["input"][0]
        seen.append(len(text))
        assert len(text) <= 8192
        return _FakeResp(leaf=text)

    monkeypatch.setattr(emb, "_embed_with_retry", fake_retry)
    long = "字" * 15280
    vec = emb._embed([long])[0]
    assert len(seen) >= 2
    assert all(n <= 8192 for n in seen)
    # mean of window lengths
    assert abs(vec[0] - (sum(seen) / len(seen))) < 1e-6


def test_pack_isolates_oversize() -> None:
    emb = Embedder(batch_size=4, max_input_tokens=8192)
    batches = emb._pack_batches(["短", "x" * 9000, "短2"])
    assert batches[0] == ["短"]
    assert batches[1] == ["x" * 9000]
    assert batches[2] == ["短2"]
