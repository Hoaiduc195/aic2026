"""CLI entrypoint.

    python -m aicpp.cli probe    --input-glob "..." --out outputs
    python -m aicpp.cli shots    --out outputs                     # Pass A (GPU: TransNetV2)
    python -m aicpp.cli extract  --out outputs                     # Pass B (GPU: CLIP)
    python -m aicpp.cli index    --out outputs
    python -m aicpp.cli search   --out outputs --query "a red motorcycle on the street" -k 10
    python -m aicpp.cli report   --out outputs
    python -m aicpp.cli eval-btc --out outputs --btc-dir btc_keyframes  # coverage vs organizer ground truth
    python -m aicpp.cli all      --input-glob "..." --out outputs  # everything in order
"""

import argparse
import dataclasses

from .config import PipelineConfig
from .store import OutputStore


def _add_common(sp: argparse.ArgumentParser) -> None:
    defaults = PipelineConfig()
    sp.add_argument("--input-glob", default=defaults.input_glob)
    sp.add_argument("--out", default=defaults.out_dir)
    sp.add_argument("--device", default=defaults.device)
    sp.add_argument("--limit", type=int, default=None, help="process only the first N videos")
    sp.add_argument("--limit-hours", type=float, default=None,
                    help="pick a subset spanning ~N hours, round-robin across batches "
                         "(L21, L22, ...) instead of just the first N videos in file order")
    sp.add_argument("--no-embed", action="store_true", help="skip CLIP embedding (CPU smoke tests)")
    sp.add_argument("--sbd-threshold", type=float, default=defaults.sbd_threshold)
    sp.add_argument("--sbd-weights", default=defaults.sbd_weights)
    sp.add_argument("--blur-min", type=float, default=defaults.blur_min)
    sp.add_argument("--max-gap-s", type=float, default=defaults.max_gap_s)
    sp.add_argument("--embed-model", default=defaults.embed_model)
    sp.add_argument("--embed-pretrained", default=defaults.embed_pretrained)
    sp.add_argument("--embed-batch-size", type=int, default=defaults.embed_batch_size)


def _cfg_from_args(args) -> PipelineConfig:
    cfg = PipelineConfig(
        input_glob=args.input_glob,
        out_dir=args.out,
        device=args.device,
        sbd_threshold=args.sbd_threshold,
        sbd_weights=args.sbd_weights,
        blur_min=args.blur_min,
        max_gap_s=args.max_gap_s,
        embed_model=args.embed_model,
        embed_pretrained=args.embed_pretrained,
        embed_batch_size=args.embed_batch_size,
    )
    if args.no_embed:
        cfg.embed = False
    return cfg


def main() -> None:
    parser = argparse.ArgumentParser("aicpp", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ["probe", "shots", "extract", "index", "report", "all"]:
        sp = sub.add_parser(name)
        _add_common(sp)
    sp = sub.add_parser("search")
    _add_common(sp)
    sp.add_argument("--query", required=True)
    sp.add_argument("-k", type=int, default=10)
    sp = sub.add_parser("benchmark")
    _add_common(sp)
    sp.add_argument("-k", type=int, default=10)
    sp.add_argument("--rounds", type=int, default=5)
    sp = sub.add_parser("eval-btc")
    _add_common(sp)
    sp.add_argument("--btc-dir", required=True,
                    help="local folder of organizer ground-truth map-keyframes CSVs "
                         "(n,pts_time,fps,frame_idx), one file per video_id")
    sp.add_argument("--tolerances", default="1,2,5",
                    help="comma-separated time tolerances in seconds")

    args = parser.parse_args()
    cfg = _cfg_from_args(args)
    store = OutputStore(cfg.out_dir)

    if args.cmd in ("probe", "all"):
        from .video_ingestion.probe import build_manifest
        manifest = build_manifest(cfg, store)
    if args.cmd in ("shots", "extract", "all") and args.cmd != "probe":
        from .video_ingestion.probe import load_manifest, stratified_subset
        manifest = load_manifest(cfg, store)
        if args.limit_hours:
            manifest = stratified_subset(manifest, args.limit_hours)
            args.limit = None  # subset is already the exact target -- don't re-truncate by count

    if args.cmd in ("shots", "extract", "all", "search", "benchmark"):
        from .gpu_check import assert_cuda_usable
        assert_cuda_usable(cfg.device)

    if args.cmd in ("shots", "all"):
        from .shot_detection.shots import ensure_transnet_assets, run_pass_a
        ensure_transnet_assets(cfg)
        run_pass_a(cfg, store, manifest, limit=args.limit)

    if args.cmd in ("extract", "all"):
        from .extract import run_pass_b
        run_pass_b(cfg, store, manifest, limit=args.limit)

    if args.cmd in ("index", "all"):
        if cfg.embed:
            from .indexer import build_index
            build_index(cfg, store)
        else:
            print("[index] skipped (--no-embed)")

    if args.cmd == "benchmark" or (args.cmd == "all" and cfg.embed):
        from .indexer import benchmark
        if store.faiss_path.exists():
            benchmark(cfg, store, k=getattr(args, "k", 10),
                      rounds=getattr(args, "rounds", 5))
        else:
            print("[benchmark] skipped (no index)")

    if args.cmd in ("report", "all"):
        from .metadata_extraction.stats import build_report
        build_report(cfg, store)

    if args.cmd == "eval-btc":
        from pathlib import Path
        from .metadata_extraction.eval_btc import build_eval_report
        tolerances = tuple(float(x) for x in args.tolerances.split(","))
        build_eval_report(store, Path(args.btc_dir), tolerances)

    if args.cmd == "search":
        from .indexer import search
        hits = search(cfg, store, args.query, k=args.k)
        with_cols = hits[["score", "video_id", "n", "pts_time", "shot_id", "path"]]
        print(with_cols.to_string(index=False))


if __name__ == "__main__":
    main()
