import glob
import os
import re
from collections import Counter
from fractions import Fraction
from pathlib import Path

import av
import pandas as pd

from ..io_utils import write_parquet_atomic
from ..video_source import open_video_source, parse_video_uri


MANIFEST_COLUMNS = [
    "video_id",
    "original_filename",
    "storage_uri",
    "duration_ms",
    "fps_str",
    "width",
    "height",
    "size_bytes",
    "etag",
    "version_id",
    "frame_count",
    # Legacy probe columns retained for current preprocessing consumers.
    "path",
    "duration_s",
    "codec",
    "fps",
    "n_frames_est",
]


def _positive_rate(stream) -> Fraction:
    """Return the best positive stream FPS without rounding through float."""
    for attribute in ("average_rate", "base_rate", "guessed_rate"):
        value = getattr(stream, attribute, None)
        if value is None:
            continue
        try:
            rate = value if isinstance(value, Fraction) else Fraction(value)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if rate > 0:
            return rate
    raise ValueError("video stream does not expose a positive frame rate")


def _duration_seconds(container, stream) -> Fraction:
    if container.duration is not None:
        return max(Fraction(container.duration, av.time_base), Fraction(0, 1))
    if stream.duration is not None and stream.time_base is not None:
        return max(Fraction(stream.duration) * Fraction(stream.time_base), Fraction(0, 1))
    return Fraction(0, 1)


def _nearest_millisecond(duration: Fraction) -> int:
    """Round a non-negative exact duration to the nearest integer millisecond."""
    milliseconds = duration * 1000
    quotient, remainder = divmod(milliseconds.numerator, milliseconds.denominator)
    return quotient + int(remainder * 2 >= milliseconds.denominator)


def _probe_open_container(container) -> dict:
    if not container.streams.video:
        raise ValueError("source does not contain a video stream")
    video_stream = container.streams.video[0]
    fps = _positive_rate(video_stream)
    duration = _duration_seconds(container, video_stream)
    reported_frames = int(video_stream.frames or 0)
    estimated_frames = reported_frames or int(duration * fps)
    return {
        "duration_ms": _nearest_millisecond(duration),
        "fps_str": f"{fps.numerator}/{fps.denominator}",
        "width": int(video_stream.width),
        "height": int(video_stream.height),
        # Container ``nb_frames`` is useful for an estimate but is not decoded
        # truth. Only the sequential full-frame stage may populate frame_count.
        "frame_count": None,
        "duration_s": float(duration),
        "codec": video_stream.codec_context.name,
        "fps": float(fps),
        "n_frames_est": estimated_frames,
    }


def probe_one(path: str) -> dict:
    """Extract canonical raw-video metadata plus legacy probe fields.

    ``fps_str`` is kept as an exact fraction (for example ``30000/1001``),
    never reconstructed from the convenience float column. ``storage_uri``
    is a credential-free ``file://`` URI; ``path`` remains available only for
    existing local pipeline consumers.
    """
    local_path = Path(path).expanduser().resolve()
    with av.open(str(local_path)) as container:
        return {
            "original_filename": local_path.name,
            "storage_uri": local_path.as_uri(),
            "size_bytes": int(local_path.stat().st_size),
            "etag": None,
            "version_id": None,
            "path": os.path.abspath(local_path),
            **_probe_open_container(container),
        }


def probe_source(uri: str, cfg) -> dict:
    """Probe one local/file/R2/S3 source without downloading it wholesale."""

    parsed = parse_video_uri(uri)
    if parsed.path is not None:
        return probe_one(str(parsed.path))
    options = (
        dict(cfg.video_source_kwargs(uri))
        if hasattr(cfg, "video_source_kwargs")
        else {}
    )
    with open_video_source(uri, **options) as source:
        identity = {
            "size_bytes": int(source.size),
            "etag": source.etag,
            "version_id": source.version_id,
        }
        with av.open(source) as container:
            metadata = _probe_open_container(container)
    assert parsed.key is not None
    return {
        "original_filename": Path(parsed.key).name,
        "storage_uri": uri,
        "path": None,
        **identity,
        **metadata,
    }


def _safe_id_part(value: str, fallback: str = "video") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._-")
    return cleaned or fallback


def _make_video_id(path: str, seen: set, *, qualify: bool = False) -> str:
    stem = _safe_id_part(Path(path).stem)
    vid = (
        f"{_safe_id_part(Path(path).parent.name, 'folder')}_{stem}"
        if qualify
        else stem
    )
    if vid in seen:
        vid = f"{_safe_id_part(Path(path).parent.name, 'folder')}_{stem}"
    i = 2
    while vid in seen:
        vid = f"{stem}_{i}"
        i += 1
    return vid


def build_manifest(cfg, store) -> pd.DataFrame:
    """Scan input glob, probe every video, write videos_manifest.parquet.
    Corrupted files go to failed_videos.log and the pipeline moves on."""
    files = sorted(glob.glob(cfg.input_glob, recursive=True))
    stem_counts = Counter(_safe_id_part(Path(path).stem) for path in files)
    rows, seen = [], set()
    for f in files:
        try:
            meta = probe_one(f)
        except (av.FFmpegError, OSError, IndexError, ValueError) as e:
            store.log_failed(f, f"probe | {type(e).__name__} | {e}")
            continue
        vid = _make_video_id(
            f,
            seen,
            qualify=stem_counts[_safe_id_part(Path(f).stem)] > 1,
        )
        seen.add(vid)
        rows.append({"video_id": vid, **meta})
    # Explicit columns also give an empty manifest a stable Parquet schema.
    df = pd.DataFrame(rows, columns=MANIFEST_COLUMNS)
    write_parquet_atomic(df, store.manifest_path)
    n_failed = len(files) - len(rows)
    print(f"[probe] {len(rows)} videos OK, {n_failed} failed, "
          f"{df['duration_s'].sum() / 3600:.2f} h total" if len(rows) else "[probe] no videos found")
    return df


def build_manifest_from_sources(cfg, store, sources: list[str]) -> pd.DataFrame:
    """Probe explicit local/R2/S3 URIs and persist a canonical manifest."""

    if not sources:
        raise ValueError("at least one source URI is required")
    if len(sources) != len(set(sources)):
        raise ValueError("source URI list contains duplicates")
    id_paths: list[str] = []
    for source in sources:
        parsed = parse_video_uri(source)
        id_paths.append(str(parsed.path) if parsed.path is not None else str(parsed.key))
    stem_counts = Counter(_safe_id_part(Path(path).stem) for path in id_paths)
    rows, seen = [], set()
    for source, id_path in zip(sources, id_paths):
        try:
            metadata = probe_source(source, cfg)
        except (av.FFmpegError, OSError, IndexError, ValueError) as error:
            store.log_failed(source, f"probe | {type(error).__name__} | {error}")
            continue
        video_id = _make_video_id(
            id_path,
            seen,
            qualify=stem_counts[_safe_id_part(Path(id_path).stem)] > 1,
        )
        seen.add(video_id)
        rows.append({"video_id": video_id, **metadata})
    manifest = pd.DataFrame(rows, columns=MANIFEST_COLUMNS)
    write_parquet_atomic(manifest, store.manifest_path)
    failed = len(sources) - len(rows)
    print(
        f"[probe] {len(rows)} URI videos OK, {failed} failed, "
        f"{manifest['duration_s'].sum() / 3600:.2f} h total"
        if len(rows)
        else "[probe] no URI videos could be opened"
    )
    return manifest


def load_manifest(cfg, store) -> pd.DataFrame:
    if store.manifest_path.exists():
        return pd.read_parquet(store.manifest_path)
    return build_manifest(cfg, store)


def _batch_of(video_id: str) -> str:
    """AIC-style ids look like 'L30_V001' -> batch 'L30'. Anything that
    doesn't match the convention (e.g. synthetic test videos) is its own
    singleton batch, so round-robin degrades to plain order."""
    m = re.match(r"^(.+?)_V\d+$", video_id)
    return m.group(1) if m else video_id


def stratified_subset(manifest: pd.DataFrame, target_hours: float) -> pd.DataFrame:
    """Pick a subset spanning target_hours of video, round-robin across
    batches (L21, L22, ..., L30, ...) instead of just taking the first N rows
    in file-listing order -- a plain .head(N) would be dominated by whichever
    batch glob() happens to list first."""
    groups: dict[str, list[int]] = {}
    for i, vid in enumerate(manifest["video_id"]):
        groups.setdefault(_batch_of(vid), []).append(i)
    batches = sorted(groups)
    cursors = {b: 0 for b in batches}

    selected_idx: list[int] = []
    total_h = 0.0
    while total_h < target_hours:
        progressed = False
        for b in batches:
            i = cursors[b]
            if i >= len(groups[b]):
                continue
            row_idx = groups[b][i]
            selected_idx.append(row_idx)
            total_h += float(manifest.iloc[row_idx]["duration_s"]) / 3600
            cursors[b] = i + 1
            progressed = True
            if total_h >= target_hours:
                break
        if not progressed:
            break  # every batch exhausted before reaching target_hours
    subset = manifest.iloc[selected_idx].reset_index(drop=True)
    print(f"[subset] {len(subset)} videos, {total_h:.2f} h, spanning "
          f"{subset['video_id'].map(_batch_of).nunique()}/{len(batches)} batches "
          f"(target was {target_hours:.1f} h)")
    return subset
