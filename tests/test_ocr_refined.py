from __future__ import annotations

import json
from pathlib import Path

import pyarrow.parquet as pq

from pipelines.ingestion.ocr_refined import normalize_ocr_jsonl, normalize_ocr_record


def test_normalize_ocr_record_keeps_accepted_detections_and_occurrence_identity() -> None:
    record = {
        "frame_path": "L01_V001/007.jpg",
        "frame_id": 123,
        "texts": [
            {
                "text": " Xin chào ",
                "confidence": 0.95,
                "detection_confidence": 0.9,
                "bbox": [[1, 2], [30, 2], [30, 20], [1, 20]],
                "accepted": True,
                "source": "paddle",
            },
            {
                "text": "low confidence",
                "confidence": 0.2,
                "detection_confidence": 0.2,
                "bbox": [[0, 0], [1, 0], [1, 1], [0, 1]],
                "accepted": False,
            },
        ],
        "width": 1280,
        "height": 720,
        "language": "vi",
        "model_version": "PP-OCRv6_medium_det+PP-OCRv6_medium_rec",
        "pipeline_version": "ocr-modal-ppocrv6-vi-batched-v4",
    }

    rows = tuple(normalize_ocr_record(record, source_record_index=11))

    assert len(rows) == 1
    assert rows[0]["video_id"] == "L01_V001"
    assert rows[0]["keyframe_no"] == 7
    assert rows[0]["text_content"] == "Xin chào"
    assert rows[0]["normalized_text"] == "xin chào"
    assert rows[0]["source_record_index"] == 11
    assert rows[0]["source_detection_index"] == 0
    assert rows[0]["bbox"] == [[1.0, 2.0], [30.0, 2.0], [30.0, 20.0], [1.0, 20.0]]


def test_normalize_ocr_jsonl_writes_only_accepted_text_rows(tmp_path: Path) -> None:
    source = tmp_path / "ocr.jsonl"
    output = tmp_path / "ocr.parquet"
    source.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "frame_path": "L01_V001/001.jpg",
                        "frame_id": 0,
                        "texts": [
                            {
                                "text": "Bảng hiệu",
                                "confidence": 0.9,
                                "detection_confidence": 0.8,
                                "bbox": [[1, 1], [2, 1], [2, 2], [1, 2]],
                                "accepted": True,
                            }
                        ],
                        "width": 100,
                        "height": 50,
                        "language": "vi",
                        "model_version": "ocr-model",
                        "pipeline_version": "ocr-pipeline",
                    },
                    ensure_ascii=False,
                ),
                json.dumps(
                    {
                        "frame_path": "L01_V001/002.jpg",
                        "frame_id": 1,
                        "texts": [],
                        "width": 100,
                        "height": 50,
                        "language": "vi",
                        "model_version": "ocr-model",
                        "pipeline_version": "ocr-pipeline",
                    },
                    ensure_ascii=False,
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    summary = normalize_ocr_jsonl(source, output)

    rows = pq.read_table(output).to_pylist()
    assert summary == {"source_records": 2, "output_rows": 1, "skipped_records": 1}
    assert rows[0]["video_id"] == "L01_V001"
    assert rows[0]["keyframe_no"] == 1
    assert rows[0]["language"] == "vi"
