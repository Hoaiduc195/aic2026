import glob
import os
import re
from fractions import Fraction
from pathlib import Path

import av
import pandas as pd


def probe_one(path: str) -> dict:
    """Extract container/stream metadata. fps is kept as an exact fraction string
    (e.g. "30000/1001") — never a rounded float (P1: rounding 29.97->30 drifts
    ~3.6s over a 1h video and breaks timestamp-based answers)."""
    with av.open(path) as container:
        v = container.streams.video[0]
        fps = v.average_rate or Fraction(0, 1)
        if container.duration is not None:
            duration = container.duration / av.time_base
        elif v.duration is not None and v.time_base is not None:
            duration = float(v.duration * v.time_base)
        else:
            duration = 0.0
        n_frames = v.frames or (int(duration * float(fps)) if fps else 0)
        return {
            "path": os.path.abspath(path),
            "duration_s": float(duration),
            "width": v.width,
            "height": v.height,
            "codec": v.codec_context.name,
            "fps_str": f"{fps.numerator}/{fps.denominator}",
            "fps": float(fps) if fps else 0.0,
            "n_frames_est": int(n_frames),
        }


def _make_video_id(path: str, seen: set) -> str:
    stem = Path(path).stem
    vid = stem
    if vid in seen:
        vid = f"{Path(path).parent.name}_{stem}"
    i = 2
    while vid in seen:
        vid = f"{stem}_{i}"
        i += 1
    return vid


def build_manifest(cfg, store) -> pd.DataFrame:
    """Scan input glob, probe every video, write videos_manifest.parquet.
    Corrupted files go to failed_videos.log and the pipeline moves on."""
    files = sorted(glob.glob(cfg.input_glob, recursive=True))
    rows, seen = [], set()
    for f in files:
        try:
            meta = probe_one(f)
        except (av.FFmpegError, OSError, IndexError) as e:
            store.log_failed(f, f"probe | {type(e).__name__} | {e}")
            continue
        vid = _make_video_id(f, seen)
        seen.add(vid)
        rows.append({"video_id": vid, **meta})
    df = pd.DataFrame(rows)
    df.to_parquet(store.manifest_path, index=False)
    n_failed = len(files) - len(rows)
    print(f"[probe] {len(rows)} videos OK, {n_failed} failed, "
          f"{df['duration_s'].sum() / 3600:.2f} h total" if len(rows) else "[probe] no videos found")
    return df


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
