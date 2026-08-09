"""Validate keyframe quality against the organizer-provided (BTC) ground
truth keyframes shipped inside the AIC 2025 Kaggle dataset
(features/map-keyframes/*.csv, format: n,pts_time,fps,frame_idx — nearly
identical to our own map-keyframes schema).

This is NOT text-query Recall@k (no query ground truth exists for this
practice dataset) — it is a temporal coverage metric: for every keyframe
BTC's own system selected as representing a distinct moment, check whether
our pipeline also placed a keyframe near that same moment. High coverage is
objective evidence the pipeline does not silently drop events BTC itself
considered worth indexing — exactly the "keyframe chất lượng, không phải lời
nói suông" evidence requested.

Usage:
    python -m pipelines.preprocessing.cli eval-btc --out outputs --btc-dir btc_keyframes
"""

from pathlib import Path

import numpy as np
import pandas as pd

from ..io_utils import write_csv_atomic, write_text_atomic


def coverage_for_video(btc_times: np.ndarray, our_times: np.ndarray, tolerance_s: float) -> float:
    if len(btc_times) == 0:
        return 1.0  # nothing to miss
    if len(our_times) == 0:
        return 0.0
    diffs = np.abs(our_times[None, :] - btc_times[:, None])  # (n_btc, n_ours)
    return float((diffs.min(axis=1) <= tolerance_s).mean())


def _btc_path_for(btc_dir: Path, vid: str) -> Path | None:
    """Our duplicate-disambiguation (video_ingestion/probe.py::_make_video_id) prefixes
    a video_id with its parent folder name when two files share a stem, e.g.
    'video_L25_V006' for a copy found under a folder literally named 'video'.
    BTC's own files are keyed by the original stem only, so also try that."""
    for cand in (vid, vid.removeprefix("video_")):
        p = btc_dir / f"{cand}.csv"
        if p.exists():
            return p
    return None


def run_eval(store, btc_dir: Path, tolerances: tuple[float, ...] = (1.0, 2.0, 5.0)) -> pd.DataFrame:
    rows = []
    n_skipped = 0
    for map_path in sorted((store.root / "map-keyframes").glob("*.csv")):
        vid = map_path.stem
        btc_path = _btc_path_for(btc_dir, vid)
        if btc_path is None:
            continue
        # BTC files are externally supplied (organizer download) -- a single
        # truncated/empty/mis-schema'd file must not abort validation for every
        # other video. Isolate per video, mirroring run_pass_a/b's try/except.
        try:
            btc_df = pd.read_csv(btc_path)
            try:
                our_df = pd.read_csv(map_path)
            except pd.errors.EmptyDataError:
                our_df = pd.DataFrame(columns=["pts_time"])
            btc_times = btc_df["pts_time"].to_numpy(dtype=float)
            our_times = our_df["pts_time"].to_numpy(dtype=float) if len(our_df) else np.array([])
        except (pd.errors.EmptyDataError, pd.errors.ParserError, KeyError, ValueError) as e:
            print(f"[eval_btc] skipping {vid}: unreadable ground-truth/map csv ({type(e).__name__}: {e})")
            n_skipped += 1
            continue
        row = {"video_id": vid, "n_btc": len(btc_times), "n_ours": len(our_times)}
        for tol in tolerances:
            row[f"coverage@{tol:g}s"] = round(coverage_for_video(btc_times, our_times, tol), 4)
        rows.append(row)
    if n_skipped:
        print(f"[eval_btc] {n_skipped} video(s) skipped due to unreadable CSVs")
    return pd.DataFrame(rows)


def build_eval_report(store, btc_dir: Path, tolerances: tuple[float, ...] = (1.0, 2.0, 5.0)) -> str:
    df = run_eval(store, btc_dir, tolerances)
    out_path = store.root / "EVAL_BTC.md"
    if df.empty:
        # ALWAYS write the report (even on zero matches) so the notebook's
        # display cell never crashes on a missing file, and so the reason is
        # visible instead of silent -- this exact silent-early-return is why an
        # earlier run produced no EVAL_BTC.md at all.
        n_maps = len(list((store.root / "map-keyframes").glob("*.csv")))
        btc_exists = Path(btc_dir).exists()
        btc_files = sorted(p.name for p in Path(btc_dir).glob("*.csv")) if btc_exists else []
        sample_ours = sorted(p.stem for p in (store.root / "map-keyframes").glob("*.csv"))[:5]
        msg = "\n".join([
            "# BTC Ground-Truth Coverage Validation",
            "",
            "**No matching BTC ground-truth files were found — validation did not run.**",
            "",
            f"- our processed videos (map-keyframes CSVs): **{n_maps}**",
            f"- `--btc-dir` = `{btc_dir}` — exists: **{btc_exists}**, CSVs inside: **{len(btc_files)}**",
            f"- sample of our video_ids: {', '.join(sample_ours) if sample_ours else '(none)'}",
            f"- sample of btc-dir files: {', '.join(btc_files[:5]) if btc_files else '(none)'}",
            "",
            "Likely cause: the notebook's BTC-copy cell put 0 files into `--btc-dir` "
            "(wrong source path for `features/map-keyframes`, or a mount-path mismatch "
            "with the videos), or the BTC filenames don't match our video_ids.",
        ])
        write_text_atomic(msg, out_path)
        print("[eval_btc] no matching BTC files — wrote diagnostic EVAL_BTC.md")
        return msg

    lines = [
        "# BTC Ground-Truth Coverage Validation",
        "",
        "For every keyframe timestamp the organizers' own system (BTC) selected, "
        "checks whether our pipeline placed a keyframe within a time tolerance. "
        "This is a temporal-coverage proxy for recall, not text-query Recall@k "
        "(no query ground truth exists for this practice dataset).",
        "",
        f"Videos compared: **{len(df)}**",
        f"Total BTC keyframes: **{int(df['n_btc'].sum()):,}**  ·  "
        f"Total our keyframes: **{int(df['n_ours'].sum()):,}**",
        "",
        "| Tolerance | Aggregate coverage (weighted by BTC keyframe count) |",
        "|---|---:|",
    ]
    for tol in tolerances:
        col = f"coverage@{tol:g}s"
        weighted = (df[col] * df["n_btc"]).sum() / df["n_btc"].sum() if df["n_btc"].sum() else 0.0
        lines.append(f"| ±{tol:g}s | {100*weighted:.1f}% |")

    worst_col = f"coverage@{tolerances[-1]:g}s"
    worst = df.sort_values(worst_col).head(10)
    lines += [
        "",
        f"## Worst 10 videos by coverage@{tolerances[-1]:g}s",
        "",
        "| video_id | BTC keyframes | our keyframes | " + " | ".join(f"cov@{t:g}s" for t in tolerances) + " |",
        "|---|---:|---:|" + "---:|" * len(tolerances),
    ]
    for _, r in worst.iterrows():
        covs = " | ".join(f"{100*r[f'coverage@{t:g}s']:.0f}%" for t in tolerances)
        lines.append(f"| {r['video_id']} | {int(r['n_btc'])} | {int(r['n_ours'])} | {covs} |")

    report = "\n".join(lines)
    write_text_atomic(report, out_path)
    write_csv_atomic(df, store.root / "eval_btc_per_video.csv")
    print(f"[eval_btc] {len(df)} videos compared, report -> {out_path}")
    for tol in tolerances:
        col = f"coverage@{tol:g}s"
        weighted = (df[col] * df["n_btc"]).sum() / df["n_btc"].sum() if df["n_btc"].sum() else 0.0
        print(f"[eval_btc]   coverage@{tol:g}s = {100*weighted:.1f}%")
    return report
