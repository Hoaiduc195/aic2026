"""Pass B — the heart of the pipeline. For each video, in ONE sequential decode:

  candidates (from shots) -> pick sharpest frame in ±window -> quality filter
  -> dHash dedup -> CLIP embed -> global cosine dedup -> coverage repair
  -> write WebP + CSV + NPY

Frames are decoded exactly once (D2); WebP bytes are encoded in memory and only
written for frames that survive every filter. Per-video metadata JSON is the
resume checkpoint AND the source of funnel numbers for the final report.

Dedup and the max_gap_s coverage guarantee are deliberately two separate
passes (see aicpp/dedup.py module docstring for why entangling them in one
sequential loop is unsound): phash_dedup and cosine_dedup are pure
compaction, then enforce_coverage backfills any gap they left too wide using
the full pre-dedup candidate list.
"""

import json
import platform
import time
from fractions import Fraction

import av
import cv2
import numpy as np
import pandas as pd

from .deduplication.dedup import cosine_dedup, enforce_coverage, phash_dedup
from .quality_filtering.quality import passes, quality_scores, resize_long_edge
from .keyframe_sampling.sampling import build_candidates


def extract_video(video_row, shots_df, cfg, store, embedder=None) -> dict:
    vid = video_row["video_id"]
    t0 = time.perf_counter()
    cands = build_candidates(shots_df, cfg)
    fps = float(Fraction(video_row["fps_str"])) or 25.0
    half_win = (cfg.window_radius + 0.5) / fps

    picked: list[dict] = []
    # reserve: sharpest frame of a window where NOTHING passed quality. Not
    # indexed on its own, but available to enforce_coverage as a last-resort
    # backfill so a run of sub-threshold shots (station logos, soft dusk b-roll)
    # can't open a coverage blind spot -- a slightly-soft keyframe of a distinct
    # shot beats no keyframe at all for retrieval recall. Flagged quality_ok=False.
    reserve: list[dict] = []
    drops = {"quality": 0, "empty_window": 0, "phash": 0, "cosine": 0}
    n_decoded = 0
    ci = 0            # index of the current candidate
    buf: list[tuple] = []  # (rgb_resized, pts_time, frame_idx, scores) inside current window

    def finalize_current():
        """Keep the sharpest passing frame in the window; if none passes, stash
        the sharpest frame regardless into `reserve` (still counted as a quality
        drop) so coverage repair has something to fall back on."""
        nonlocal buf
        best, best_scores = None, None
        best_any, best_any_scores = None, None  # sharpest regardless of quality
        for rgb, t, idx, scores in buf:
            if best_any_scores is None or scores["blur_score"] > best_any_scores["blur_score"]:
                best_any, best_any_scores = (rgb, t, idx), scores
            ok, _reason = passes(scores, cfg)
            if ok and (best_scores is None or scores["blur_score"] > best_scores["blur_score"]):
                best, best_scores = (rgb, t, idx), scores
        if best is not None:
            picked.append({
                "frame": best[0], "pts_time": best[1], "frame_idx": best[2],
                "shot_id": cands[ci]["shot_id"], "quality_ok": True, **best_scores,
            })
        elif best_any is not None:  # window had frames but none passed quality
            drops["quality"] += 1
            reserve.append({
                "frame": best_any[0], "pts_time": best_any[1], "frame_idx": best_any[2],
                "shot_id": cands[ci]["shot_id"], "quality_ok": False, **best_any_scores,
            })
        else:  # no decoded frame landed in the window at all
            drops["empty_window"] += 1
        buf = []

    with av.open(video_row["path"]) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        tb = stream.time_base
        for idx, frame in enumerate(container.decode(stream)):
            n_decoded += 1
            t = float(frame.pts * tb) if frame.pts is not None else idx / fps
            while ci < len(cands) and t > cands[ci]["target_time"] + half_win:
                finalize_current()
                ci += 1
            if ci >= len(cands):
                break
            if abs(t - cands[ci]["target_time"]) <= half_win:
                rgb = resize_long_edge(frame.to_ndarray(format="rgb24"), cfg.webp_long_edge)
                buf.append((rgb, t, idx, quality_scores(rgb)))
        while ci < len(cands):
            finalize_current()
            ci += 1

    n_after_quality = len(picked)
    kept = phash_dedup(picked)
    drops["phash"] = n_after_quality - len(kept)

    feats = None
    if embedder is not None and kept:
        feats = embedder.encode_images([k["frame"] for k in kept])
        keep_idx = cosine_dedup(feats, cfg.cosine_dup_threshold)
        drops["cosine"] = len(kept) - len(keep_idx)
        kept = [kept[i] for i in keep_idx]
        feats = feats[keep_idx]
    n_after_cosine = len(kept)

    # coverage repair: guarantee no keyframe gap exceeds max_gap_s. Backfill
    # from the full pre-dedup candidate list (`picked`, quality_ok=True) first,
    # then from `reserve` (quality_ok=False) only where a gap has no quality
    # candidate at all -- enforce_coverage prefers quality frames and only dips
    # into the reserve when it must. See aicpp/dedup.py for why this is a
    # separate pass rather than folded into the dedup loops above.
    n_before_coverage = len(kept)
    kept = enforce_coverage(picked + reserve, kept, cfg.max_gap_s, 0.0, float(video_row["duration_s"]))
    n_backfilled = len(kept) - n_before_coverage
    drops["backfilled"] = n_backfilled
    n_soft = sum(1 for k in kept if not k.get("quality_ok", True))  # sub-threshold survivors
    drops["soft_backfilled"] = n_soft
    if embedder is not None and kept and n_backfilled > 0:
        # re-embed the final (now backfill-augmented) list; cheap relative to
        # decode cost, and keeps feats trivially aligned with kept's order.
        feats = embedder.encode_images([k["frame"] for k in kept])

    # ---- write outputs (only the survivors touch disk) ----
    kf_dir = store.keyframe_dir(vid)
    kf_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for n, k in enumerate(kept, start=1):
        name = f"{n:04d}.webp"
        bgr = cv2.cvtColor(k["frame"], cv2.COLOR_RGB2BGR)
        ok = cv2.imwrite(str(kf_dir / name), bgr,
                         [int(cv2.IMWRITE_WEBP_QUALITY), cfg.webp_quality])
        if not ok:
            raise OSError(f"failed to write {kf_dir / name}")
        rows.append({
            "n": n, "video_id": vid, "shot_id": k["shot_id"],
            "frame_idx": k["frame_idx"], "pts_time": round(k["pts_time"], 6),
            "fps": video_row["fps_str"], "path": f"keyframes/{vid}/{name}",
            "brightness": round(k["brightness"], 2),
            "blur_score": round(k["blur_score"], 2),
            "std_score": round(k["std_score"], 2),
            # False = a sub-threshold frame kept only to satisfy the coverage
            # guarantee; retrieval/rerank can down-weight these.
            "quality_ok": bool(k.get("quality_ok", True)),
        })
    map_columns = ["n", "video_id", "shot_id", "frame_idx", "pts_time", "fps",
                   "path", "brightness", "blur_score", "std_score", "quality_ok"]
    pd.DataFrame(rows, columns=map_columns).to_csv(store.map_path(vid), index=False)
    if feats is not None:
        np.save(store.features_path(vid), feats.astype(np.float16))

    meta = {
        "video_id": vid,
        "duration_s": float(video_row["duration_s"]),
        "fps": video_row["fps_str"],
        "n_frames_raw_est": int(video_row["n_frames_est"]),
        "n_frames_decoded": n_decoded,
        "n_shots": int(len(shots_df)),
        "sbd_method": str(shots_df["method"].iloc[0]) if len(shots_df) else "none",
        "n_candidates": len(cands),
        "n_after_quality": n_after_quality,
        "n_after_phash": n_after_quality - drops["phash"],
        "n_after_cosine": n_after_cosine,
        "n_keyframes": len(kept),
        "drops": drops,
        "embedded": feats is not None,
        "elapsed_s": round(time.perf_counter() - t0, 2),
    }
    store.metadata_path(vid).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def _write_env_info(store) -> None:
    """Record what hardware this run used — the report cites it so throughput
    numbers are reproducible claims, not anecdotes."""
    info = {"platform": platform.platform(), "python": platform.python_version()}
    try:
        import torch
        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
    except ModuleNotFoundError:
        pass
    (store.root / "env.json").write_text(json.dumps(info, indent=2), encoding="utf-8")


def run_pass_b(cfg, store, manifest: pd.DataFrame, limit: int | None = None) -> None:
    """Extract keyframes (+embeddings) for every video with Pass A shots.
    Resumable: a video whose metadata JSON exists is skipped."""
    _write_env_info(store)
    embedder = None
    if cfg.embed:
        from .embed import ClipEmbedder
        embedder = ClipEmbedder(cfg)

    todo = manifest.head(limit) if limit else manifest
    done = skipped = failed = 0
    for _, row in todo.iterrows():
        vid = row["video_id"]
        if store.metadata_path(vid).exists():
            skipped += 1
            continue
        shots_path = store.shots_path(vid)
        if not shots_path.exists():
            store.log_failed(row["path"], "extract | missing shots checkpoint (run Pass A first)")
            failed += 1
            continue
        try:
            shots_df = pd.read_parquet(shots_path)
            meta = extract_video(row, shots_df, cfg, store, embedder)
        except Exception as e:  # noqa: BLE001 -- one bad video must never kill the whole batch
            store.log_failed(row["path"], f"extract | {type(e).__name__} | {e}")
            failed += 1
            if embedder is not None:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            continue
        done += 1
        print(f"[extract] {vid}: {meta['n_candidates']} cand -> {meta['n_after_quality']} quality "
              f"-> {meta['n_after_phash']} phash -> {meta['n_keyframes']} final "
              f"({meta['elapsed_s']:.1f}s, {meta['duration_s'] / max(meta['elapsed_s'], 1e-9):.1f}x realtime)")
    print(f"[extract] done={done} skipped={skipped} failed={failed}")
