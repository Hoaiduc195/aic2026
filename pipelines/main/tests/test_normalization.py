from __future__ import annotations

import unittest

from pipelines.main.contracts.validation import validate_record
from pipelines.main.tasks.normalization.records import (
    FrameIdentity,
    normalize_detection,
    normalize_detections,
    normalize_ocr,
)


class NormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.identity = FrameIdentity(
            video_id="video-1",
            segment_id="video-1-seg-0001",
            original_frame_id=12,
            timestamp_ms=480,
        )

    def test_detection_is_mapped_to_object_contract_shape(self) -> None:
        record = normalize_detection(
            self.identity,
            {
                "class_name": "person",
                "class_id": 0,
                "confidence": 0.91,
                "bbox_xyxy": [1, 2, 30, 40],
                "bbox_normalized": [0.01, 0.02, 0.3, 0.4],
            },
            model_version="yolo26n.pt",
        )
        self.assertEqual(record["objects"][0]["class"], "person")
        self.assertEqual(record["objects"][0]["box"], [1, 2, 30, 40])
        self.assertEqual(record["original_frame_id"], 12)

    def test_ocr_empty_frame_still_has_valid_evidence_fields(self) -> None:
        record = normalize_ocr(
            self.identity,
            {"text": "", "boxes": [], "confidence": 0.0},
            model_version="PP-OCRv5",
        )
        self.assertEqual(record["text"], "")
        self.assertEqual(record["boxes"], [])
        self.assertEqual(record["segment_id"], "video-1-seg-0001")

    def test_normalized_object_record_validates_against_repository_contract(self) -> None:
        record = normalize_detections(self.identity, [], model_version="yolo26n.pt")
        validate_record("object_result", record)
        self.assertEqual(record["objects"], [])


if __name__ == "__main__":
    unittest.main()
