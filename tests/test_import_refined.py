from __future__ import annotations

import json
import sys
import types
from contextlib import nullcontext
from pathlib import Path
from typing import Self

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipelines.ingestion.import_refined import (
    ImportOptions,
    build_artifact_id,
    build_evidence_id,
    local_file_uri,
    run_import,
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


class _FakeCursor:
    def __init__(self, statements: list[tuple[str, object]]) -> None:
        self.statements = statements

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: object = None) -> None:
        self.statements.append((sql, params))

    def executemany(self, sql: str, params: object) -> None:
        self.statements.append((sql, list(params)))


class _FakeConnection:
    def __init__(self) -> None:
        self.statements: list[tuple[str, object]] = []

    def transaction(self) -> object:
        return nullcontext()

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self.statements)

    def close(self) -> None:
        return None


def _write_parquet(path: Path, rows: list[dict[str, object]]) -> None:
    pq.write_table(pa.Table.from_pylist(rows), path)


def _write_minimal_refined_dataset(root: Path) -> None:
    (root / "embeddings").mkdir(parents=True)
    _write_parquet(
        root / "videos_manifest.parquet",
        [
            {
                "video_id": "L01_V001",
                "object_key": "videos/L01_V001.mp4",
                "original_filename": "L01_V001.mp4",
                "storage_uri": "r2://aic/videos/L01_V001.mp4",
                "duration_ms": 1000,
                "fps_str": "30/1",
                "fps": 30.0,
                "width": 1280,
                "height": 720,
                "size_bytes": 10,
                "sha256": None,
                "etag": None,
                "version_id": None,
                "frame_count": 30,
                "mime_type": "video/mp4",
                "dataset_version": "aic2026",
                "pipeline_version": "video-v1",
                "schema_version": "1.0.0",
                "path": "L01_V001.mp4",
                "duration_s": 1.0,
                "codec": "h264",
                "n_frames_est": 30,
            }
        ],
    )
    frame = {
        "video_id": "L01_V001",
        "keyframe_no": 1,
        "original_frame_id": 0,
        "timestamp_ms": 0,
        "thumbnail_object_key": "keyframes/L01_V001/001.jpg",
        "storage_uri": "r2://aic/keyframes/L01_V001/001.jpg",
        "metadata": json.dumps({"canonical_mapping_verified": True}),
    }
    _write_parquet(root / "canonical_frame_candidates.parquet", [frame | {"alias_count": 1}])
    _write_parquet(root / "frame_aliases.parquet", [frame])
    _write_parquet(
        root / "captions_en.parquet",
        [
            {
                "video_id": "L01_V001",
                "keyframe_no": 1,
                "original_frame_id_candidate": 0,
                "timestamp_ms_candidate": 0,
                "source_frame_idx": 0,
                "text_content": "A person stands near a table.",
                "normalized_text": "A person stands near a table.",
                "language": "en",
                "source_model": "caption-model",
                "task": "caption",
                "producer": "caption-test",
                "source_dataset": "test",
                "source_caption_path": "L01_V001/001.txt",
                "source_keyframe_path": "L01_V001/001.jpg",
                "source_row_index": 0,
                "frame_id_status": "canonical_source_frame_id_resolved",
                "ready_for_db": True,
                "canonical_timestamp_ms": 0,
                "source_original_frame_id_candidate": 0,
                "source_timestamp_ms_candidate": 0,
            }
        ],
    )
    _write_parquet(
        root / "asr_spans.parquet",
        [
            {
                "video_id": "L01_V001",
                "start_ms": 10,
                "end_ms": 100,
                "text_raw": "Xin chao",
                "text_normalized": "Xin chao",
                "language": "vi",
                "producer": "asr-test",
                "model_version": "asr-v1",
                "pipeline_version": "asr-v1",
                "schema_version": "1.0.0",
                "source_file": "L01_V001.asr.json",
                "source_span_index": 0,
                "source_row_index": 0,
                "ready_for_db": False,
            }
        ],
    )
    object_row = {
        "object_row_id": "L01_V001:kf:1:det:0",
        "video_id": "L01_V001",
        "keyframe_no": 1,
        "detection_index": 0,
        "source_frame_idx": 0,
        "original_frame_id_candidate": 0,
        "timestamp_ms_candidate": 0,
        "class_id": 0,
        "raw_label": "person",
        "label": "person",
        "normalized_label": "person",
        "confidence": 0.9,
        "bbox": [1.0, 2.0, 3.0, 4.0],
        "normalized_bbox": [0.1, 0.2, 0.3, 0.4],
        "track_id": None,
        "attributes_json": "{}",
        "image_width": 1280,
        "image_height": 720,
        "source_object_path": "L01_V001/001.json",
        "source_frame_path": "L01_V001/001.jpg",
        "source_map_file": "L01_V001.csv",
        "source_row_index": 0,
        "frame_id_status": "canonical_source_frame_id_resolved",
        "producer": "object-test",
        "model_version": "object-v1",
        "pipeline_version": "object-v1",
        "schema_version": "1.0.0",
        "object_validation_status": "valid",
        "ready_for_db": True,
        "canonical_timestamp_ms": 0,
        "source_original_frame_id_candidate": 0,
        "source_timestamp_ms_candidate": 0,
    }
    _write_parquet(root / "objects.parquet", [object_row])
    _write_parquet(root / "object_frame_manifest.parquet", [frame])
    _write_parquet(
        root / "embedding_index.parquet",
        [
            {
                "video_id": "L01_V001",
                "embedding_row_index": 0,
                "keyframe_no_candidate": 1,
                # This is deliberately the legacy ordinal, not the canonical ID.
                "source_original_frame_id": 0,
                "original_frame_id_candidate": 0,
                "source_frame_idx": 0,
                "embedding_relative_path": "embeddings/L01_V001.npy",
                "source_embedding_uri": "file:///legacy/L01_V001.npy",
                "embedding_dim": 1024,
                "dtype": "float32",
                "normalized": True,
                "model_name": "visual-test",
                "model_version": "visual-v1",
                "mapping_status": "canonical_source_frame_id_resolved",
                "ready_for_db": True,
                "canonical_timestamp_ms": 0,
                "frame_id_status": "canonical_source_frame_id_resolved",
                "source_original_frame_id_candidate": 0,
                "source_timestamp_ms_candidate": 0,
            }
        ],
    )
    np.save(root / "embeddings" / "L01_V001.npy", np.zeros((1, 1024), dtype=np.float32))


def test_full_import_flow_is_idempotent_and_preserves_legacy_ordinal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_minimal_refined_dataset(tmp_path)
    connection = _FakeConnection()
    fake_psycopg = types.SimpleNamespace(connect=lambda _url: connection)
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)

    result = run_import(
        ImportOptions(data_root=tmp_path, database_url="postgres://local/test", batch_size=1)
    )

    assert result["status"] == "imported"
    assert result["counts"]["videos"] == 1
    assert result["counts"]["embeddings"] == 1
    assert result["embedding_upload_to_r2_required"] is False
    assert len(connection.statements) > 10
