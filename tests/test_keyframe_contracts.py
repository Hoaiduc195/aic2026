import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from pipelines.preprocessing.video_source import VideoSourceError, parse_video_uri


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = REPO_ROOT / "contracts" / "schemas"
EXAMPLE_ROOT = REPO_ROOT / "contracts" / "examples"


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def _validator(schema_name: str) -> Draft202012Validator:
    schema = _load_json(SCHEMA_ROOT / schema_name / "schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


class KeyframeContractTest(unittest.TestCase):
    def assertContractValid(self, schema_name: str, record: dict) -> None:
        errors = sorted(_validator(schema_name).iter_errors(record), key=lambda error: list(error.path))
        self.assertEqual([], errors, "\n".join(error.message for error in errors))

    def test_video_manifest_valid_example_is_canonical(self):
        record = _load_json(EXAMPLE_ROOT / "valid_outputs" / "video_manifest.valid.json")

        self.assertContractValid("video_manifest", record)
        self.assertEqual(record["storage_uri"].split(":", 1)[0], "r2")
        self.assertEqual(record["fps_str"], "25/1")

    def test_video_manifest_accepts_augmented_legacy_probe_fields(self):
        # probe.py currently emits path/duration_s/fps/fps_str/n_frames_est.
        # An ingestion adapter only needs to add the canonical URI/duration and
        # original filename; it does not have to discard those useful fields.
        record = {
            "video_id": "L01_V001",
            "original_filename": "L01_V001.mp4",
            "storage_uri": "file:///D:/datasets/L01_V001.mp4",
            "duration_ms": 10010,
            "fps_str": "30000/1001",
            "width": 1920,
            "height": 1080,
            "path": "D:/datasets/L01_V001.mp4",
            "duration_s": 10.01,
            "fps": 29.97002997002997,
            "codec": "h264",
            "n_frames_est": 300,
        }

        self.assertContractValid("video_manifest", record)

    def test_plain_local_path_is_not_a_canonical_storage_uri(self):
        record = _load_json(
            EXAMPLE_ROOT / "invalid_outputs" / "local_path_instead_of_storage_uri.json"
        )
        errors = list(_validator("video_manifest").iter_errors(record))

        self.assertTrue(errors)
        self.assertIn("storage_uri", {str(part) for error in errors for part in error.path})

    def test_video_manifest_uri_matches_runtime_security_rules(self):
        valid = _load_json(EXAMPLE_ROOT / "valid_outputs" / "video_manifest.valid.json")
        validator = _validator("video_manifest")
        for unsafe_uri in (
            "r2://access:secret@bucket/video.mp4",
            "r2://bucket/video.mp4?token=secret",
            "https://example.com/video.mp4",
        ):
            with self.subTest(uri=unsafe_uri):
                record = {**valid, "storage_uri": unsafe_uri}
                self.assertTrue(list(validator.iter_errors(record)))

    def test_video_manifest_uri_shape_tracks_runtime_parser(self):
        valid = _load_json(EXAMPLE_ROOT / "valid_outputs" / "video_manifest.valid.json")
        validator = _validator("video_manifest")
        accepted = (
            "r2://bucket/folder/video%201@camera.mp4",
            "s3://bucket/video.mp4",
            "file:///D:/videos/camera@door.mp4",
            "file://localhost/D:/videos/camera.mp4",
        )
        rejected = (
            "r2://bucket",
            "r2:///video.mp4",
            "r2://bucket:9000/video.mp4",
            "r2://bucket/bad%ZZ.mp4",
            "file://server:9000/video.mp4",
        )

        for uri in accepted:
            with self.subTest(uri=uri):
                record = {**valid, "storage_uri": uri}
                self.assertEqual([], list(validator.iter_errors(record)))
                parse_video_uri(uri)
        for uri in rejected:
            with self.subTest(uri=uri):
                record = {**valid, "storage_uri": uri}
                self.assertTrue(list(validator.iter_errors(record)))
                with self.assertRaises(VideoSourceError):
                    parse_video_uri(uri)

    def test_canonical_source_frame_contract(self):
        self.assertContractValid(
            "frame",
            {
                "video_id": "L01_V001",
                "original_frame_id": 30,
                "decoded_frame_index": 30,
                "pts": 30030,
                "time_base_num": 1,
                "time_base_den": 30000,
                "fps_num": 30000,
                "fps_den": 1001,
                "raw_pts_timestamp_ms": 1001.0,
                "pts_origin_ms": 0.0,
                "pts_timestamp_ms": 1001.0,
                "cfr_timestamp_ms": 1001.0,
                "timestamp_ms": 1001.0,
                "timestamp_source": "pts",
                "is_codec_keyframe": False,
                "decode_status": "success",
                "width": 1920,
                "height": 1080,
                "brightness_score": 120.0,
                "blur_score": 315.2,
                "contrast_score": 40.1,
                "entropy_score": 6.5,
                "motion_score": 4.2,
                "scene_change_score": 0.1,
                "text_change_score": 0.02,
            },
        )

    def test_retrieval_keyframe_example_and_wrong_timestamp(self):
        valid = _load_json(EXAMPLE_ROOT / "valid_outputs" / "keyframe.valid.json")
        invalid = _load_json(EXAMPLE_ROOT / "invalid_outputs" / "timestamp_wrong_type.json")

        validator = _validator("keyframe")
        self.assertEqual([], list(validator.iter_errors(valid)))
        errors = list(validator.iter_errors(invalid))
        self.assertTrue(errors)
        self.assertIn("timestamp_ms", {str(part) for error in errors for part in error.path})

    def test_event_window_contract(self):
        self.assertContractValid(
            "event_window",
            {
                "event_window_id": "L01_V001_window_0001",
                "video_id": "L01_V001",
                "start_frame_id": 120,
                "end_frame_id": 151,
                "start_ms": 4000.0,
                "end_ms": 5033.333,
                "source": "retrieval_hits",
                "retrieval_score": 0.88,
                "member_frame_ids": [128, 145],
            },
        )

    def test_dense_candidate_contract(self):
        self.assertContractValid(
            "dense_candidate",
            {
                "event_window_id": "L01_V001_window_0001",
                "video_id": "L01_V001",
                "original_frame_id": 148,
                "timestamp_ms": 4938.267,
                "decode_status": "success",
                "quality_scores": {"blur_score": 210.5},
                "event_score": 0.93,
                "evidence": {"transition": "object_released"},
            },
        )

    def test_semantic_keyframe_contract(self):
        self.assertContractValid(
            "semantic_keyframe",
            {
                "event_window_id": "L01_V001_window_0001",
                "video_id": "L01_V001",
                "original_frame_id": 148,
                "timestamp_ms": 4938.267,
                "selection_score": 0.93,
                "selector": "transition_scorer:v1",
                "evidence": {"transition": "object_released"},
            },
        )


if __name__ == "__main__":
    unittest.main()
