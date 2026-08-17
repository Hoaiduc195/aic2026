import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from contracts.semantic_validation import ContractSemanticError, validate_record_semantics


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = REPO_ROOT / "contracts" / "schemas"


REQUIRED_SCHEMAS = (
    "artifact_manifest",
    "branch_result",
    "context_window",
    "event_score",
    "evidence",
    "evidence_relation",
    "micro_event",
    "processing_run",
    "qualification_request",
    "qualification_response",
    "query_plan",
    "trake_alignment",
    "textual_kis_response",
    "version_manifest",
    "vqa_response",
)


def _load_schema(schema_name: str) -> dict:
    path = SCHEMA_ROOT / schema_name / "schema.json"
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def _validator(schema_name: str) -> Draft202012Validator:
    schema = _load_schema(schema_name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


class QualificationContractTest(unittest.TestCase):
    def assert_valid(self, schema_name: str, record: dict) -> None:
        errors = sorted(
            _validator(schema_name).iter_errors(record),
            key=lambda error: list(error.path),
        )
        self.assertEqual([], errors, "\n".join(error.message for error in errors))

    def assert_invalid(self, schema_name: str, record: dict) -> None:
        self.assertTrue(list(_validator(schema_name).iter_errors(record)))

    def test_qualification_schema_set_is_machine_valid(self):
        for schema_name in REQUIRED_SCHEMAS:
            with self.subTest(schema=schema_name):
                _validator(schema_name)

    def test_every_schema_document_is_machine_valid(self):
        schema_paths = sorted(SCHEMA_ROOT.glob("*/schema.json"))
        self.assertGreaterEqual(len(schema_paths), len(REQUIRED_SCHEMAS))
        for path in schema_paths:
            with self.subTest(schema=path.parent.name):
                schema = json.loads(path.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(schema)

    def test_temporal_and_version_contracts(self):
        self.assert_valid(
            "micro_event",
            {
                "micro_event_id": "vid_01_evt_0001",
                "video_id": "vid_01",
                "start_ms": 12000,
                "end_ms": 13500,
                "event_type": "state_transition",
                "event_label": "object_released",
                "event_ordinal": 1,
                "confidence": 0.86,
                "producer": "temporal-baseline:v1",
            },
        )
        self.assert_valid(
            "context_window",
            {
                "context_window_id": "vid_01_ctx_0001",
                "video_id": "vid_01",
                "start_ms": 9000,
                "end_ms": 18000,
                "member_frame_ids": [148],
                "overlap_ms": 500,
                "granularity": "context_window",
            },
        )
        self.assert_valid(
            "version_manifest",
            {
                "dataset_id": "aic2026",
                "dataset_version": "qualification-v1",
                "pipeline_version": "pipe-v2",
                "schema_version": "1.0.0",
                "index_version": "idx-v1",
                "artifact_versions": {"retrieval_input": "artifacts-v1"},
                "model_versions": {"visual": "siglip-local-v1"},
                "checksums": {"index": "sha256:" + "a" * 64},
                "created_at": "2026-08-10T08:00:00Z",
                "status": "active",
            },
        )

    def test_artifact_and_processing_provenance_contracts(self):
        self.assert_valid(
            "processing_run",
            {
                "run_id": "run_01",
                "dataset_id": "aic2026",
                "dataset_version": "qualification-v1",
                "stage": "dense_alignment",
                "pipeline_version": "pipe-v2",
                "schema_version": "1.0.0",
                "config_hash": "sha256:abc123",
                "model_versions": {"selector": "transition-v1"},
                "status": "completed",
                "started_at": "2026-08-10T08:00:00Z",
                "finished_at": "2026-08-10T08:00:05Z",
                "input_artifact_ids": ["art_frames"],
                "output_artifact_ids": ["art_dense"],
                "errors": [],
            },
        )
        self.assert_valid(
            "artifact_manifest",
            {
                "artifact_id": "art_dense",
                "run_id": "run_01",
                "dataset_id": "aic2026",
                "dataset_version": "qualification-v1",
                "artifact_type": "dense_candidates",
                "uri": "s3://aic-artifacts/runs/run_01/dense.parquet",
                "sha256": "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab",
                "schema_name": "dense_candidate",
                "schema_version": "1.0.0",
                "size_bytes": 1024,
                "record_count": 20,
                "publication_state": "published",
                "created_at": "2026-08-10T08:00:05Z",
            },
        )

    def test_query_and_branch_contracts(self):
        self.assert_valid(
            "qualification_request",
            {
                "request_id": "req_01",
                "query_id": "q_01",
                "task": "vqa",
                "event_description": "một người đặt chai xuống bàn",
                "question": "Chai có màu gì?",
                "dataset_version": "qualification-v1",
                "top_k": 20,
                "latency_budget_ms": 1500,
            },
        )
        self.assert_valid(
            "query_plan",
            {
                "query_id": "q_01",
                "task": "vqa",
                "language": "vi",
                "original_query": "một người đặt chai xuống bàn; chai có màu gì?",
                "query_variants": ["người đặt chai xuống bàn"],
                "concepts": ["chai", "đặt xuống bàn"],
                "query_atoms": [
                    {"id": "object:person", "type": "object", "value": "person", "weight": 1.0},
                    {"id": "object:bottle", "type": "object", "value": "bottle", "weight": 1.0},
                ],
                "negative_concepts": [],
                "text_constraints": [],
                "audio_concepts": [],
                "object_terms": ["person", "bottle"],
                "object_constraints": {
                    "class_filters": ["person", "bottle"],
                    "excluded_classes": [],
                    "min_confidence": 0.25,
                    "counts": {},
                    "spatial": [],
                },
                "query_views": {
                    "visual": "một người đặt chai xuống bàn",
                    "caption": "một người đặt chai xuống bàn",
                    "object": "person bottle",
                },
                "channel_weights": {"visual": 1.0, "caption": 1.0, "object": 1.2},
                "temporal_relations": [],
                "target_granularities": ["frame"],
                "branches": ["visual", "caption", "object"],
                "top_k_per_branch": 100,
                "fusion_k": 100,
                "display_k": 20,
                "latency_budget_ms": 1500,
                "fallback_policy": "expand_then_clarify",
                "planner_version": "deterministic-v1",
                "fusion": "rrf",
                "index_version": "idx-v1",
                "hard_filters": {},
                "transformations": ["unicode_nfkc"],
            },
        )
        self.assert_valid(
            "branch_result",
            {
                "query_id": "q_01",
                "branch": "visual",
                "status": "completed",
                "query_variant": "người đặt chai xuống bàn",
                "candidates": [
                    {
                        "video_id": "vid_01",
                        "original_frame_id": 148,
                        "rank": 1,
                        "raw_score": 0.91,
                        "evidence_ids": ["ev_frame_01"],
                    }
                ],
                "elapsed_ms": 42,
                "deadline_ms": 300,
                "index_version": "idx-v1",
                "producer": "visual-branch:v1",
            },
        )
        self.assert_invalid(
            "qualification_request",
            {
                "request_id": "req_01",
                "query_id": "q_01",
                "task": "vqa",
                "dataset_version": "qualification-v1",
            },
        )

    def test_evidence_and_trake_alignment_contracts(self):
        self.assert_valid(
            "event_score",
            {
                "event_score_id": "score_01",
                "query_id": "q_trake_01",
                "event_id": "event_2",
                "video_id": "vid_01",
                "event_window_id": "window_2",
                "original_frame_id": 148,
                "score": 0.93,
                "score_type": "state_transition",
                "producer": "transition-scorer:v1",
                "model_version": "pose-v1",
                "evidence_ids": ["ev_frame_01"],
                "computed_at": "2026-08-10T08:00:04Z",
            },
        )
        self.assert_valid(
            "evidence",
            {
                "evidence_id": "ev_frame_01",
                "evidence_type": "frame",
                "video_id": "vid_01",
                "original_frame_id": 148,
                "start_ms": 4933,
                "end_ms": 4967,
                "confidence": 0.93,
                "producer": "transition-scorer:v1",
                "payload": {"state_before": "holding", "state_after": "released"},
            },
        )
        self.assert_valid(
            "evidence_relation",
            {
                "relation_id": "rel_01",
                "source_evidence_id": "ev_frame_01",
                "target_evidence_id": "ev_frame_02",
                "relation": "supports",
                "confidence": 0.88,
                "producer": "trake-aligner:v1",
            },
        )
        self.assert_valid(
            "trake_alignment",
            {
                "alignment_id": "align_01",
                "query_id": "q_trake_01",
                "video_id": "vid_01",
                "status": "completed",
                "sequence_score": 0.84,
                "ordering_valid": True,
                "events": [
                    {
                        "event_id": "event_1",
                        "event_ordinal": 1,
                        "event_label": "pick_up",
                        "event_window_id": "window_1",
                        "original_frame_id": 100,
                        "timestamp_ms": 3333,
                        "selection_score": 0.81,
                        "evidence_ids": ["ev_1"],
                    },
                    {
                        "event_id": "event_2",
                        "event_ordinal": 2,
                        "event_label": "release",
                        "event_window_id": "window_2",
                        "original_frame_id": 148,
                        "timestamp_ms": 4933,
                        "selection_score": 0.93,
                        "evidence_ids": ["ev_frame_01"],
                    },
                ],
                "selector": "viterbi:v1",
                "pipeline_version": "pipe-v2",
                "schema_version": "1.0.0",
            },
        )

    def test_qualification_response_carries_task_specific_outputs(self):
        self.assert_valid(
            "textual_kis_response",
            {
                "result_id": "kis_result_01",
                "query_id": "q_kis_01",
                "video_id": "vid_01",
                "original_frame_id": 148,
                "timestamp_ms": 4933,
                "score": 0.94,
                "evidence_ids": ["ev_frame_01"],
                "confidence": {"level": "high", "score": 0.92},
            },
        )
        self.assert_valid(
            "vqa_response",
            {
                "result_id": "qa_result_01",
                "query_id": "q_01",
                "video_id": "vid_01",
                "original_frame_id": 148,
                "timestamp_ms": 4933,
                "answer_status": "answered",
                "answer": "Màu xanh.",
                "normalized_answer": "xanh",
                "evidence_ids": ["ev_frame_01"],
                "confidence": {"level": "high", "score": 0.9},
                "producer": "vqa-evidence:v1",
            },
        )
        self.assert_valid(
            "qualification_response",
            {
                "request_id": "req_01",
                "query_id": "q_01",
                "task": "vqa",
                "status": "completed",
                "dataset_version": "qualification-v1",
                "pipeline_version": "pipe-v2",
                "schema_version": "1.0.0",
                "index_version": "idx-v1",
                "degraded": False,
                "confidence": {"level": "high", "score": 0.9},
                "results": [
                    {
                        "result_type": "vqa",
                        "result_id": "qa_result_01",
                        "video_id": "vid_01",
                        "original_frame_id": 148,
                        "timestamp_ms": 4933,
                        "answer_status": "answered",
                        "answer": "Màu xanh.",
                        "normalized_answer": "xanh",
                        "evidence_ids": ["ev_frame_01"],
                        "confidence": {"level": "high", "score": 0.9},
                    }
                ],
                "unavailable_branches": [],
            },
        )

    def test_search_response_examples_use_versioned_evidence_envelope(self):
        valid_path = REPO_ROOT / "contracts" / "examples" / "valid_outputs" / "search_response.valid.json"
        invalid_path = REPO_ROOT / "contracts" / "examples" / "invalid_outputs" / "search_response_missing_evidence.json"
        with valid_path.open("r", encoding="utf-8") as source:
            valid = json.load(source)
        with invalid_path.open("r", encoding="utf-8") as source:
            invalid = json.load(source)

        self.assert_valid("search_response", valid)
        self.assert_invalid("search_response", invalid)

    def test_frame_first_shapes_are_accepted(self):
        self.assert_valid(
            "search_response",
            {
                "query_id": "query_legacy_0001",
                "query": "tim xe may",
                "results": [
                    {
                        "video_id": "vid_legacy",
                        "original_frame_id": 12,
                        "timestamp_start_ms": 1000,
                        "timestamp_end_ms": 2000,
                        "preview_uri": "s3://bucket/preview.webp",
                        "score": 0.8,
                        "evidence": {"caption": "a motorcycle"},
                        "matched_modalities": ["embedding", "caption"],
                    }
                ],
            },
        )
        self.assert_valid(
            "ocr_result",
            {
                "video_id": "vid_legacy",
                "original_frame_id": 12,
                "frame_id": "frame_01",
                "timestamp_ms": 1000,
                "text": "xin chao",
                "boxes": [],
                "confidence": 0.8,
                "language": "vi",
            },
        )
        self.assert_valid(
            "embedding_result",
            {
                "video_id": "vid_legacy",
                "original_frame_id": 12,
                "frame_id": "frame_01",
                "timestamp_ms": 1000,
                "embedding_id": "emb_01",
                "embedding_uri": "s3://bucket/embeddings/emb_01.npy",
                "embedding_dim": 512,
                "model_name": "clip",
                "model_version": "v1",
            },
        )

    def test_task_and_artifact_fixtures(self):
        fixture_map = {
            "qualification_request": "qualification_request.valid.json",
            "trake_alignment": "trake_alignment.valid.json",
            "qualification_response": "qualification_response.valid.json",
            "event_score": "event_score.valid.json",
        }
        valid_root = REPO_ROOT / "contracts" / "examples" / "valid_outputs"
        for schema_name, filename in fixture_map.items():
            with self.subTest(schema=schema_name):
                with (valid_root / filename).open("r", encoding="utf-8") as source:
                    self.assert_valid(schema_name, json.load(source))

        invalid_root = REPO_ROOT / "contracts" / "examples" / "invalid_outputs"
        with (invalid_root / "qualification_request_missing_task_field.json").open(
            "r", encoding="utf-8"
        ) as source:
            self.assert_invalid("qualification_request", json.load(source))

    def test_semantic_contract_rules(self):
        valid_window = {
            "start_frame_id": 10,
            "end_frame_id": 20,
            "start_ms": 1000,
            "end_ms": 2000,
        }
        validate_record_semantics("event_window", valid_window)

        with self.assertRaises(ContractSemanticError):
            validate_record_semantics(
                "event_window",
                {**valid_window, "end_frame_id": 10},
            )

        valid_alignment = {
            "status": "completed",
            "events": [
                {"event_ordinal": 1, "original_frame_id": 10},
                {"event_ordinal": 2, "original_frame_id": 20},
            ],
        }
        validate_record_semantics("trake_alignment", valid_alignment)
        with self.assertRaises(ContractSemanticError):
            validate_record_semantics(
                "trake_alignment",
                {
                    "status": "completed",
                    "events": [
                        {"event_ordinal": 1, "original_frame_id": 20},
                        {"event_ordinal": 2, "original_frame_id": 10},
                    ],
                },
            )

        with self.assertRaises(ContractSemanticError):
            validate_record_semantics(
                "vqa_response",
                {
                    "answer_status": "answered",
                    "answer": "",
                    "evidence_ids": [],
                },
            )

    def test_caption_and_ocr_language_contracts(self):
        caption = {
            "video_id": "vid_01",
            "original_frame_id": 148,
            "timestamp_ms": 4933,
            "caption_en": "A person is holding a bottle.",
            "language": "en",
            "confidence": 0.9,
            "producer": "florence-caption:v1",
            "model_version": "florence-2-base",
            "pipeline_version": "caption-v2",
            "schema_version": "2.0.0",
        }
        self.assert_valid("caption_result", caption)
        self.assert_invalid("caption_result", {**caption, "language": "vi"})
        self.assert_invalid("caption_result", {**caption, "caption_vi": "Một người cầm chai."})

        ocr = {
            "video_id": "vid_01",
            "original_frame_id": 148,
            "timestamp_ms": 4933,
            "text": "Cửa hàng",
            "boxes": [],
            "confidence": 0.9,
            "language": "vi",
            "producer": "ocr:v1",
        }
        self.assert_valid("ocr_result", ocr)
        self.assert_invalid("ocr_result", {**ocr, "language": "en"})


if __name__ == "__main__":
    unittest.main()
