import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import av
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from jsonschema import Draft202012Validator

from pipelines.preprocessing.config import PipelineConfig
from pipelines.preprocessing.keyframes.extractor import (
    _remote_source_options,
    _retrieval_checkpoint_complete,
    extract_video,
    run_pass_b,
)
from pipelines.preprocessing.keyframes.frame_manifest import (
    FRAME_MANIFEST_SCHEMA,
    build_frame_manifest,
)
from pipelines.preprocessing.keyframes.workflow import (
    _video_source_options,
    build_event_window_artifact,
    run_dense_event_windows,
)
from pipelines.preprocessing.store import OutputStore


def _write_quality_routing_video(path: Path) -> None:
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=4)
        stream.width = 64
        stream.height = 48
        stream.pix_fmt = "yuv420p"
        stream.codec_context.gop_size = 4
        for frame_id in range(8):
            if frame_id < 4:
                image = np.zeros((48, 64, 3), dtype=np.uint8)
            else:
                yy, xx = np.indices((48, 64))
                checker = ((xx + yy + frame_id) % 2 * 255).astype(np.uint8)
                image = np.repeat(checker[:, :, None], 3, axis=2)
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _native(value):
    if isinstance(value, dict):
        return {key: _native(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_native(item) for item in value]
    if hasattr(value, "tolist"):
        return _native(value.tolist())
    if hasattr(value, "item"):
        return value.item()
    return value


class KeyframeExtractorWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.video_path = self.root / "routing.mp4"
        _write_quality_routing_video(self.video_path)
        self.store = OutputStore(str(self.root / "outputs"))
        self.video_row = pd.Series({
            "video_id": "routing",
            "original_filename": self.video_path.name,
            "storage_uri": self.video_path.resolve().as_uri(),
            "path": str(self.video_path),
            "duration_ms": 2_000,
            "duration_s": 2.0,
            "fps_str": "4/1",
            "fps": 4.0,
            "width": 64,
            "height": 48,
            "frame_count": 8,
            "n_frames_est": 8,
        })
        self.frame_manifest = build_frame_manifest(
            self.video_row,
            self.store.frame_manifest_path("routing"),
            signal_long_edge=64,
            quality_long_edge=64,
        )
        self.shots = pd.DataFrame([
            {
                "video_id": "routing",
                "shot_id": 0,
                "start_frame": 0,
                "end_frame": 3,
                "start_time": 0.0,
                "end_time": 0.75,
                "method": "test",
            },
            {
                "video_id": "routing",
                "shot_id": 1,
                "start_frame": 4,
                "end_frame": 7,
                "start_time": 1.0,
                "end_time": 1.75,
                "method": "test",
            },
        ])
        self.cfg = PipelineConfig(
            out_dir=str(self.store.root),
            device="cpu",
            embed=False,
            window_radius=0,
            include_shot_boundaries=False,
            signal_sampling=False,
            brightness_min=15.0,
            blur_min=0.0,
            std_min=1.0,
            phash_hamming_max=0,
            max_gap_s=0.0,
            webp_long_edge=64,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def _create_dense_checkpoint(self):
        windows = pd.DataFrame([{
            "event_window_id": "checkpoint_window",
            "video_id": "routing",
            "start_frame_id": 1,
            "end_frame_id": 5,
        }])
        video_manifest = pd.DataFrame([self.video_row.to_dict()])
        results = run_dense_event_windows(
            self.cfg,
            self.store,
            video_manifest,
            windows,
            resize=64,
        )
        self.assertEqual(results[0]["status"], "written")
        return (
            windows,
            video_manifest,
            self.store.dense_candidates_path("checkpoint_window"),
            self.store.semantic_keyframe_path("checkpoint_window"),
        )

    def test_temporal_only_candidate_never_enters_retrieval_artifact(self):
        meta = extract_video(
            self.video_row,
            self.shots,
            self.frame_manifest,
            self.cfg,
            self.store,
        )
        candidates = pd.read_parquet(self.store.retrieval_candidates_path("routing"))
        selected = pd.read_parquet(self.store.retrieval_frames_path("routing"))

        self.assertEqual(meta["quality_routing"], "no_hard_delete")
        self.assertEqual(set(candidates["quality_route"]), {"temporal_only", "retrieval_embedding"})
        temporal = candidates[candidates["quality_route"] == "temporal_only"]
        self.assertFalse(temporal["eligible_for_embedding"].any())
        self.assertFalse(temporal["selected_for_retrieval"].any())
        self.assertTrue((selected["quality_route"] == "retrieval_embedding").all())
        self.assertTrue(selected["eligible_for_embedding"].all())
        self.assertEqual(
            selected["timestamp_ms"].tolist(),
            self.frame_manifest.set_index("original_frame_id")
            .loc[selected["original_frame_id"], "timestamp_ms"]
            .tolist(),
        )

        schema = json.loads(
            (Path(__file__).parents[1] / "contracts/schemas/keyframe/schema.json").read_text()
        )
        for row in selected.to_dict("records"):
            self.assertEqual([], list(Draft202012Validator(schema).iter_errors(_native(row))))

    def test_sparse_hit_to_dense_selection_artifacts(self):
        extract_video(
            self.video_row,
            self.shots,
            self.frame_manifest,
            self.cfg,
            self.store,
        )
        hits = pd.read_parquet(self.store.retrieval_frames_path("routing"))
        windows_path = build_event_window_artifact(
            self.store,
            hits,
            "test_run",
            radius_ms=250.0,
            merge_gap_ms=0.0,
        )
        video_manifest = pd.DataFrame([self.video_row.to_dict()])
        results = run_dense_event_windows(
            self.cfg,
            self.store,
            video_manifest,
            windows_path,
            resize=64,
        )

        self.assertTrue(results)
        result = results[0]
        dense = pd.read_parquet(
            self.store.dense_candidates_path(result["event_window_id"])
        )
        semantic = json.loads(
            self.store.semantic_keyframe_path(result["event_window_id"]).read_text()
        )
        self.assertEqual(
            dense["original_frame_id"].tolist(),
            list(range(int(dense["original_frame_id"].min()), int(dense["original_frame_id"].max()) + 1)),
        )
        self.assertIn(semantic["original_frame_id"], dense["original_frame_id"].tolist())
        expected_ms = self.frame_manifest.set_index("original_frame_id").loc[
            semantic["original_frame_id"], "timestamp_ms"
        ]
        self.assertAlmostEqual(semantic["timestamp_ms"], expected_ms)

        resumed = run_dense_event_windows(
            self.cfg,
            self.store,
            video_manifest,
            windows_path,
            resize=64,
        )
        self.assertTrue(all(result["status"] == "skipped" for result in resumed))

        changed_windows = pd.read_parquet(windows_path).head(1)
        changed_windows.loc[:, "end_frame_id"] = (
            changed_windows["start_frame_id"] + 1
        )
        rebuilt = run_dense_event_windows(
            self.cfg,
            self.store,
            video_manifest,
            changed_windows,
            resize=64,
        )
        self.assertEqual(rebuilt[0]["status"], "written")
        rebuilt_dense = pd.read_parquet(
            self.store.dense_candidates_path(rebuilt[0]["event_window_id"])
        )
        self.assertEqual(len(rebuilt_dense), 1)

    def test_multi_window_scores_must_be_explicitly_scoped(self):
        windows = pd.DataFrame([
            {
                "event_window_id": "w1",
                "video_id": "routing",
                "start_frame_id": 0,
                "end_frame_id": 1,
            },
            {
                "event_window_id": "w2",
                "video_id": "routing",
                "start_frame_id": 1,
                "end_frame_id": 2,
            },
        ])
        scores = pd.DataFrame({"original_frame_id": [0, 1], "event_score": [0.1, 0.2]})

        with self.assertRaisesRegex(ValueError, "scope columns"):
            run_dense_event_windows(
                self.cfg,
                self.store,
                pd.DataFrame([self.video_row.to_dict()]),
                windows,
                event_scores=scores,
                resize=64,
            )

    def test_readable_but_invalid_dense_checkpoint_is_rebuilt(self):
        windows, video_manifest, dense_path, semantic_path = self._create_dense_checkpoint()

        def drop_required_column(frame):
            return frame.drop(columns=["timestamp_ms"])

        def use_float_frame_ids(frame):
            frame["original_frame_id"] = frame["original_frame_id"].astype(float)
            return frame

        def reorder_candidates(frame):
            return frame.iloc[::-1].reset_index(drop=True)

        def duplicate_candidate(frame):
            frame.loc[frame.index[-1], "original_frame_id"] = frame.loc[
                frame.index[-2], "original_frame_id"
            ]
            return frame

        def use_non_finite_timestamp(frame):
            frame.loc[frame.index[0], "timestamp_ms"] = np.inf
            return frame

        def use_failed_decode_status(frame):
            frame.loc[frame.index[0], "decode_status"] = "decode_error"
            return frame

        def use_wrong_window_id(frame):
            frame.loc[frame.index[0], "event_window_id"] = "another_window"
            return frame

        def use_wrong_video_id(frame):
            frame.loc[frame.index[0], "video_id"] = "another_video"
            return frame

        mutations = {
            "missing required column": drop_required_column,
            "non-integer frame ids": use_float_frame_ids,
            "out-of-order candidates": reorder_candidates,
            "duplicate candidate": duplicate_candidate,
            "non-finite timestamp": use_non_finite_timestamp,
            "unsuccessful decode": use_failed_decode_status,
            "wrong event window": use_wrong_window_id,
            "wrong video": use_wrong_video_id,
        }

        for name, mutate in mutations.items():
            with self.subTest(name=name):
                corrupt = mutate(pd.read_parquet(dense_path).copy(deep=True))
                corrupt.to_parquet(dense_path, index=False)

                rebuilt = run_dense_event_windows(
                    self.cfg,
                    self.store,
                    video_manifest,
                    windows,
                    resize=64,
                )

                self.assertEqual(rebuilt[0]["status"], "written")
                restored = pd.read_parquet(dense_path)
                self.assertEqual(restored["original_frame_id"].tolist(), [1, 2, 3, 4])
                self.assertEqual(set(restored["decode_status"]), {"success"})
                self.assertTrue(np.isfinite(restored["timestamp_ms"]).all())
                self.assertTrue(semantic_path.exists())

    def test_readable_but_invalid_semantic_checkpoint_is_rebuilt(self):
        windows, video_manifest, dense_path, semantic_path = self._create_dense_checkpoint()

        def use_list_record(record):
            return [record]

        def drop_required_field(record):
            record.pop("selection_score")
            return record

        def use_string_frame_id(record):
            record["original_frame_id"] = str(record["original_frame_id"])
            return record

        def use_non_finite_timestamp(record):
            record["timestamp_ms"] = float("inf")
            return record

        def use_mismatched_timestamp(record):
            record["timestamp_ms"] += 1.0
            return record

        def use_non_finite_score(record):
            record["selection_score"] = float("nan")
            return record

        def use_empty_selector(record):
            record["selector"] = ""
            return record

        def use_wrong_selector(record):
            record["selector"] = "another_selector"
            return record

        def use_wrong_window_id(record):
            record["event_window_id"] = "another_window"
            return record

        def use_wrong_video_id(record):
            record["video_id"] = "another_video"
            return record

        def use_non_object_evidence(record):
            record["evidence"] = []
            return record

        def use_wrong_fingerprint(record):
            record["evidence"]["workflow_fingerprint"] = "stale"
            return record

        mutations = {
            "record is not an object": use_list_record,
            "missing required field": drop_required_field,
            "non-integer selected frame": use_string_frame_id,
            "non-finite timestamp": use_non_finite_timestamp,
            "timestamp differs from dense candidate": use_mismatched_timestamp,
            "non-finite score": use_non_finite_score,
            "empty selector": use_empty_selector,
            "wrong selector": use_wrong_selector,
            "wrong event window": use_wrong_window_id,
            "wrong video": use_wrong_video_id,
            "evidence is not an object": use_non_object_evidence,
            "wrong fingerprint": use_wrong_fingerprint,
        }

        for name, mutate in mutations.items():
            with self.subTest(name=name):
                valid = json.loads(semantic_path.read_text(encoding="utf-8"))
                corrupt = mutate(valid)
                semantic_path.write_text(json.dumps(corrupt), encoding="utf-8")

                rebuilt = run_dense_event_windows(
                    self.cfg,
                    self.store,
                    video_manifest,
                    windows,
                    resize=64,
                )

                self.assertEqual(rebuilt[0]["status"], "written")
                restored = json.loads(semantic_path.read_text(encoding="utf-8"))
                self.assertIsInstance(restored, dict)
                self.assertIn(restored["original_frame_id"], [1, 2, 3, 4])
                self.assertTrue(np.isfinite(restored["timestamp_ms"]))
                self.assertTrue(np.isfinite(restored["selection_score"]))
                self.assertTrue(restored["selector"])
                self.assertTrue(dense_path.exists())

    def test_structurally_corrupt_retrieval_checkpoint_is_not_resumed(self):
        extract_video(
            self.video_row,
            self.shots,
            self.frame_manifest,
            self.cfg,
            self.store,
            stage_fingerprint="checkpoint-v1",
        )
        self.assertTrue(_retrieval_checkpoint_complete(
            self.store,
            "routing",
            fingerprint="checkpoint-v1",
            embed=False,
        ))

        self.store.metadata_path("routing").write_text("[]", encoding="utf-8")
        self.assertFalse(_retrieval_checkpoint_complete(
            self.store,
            "routing",
            fingerprint="checkpoint-v1",
            embed=False,
        ))

        extract_video(
            self.video_row,
            self.shots,
            self.frame_manifest,
            self.cfg,
            self.store,
            stage_fingerprint="checkpoint-v1",
        )
        selected = pd.read_parquet(self.store.retrieval_frames_path("routing"))
        selected.drop(columns=["eligible_for_embedding"]).to_parquet(
            self.store.retrieval_frames_path("routing"), index=False
        )
        self.assertFalse(_retrieval_checkpoint_complete(
            self.store,
            "routing",
            fingerprint="checkpoint-v1",
            embed=False,
        ))

    def test_empty_frame_manifest_writes_terminal_resumable_checkpoint(self):
        empty_store = OutputStore(str(self.root / "empty-output"))
        pq.write_table(
            pa.Table.from_pylist([], schema=FRAME_MANIFEST_SCHEMA),
            empty_store.frame_manifest_path("routing"),
        )
        self.shots.to_parquet(empty_store.shots_path("routing"), index=False)
        manifest = pd.DataFrame([self.video_row.to_dict()])

        run_pass_b(self.cfg, empty_store, manifest)
        metadata = json.loads(empty_store.metadata_path("routing").read_text())
        self.assertEqual(metadata["status"], "no_video_frames")
        self.assertEqual(metadata["n_keyframes"], 0)
        self.assertTrue(pd.read_parquet(
            empty_store.retrieval_candidates_path("routing")
        ).empty)
        self.assertTrue(pd.read_parquet(
            empty_store.retrieval_frames_path("routing")
        ).empty)

        with patch(
            "pipelines.preprocessing.keyframes.extractor._write_no_video_checkpoint"
        ) as writer:
            run_pass_b(self.cfg, empty_store, manifest)
        writer.assert_not_called()

    def test_remote_identity_is_forwarded_to_sparse_and_dense_readers(self):
        client = object()
        cfg = PipelineConfig(out_dir=str(self.store.root), device="cpu", embed=False)
        cfg.video_source_client = {"r2": client}
        remote_row = pd.Series({
            "etag": '"object-etag"',
            "version_id": "object-version",
        })
        uri = "r2://raw/video.mp4"

        sparse = _remote_source_options(uri, cfg, video_row=remote_row)
        dense = _video_source_options(cfg, uri, remote_row)
        for options in (sparse, dense):
            self.assertIs(options["client"], client)
            self.assertEqual(options["expected_etag"], '"object-etag"')
            self.assertEqual(options["expected_version_id"], "object-version")

    def test_dino_cluster_medoids_drive_the_structural_dedup_lane(self):
        class IdenticalStructuralEmbedder:
            def encode_images(self, images):
                return np.tile(np.array([[1.0, 0.0]], dtype=np.float32), (len(images), 1))

        self.cfg.brightness_min = 0.0
        self.cfg.std_min = 0.0
        self.cfg.dino_mode = "cluster_medoids"
        self.cfg.dino_similarity_threshold = 0.9
        with patch(
            "pipelines.preprocessing.keyframes.extractor.phash_dedup",
            side_effect=lambda items, _threshold: items,
        ):
            meta = extract_video(
                self.video_row,
                self.shots,
                self.frame_manifest,
                self.cfg,
                self.store,
                structural_embedder=IdenticalStructuralEmbedder(),
            )
        selected = pd.read_parquet(self.store.retrieval_frames_path("routing"))

        self.assertGreater(meta["n_after_phash"], 1)
        self.assertEqual(meta["n_after_cosine"], 1)
        self.assertEqual(meta["structural_dedup_backend"], "dinov2_cluster_medoids")
        self.assertEqual(meta["dino_mode"], "cluster_medoids")
        self.assertEqual(len(selected), 1)
        self.assertIn("cluster_medoid", selected.iloc[0]["retrieval_roles"])


if __name__ == "__main__":
    unittest.main()
