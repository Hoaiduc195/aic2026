"""Build the canonical, full-frame timeline for one video.

The frame manifest is deliberately created by a sequential decode from the
start of the video.  Consequently ``original_frame_id`` is a source-frame
identity, not a keyframe number and not a timestamp rounded back to a frame.

Image signals in this module are intentionally cheap.  They are useful for
later candidate generation, but ``text_change_score`` is only an edge-change
proxy; it is not OCR and must not be treated as recognized text.
"""

from __future__ import annotations

import math
import json
import time
import hashlib
from fractions import Fraction
from os import PathLike
from pathlib import Path
from typing import Any, Mapping

import av
import cv2
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..io_utils import atomic_output_path, write_json_atomic, write_parquet_atomic
from ..video_source import open_video_source, parse_video_uri
from .quality import quality_scores, resize_long_edge


FRAME_MANIFEST_SCHEMA = pa.schema(
    [
        pa.field("video_id", pa.string(), nullable=False),
        pa.field("original_frame_id", pa.int64(), nullable=False),
        pa.field("decoded_frame_index", pa.int64(), nullable=False),
        pa.field("pts", pa.int64(), nullable=True),
        pa.field("time_base_num", pa.int64(), nullable=True),
        pa.field("time_base_den", pa.int64(), nullable=True),
        pa.field("fps_num", pa.int64(), nullable=True),
        pa.field("fps_den", pa.int64(), nullable=True),
        pa.field("raw_pts_timestamp_ms", pa.float64(), nullable=True),
        pa.field("pts_origin_ms", pa.float64(), nullable=True),
        pa.field("pts_timestamp_ms", pa.float64(), nullable=True),
        pa.field("cfr_timestamp_ms", pa.float64(), nullable=True),
        pa.field("timestamp_ms", pa.float64(), nullable=True),
        pa.field("timestamp_source", pa.string(), nullable=False),
        pa.field("is_codec_keyframe", pa.bool_(), nullable=False),
        pa.field("decode_status", pa.string(), nullable=False),
        pa.field("width", pa.int32(), nullable=False),
        pa.field("height", pa.int32(), nullable=False),
        pa.field("brightness_score", pa.float32(), nullable=False),
        pa.field("blur_score", pa.float32(), nullable=False),
        pa.field("contrast_score", pa.float32(), nullable=False),
        pa.field("entropy_score", pa.float32(), nullable=False),
        pa.field("motion_score", pa.float32(), nullable=False),
        pa.field("scene_change_score", pa.float32(), nullable=False),
        pa.field("text_change_score", pa.float32(), nullable=False),
    ],
    metadata={b"frame_manifest_schema_version": b"1"},
)


def _row_value(video_row: Mapping[str, Any] | pd.Series | Any, key: str) -> Any:
    if isinstance(video_row, Mapping):
        return video_row.get(key)
    if isinstance(video_row, pd.Series):
        return video_row.get(key)
    return getattr(video_row, key, None)


def _has_source_value(value: Any) -> bool:
    if value is None:
        return False
    try:
        if bool(pd.isna(value)):
            return False
    except (TypeError, ValueError):
        pass
    return bool(str(value).strip())


def _source_reference(video_row: Any) -> str | PathLike[str]:
    storage_uri = _row_value(video_row, "storage_uri")
    if _has_source_value(storage_uri):
        return storage_uri
    path = _row_value(video_row, "path")
    if not _has_source_value(path):
        raise ValueError("video_row must contain storage_uri or a local path")
    return path


_VIDEO_SOURCE_OPTION_NAMES = {
    "endpoint_url",
    "region_name",
    "chunk_size",
    "max_cached_chunks",
    "max_retries",
    "expected_etag",
    "expected_version_id",
}


def _checked_source_options(source_options: Mapping[str, Any] | None) -> dict[str, Any]:
    if source_options is None:
        return {}
    if not isinstance(source_options, Mapping):
        raise TypeError("source_options must be a mapping")
    unknown = set(source_options) - _VIDEO_SOURCE_OPTION_NAMES
    if unknown:
        raise ValueError(f"unsupported video source options: {sorted(unknown)}")
    # This copy is used only to open the source.  It is never included in a
    # manifest row, exception message, or batch failure log.
    return dict(source_options)


def _manifest_identity_options(video_row: Any, source: str | PathLike[str]) -> dict[str, str]:
    """Return manifest-declared immutable identity for a remote source."""

    if parse_video_uri(source).path is not None:
        return {}
    options: dict[str, str] = {}
    for field, option in (
        ("etag", "expected_etag"),
        ("version_id", "expected_version_id"),
    ):
        value = _row_value(video_row, field)
        if _has_source_value(value):
            options[option] = str(value)
    return options


def _positive_fraction(value: Any) -> Fraction | None:
    if value is None:
        return None
    try:
        fraction = value if isinstance(value, Fraction) else Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        return None
    return fraction if fraction > 0 else None


def _manifest_fps(video_row: Any, stream: Any | None) -> Fraction | None:
    # fps_str is the exact value written by video_ingestion.probe.  Do not
    # round-trip through its convenience float column.
    fps = _positive_fraction(_row_value(video_row, "fps_str"))
    if fps is not None:
        return fps
    if stream is not None:
        fps = _positive_fraction(stream.average_rate)
        if fps is not None:
            return fps
    return _positive_fraction(_row_value(video_row, "fps"))


def _fraction_parts(value: Any) -> tuple[int | None, int | None]:
    if value is None:
        return None, None
    try:
        fraction = value if isinstance(value, Fraction) else Fraction(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None, None
    if fraction.denominator <= 0:
        return None, None
    return int(fraction.numerator), int(fraction.denominator)


def _timestamp_ms(numerator: int, denominator: int) -> float:
    return float(Fraction(numerator * 1000, denominator))


def _gray_and_edges(rgb: np.ndarray, signal_long_edge: int) -> tuple[np.ndarray, np.ndarray]:
    small = resize_long_edge(rgb, signal_long_edge)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    return gray, edges


def _gray_histogram(gray: np.ndarray) -> np.ndarray:
    histogram = cv2.calcHist([gray], [0], None, [64], [0, 256])
    return cv2.normalize(histogram, None, alpha=1.0, norm_type=cv2.NORM_L1)


def _same_shape(previous: np.ndarray, current: np.ndarray) -> np.ndarray:
    if previous.shape == current.shape:
        return previous
    return cv2.resize(previous, (current.shape[1], current.shape[0]), interpolation=cv2.INTER_AREA)


def _change_signals(
    gray: np.ndarray,
    edges: np.ndarray,
    previous_gray: np.ndarray | None,
    previous_edges: np.ndarray | None,
    previous_histogram: np.ndarray | None,
) -> tuple[float, float, float, np.ndarray]:
    histogram = _gray_histogram(gray)
    if previous_gray is None or previous_edges is None or previous_histogram is None:
        return 0.0, 0.0, 0.0, histogram

    aligned_gray = _same_shape(previous_gray, gray)
    aligned_edges = _same_shape(previous_edges, edges)
    motion = float(cv2.absdiff(gray, aligned_gray).mean())
    scene_change = float(
        cv2.compareHist(previous_histogram, histogram, cv2.HISTCMP_BHATTACHARYYA)
    )
    # Edge XOR is a lightweight signal for changed glyph-like structures.  A
    # later OCR branch is responsible for deciding whether the change is text.
    # Percentage of changed edge pixels (0..100), matching the configured
    # ``text_change_peak_min`` scale used by sparse sampling.
    text_change = float(100.0 * np.count_nonzero(edges != aligned_edges) / edges.size)
    return motion, scene_change, text_change, histogram


def _empty_table() -> pa.Table:
    return pa.Table.from_pylist([], schema=FRAME_MANIFEST_SCHEMA)


def _write_table(table: pa.Table, output_path: str | PathLike[str]) -> None:
    path = Path(output_path)
    with atomic_output_path(path) as temporary:
        pq.write_table(table, temporary)


def build_frame_manifest(
    video_row: Mapping[str, Any] | pd.Series | Any,
    output_path: str | PathLike[str],
    signal_long_edge: int = 320,
    quality_long_edge: int = 720,
    *,
    client: Any | None = None,
    source_options: Mapping[str, Any] | None = None,
) -> pd.DataFrame:
    """Sequentially decode a video and persist one manifest row per frame.

    ``timestamp_ms`` uses a frame PTS and its time base whenever both exist.
    ``cfr_timestamp_ms`` is also retained as an exact-FPS diagnostic/fallback.
    Videos with no video stream, or a valid video stream containing no frames,
    produce a readable empty Parquet file with :data:`FRAME_MANIFEST_SCHEMA`.
    Decode errors are deliberately propagated so callers cannot mistake a
    partial timeline for a complete one.
    """
    if signal_long_edge <= 0 or quality_long_edge <= 0:
        raise ValueError("signal_long_edge and quality_long_edge must be positive")

    video_id_value = _row_value(video_row, "video_id")
    if video_id_value is None or not str(video_id_value).strip():
        raise ValueError("video_row must contain a non-empty video_id")
    video_id = str(video_id_value)

    source = _source_reference(video_row)
    options = _checked_source_options(source_options)

    rows: list[dict[str, Any]] = []
    source_context = open_video_source(source, client=client, **options)
    with source_context as opened_source, av.open(opened_source) as container:
        stream = next(iter(container.streams.video), None)
        if stream is None:
            table = _empty_table()
            _write_table(table, output_path)
            return table.to_pandas()

        fps = _manifest_fps(video_row, stream)
        fps_num = fps.numerator if fps is not None else None
        fps_den = fps.denominator if fps is not None else None

        previous_gray: np.ndarray | None = None
        previous_edges: np.ndarray | None = None
        previous_histogram: np.ndarray | None = None
        pts_origin_ms: float | None = None

        for decoded_frame_index, frame in enumerate(container.decode(stream)):
            rgb = frame.to_ndarray(format="rgb24")
            quality_rgb = resize_long_edge(rgb, quality_long_edge)
            scores = quality_scores(quality_rgb)
            gray, edges = _gray_and_edges(rgb, signal_long_edge)
            motion, scene_change, text_change, histogram = _change_signals(
                gray,
                edges,
                previous_gray,
                previous_edges,
                previous_histogram,
            )

            frame_time_base = frame.time_base or stream.time_base
            time_base_num, time_base_den = _fraction_parts(frame_time_base)
            pts = int(frame.pts) if frame.pts is not None else None

            raw_pts_timestamp_ms: float | None = None
            if pts is not None and time_base_num is not None and time_base_den is not None:
                raw_pts_timestamp_ms = _timestamp_ms(pts * time_base_num, time_base_den)

            cfr_timestamp_ms: float | None = None
            if fps_num is not None and fps_den is not None:
                cfr_timestamp_ms = _timestamp_ms(decoded_frame_index * fps_den, fps_num)

            if raw_pts_timestamp_ms is not None and pts_origin_ms is None:
                # Align the first usable PTS to its CFR position when earlier
                # decoded frames lacked PTS; normally this makes frame 0 time 0.
                pts_origin_ms = raw_pts_timestamp_ms - (cfr_timestamp_ms or 0.0)
            pts_timestamp_ms = (
                raw_pts_timestamp_ms - pts_origin_ms
                if raw_pts_timestamp_ms is not None and pts_origin_ms is not None
                else None
            )
            if pts_timestamp_ms is not None and abs(pts_timestamp_ms) < 1e-9:
                pts_timestamp_ms = 0.0

            if pts_timestamp_ms is not None:
                timestamp_ms = pts_timestamp_ms
                timestamp_source = "pts"
            elif cfr_timestamp_ms is not None:
                timestamp_ms = cfr_timestamp_ms
                timestamp_source = "cfr_fallback"
            else:
                timestamp_ms = None
                timestamp_source = "unavailable"

            rows.append(
                {
                    "video_id": video_id,
                    "original_frame_id": decoded_frame_index,
                    "decoded_frame_index": decoded_frame_index,
                    "pts": pts,
                    "time_base_num": time_base_num,
                    "time_base_den": time_base_den,
                    "fps_num": fps_num,
                    "fps_den": fps_den,
                    "raw_pts_timestamp_ms": raw_pts_timestamp_ms,
                    "pts_origin_ms": pts_origin_ms,
                    "pts_timestamp_ms": pts_timestamp_ms,
                    "cfr_timestamp_ms": cfr_timestamp_ms,
                    "timestamp_ms": timestamp_ms,
                    "timestamp_source": timestamp_source,
                    "is_codec_keyframe": bool(frame.key_frame),
                    "decode_status": "success",
                    "width": int(frame.width),
                    "height": int(frame.height),
                    "brightness_score": scores["brightness_score"],
                    "blur_score": scores["blur_score"],
                    "contrast_score": scores["contrast_score"],
                    "entropy_score": scores["entropy_score"],
                    "motion_score": motion,
                    "scene_change_score": scene_change,
                    "text_change_score": text_change,
                }
            )
            previous_gray = gray
            previous_edges = edges
            previous_histogram = histogram

        if pts_origin_ms is not None:
            for row in rows:
                row["pts_origin_ms"] = pts_origin_ms

    table = pa.Table.from_pylist(rows, schema=FRAME_MANIFEST_SCHEMA) if rows else _empty_table()
    validate_frame_manifest(table)
    _write_table(table, output_path)
    return table.to_pandas()


def _as_table(value: pa.Table | pd.DataFrame | str | PathLike[str]) -> pa.Table:
    if isinstance(value, pa.Table):
        return value
    if isinstance(value, pd.DataFrame):
        return pa.Table.from_pandas(
            value,
            schema=FRAME_MANIFEST_SCHEMA,
            preserve_index=False,
            safe=True,
        )
    return pq.read_table(Path(value))


def validate_frame_manifest(
    value: pa.Table | pd.DataFrame | str | PathLike[str],
) -> None:
    """Raise ``ValueError`` if a manifest violates timeline/schema invariants."""
    table = _as_table(value)
    if not table.schema.equals(FRAME_MANIFEST_SCHEMA, check_metadata=False):
        raise ValueError(
            "frame manifest schema mismatch: "
            f"expected {FRAME_MANIFEST_SCHEMA.names}, got {table.schema.names}"
        )
    if table.num_rows == 0:
        return

    data = table.to_pydict()
    expected_ids = list(range(table.num_rows))
    if data["original_frame_id"] != expected_ids:
        raise ValueError("original_frame_id must be contiguous and zero-based")
    if data["decoded_frame_index"] != expected_ids:
        raise ValueError("decoded_frame_index must equal original_frame_id")
    if len(set(data["video_id"])) != 1 or not data["video_id"][0]:
        raise ValueError("all rows must have one non-empty video_id")
    if any(status != "success" for status in data["decode_status"]):
        raise ValueError("every stored row must have decode_status='success'")

    for row_index in range(table.num_rows):
        fps_num = data["fps_num"][row_index]
        fps_den = data["fps_den"][row_index]
        if (fps_num is None) != (fps_den is None):
            raise ValueError("fps_num and fps_den must be null together")
        if fps_den is not None and (fps_num <= 0 or fps_den <= 0):
            raise ValueError("FPS fraction must be positive")

        tb_num = data["time_base_num"][row_index]
        tb_den = data["time_base_den"][row_index]
        if (tb_num is None) != (tb_den is None):
            raise ValueError("time_base_num and time_base_den must be null together")
        if tb_den is not None and tb_den <= 0:
            raise ValueError("time-base denominator must be positive")

        pts = data["pts"][row_index]
        raw_pts_ms = data["raw_pts_timestamp_ms"][row_index]
        pts_origin_ms = data["pts_origin_ms"][row_index]
        pts_ms = data["pts_timestamp_ms"][row_index]
        cfr_ms = data["cfr_timestamp_ms"][row_index]
        timestamp_ms = data["timestamp_ms"][row_index]
        source = data["timestamp_source"][row_index]

        if pts is not None and tb_num is not None and tb_den is not None:
            expected_raw_pts_ms = _timestamp_ms(pts * tb_num, tb_den)
            if raw_pts_ms is None or not math.isclose(
                raw_pts_ms, expected_raw_pts_ms, abs_tol=1e-6
            ):
                raise ValueError(f"row {row_index} has an invalid raw PTS timestamp")
            if pts_origin_ms is None:
                raise ValueError(f"row {row_index} is missing its PTS origin")
            expected_pts_ms = raw_pts_ms - pts_origin_ms
            if pts_ms is None or not math.isclose(pts_ms, expected_pts_ms, abs_tol=1e-6):
                raise ValueError(f"row {row_index} has an invalid relative PTS timestamp")
        if fps_num is not None and fps_den is not None:
            expected_cfr_ms = _timestamp_ms(row_index * fps_den, fps_num)
            if cfr_ms is None or not math.isclose(cfr_ms, expected_cfr_ms, abs_tol=1e-6):
                raise ValueError(f"row {row_index} has an invalid CFR timestamp")

        if pts_ms is not None:
            if source != "pts" or timestamp_ms is None or not math.isclose(
                timestamp_ms, pts_ms, abs_tol=1e-6
            ):
                raise ValueError(f"row {row_index} must prefer its PTS timestamp")
        elif cfr_ms is not None:
            if source != "cfr_fallback" or timestamp_ms is None or not math.isclose(
                timestamp_ms, cfr_ms, abs_tol=1e-6
            ):
                raise ValueError(f"row {row_index} has an invalid CFR fallback")
        elif source != "unavailable" or timestamp_ms is not None:
            raise ValueError(f"row {row_index} has an invalid unavailable timestamp")

    non_null_pts = [value for value in data["pts"] if value is not None]
    if len(non_null_pts) != len(set(non_null_pts)):
        raise ValueError("non-null PTS values must be unique")
    canonical_times = [value for value in data["timestamp_ms"] if value is not None]
    if any(not math.isfinite(value) or value < 0 for value in canonical_times):
        raise ValueError("canonical timestamps must be finite and non-negative")
    if any(right < left for left, right in zip(canonical_times, canonical_times[1:])):
        raise ValueError("canonical timestamps must be non-decreasing")


def load_frame_manifest(
    path: str | PathLike[str],
    *,
    validate: bool = True,
) -> pd.DataFrame:
    """Load a frame manifest, optionally checking its schema and timeline."""
    table = pq.read_table(Path(path))
    if validate:
        validate_frame_manifest(table)
    return table.to_pandas()


def _frame_stage_fingerprint(
    video_row: Any,
    source: str | PathLike[str],
    cfg: Any,
    source_kwargs: Mapping[str, Any],
) -> tuple[str, dict[str, Any]]:
    parsed = parse_video_uri(source)
    if parsed.path is not None:
        stat = parsed.path.stat()
        identity: dict[str, Any] = {
            "scheme": "local",
            "size_bytes": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
    else:
        with open_video_source(source, **dict(source_kwargs)) as opened:
            identity = {
                "scheme": parsed.scheme,
                "size_bytes": int(getattr(opened, "size")),
                "etag": getattr(opened, "etag", None),
                "version_id": getattr(opened, "version_id", None),
            }
    payload = {
        "version": "frame_manifest_v2",
        "video_id": str(_row_value(video_row, "video_id")),
        "source": identity,
        "fps_str": str(_row_value(video_row, "fps_str") or ""),
        "signal_long_edge": int(cfg.frame_signal_long_edge),
        "quality_long_edge": int(cfg.webp_long_edge),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest(), identity


def run_frame_manifest(
    cfg: Any,
    store: Any,
    manifest: pd.DataFrame,
    limit: int | None = None,
) -> None:
    """Build resumable per-video full-frame checkpoints for a batch.

    Optional remote access is resolved by ``cfg.video_source_kwargs(uri)``.
    Client/endpoint options are never written to an artifact or failure log.
    """
    if not isinstance(manifest, pd.DataFrame):
        raise TypeError("manifest must be a pandas DataFrame")
    if "video_id" not in manifest.columns:
        raise ValueError("manifest must contain video_id")
    if manifest["video_id"].astype(str).duplicated().any():
        raise ValueError("manifest contains duplicate video_id values")
    if limit is not None:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise ValueError("limit must be a non-negative integer or None")
        todo = manifest.head(limit)
    else:
        todo = manifest

    signal_long_edge = cfg.frame_signal_long_edge
    quality_long_edge = cfg.webp_long_edge
    done = skipped = failed = 0
    exact_counts: dict[str, int] = {}
    observed_identities: dict[str, dict[str, Any]] = {}

    for _, row in todo.iterrows():
        video_id_value = _row_value(row, "video_id")
        video_id = str(video_id_value) if _has_source_value(video_id_value) else "unknown-video"
        try:
            started = time.perf_counter()
            source = _source_reference(row)
            source_kwargs = (
                cfg.video_source_kwargs(str(source))
                if hasattr(cfg, "video_source_kwargs")
                else {}
            )
            source_kwargs.update(_manifest_identity_options(row, source))
            fingerprint, source_identity = _frame_stage_fingerprint(
                row,
                source,
                cfg,
                source_kwargs,
            )
            observed_identities[video_id] = source_identity
            # If a curated manifest did not yet carry an object identity, pin
            # the decode to the exact revision observed by the fingerprint
            # HEAD request. This closes the HEAD->decode replacement window.
            if parse_video_uri(source).path is None:
                if source_identity.get("etag"):
                    source_kwargs.setdefault("expected_etag", source_identity["etag"])
                if source_identity.get("version_id"):
                    source_kwargs.setdefault(
                        "expected_version_id", source_identity["version_id"]
                    )
            source_client = source_kwargs.pop("client", None)
            output_path = store.frame_manifest_path(video_id)
            stats_path_factory = getattr(store, "frame_manifest_stats_path", None)
            stats_path = (
                Path(stats_path_factory(video_id))
                if callable(stats_path_factory)
                else Path(output_path).with_suffix(".stats.json")
            )
            if Path(output_path).exists():
                try:
                    validate_frame_manifest(output_path)
                    stats = json.loads(stats_path.read_text(encoding="utf-8"))
                except (OSError, ValueError, pa.ArrowException):
                    # An incomplete/corrupt checkpoint is not considered done;
                    # build_frame_manifest will replace it only after decoding.
                    pass
                else:
                    if stats.get("fingerprint") != fingerprint:
                        pass
                    else:
                        exact_counts[video_id] = pq.read_metadata(output_path).num_rows
                        skipped += 1
                        continue

            frame_table = build_frame_manifest(
                row,
                output_path,
                signal_long_edge=signal_long_edge,
                quality_long_edge=quality_long_edge,
                client=source_client,
                source_options=source_kwargs or None,
            )
            write_json_atomic(
                {
                    "video_id": video_id,
                    "frame_count": len(frame_table),
                    "elapsed_s": round(time.perf_counter() - started, 3),
                    "signal_long_edge": signal_long_edge,
                    "quality_long_edge": quality_long_edge,
                    "fingerprint": fingerprint,
                    "source_identity": source_identity,
                    "status": "success" if len(frame_table) else "no_video_frames",
                },
                stats_path,
            )
            done += 1
            exact_counts[video_id] = len(frame_table)
            print(f"[frame-manifest] {video_id}: {len(frame_table)} frames")
        except Exception as error:  # one damaged video must not abort a batch
            # Log only the stable video ID.  A client or endpoint option can
            # contain authentication state and must never be stringified here.
            store.log_failed(
                video_id,
                f"frame_manifest | {type(error).__name__} | {error}",
            )
            failed += 1

    def apply_exact_counts(table: pd.DataFrame) -> None:
        if "video_id" not in table.columns:
            return
        for column in ("frame_count", "n_frames_est"):
            if column not in table.columns:
                table[column] = pd.Series(pd.NA, index=table.index, dtype="Int64")
        video_ids = table["video_id"].astype(str)
        for exact_video_id, frame_count in exact_counts.items():
            matches = video_ids == exact_video_id
            table.loc[matches, "frame_count"] = frame_count
            table.loc[matches, "n_frames_est"] = frame_count
            identity = observed_identities.get(exact_video_id, {})
            for field in ("size_bytes", "etag", "version_id"):
                value = identity.get(field)
                if value is not None:
                    if field not in table.columns:
                        table[field] = pd.NA
                    table.loc[matches, field] = value
        # Nullable Int64 preserves a true missing count without turning exact
        # decoded counts into floating-point values in Parquet.
        table["frame_count"] = pd.to_numeric(table["frame_count"], errors="coerce").astype(
            "Int64"
        )
        table["n_frames_est"] = pd.to_numeric(
            table["n_frames_est"], errors="coerce"
        ).astype("Int64")
        if "size_bytes" in table.columns:
            table["size_bytes"] = pd.to_numeric(
                table["size_bytes"], errors="coerce"
            ).astype("Int64")

    if exact_counts:
        # ``all`` passes this same object directly to the following shot stage;
        # update it before returning so fallback bounds use decoded truth now,
        # not only after a future CLI invocation reloads the Parquet file.
        apply_exact_counts(manifest)

    manifest_path = getattr(store, "manifest_path", None)
    if exact_counts and manifest_path is not None and Path(manifest_path).exists():
        persisted = pd.read_parquet(manifest_path)
        apply_exact_counts(persisted)
        write_parquet_atomic(persisted, manifest_path)
    print(f"[frame-manifest] done={done} skipped={skipped} failed={failed}")
