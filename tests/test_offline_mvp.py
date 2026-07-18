import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from pipelines.fusion.publication import Evidence, fuse_evidence, publish_artifacts
from pipelines.offline_retrieval import IndexedRecord, evaluate_ranking, hybrid_search
from pipelines.preprocessing.dedup import DedupCandidate, cluster_duplicates
from pipelines.preprocessing.manifest import build_dataset_manifest
from pipelines.preprocessing.quality import score_quality
from pipelines.preprocessing.sampling import FrameCandidate, coverage_safe_sample
from pipelines.preprocessing.temporal import (
    TemporalNode,
    build_temporal_hierarchy,
    validate_hierarchy,
)
from contracts.validate import validate_contract


class ManifestTest(unittest.TestCase):
    def test_manifest_is_deterministic_content_checked_and_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "b.mp4").write_bytes(b"second")
            (root / "a.mp4").write_bytes(b"first")

            first = build_dataset_manifest("aic", "v1", root, [root / "b.mp4", root / "a.mp4"])
            second = build_dataset_manifest("aic", "v1", root, [root / "a.mp4", root / "b.mp4"])

        self.assertEqual(first, second)
        self.assertEqual([item.relative_path for item in first.assets], ["a.mp4", "b.mp4"])
        self.assertEqual(first.assets[0].sha256, hashlib.sha256(b"first").hexdigest())
        self.assertEqual(first.manifest_id, second.manifest_id)

    def test_manifest_rejects_escape_duplicate_and_missing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inside = root / "one.mp4"
            inside.write_bytes(b"one")
            outside = root.parent / "outside-aic-test.mp4"
            outside.write_bytes(b"outside")
            try:
                with self.assertRaisesRegex(ValueError, "outside dataset root"):
                    build_dataset_manifest("aic", "v1", root, [outside])
                with self.assertRaisesRegex(ValueError, "duplicate"):
                    build_dataset_manifest("aic", "v1", root, [inside, inside])
                with self.assertRaises(FileNotFoundError):
                    build_dataset_manifest("aic", "v1", root, [root / "missing.mp4"])
            finally:
                outside.unlink(missing_ok=True)

    def test_manifest_rejects_directory_and_empty_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "regular file"):
                build_dataset_manifest("aic", "v1", root, [root])
            with self.assertRaisesRegex(ValueError, "dataset_id"):
                build_dataset_manifest("", "v1", root, [])


class TemporalHierarchyTest(unittest.TestCase):
    def test_builds_complete_half_open_hierarchy(self):
        hierarchy = build_temporal_hierarchy(
            "video-1", duration_ms=10_000, frame_pts_ms=[0, 900, 2_000, 4_999, 5_000, 9_999],
            segment_boundaries_ms=[0, 5_000, 10_000], micro_event_ms=2_000,
            context_window_ms=10_000,
        )

        validate_hierarchy(hierarchy, expected_duration_ms=10_000)
        segments = [node for node in hierarchy if node.kind == "segment"]
        self.assertEqual([(node.start_ms, node.end_ms) for node in segments], [(0, 5_000), (5_000, 10_000)])
        boundary_frame = next(node for node in hierarchy if node.kind == "frame" and node.start_ms == 5_000)
        self.assertEqual(boundary_frame.parent_id, segments[1].node_id)

    def test_validator_rejects_gap_overlap_and_wrong_parent(self):
        context = TemporalNode("c", "v", "context_window", 0, 100, None)
        left = TemporalNode("s1", "v", "segment", 0, 40, "c")
        right = TemporalNode("s2", "v", "segment", 50, 100, "c")
        with self.assertRaisesRegex(ValueError, "coverage gap"):
            validate_hierarchy((context, left, right), expected_duration_ms=100)
        overlap = TemporalNode("s2", "v", "segment", 30, 100, "c")
        with self.assertRaisesRegex(ValueError, "overlap"):
            validate_hierarchy((context, left, overlap), expected_duration_ms=100)
        outside = TemporalNode("m", "v", "micro_event", 90, 110, "s2")
        with self.assertRaisesRegex(ValueError, "contained"):
            validate_hierarchy((context, TemporalNode("s2", "v", "segment", 0, 100, "c"), outside), expected_duration_ms=100)

    def test_hierarchy_is_deterministic_across_context_windows(self):
        arguments = dict(
            video_id="v", duration_ms=12_000, frame_pts_ms=[0, 6_000],
            segment_boundaries_ms=[0, 4_000, 8_000, 12_000], micro_event_ms=3_000,
            context_window_ms=8_000,
        )
        first = build_temporal_hierarchy(**arguments)
        second = build_temporal_hierarchy(**arguments)
        self.assertEqual(first, second)
        self.assertEqual(len([item for item in first if item.kind == "context_window"]), 2)
        with self.assertRaisesRegex(ValueError, "start at 0"):
            build_temporal_hierarchy("v", duration_ms=100, frame_pts_ms=[], segment_boundaries_ms=[1, 100])
        with self.assertRaisesRegex(ValueError, "unique"):
            build_temporal_hierarchy("v", duration_ms=100, frame_pts_ms=[0, 0], segment_boundaries_ms=[0, 100])


class SamplingQualityDedupTest(unittest.TestCase):
    def test_sampling_preserves_every_segment_and_short_boundary_event(self):
        segments = (
            TemporalNode("s1", "v", "segment", 0, 1000, "c"),
            TemporalNode("s2", "v", "segment", 1000, 1100, "c"),
        )
        frames = tuple(FrameCandidate(f"f{pts}", "v", pts, motion) for pts, motion in [
            (0, 0.1), (500, 0.2), (999, 0.1), (1000, 0.9), (1050, 0.2)
        ])
        selected = coverage_safe_sample(segments, frames, max_per_segment=2)

        self.assertEqual({item.segment_id for item in selected}, {"s1", "s2"})
        self.assertIn("f1000", {item.frame_id for item in selected})
        self.assertEqual(selected, tuple(sorted(selected, key=lambda item: (item.pts_ms, item.frame_id))))

    def test_quality_is_soft_scored_and_validated(self):
        dark = score_quality(brightness=2, blur_score=0.1, contrast=1)
        clear = score_quality(brightness=128, blur_score=100, contrast=55)
        self.assertEqual(dark.tier, "low")
        self.assertGreater(clear.score, dark.score)
        self.assertFalse(dark.hard_drop)
        with self.assertRaises(ValueError):
            score_quality(brightness=300, blur_score=1, contrast=1)
        with self.assertRaises(ValueError):
            Evidence("bool-time", "s", "ocr", True, 2, "x", 1, "v")

    def test_dedupe_is_deterministic_but_preserves_changed_ocr(self):
        candidates = (
            DedupCandidate("b", "v", 100, 0b0000, "BUS 18", 0.8),
            DedupCandidate("a", "v", 0, 0b0001, "BUS 18", 0.9),
            DedupCandidate("c", "v", 200, 0b0000, "BUS 19", 0.7),
        )
        clusters = cluster_duplicates(candidates, max_hamming_distance=1)
        self.assertEqual([cluster.members for cluster in clusters], [("a", "b"), ("c",)])
        self.assertEqual(clusters[0].representative_id, "a")

    def test_sampling_and_dedupe_fail_fast_on_invalid_boundaries(self):
        segment = TemporalNode("s", "v", "segment", 0, 100, "c")
        with self.assertRaisesRegex(ValueError, "no candidate"):
            coverage_safe_sample((segment,), (), max_per_segment=1)
        with self.assertRaisesRegex(ValueError, "positive"):
            coverage_safe_sample((segment,), (), max_per_segment=0)
        duplicate = DedupCandidate("f", "v", 0, 0, "", 1)
        with self.assertRaisesRegex(ValueError, "duplicate frame_id"):
            cluster_duplicates((duplicate, duplicate))
        with self.assertRaisesRegex(ValueError, "non-negative"):
            cluster_duplicates((), max_hamming_distance=-1)

    def test_quality_reports_overexposure_and_medium_tier(self):
        overexposed = score_quality(brightness=250, blur_score=100, contrast=64)
        self.assertIn("overexposed", overexposed.reasons)
        self.assertEqual(overexposed.tier, "medium")


class FusionPublicationTest(unittest.TestCase):
    def test_fusion_groups_modalities_and_rejects_out_of_bounds_evidence(self):
        segment = TemporalNode("s", "v", "segment", 0, 1000, "c")
        evidence = (
            Evidence("e2", "s", "ocr", 200, 400, "BEN THANH", 0.8, "ocr-v1"),
            Evidence("e1", "s", "asr", 0, 250, "Ben Thanh", 0.9, "asr-v1"),
        )
        fused = fuse_evidence((segment,), evidence)
        self.assertEqual(fused[0].evidence_ids, ("e1", "e2"))
        self.assertEqual(fused[0].modalities, ("asr", "ocr"))
        with self.assertRaisesRegex(ValueError, "outside segment"):
            fuse_evidence((segment,), (Evidence("bad", "s", "ocr", 900, 1100, "x", 1, "v"),))

    def test_publication_manifest_is_reproducible_and_checksums_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "b.json").write_text("{}", encoding="utf-8")
            (root / "a.json").write_text("[]", encoding="utf-8")
            first = publish_artifacts("run-1", "dataset-v1", "pipeline-v1", root, [root / "b.json", root / "a.json"])
            second = publish_artifacts("run-1", "dataset-v1", "pipeline-v1", root, [root / "a.json", root / "b.json"])
            payload = json.loads(first.to_json())
            validate_contract("publication_receipt", payload)
        self.assertEqual(first, second)
        self.assertEqual([item.relative_path for item in first.artifacts], ["a.json", "b.json"])
        self.assertEqual(payload["manifest_id"], first.manifest_id)

    def test_fusion_and_publication_reject_untrusted_references(self):
        segment = TemporalNode("s", "v", "segment", 0, 100, "c")
        unknown = Evidence("e", "missing", "ocr", 0, 10, "x", 1, "v1")
        with self.assertRaisesRegex(ValueError, "unknown segment"):
            fuse_evidence((segment,), (unknown,))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root.parent / "outside-artifact-test.json"
            outside.write_text("{}", encoding="utf-8")
            try:
                with self.assertRaisesRegex(ValueError, "outside publication root"):
                    publish_artifacts("run", "data", "pipe", root, [outside])
            finally:
                outside.unlink(missing_ok=True)


class OfflineRetrievalTest(unittest.TestCase):
    def setUp(self):
        self.records = (
            IndexedRecord("s1", "Xe buyt den Ben Thanh", (1.0, 0.0), 0, 1000),
            IndexedRecord("s2", "Nguoi di bo", (0.0, 1.0), 1000, 2000),
            IndexedRecord("s3", "ben thanh market", (0.8, 0.2), 2000, 3000),
        )

    def test_hybrid_search_supports_vietnamese_no_diacritic_and_vectors(self):
        ranked = hybrid_search(self.records, "bến thành", query_vector=(1.0, 0.0), top_k=2)
        self.assertEqual(ranked[0].record_id, "s1")
        self.assertEqual({item.record_id for item in ranked}, {"s1", "s3"})

    def test_retrieval_is_deterministic_validated_and_evaluated(self):
        first = hybrid_search(self.records, "unknown", query_vector=(0.0, 1.0), top_k=3)
        second = hybrid_search(tuple(reversed(self.records)), "unknown", query_vector=(0.0, 1.0), top_k=3)
        self.assertEqual(first, second)
        metrics = evaluate_ranking(["s2", "s1"], {"s1"}, k=2)
        self.assertEqual(metrics.recall_at_k, 1.0)
        self.assertEqual(metrics.reciprocal_rank, 0.5)
        with self.assertRaises(ValueError):
            hybrid_search(self.records, "x", query_vector=(1.0,), top_k=2)

    def test_empty_index_and_invalid_evaluation_are_explicit(self):
        self.assertEqual(hybrid_search((), "anything", query_vector=(1.0,), top_k=1), ())
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            evaluate_ranking([], set(), k=1)
        with self.assertRaisesRegex(ValueError, "positive"):
            evaluate_ranking([], {"s"}, k=0)
        with self.assertRaisesRegex(ValueError, "finite values"):
            hybrid_search(self.records, "x", query_vector=(True, 0.0), top_k=1)
        with self.assertRaisesRegex(ValueError, "finite values"):
            IndexedRecord("bad", "x", (True, 0.0), 0, 1)


if __name__ == "__main__":
    unittest.main()
