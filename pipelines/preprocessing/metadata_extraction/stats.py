"""Aggregate per-video metadata into REPORT.md — the source of every CV number:
input scale, reduction funnel, keyframe density, temporal coverage, throughput,
index size. Healthy ranges follow spec §5 of the improvement plan."""

import json

import pandas as pd


def _coverage(store, metas: list[dict]) -> pd.DataFrame:
    """Max gap between consecutive keyframes per video (including video ends).
    Gaps > 10s are blind spots for temporal tasks like TRAKE."""
    rows = []
    for m in metas:
        vid = m["video_id"]
        map_path = store.map_path(vid)
        if not map_path.exists():
            continue
        try:
            df = pd.read_csv(map_path)
        except pd.errors.EmptyDataError:  # header-less csv from an older run
            df = pd.DataFrame(columns=["pts_time"])
        dur = float(m["duration_s"])
        if len(df) == 0:
            rows.append({"video_id": vid, "max_gap_s": dur, "n_gaps_gt_10s": 1 if dur > 10 else 0})
            continue
        times = sorted(df["pts_time"].tolist())
        gaps = [times[0] - 0.0] + [b - a for a, b in zip(times, times[1:])] + [dur - times[-1]]
        rows.append({
            "video_id": vid,
            "max_gap_s": round(max(gaps), 2),
            "n_gaps_gt_10s": int(sum(g > 10.0 for g in gaps)),
        })
    return pd.DataFrame(rows)


def build_report(cfg, store) -> str:
    meta_files = sorted((store.root / "metadata").glob("*.json"))
    metas = [json.loads(p.read_text(encoding="utf-8")) for p in meta_files]
    if not metas:
        print("[report] no per-video metadata found — run extract first")
        return ""

    n_videos = len(metas)
    total_h = sum(m["duration_s"] for m in metas) / 3600
    raw_frames = sum(m["n_frames_raw_est"] for m in metas)
    candidates = sum(m["n_candidates"] for m in metas)
    after_quality = sum(m["n_after_quality"] for m in metas)
    after_phash = sum(m["n_after_phash"] for m in metas)
    # n_after_cosine falls back to n_keyframes for metadata from before the
    # coverage-repair pass existed (no backfill possible then, so they're equal)
    after_cosine = sum(m.get("n_after_cosine", m["n_keyframes"]) for m in metas)
    final = sum(m["n_keyframes"] for m in metas)
    backfilled = sum(m.get("drops", {}).get("backfilled", 0) for m in metas)
    soft_backfilled = sum(m.get("drops", {}).get("soft_backfilled", 0) for m in metas)
    elapsed_h = sum(m["elapsed_s"] for m in metas) / 3600
    reduction = 100.0 * (1 - final / raw_frames) if raw_frames else 0.0
    density = final / total_h if total_h else 0.0
    dedup_rate = 100.0 * (1 - final / after_quality) if after_quality else 0.0

    # Pass A (shot detection) time, one value per video in its shots parquet
    sbd_h = 0.0
    for m in metas:
        p = store.shots_path(m["video_id"])
        if p.exists():
            try:
                sbd_h += float(pd.read_parquet(p, columns=["sbd_elapsed_s"]).iloc[0, 0]) / 3600
            except (KeyError, IndexError):
                pass
    total_compute_h = elapsed_h + sbd_h

    env = {}
    env_path = store.root / "env.json"
    if env_path.exists():
        env = json.loads(env_path.read_text(encoding="utf-8"))

    total_shots = sum(m["n_shots"] for m in metas)
    method_counts: dict[str, int] = {}
    for m in metas:
        method_counts[m["sbd_method"]] = method_counts.get(m["sbd_method"], 0) + 1
    sbd_summary = ", ".join(f"{v} videos via {k}" for k, v in sorted(method_counts.items()))

    n_failed = 0
    if store.failed_log.exists():
        n_failed = len({line.split("|")[1].strip()
                        for line in store.failed_log.read_text(encoding="utf-8").splitlines()
                        if "|" in line})

    cov = _coverage(store, metas)
    n_bad_cov = int((cov["max_gap_s"] > 10.0).sum()) if len(cov) else 0
    worst = cov.sort_values("max_gap_s", ascending=False).head(5) if len(cov) else cov

    idx_meta = {}
    if store.index_meta_path.exists():
        idx_meta = json.loads(store.index_meta_path.read_text(encoding="utf-8"))
        idx_meta["size_mb"] = round(store.faiss_path.stat().st_size / 2**20, 1)

    kf_bytes = sum(f.stat().st_size for f in (store.root / "keyframes").rglob("*.webp"))

    lines = [
        "# AIC26 Preprocessing Pipeline — Report",
        "",
        "## Input",
        f"- Videos processed: **{n_videos}** (failed/corrupted skipped: {n_failed})",
        f"- Total duration: **{total_h:.2f} h**",
        f"- Raw frames (est. from fps x duration): **{raw_frames:,}**",
        "",
        "## Shot boundary detection",
        f"- Total shots: **{total_shots:,}** ({total_shots / n_videos:.1f} per video, "
        f"{total_shots / total_h if total_h else 0:.0f} per hour)",
        f"- Method: {sbd_summary}",
        "",
        "## Reduction funnel",
        "| Stage | Frames | Kept vs raw |",
        "|---|---:|---:|",
        f"| Raw frames | {raw_frames:,} | 100% |",
        f"| Adaptive sampling candidates | {candidates:,} | {100 * candidates / raw_frames if raw_frames else 0:.2f}% |",
        f"| After quality filter | {after_quality:,} | {100 * after_quality / raw_frames if raw_frames else 0:.2f}% |",
        f"| After dHash dedup | {after_phash:,} | {100 * after_phash / raw_frames if raw_frames else 0:.2f}% |",
        f"| After cosine dedup | {after_cosine:,} | {100 * after_cosine / raw_frames if raw_frames else 0:.2f}% |",
        f"| **Final keyframes (after coverage repair, +{backfilled:,} backfilled)** | **{final:,}** | **{100 * final / raw_frames if raw_frames else 0:.2f}%** |",
        "",
        f"- **Reduction: {raw_frames:,} frames -> {final:,} keyframes (-{reduction:.2f}%)**",
        f"- Keyframe density: **{density:.0f} keyframes/hour** (healthy: 1,500-4,000)",
        f"- Dedup + filter removal after sampling: {dedup_rate:.1f}% (healthy: 30-60%)",
        f"- Keyframe storage (WebP {cfg.webp_long_edge}px q{cfg.webp_quality}): {kf_bytes / 2**30:.2f} GB",
        "",
        "## Temporal coverage",
        f"- Videos with a keyframe gap > 10s: **{n_bad_cov} / {n_videos}**",
        f"- Sub-threshold keyframes kept only to guarantee coverage (quality_ok=False): "
        f"**{soft_backfilled:,}** ({100 * soft_backfilled / final if final else 0:.1f}% of final) "
        f"— flagged in map-keyframes so retrieval can down-weight them",
    ]
    if len(worst):
        lines += ["- Worst 5 videos by max gap:", "",
                  "| video_id | max gap (s) | gaps > 10s |", "|---|---:|---:|"]
        lines += [f"| {r.video_id} | {r.max_gap_s} | {r.n_gaps_gt_10s} |" for r in worst.itertuples()]
    hw = env.get("gpu", "CPU only")
    if "torch" in env:
        hw += f" · torch {env['torch']}"
    lines += [
        "",
        "## Throughput",
        f"- Hardware: **{hw}**" if env else "- Hardware: (env.json missing — re-run extract)",
        f"- Pass A (shot detection): {sbd_h:.2f} h",
        f"- Pass B (decode + filter + embed + write): {elapsed_h:.2f} h",
        f"- Total: {total_compute_h:.2f} h of compute for {total_h:.2f} h of video "
        f"= **{total_h / total_compute_h if total_compute_h else 0:.1f}x realtime** "
        f"(**{total_h / total_compute_h if total_compute_h else 0:.1f} hours of video per compute-hour**)",
        "",
        "## Dedup impact",
        f"- Quality filter removed {candidates - after_quality:,} frames "
        f"({100 * (candidates - after_quality) / candidates if candidates else 0:.1f}% of candidates) "
        f"before any GPU work",
        f"- dHash (CPU) removed {after_quality - after_phash:,} near-duplicates "
        f"({100 * (after_quality - after_phash) / after_quality if after_quality else 0:.1f}%) "
        f"-> that many CLIP encodes never had to run",
        f"- Cosine dedup (global, >{cfg.cosine_dup_threshold}) removed {after_phash - after_cosine:,} more "
        f"({100 * (after_phash - after_cosine) / after_phash if after_phash else 0:.1f}%) "
        f"-> vectors that never entered the index",
        f"- Coverage repair added back {backfilled:,} frames "
        f"({100 * backfilled / after_cosine if after_cosine else 0:.1f}% of post-dedup count) "
        f"where dedup would otherwise have left a gap > {cfg.max_gap_s:.0f}s",
    ]
    if idx_meta:
        dim = idx_meta["dim"]
        size_no_dedup_mb = after_phash * dim * 4 / 2**20
        lines += [
            f"- Index size: **{idx_meta['size_mb']} MB** actual vs {size_no_dedup_mb:.1f} MB "
            f"without cosine dedup (flat fp32, {after_phash:,} x {dim} x 4B) "
            f"= **-{100 * (1 - idx_meta['size_mb'] / size_no_dedup_mb) if size_no_dedup_mb else 0:.1f}%**",
        ]
    lines += [
        "",
        "## Index",
    ]
    if idx_meta:
        lines += [
            f"- FAISS IndexFlatIP (exact cosine): **{idx_meta['n_vectors']:,} vectors**, dim {idx_meta['dim']}, "
            f"{idx_meta['size_mb']} MB on disk",
            f"- Embedding model: {idx_meta['embed_model']} ({idx_meta['embed_pretrained']})",
        ]
    else:
        lines += ["- (index not built yet)"]

    bench = {}
    bench_path = store.root / "index" / "benchmark.json"
    if bench_path.exists():
        bench = json.loads(bench_path.read_text(encoding="utf-8"))
        vs, e2e = bench["vector_search"], bench["end_to_end"]
        lines += [
            "",
            "## Query latency",
            f"- Benchmark: {bench['n_queries']} diverse text queries x {bench['rounds']} rounds, "
            f"top-{bench['k']}, on {bench['n_vectors']:,} vectors",
            "| Stage | mean (ms) | p50 (ms) | p95 (ms) |",
            "|---|---:|---:|---:|",
            f"| Vector search (FAISS) | {vs['mean_ms']} | {vs['p50_ms']} | {vs['p95_ms']} |",
            f"| End-to-end (text encode + search) | {e2e['mean_ms']} | {e2e['p50_ms']} | {e2e['p95_ms']} |",
        ]

    report = "\n".join(lines)
    store.report_path.write_text(report, encoding="utf-8")
    print(f"[report] written to {store.report_path}")
    return report
