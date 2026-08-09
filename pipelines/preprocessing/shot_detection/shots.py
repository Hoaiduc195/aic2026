"""Pass A — Shot Boundary Detection (spec §3.1).

TransNetV2 (PyTorch port) when weights are available; otherwise every video
falls back to a single whole-video shot, which the adaptive sampler then
handles with the fixed 2s-period rule (fallback temporal sampling).
"""

import time
import json
import hashlib
import urllib.request
from pathlib import Path

import av
import numpy as np
import pandas as pd

from ..io_utils import write_parquet_atomic
from ..video_source import open_video_source, parse_video_uri

_VENDOR_PY_URL = ("https://raw.githubusercontent.com/soCzech/TransNetV2/master/"
                  "inference-pytorch/transnetv2_pytorch.py")
# The official repo ships only a TF->PyTorch conversion script; these are
# well-known mirrors of the converted weights (identical file).
_WEIGHTS_URLS = [
    "https://huggingface.co/ByteDance/shot2story/resolve/main/transnetv2-pytorch-weights.pth",
    "https://huggingface.co/MiaoshouAI/transnetv2-pytorch-weights/resolve/main/transnetv2-pytorch-weights.pth",
    "https://huggingface.co/Sn4kehead/TransNetV2/resolve/main/transnetv2-pytorch-weights.pth",
]


def ensure_transnet_assets(cfg) -> bool:
    """Download the official model definition + converted weights if missing.
    Returns True when both are in place."""
    vendor_py = Path(__file__).parent / "vendor" / "transnetv2_pytorch.py"
    weights = Path(cfg.sbd_weights)
    try:
        if not vendor_py.exists():
            print(f"[shots] downloading model definition -> {vendor_py}")
            urllib.request.urlretrieve(_VENDOR_PY_URL, vendor_py)
    except OSError as e:
        print(f"[shots] could not fetch TransNetV2 model definition ({e}); fallback sampling will be used.")
        return False
    if not weights.exists():
        for url in _WEIGHTS_URLS:
            try:
                print(f"[shots] downloading weights from {url.split('/')[3]} -> {weights}")
                urllib.request.urlretrieve(url, weights)
                break
            except OSError as e:
                print(f"[shots]   failed ({e}), trying next mirror")
        else:
            print("[shots] no weights mirror reachable; fallback sampling will be used.")
            return False
    return True


def load_transnet(cfg):
    """Returns a ready TransNetV2 model or None (-> fallback mode)."""
    try:
        import torch
        from .vendor.transnetv2_pytorch import TransNetV2
    except Exception as e:  # torch missing, vendor file missing, etc.
        print(f"[shots] TransNetV2 unavailable ({type(e).__name__}: {e}); using fallback temporal sampling.")
        return None
    weights = Path(cfg.sbd_weights)
    if not weights.exists():
        print(f"[shots] weights not found at {weights}; using fallback temporal sampling.")
        return None
    model = TransNetV2()
    state_dict = torch.load(str(weights), map_location="cpu")
    model.load_state_dict(state_dict)
    device = cfg.device if torch.cuda.is_available() else "cpu"
    model.eval().to(device)
    print(f"[shots] TransNetV2 loaded on {device}")
    return model


def _decode_lowres(source_uri: str, *, client=None, source_options=None):
    """Single sequential decode at 48x27 (TransNetV2's native input) while
    recording the true pts_time of every frame — exact frame->time mapping
    even for VFR videos."""
    frames, pts = [], []
    with open_video_source(
        source_uri,
        client=client,
        **dict(source_options or {}),
    ) as source:
        with av.open(source) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            tb = stream.time_base
            for fr in container.decode(stream):
                frames.append(fr.reformat(width=48, height=27, format="rgb24").to_ndarray())
                pts.append(float(fr.pts * tb) if fr.pts is not None else np.nan)
    pts = np.asarray(pts, dtype=np.float64)
    if np.isnan(pts).any():
        idx = np.arange(len(pts))
        good = ~np.isnan(pts)
        pts = np.interp(idx, idx[good], pts[good]) if good.any() else idx / 25.0
    return np.stack(frames), pts


def _predict(model, frames: np.ndarray) -> np.ndarray:
    """Sliding-window inference exactly as in the official repo:
    pad 25 frames on each side, windows of 100 with stride 50, keep the
    middle 50 predictions of each window."""
    import torch
    device = next(model.parameters()).device
    n = len(frames)
    pad_end = 25 + (50 - n % 50 if n % 50 else 0)
    padded = np.concatenate([
        np.repeat(frames[:1], 25, axis=0),
        frames,
        np.repeat(frames[-1:], pad_end, axis=0),
    ])
    preds = []
    with torch.no_grad():
        ptr = 0
        while ptr + 100 <= len(padded):
            window = torch.from_numpy(padded[ptr:ptr + 100]).unsqueeze(0).to(device)
            out = model(window)
            logits = out[0] if isinstance(out, (tuple, list)) else out
            p = torch.sigmoid(logits).cpu().numpy().reshape(-1)
            preds.append(p[25:75])
            ptr += 50
    return np.concatenate(preds)[:n]


def _scenes_from_predictions(preds: np.ndarray, threshold: float):
    """Partition every decoded frame into contiguous inclusive shot ranges.

    TransNet can mark several consecutive frames as one transition.  A cut is
    placed at the midpoint of each transition run so those frames are not
    dropped from the source timeline and terminal transition predictions do
    not produce a missing final shot.
    """

    hard = np.asarray(preds, dtype=float) > threshold
    frame_count = len(hard)
    if frame_count == 0:
        return []
    boundaries = [0]
    index = 0
    while index < frame_count:
        if not hard[index]:
            index += 1
            continue
        run_start = index
        while index + 1 < frame_count and hard[index + 1]:
            index += 1
        run_end = index
        boundary = (run_start + run_end + 1) // 2
        if 0 < boundary < frame_count and boundary > boundaries[-1]:
            boundaries.append(boundary)
        index += 1
    boundaries.append(frame_count)
    return [
        (start, end_exclusive - 1)
        for start, end_exclusive in zip(boundaries, boundaries[1:])
        if end_exclusive > start
    ]


def _merge_short(scenes, min_frames: int):
    """Shots shorter than min_frames are usually leftover transition garbage —
    merge them into the previous shot."""
    merged = []
    for s, e in scenes:
        if merged and (e - s + 1) < min_frames:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    if len(merged) >= 2 and (merged[0][1] - merged[0][0] + 1) < min_frames:
        merged[1] = (merged[0][0], merged[1][1])
        merged.pop(0)
    return merged


def _fallback_shots(video_row) -> pd.DataFrame:
    frame_count = _preferred_frame_count(video_row)
    return pd.DataFrame([{
        "video_id": video_row["video_id"],
        "shot_id": 0,
        "start_frame": 0,
        "end_frame": max(frame_count - 1, 0),
        "start_time": 0.0,
        "end_time": float(video_row["duration_s"]),
        "method": "fallback",
    }])


def _preferred_frame_count(video_row) -> int:
    """Return decoded truth when available, otherwise the legacy estimate."""
    for column in ("frame_count", "n_frames_est"):
        value = video_row.get(column)
        if value is None or pd.isna(value):
            continue
        numeric = float(value)
        if not np.isfinite(numeric) or numeric < 0 or not numeric.is_integer():
            raise ValueError(f"{column} must be a non-negative integer")
        return int(numeric)
    raise ValueError("video manifest needs frame_count or n_frames_est")


def detect_shots(video_row, cfg, model) -> pd.DataFrame:
    # A valid no-video/zero-frame source has a terminal frame-manifest state.
    # Do not index video stream 0 or invoke a model for it; retain one explicit
    # empty-timeline fallback record so downstream extraction can checkpoint.
    if model is None or _preferred_frame_count(video_row) == 0:
        return _fallback_shots(video_row)
    storage_uri = video_row.get("storage_uri")
    source_uri = (
        str(storage_uri)
        if isinstance(storage_uri, str) and storage_uri.strip()
        else str(video_row["path"])
    )
    source_kwargs = (
        dict(cfg.video_source_kwargs(source_uri))
        if hasattr(cfg, "video_source_kwargs")
        else {}
    )
    if parse_video_uri(source_uri).path is None:
        for field, option in (
            ("etag", "expected_etag"),
            ("version_id", "expected_version_id"),
        ):
            value = video_row.get(field)
            if value is not None and not pd.isna(value):
                source_kwargs[option] = str(value)
    source_client = source_kwargs.pop("client", None)
    frames, pts = _decode_lowres(
        source_uri,
        client=source_client,
        source_options=source_kwargs or None,
    )
    preds = _predict(model, frames)
    scenes = _merge_short(_scenes_from_predictions(preds, cfg.sbd_threshold), cfg.sbd_min_shot_frames)
    rows = [{
        "video_id": video_row["video_id"],
        "shot_id": i,
        "start_frame": int(s),
        "end_frame": int(e),
        "start_time": float(pts[s]),
        "end_time": float(pts[e]),
        "method": "transnetv2",
    } for i, (s, e) in enumerate(scenes)]
    return pd.DataFrame(rows)


def _shot_stage_fingerprint(video_row, cfg, model, store) -> str:
    video_id = str(video_row["video_id"])
    frame_stats_factory = getattr(store, "frame_manifest_stats_path", None)
    frame_fingerprint = None
    if callable(frame_stats_factory):
        path = frame_stats_factory(video_id)
        if path.exists():
            try:
                frame_fingerprint = json.loads(path.read_text(encoding="utf-8")).get(
                    "fingerprint"
                )
            except (OSError, ValueError, TypeError, AttributeError):
                frame_fingerprint = None
    storage_uri = video_row.get("storage_uri")
    source = (
        str(storage_uri)
        if isinstance(storage_uri, str) and storage_uri.strip()
        else str(video_row["path"])
    )
    parsed = parse_video_uri(source)
    source_identity = {"uri": source, "frame_fingerprint": frame_fingerprint}
    if parsed.path is not None:
        stat = parsed.path.stat()
        source_identity.update({"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    else:
        for key in ("size_bytes", "etag", "version_id", "sha256"):
            value = video_row.get(key)
            if value is not None and not pd.isna(value):
                source_identity[key] = value.item() if hasattr(value, "item") else value
    weights = Path(cfg.sbd_weights)
    weights_identity = None
    if weights.exists():
        stat = weights.stat()
        weights_identity = [stat.st_size, stat.st_mtime_ns]
    payload = {
        "version": "shot_detection_v1",
        "video_id": video_id,
        "source": source_identity,
        "model_enabled": model is not None,
        "threshold": cfg.sbd_threshold,
        "min_shot_frames": cfg.sbd_min_shot_frames,
        "weights": weights_identity,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


_SHOT_CHECKPOINT_COLUMNS = {
    "video_id",
    "shot_id",
    "start_frame",
    "end_frame",
    "start_time",
    "end_time",
    "method",
    "sbd_elapsed_s",
    "stage_fingerprint",
    "checkpoint_shot_count",
    "checkpoint_frame_count",
}


def _shot_checkpoint_table_valid(
    table: pd.DataFrame,
    *,
    video_id: str,
    fingerprint: str,
    frame_count: int,
) -> bool:
    """Validate physical content, identity, and completeness of a shot table."""
    if table.empty or not _SHOT_CHECKPOINT_COLUMNS.issubset(table.columns):
        return False
    if table[list(_SHOT_CHECKPOINT_COLUMNS)].isna().any().any():
        return False
    if not (table["video_id"].astype(str) == video_id).all():
        return False
    if not (table["stage_fingerprint"].astype(str) == fingerprint).all():
        return False

    numeric_columns = [
        "shot_id",
        "start_frame",
        "end_frame",
        "start_time",
        "end_time",
        "sbd_elapsed_s",
        "checkpoint_shot_count",
        "checkpoint_frame_count",
    ]
    numeric = table[numeric_columns].apply(pd.to_numeric, errors="coerce")
    if numeric.isna().any().any() or not np.isfinite(numeric.to_numpy(dtype=float)).all():
        return False

    integer_columns = [
        "shot_id",
        "start_frame",
        "end_frame",
        "checkpoint_shot_count",
        "checkpoint_frame_count",
    ]
    if any((numeric[column] % 1 != 0).any() for column in integer_columns):
        return False

    shot_ids = numeric["shot_id"].astype("int64").tolist()
    starts = numeric["start_frame"].astype("int64").tolist()
    ends = numeric["end_frame"].astype("int64").tolist()
    if shot_ids != list(range(len(table))):
        return False
    if starts[0] != 0 or any(start < 0 for start in starts):
        return False
    if any(end < start for start, end in zip(starts, ends)):
        return False
    if any(right_start != left_end + 1 for left_end, right_start in zip(ends, starts[1:])):
        return False
    if frame_count > 0:
        if any(end >= frame_count for end in ends) or ends[-1] != frame_count - 1:
            return False
    if frame_count == 0 and (starts != [0] or ends != [0]):
        return False

    start_times = numeric["start_time"].to_numpy(dtype=float)
    end_times = numeric["end_time"].to_numpy(dtype=float)
    elapsed = numeric["sbd_elapsed_s"].to_numpy(dtype=float)
    if np.any(end_times < start_times) or np.any(elapsed < 0):
        return False
    if len(start_times) > 1 and np.any(start_times[1:] < end_times[:-1]):
        return False
    if not table["method"].astype(str).str.strip().ne("").all():
        return False

    recorded_shot_counts = numeric["checkpoint_shot_count"].astype("int64")
    recorded_frame_counts = numeric["checkpoint_frame_count"].astype("int64")
    if not (recorded_shot_counts == len(table)).all():
        return False
    if not (recorded_frame_counts == frame_count).all():
        return False
    return True


def _shot_checkpoint_valid(
    path: Path,
    *,
    video_id: str,
    fingerprint: str,
    frame_count: int,
) -> bool:
    if not path.exists():
        return False
    try:
        table = pd.read_parquet(path)
        return _shot_checkpoint_table_valid(
            table,
            video_id=video_id,
            fingerprint=fingerprint,
            frame_count=frame_count,
        )
    except Exception:  # noqa: BLE001 -- every corrupt checkpoint must rebuild
        return False


def run_pass_a(cfg, store, manifest: pd.DataFrame, limit: int | None = None) -> None:
    """Detect shots for every video, one parquet checkpoint per video (resumable)."""
    if "video_id" not in manifest.columns or manifest["video_id"].astype(str).duplicated().any():
        raise ValueError("video manifest needs unique video_id values")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 0):
        raise ValueError("limit must be a non-negative integer or None")
    model = load_transnet(cfg)
    todo = manifest.head(limit) if limit is not None else manifest
    done = skipped = failed = 0
    for _, row in todo.iterrows():
        try:
            video_id = str(row["video_id"])
            out = store.shots_path(video_id)
            frame_count = _preferred_frame_count(row)
            fingerprint = _shot_stage_fingerprint(row, cfg, model, store)
            if _shot_checkpoint_valid(
                out,
                video_id=video_id,
                fingerprint=fingerprint,
                frame_count=frame_count,
            ):
                skipped += 1
                continue

            t0 = time.perf_counter()
            df = detect_shots(row, cfg, model)
            df["sbd_elapsed_s"] = round(time.perf_counter() - t0, 3)
            df["stage_fingerprint"] = fingerprint
            df["checkpoint_shot_count"] = len(df)
            df["checkpoint_frame_count"] = frame_count
            if not _shot_checkpoint_table_valid(
                df,
                video_id=video_id,
                fingerprint=fingerprint,
                frame_count=frame_count,
            ):
                raise ValueError("shot detector produced an invalid or incomplete table")
            write_parquet_atomic(df, out)
            done += 1
            print(
                f"[shots] {video_id}: {len(df)} shots ({df['method'].iloc[0]}, "
                f"{df['sbd_elapsed_s'].iloc[0]:.1f}s)"
            )
        except Exception as e:  # noqa: BLE001 -- one bad video must never kill the whole batch
            store.log_failed(str(row["video_id"]), f"shots | {type(e).__name__} | {e}")
            failed += 1
            if model is not None:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            continue
    if model is not None:
        import torch
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    print(f"[shots] done={done} skipped={skipped} failed={failed}")
