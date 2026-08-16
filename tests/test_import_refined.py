from __future__ import annotations

import numpy as np
import pytest

from pipelines.ingestion.import_refined import (
    build_artifact_id,
    build_evidence_id,
    local_file_uri,
    to_pgvector_literal,
    validate_embedding_rows,
)


def test_local_file_uri_is_database_safe() -> None:
    assert local_file_uri(r"D:\workspace\aic\data\refined\captions_en.parquet") == (
        "file:///D:/workspace/aic/data/refined/captions_en.parquet"
    )


def test_ids_are_stable_and_scope_the_record() -> None:
    first = build_evidence_id("caption", "L21_V001", "1")
    assert first == build_evidence_id("caption", "L21_V001", "1")
    assert first != build_evidence_id("caption", "L21_V001", "2")
    assert build_artifact_id("caption", "file:///tmp/captions.parquet") != build_artifact_id(
        "object", "file:///tmp/captions.parquet"
    )


def test_pgvector_literal_preserves_float32_values() -> None:
    vector = np.asarray([0.25, -1.0, 0.0], dtype=np.float32)
    assert to_pgvector_literal(vector) == "[0.25,-1.0,0.0]"


def test_pgvector_literal_rejects_non_finite_values() -> None:
    with pytest.raises(ValueError, match="finite"):
        to_pgvector_literal(np.asarray([0.1, np.nan], dtype=np.float32))


def test_embedding_rows_validate_matrix_and_index_alignment() -> None:
    matrix = np.zeros((2, 3), dtype=np.float32)
    rows = [
        {"embedding_row_index": 0, "embedding_dim": 3},
        {"embedding_row_index": 1, "embedding_dim": 3},
    ]
    validate_embedding_rows(rows, matrix, expected_dim=3)

    with pytest.raises(ValueError, match="row index"):
        validate_embedding_rows(
            [{"embedding_row_index": 2, "embedding_dim": 3}],
            matrix,
            expected_dim=3,
        )
