"""Small deterministic in-memory retrieval and evaluation baseline."""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class IndexedRecord:
    record_id: str
    text: str
    vector: tuple[float, ...]
    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        if not self.record_id or not isinstance(self.text, str):
            raise ValueError("record_id and text are required")
        if not self.vector or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in self.vector):
            raise ValueError("vector must contain finite values")
        if not isinstance(self.start_ms, int) or not isinstance(self.end_ms, int) or self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("record interval is invalid")


@dataclass(frozen=True)
class RankedResult:
    record_id: str
    score: float
    lexical_rank: int | None
    vector_rank: int | None


@dataclass(frozen=True)
class RankingMetrics:
    recall_at_k: float
    reciprocal_rank: float


def _tokens(value: str) -> set[str]:
    decomposed = unicodedata.normalize("NFD", value.casefold()).replace("đ", "d")
    plain = "".join(character for character in decomposed if unicodedata.category(character) != "Mn")
    return set(re.findall(r"[\w]+", plain, flags=re.UNICODE))


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def hybrid_search(
    records: Iterable[IndexedRecord],
    query: str,
    *,
    query_vector: Sequence[float],
    top_k: int = 10,
    rrf_k: int = 60,
) -> tuple[RankedResult, ...]:
    if not isinstance(query, str):
        raise ValueError("query must be a string")
    if not isinstance(top_k, int) or top_k < 1 or not isinstance(rrf_k, int) or rrf_k < 1:
        raise ValueError("top_k and rrf_k must be positive integers")
    items = tuple(records)
    if len({item.record_id for item in items}) != len(items):
        raise ValueError("duplicate record_id")
    if not items:
        return ()
    dimension = len(items[0].vector)
    if len(query_vector) != dimension or any(len(item.vector) != dimension for item in items):
        raise ValueError("vector dimension mismatch")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in query_vector):
        raise ValueError("query_vector must contain finite values")
    query_tokens = _tokens(query)
    lexical_scored = []
    for item in items:
        overlap = len(query_tokens & _tokens(item.text))
        if overlap:
            lexical_scored.append((overlap / len(query_tokens), item.record_id))
    lexical_order = [identifier for _, identifier in sorted(lexical_scored, key=lambda pair: (-pair[0], pair[1]))]
    vector_order = [identifier for _, identifier in sorted(
        ((_cosine(item.vector, query_vector), item.record_id) for item in items),
        key=lambda pair: (-pair[0], pair[1]),
    )]
    lexical_ranks = {identifier: rank for rank, identifier in enumerate(lexical_order, 1)}
    vector_ranks = {identifier: rank for rank, identifier in enumerate(vector_order, 1)}
    combined = []
    for item in items:
        lexical_rank = lexical_ranks.get(item.record_id)
        vector_rank = vector_ranks[item.record_id]
        score = (0 if lexical_rank is None else 1 / (rrf_k + lexical_rank)) + 1 / (rrf_k + vector_rank)
        combined.append(RankedResult(item.record_id, score, lexical_rank, vector_rank))
    return tuple(sorted(combined, key=lambda result: (-result.score, result.record_id))[:top_k])


def evaluate_ranking(ranked_ids: Sequence[str], relevant_ids: set[str], *, k: int) -> RankingMetrics:
    if not isinstance(k, int) or k < 1:
        raise ValueError("k must be positive")
    if not relevant_ids:
        raise ValueError("relevant_ids must not be empty")
    top = ranked_ids[:k]
    recall = len(set(top) & relevant_ids) / len(relevant_ids)
    reciprocal = next((1 / rank for rank, identifier in enumerate(ranked_ids, 1) if identifier in relevant_ids), 0.0)
    return RankingMetrics(recall, reciprocal)
