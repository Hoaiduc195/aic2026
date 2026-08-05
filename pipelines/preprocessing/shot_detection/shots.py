"""Pass A — Shot Boundary Detection (spec §3.1).

TransNetV2 (PyTorch port) when weights are available; otherwise every video
falls back to a single whole-video shot, which the adaptive sampler then
handles with the fixed 2s-period rule (fallback temporal sampling).
"""

import time
import urllib.request
from pathlib import Path

import av
import numpy as np
import pandas as pd

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


def _decode_lowres(path: str):
    """Single sequential decode at 48x27 (TransNetV2's native input) while
    recording the true pts_time of every frame — exact frame->time mapping
    even for VFR videos."""
    frames, pts = [], []
    with av.open(path) as container:
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
    """Contiguous [start, end] frame ranges between predicted transitions."""
    hard = (preds > threshold).astype(np.uint8)
    scenes, start, prev = [], 0, 0
    t = 0
    for i, t in enumerate(hard):
        if prev == 1 and t == 0:
            start = i
        if prev == 0 and t == 1 and i != 0:
            scenes.append((start, i))
        prev = int(t)
    if prev == 0:
        scenes.append((start, len(hard) - 1))
    return scenes


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
    return pd.DataFrame([{
        "video_id": video_row["video_id"],
        "shot_id": 0,
        "start_frame": 0,
        "end_frame": max(int(video_row["n_frames_est"]) - 1, 0),
        "start_time": 0.0,
        "end_time": float(video_row["duration_s"]),
        "method": "fallback",
    }])


def detect_shots(video_row, cfg, model) -> pd.DataFrame:
    if model is None:
        return _fallback_shots(video_row)
    frames, pts = _decode_lowres(video_row["path"])
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


def run_pass_a(cfg, store, manifest: pd.DataFrame, limit: int | None = None) -> None:
    """Detect shots for every video, one parquet checkpoint per video (resumable)."""
    model = load_transnet(cfg)
    todo = manifest.head(limit) if limit else manifest
    done = skipped = failed = 0
    for _, row in todo.iterrows():
        out = store.shots_path(row["video_id"])
        if out.exists():
            skipped += 1
            continue
        t0 = time.perf_counter()
        try:
            df = detect_shots(row, cfg, model)
        except Exception as e:  # noqa: BLE001 -- one bad video must never kill the whole batch
            store.log_failed(row["path"], f"shots | {type(e).__name__} | {e}")
            failed += 1
            if model is not None:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            continue
        df["sbd_elapsed_s"] = round(time.perf_counter() - t0, 3)
        df.to_parquet(out, index=False)
        done += 1
        print(f"[shots] {row['video_id']}: {len(df)} shots ({df['method'].iloc[0]}, "
              f"{df['sbd_elapsed_s'].iloc[0]:.1f}s)")
    if model is not None:
        import torch
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    print(f"[shots] done={done} skipped={skipped} failed={failed}")
