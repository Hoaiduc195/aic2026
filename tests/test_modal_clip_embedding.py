from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

MODULE_PATH = (
    Path(__file__).parents[1]
    / "pipelines"
    / "feature_extraction"
    / "embedding"
    / "modal_clip_embedding.py"
)
SPEC = importlib.util.spec_from_file_location("modal_clip_embedding", MODULE_PATH)
assert SPEC and SPEC.loader
embedding = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = embedding
SPEC.loader.exec_module(embedding)


def _source_frame(rows: int) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "video_id": ["L25_V030"] * rows,
            "segment_id": ["L25_V030"] * rows,
            "embedding_uri": ["file:///embeddings/L25_V030.npy"] * rows,
            "embedding_dim": [1024] * rows,
            "model_name": [embedding.MODEL_NAME] * rows,
            "model_version": [embedding.MODEL_VERSION] * rows,
            "original_frame_id": list(range(rows)),
            "dtype": ["float32"] * rows,
            "normalized": [True] * rows,
            "pipeline_version": [embedding.MODEL_VERSION] * rows,
            "schema_version": ["1.0.0"] * rows,
        }
    )


def _manifest_frame(rows: int) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "video_id": ["L25_V030"] * rows,
            "keyframe_no": list(range(1, rows + 1)),
            "source_frame_idx": list(range(rows)),
            "original_frame_id_candidate": list(range(rows)),
            "timestamp_ms_candidate": list(range(rows)),
            "frame_id_status": [
                "candidate_source_frame_idx_needs_canonical_validation"
            ]
            * rows,
        }
    )


def test_exact_model_contract_is_explicit() -> None:
    assert embedding.MODEL_NAME == (
        "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
    )
    assert embedding.MODEL_VERSION == "visual-embedding-clipa-v2-h14"
    assert embedding.EMBEDDING_DIMENSION == 1024
    assert embedding.EMBEDDING_DTYPE == "float32"


def test_pending_manifest_rows_is_suffix_only() -> None:
    pending = embedding.pending_manifest_rows(
        _manifest_frame(5), existing_rows=3, video_id="L25_V030"
    )
    assert pending["keyframe_no"].tolist() == [4, 5]


def test_pending_manifest_rows_rejects_existing_overflow() -> None:
    with pytest.raises(ValueError, match="manifest chỉ có"):
        embedding.pending_manifest_rows(
            _manifest_frame(2), existing_rows=3, video_id="L25_V030"
        )


def test_pending_manifest_alignment_inserts_a_gap_preserved_by_source_ids() -> None:
    manifest = _manifest_frame(6)
    source = _source_frame(5)
    source["original_frame_id"] = [0, 1, 2, 3, 5]
    pending, positions, original_ids = embedding.pending_manifest_alignment(
        manifest, source, video_id="L25_V030"
    )
    assert pending["keyframe_no"].tolist() == [5]
    assert positions == (4,)
    assert original_ids == (4,)


def test_source_contract_rejects_different_model() -> None:
    source = _source_frame(2)
    source.loc[1, "model_name"] = "wrong-model"
    vectors = np.tile(
        np.array([[1.0] + [0.0] * 1023], dtype=np.float32), (2, 1)
    )
    with pytest.raises(ValueError, match="model_name"):
        embedding.validate_source_artifacts(
            source, vectors, video_id="L25_V030"
        )


def test_normalized_vector_validation_rejects_non_unit_vector() -> None:
    vectors = np.zeros((1, 1024), dtype=np.float32)
    with pytest.raises(ValueError, match="normalize"):
        embedding._validate_normalized_vectors(vectors, "test")


def test_remote_results_are_grouped_in_job_order() -> None:
    jobs = (
        embedding.PendingJob("L25_V030", 4, Path("a.jpg"), "L25_V030/004.jpg"),
        embedding.PendingJob("L25_V030", 5, Path("b.jpg"), "L25_V030/005.jpg"),
        embedding.PendingJob("L25_V078", 411, Path("c.jpg"), "L25_V078/411.jpg"),
    )
    unit = np.zeros(1024, dtype=np.float32)
    unit[0] = 1.0
    results = [
        {"relative_path": job.relative_path, "embedding": unit.tolist()}
        for job in reversed(jobs)
    ]
    grouped = embedding._parse_remote_results(jobs, results)
    assert grouped["L25_V030"].shape == (2, 1024)
    assert grouped["L25_V078"].shape == (1, 1024)
