import json
import io
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import av
import numpy as np
import pandas as pd
from jsonschema import Draft202012Validator, FormatChecker

from pipelines.preprocessing.video_ingestion.probe import (
    MANIFEST_COLUMNS,
    _make_video_id,
    build_manifest,
    build_manifest_from_sources,
    probe_one,
    probe_source,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def _write_video(path: Path, frame_count: int, rate: Fraction) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=rate)
        stream.width = 64
        stream.height = 48
        stream.pix_fmt = "yuv420p"
        for frame_index in range(frame_count):
            image = np.zeros((48, 64, 3), dtype=np.uint8)
            image[:, :, frame_index % 3] = 40 + frame_index
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _video_manifest_validator() -> Draft202012Validator:
    schema_path = REPO_ROOT / "contracts" / "schemas" / "video_manifest" / "schema.json"
    with schema_path.open("r", encoding="utf-8") as source:
        schema = json.load(source)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


class FakeStore:
    def __init__(self, root: Path) -> None:
        self.manifest_path = root / "videos_manifest.parquet"
        self.failures = []

    def log_failed(self, path: str, reason: str) -> None:
        self.failures.append((path, reason))


class FakeRemoteClient:
    def __init__(self, payload: bytes):
        self.payload = payload

    def head_object(self, *, Bucket, Key, VersionId=None):
        return {
            "ContentLength": len(self.payload),
            "ETag": '"remote-etag"',
            "VersionId": "remote-v1",
        }

    def get_object(self, *, Bucket, Key, Range, IfMatch=None, VersionId=None):
        self.asserted_version_id = VersionId
        start_text, end_text = Range.removeprefix("bytes=").split("-", 1)
        start, end = int(start_text), int(end_text)
        return {
            "Body": io.BytesIO(self.payload[start : end + 1]),
            "ETag": '"remote-etag"',
            "VersionId": "remote-v1",
            "ContentRange": f"bytes {start}-{end}/{len(self.payload)}",
        }


class VideoProbeTest(unittest.TestCase):
    def test_probe_emits_canonical_and_legacy_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            video_path = Path(directory) / "clip with spaces.mp4"
            _write_video(video_path, frame_count=6, rate=Fraction(25, 1))

            record = {"video_id": "clip", **probe_one(str(video_path))}

            self.assertEqual(record["original_filename"], video_path.name)
            self.assertEqual(record["storage_uri"], video_path.resolve().as_uri())
            self.assertNotIn(" ", record["storage_uri"])
            self.assertEqual(record["fps_str"], "25/1")
            self.assertEqual(record["fps"], 25.0)
            self.assertEqual(record["width"], 64)
            self.assertEqual(record["height"], 48)
            self.assertGreater(record["duration_ms"], 0)
            self.assertIsNone(record["frame_count"])
            self.assertGreaterEqual(record["n_frames_est"], 6)
            self.assertEqual(record["path"], str(video_path.resolve()))
            self.assertEqual(record["size_bytes"], video_path.stat().st_size)
            self.assertEqual([], list(_video_manifest_validator().iter_errors(record)))

    def test_probe_preserves_fractional_fps(self):
        with tempfile.TemporaryDirectory() as directory:
            video_path = Path(directory) / "fractional.mp4"
            _write_video(video_path, frame_count=4, rate=Fraction(30000, 1001))

            record = probe_one(str(video_path))

            self.assertEqual(record["fps_str"], "30000/1001")
            self.assertAlmostEqual(record["fps"], 30000 / 1001, places=12)

    def test_video_ids_are_stable_for_duplicate_stems(self):
        seen = set()

        first = _make_video_id("L01/clip.mp4", seen)
        seen.add(first)
        second = _make_video_id("L02/clip.mp4", seen)
        seen.add(second)
        third = _make_video_id("L03/clip.mp4", seen)

        self.assertEqual((first, second, third), ("clip", "L02_clip", "L03_clip"))

    def test_build_manifest_writes_contract_valid_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_video(root / "L01" / "same.mp4", frame_count=3, rate=Fraction(10, 1))
            _write_video(root / "L02" / "same.mp4", frame_count=3, rate=Fraction(10, 1))
            store = FakeStore(root)
            cfg = SimpleNamespace(input_glob=str(root / "**" / "*.mp4"))

            manifest = build_manifest(cfg, store)
            persisted = pd.read_parquet(store.manifest_path)

            self.assertEqual(list(manifest.columns), MANIFEST_COLUMNS)
            self.assertEqual(manifest["video_id"].tolist(), ["L01_same", "L02_same"])
            self.assertEqual(persisted["video_id"].tolist(), ["L01_same", "L02_same"])
            self.assertEqual(store.failures, [])
            validator = _video_manifest_validator()
            for record in manifest.to_dict(orient="records"):
                self.assertEqual([], list(validator.iter_errors(record)))

    def test_empty_glob_still_writes_stable_manifest_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = FakeStore(root)
            cfg = SimpleNamespace(input_glob=str(root / "**" / "*.mp4"))

            manifest = build_manifest(cfg, store)
            persisted = pd.read_parquet(store.manifest_path)

            self.assertTrue(manifest.empty)
            self.assertEqual(list(manifest.columns), MANIFEST_COLUMNS)
            self.assertEqual(list(persisted.columns), MANIFEST_COLUMNS)

    def test_probes_r2_uri_and_persists_immutable_object_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local_video = root / "remote.mp4"
            _write_video(local_video, frame_count=4, rate=Fraction(30000, 1001))
            client = FakeRemoteClient(local_video.read_bytes())
            cfg = SimpleNamespace(
                video_source_kwargs=lambda _uri: {
                    "client": client,
                    "chunk_size": 512,
                }
            )
            uri = "r2://raw-videos/L01/remote.mp4"

            record = {"video_id": "remote", **probe_source(uri, cfg)}
            self.assertEqual(record["storage_uri"], uri)
            self.assertIsNone(record["path"])
            self.assertEqual(record["etag"], '"remote-etag"')
            self.assertEqual(record["version_id"], "remote-v1")
            self.assertEqual(record["fps_str"], "30000/1001")
            self.assertEqual([], list(_video_manifest_validator().iter_errors(record)))

            store = FakeStore(root)
            manifest = build_manifest_from_sources(cfg, store, [uri])
            persisted = pd.read_parquet(store.manifest_path)
            self.assertEqual(manifest.loc[0, "video_id"], "remote")
            self.assertEqual(persisted.loc[0, "etag"], '"remote-etag"')
            self.assertEqual(store.failures, [])


if __name__ == "__main__":
    unittest.main()
