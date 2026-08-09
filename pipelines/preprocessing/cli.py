"""Command-line entry point for the two-stage keyframe pipeline.

Typical local run::

    python -m pipelines.preprocessing.cli all --input-glob "data/**/*.mp4" --out outputs

Stage 1 produces searchable retrieval frames.  ``windows`` expands retrieval
hits into candidate intervals; ``dense`` decodes every source frame in those
intervals and emits an exact semantic-frame selection.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from fractions import Fraction
from pathlib import Path

import pandas as pd

from .config import PipelineConfig
from .io_utils import write_csv_atomic, write_parquet_atomic
from .store import OutputStore
from .video_source import parse_video_uri


_SAFE_VIDEO_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_EXACT_FPS = re.compile(r"^[1-9][0-9]*/[1-9][0-9]*$")


def _non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _add_common(parser: argparse.ArgumentParser) -> None:
    defaults = PipelineConfig()
    parser.add_argument("--input-glob", default=defaults.input_glob)
    parser.add_argument(
        "--env-file",
        help="optional dotenv file for R2/AWS environment variables; secrets are never CLI flags",
    )
    parser.add_argument(
        "--manifest",
        help="existing canonical video manifest (.parquet/.csv/.json) to import/use",
    )
    parser.add_argument(
        "--source-uri",
        action="append",
        default=[],
        help="explicit local/file/r2/s3 video URI to probe; repeat for multiple videos",
    )
    parser.add_argument(
        "--source-uri-file",
        help="UTF-8 file containing one local/file/r2/s3 video URI per line",
    )
    parser.add_argument(
        "--reprobe",
        action="store_true",
        help="with `all`, replace an existing manifest by probing --input-glob again",
    )
    parser.add_argument("--out", default=defaults.out_dir)
    parser.add_argument("--device", default=defaults.device)
    parser.add_argument("--limit", type=_non_negative_int, default=None, help="process only the first N videos")
    parser.add_argument(
        "--limit-hours",
        type=_positive_float,
        default=None,
        help="select roughly N hours round-robin across AIC batches",
    )
    parser.add_argument("--no-embed", action="store_true", help="skip visual embedding/index")
    parser.add_argument("--sbd-threshold", type=float, default=defaults.sbd_threshold)
    parser.add_argument("--sbd-weights", default=defaults.sbd_weights)
    parser.add_argument(
        "--no-sbd-download",
        action="store_true",
        help="use existing TransNetV2 assets or the temporal fallback",
    )
    parser.add_argument("--window-radius", type=int, default=defaults.window_radius)
    parser.add_argument("--blur-min", type=float, default=defaults.blur_min)
    parser.add_argument("--max-gap-s", type=float, default=defaults.max_gap_s)
    parser.add_argument("--frame-signal-long-edge", type=int, default=defaults.frame_signal_long_edge)
    parser.add_argument(
        "--signal-sampling",
        action=argparse.BooleanOptionalAction,
        default=defaults.signal_sampling,
        help="sample motion/scene/text-edge-change peaks",
    )
    parser.add_argument(
        "--shot-boundaries",
        action=argparse.BooleanOptionalAction,
        default=defaults.include_shot_boundaries,
    )
    parser.add_argument("--signal-peaks-per-shot", type=int, default=defaults.signal_peaks_per_shot)
    parser.add_argument("--motion-peak-min", type=float, default=defaults.motion_peak_min)
    parser.add_argument("--scene-change-peak-min", type=float, default=defaults.scene_change_peak_min)
    parser.add_argument("--text-change-peak-min", type=float, default=defaults.text_change_peak_min)
    parser.add_argument("--embed-model", default=defaults.embed_model)
    parser.add_argument("--embed-pretrained", default=defaults.embed_pretrained)
    parser.add_argument("--embed-batch-size", type=int, default=defaults.embed_batch_size)
    parser.add_argument(
        "--dino-mode",
        choices=["off", "dedup", "cluster_medoids"],
        default=defaults.dino_mode,
        help="optional DINOv2 structural deduplication/clustering lane",
    )
    parser.add_argument("--dino-model", default=defaults.dino_model)
    parser.add_argument("--dino-batch-size", type=int, default=defaults.dino_batch_size)
    parser.add_argument(
        "--dino-similarity-threshold",
        type=float,
        default=defaults.dino_similarity_threshold,
    )
    parser.add_argument(
        "--r2-endpoint-url",
        default=defaults.r2_endpoint_url,
        help="S3 API endpoint for r2:// sources; credentials use the boto3/AWS chain",
    )
    parser.add_argument("--r2-region-name", default=defaults.r2_region_name)
    parser.add_argument("--s3-endpoint-url", default=defaults.s3_endpoint_url)
    parser.add_argument("--s3-region-name", default=defaults.s3_region_name)
    parser.add_argument(
        "--artifact-uri-prefix",
        default=defaults.artifact_uri_prefix,
        help="stable URI prefix for uploaded outputs, e.g. r2://bucket/aic-run",
    )


def _config_from_args(args: argparse.Namespace) -> PipelineConfig:
    r2_endpoint = args.r2_endpoint_url or os.environ.get("R2_ENDPOINT")
    account_id = os.environ.get("R2_ACCOUNT_ID")
    if r2_endpoint is None and account_id:
        r2_endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    cfg = PipelineConfig(
        input_glob=args.input_glob,
        out_dir=args.out,
        device=args.device,
        sbd_threshold=args.sbd_threshold,
        sbd_weights=args.sbd_weights,
        window_radius=args.window_radius,
        blur_min=args.blur_min,
        max_gap_s=args.max_gap_s,
        frame_signal_long_edge=args.frame_signal_long_edge,
        signal_sampling=args.signal_sampling,
        include_shot_boundaries=args.shot_boundaries,
        signal_peaks_per_shot=args.signal_peaks_per_shot,
        motion_peak_min=args.motion_peak_min,
        scene_change_peak_min=args.scene_change_peak_min,
        text_change_peak_min=args.text_change_peak_min,
        embed_model=args.embed_model,
        embed_pretrained=args.embed_pretrained,
        embed_batch_size=args.embed_batch_size,
        dino_mode=args.dino_mode,
        dino_model=args.dino_model,
        dino_batch_size=args.dino_batch_size,
        dino_similarity_threshold=args.dino_similarity_threshold,
        r2_endpoint_url=r2_endpoint,
        r2_region_name=args.r2_region_name,
        s3_endpoint_url=args.s3_endpoint_url,
        s3_region_name=args.s3_region_name,
        artifact_uri_prefix=args.artifact_uri_prefix,
    )
    cfg.embed = not args.no_embed
    # The CLI intentionally relies on boto3's credential chain and never
    # accepts access keys or secrets as flags.
    cfg.validate()
    return cfg


def _load_environment_file(path_value: str | None) -> None:
    """Load an explicit dotenv file and bridge R2 names to boto3's chain."""

    if path_value:
        path = Path(path_value)
        if not path.is_file():
            raise FileNotFoundError(path)
        try:
            from dotenv import load_dotenv
        except ImportError:
            raise RuntimeError(
                "--env-file requires python-dotenv; install preprocessing requirements"
            ) from None
        load_dotenv(path, override=False)
    # The companion R2 console uses R2_* names, while boto3 intentionally
    # reads the standard AWS credential chain. Bridge only missing variables
    # in this process and never copy them into PipelineConfig/artifacts.
    aliases = {
        "R2_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        "R2_SESSION_TOKEN": "AWS_SESSION_TOKEN",
    }
    for source, destination in aliases.items():
        value = os.environ.get(source)
        if value:
            os.environ.setdefault(destination, value)


def _explicit_source_uris(args: argparse.Namespace) -> list[str]:
    sources = [str(value).strip() for value in (args.source_uri or []) if str(value).strip()]
    if args.source_uri_file:
        path = Path(args.source_uri_file)
        if not path.is_file():
            raise FileNotFoundError(path)
        sources.extend(
            line.strip()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    if len(sources) != len(set(sources)):
        raise ValueError("explicit source URI list contains duplicates")
    return sources


def _load_manifest_for_pipeline(cfg: PipelineConfig, store: OutputStore, args) -> pd.DataFrame:
    from .video_ingestion.probe import (
        build_manifest_from_sources,
        load_manifest,
        stratified_subset,
    )

    sources = _explicit_source_uris(args)
    if args.manifest:
        manifest = _import_video_manifest(args.manifest, store)
    elif sources:
        manifest = _normalise_video_manifest(
            build_manifest_from_sources(cfg, store, sources)
        )
    else:
        manifest = _normalise_video_manifest(load_manifest(cfg, store))
    if args.limit_hours:
        manifest = stratified_subset(manifest, args.limit_hours)
        args.limit = None
    return manifest


def _read_manifest_table(path_value: str) -> pd.DataFrame:
    path = Path(path_value)
    if not path.exists():
        raise FileNotFoundError(path)
    suffix = path.suffix.lower()
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(path)
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in {".jsonl", ".ndjson"}:
        return pd.read_json(path, lines=True)
    if suffix == ".json":
        with path.open("r", encoding="utf-8") as source:
            payload = json.load(source)
        if isinstance(payload, dict):
            return pd.DataFrame([payload])
        if isinstance(payload, list) and all(isinstance(record, dict) for record in payload):
            return pd.DataFrame(payload)
        raise ValueError("JSON video manifest must contain one object or an array of objects")
    raise ValueError("--manifest must end in .parquet, .pq, .csv, .json, or .jsonl")


def _normalise_video_manifest(manifest: pd.DataFrame) -> pd.DataFrame:
    table = manifest.copy()
    if "video_id" not in table.columns:
        raise ValueError("video manifest must contain video_id")
    table["video_id"] = table["video_id"].astype(str)
    invalid_ids = [value for value in table["video_id"] if not _SAFE_VIDEO_ID.fullmatch(value)]
    if invalid_ids:
        raise ValueError(f"video manifest contains unsafe video_id values: {invalid_ids[:5]}")
    if table["video_id"].duplicated().any():
        duplicates = table.loc[table["video_id"].duplicated(False), "video_id"].unique().tolist()
        raise ValueError(f"video manifest contains duplicate video_id values: {duplicates[:5]}")

    if "storage_uri" not in table.columns:
        table["storage_uri"] = pd.NA
    if "path" not in table.columns:
        table["path"] = pd.NA
    for index, row in table.iterrows():
        storage_uri = row.get("storage_uri")
        local_path = row.get("path")
        if not isinstance(storage_uri, str) or not storage_uri.strip():
            if isinstance(local_path, str) and local_path.strip():
                table.at[index, "storage_uri"] = Path(local_path).expanduser().resolve().as_uri()
            else:
                raise ValueError(f"video {row['video_id']} needs storage_uri or path")
        canonical_uri = str(table.at[index, "storage_uri"])
        if "://" not in canonical_uri:
            raise ValueError(
                f"video {row['video_id']} storage_uri must be a canonical file/r2/s3 URI"
            )
        parse_video_uri(canonical_uri)
    if "original_filename" not in table.columns:
        table["original_filename"] = table.apply(
            lambda row: Path(row["path"]).name
            if isinstance(row.get("path"), str) and row["path"]
            else str(row["storage_uri"]).rsplit("/", 1)[-1],
            axis=1,
        )
    if "duration_ms" not in table.columns:
        if "duration_s" not in table.columns:
            raise ValueError("video manifest needs duration_ms or duration_s")
        table["duration_ms"] = (pd.to_numeric(table["duration_s"]) * 1000).round().astype("int64")
    if "duration_s" not in table.columns:
        table["duration_s"] = pd.to_numeric(table["duration_ms"]) / 1000.0
    if "fps_str" not in table.columns:
        raise ValueError(
            "video manifest needs exact positive fps_str; it cannot be reconstructed from float fps"
        )
    exact_fps: list[float] = []
    for index, value in table["fps_str"].items():
        if not isinstance(value, str) or not _EXACT_FPS.fullmatch(value.strip()):
            raise ValueError(
                f"video {table.at[index, 'video_id']} needs fps_str as a positive fraction"
            )
        fraction = Fraction(value.strip())
        if fraction <= 0:
            raise ValueError(
                f"video {table.at[index, 'video_id']} needs a positive fps_str"
            )
        table.at[index, "fps_str"] = value.strip()
        exact_fps.append(float(fraction))
    # fps is only a convenience projection. Never let a rounded imported float
    # disagree with the exact source fraction.
    table["fps"] = exact_fps
    if "n_frames_est" not in table.columns:
        if "frame_count" in table.columns:
            table["n_frames_est"] = pd.to_numeric(table["frame_count"], errors="coerce")
        else:
            table["n_frames_est"] = pd.NA
        missing_counts = table["n_frames_est"].isna()
        table.loc[missing_counts, "n_frames_est"] = (
            table.loc[missing_counts, "duration_s"] * table.loc[missing_counts, "fps"]
        ).round()
        table["n_frames_est"] = table["n_frames_est"].astype("int64")
    return table.reset_index(drop=True)


def _import_video_manifest(path_value: str, store: OutputStore) -> pd.DataFrame:
    table = _normalise_video_manifest(_read_manifest_table(path_value))
    write_parquet_atomic(table, store.manifest_path)
    print(f"[manifest] imported {len(table)} videos from {path_value}")
    return table


def _write_hits(hits: pd.DataFrame, output_path: str) -> None:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in {".parquet", ".pq"}:
        write_parquet_atomic(hits, path)
    elif path.suffix.lower() == ".csv":
        write_csv_atomic(hits, path)
    else:
        raise ValueError("--save-hits must end in .parquet, .pq, or .csv")


def _manual_event_window(args: argparse.Namespace) -> pd.DataFrame:
    missing = [
        name
        for name, value in (
            ("--video-id", args.video_id),
            ("--start-frame", args.start_frame),
            ("--end-frame", args.end_frame),
        )
        if value is None
    ]
    if missing:
        raise ValueError("dense without --windows requires " + ", ".join(missing))
    event_window_id = args.event_window_id or (
        f"{args.video_id}_manual_{args.start_frame}_{args.end_frame}"
    )
    members = [] if args.target_frame is None else [args.target_frame]
    return pd.DataFrame([{
        "event_window_id": event_window_id,
        "video_id": args.video_id,
        "start_frame_id": args.start_frame,
        "end_frame_id": args.end_frame,
        "member_frame_ids": members,
    }])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        "aic-preprocessing",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subcommands = parser.add_subparsers(dest="cmd", required=True)
    for name in ["probe", "frames", "shots", "extract", "index", "report", "all"]:
        _add_common(subcommands.add_parser(name))

    search_parser = subcommands.add_parser("search")
    _add_common(search_parser)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("-k", type=int, default=10)
    search_parser.add_argument("--save-hits", help="optional .parquet/.csv output for `windows`")

    windows_parser = subcommands.add_parser("windows")
    _add_common(windows_parser)
    windows_parser.add_argument("--hits", required=True, help="search/retrieval hits table")
    windows_parser.add_argument("--run-id", required=True)
    windows_parser.add_argument("--frame-manifest", help="optional combined frame-manifest table")
    windows_parser.add_argument("--radius-ms", type=float, default=PipelineConfig().event_window_radius_ms)
    windows_parser.add_argument(
        "--merge-gap-ms",
        type=float,
        default=PipelineConfig().event_window_merge_gap_ms,
    )
    windows_parser.add_argument("--max-windows-per-video", type=int)

    dense_parser = subcommands.add_parser("dense")
    _add_common(dense_parser)
    dense_parser.add_argument("--windows", help="event-window .parquet/.csv; processes every row")
    dense_parser.add_argument("--video-id", help="manual single-window video ID")
    dense_parser.add_argument("--start-frame", type=int)
    dense_parser.add_argument("--end-frame", type=int, help="exclusive canonical frame ID")
    dense_parser.add_argument("--target-frame", type=int, help="optional event-proximity hint")
    dense_parser.add_argument("--event-window-id")
    dense_parser.add_argument("--event-scores", help="optional per-frame event-score table")
    dense_parser.add_argument("--resize-long-edge", type=int, default=720)
    dense_parser.add_argument("--force", action="store_true", help="overwrite dense checkpoints")

    benchmark_parser = subcommands.add_parser("benchmark")
    _add_common(benchmark_parser)
    benchmark_parser.add_argument("-k", type=int, default=10)
    benchmark_parser.add_argument("--rounds", type=int, default=5)

    eval_parser = subcommands.add_parser("eval-btc")
    _add_common(eval_parser)
    eval_parser.add_argument("--btc-dir", required=True)
    eval_parser.add_argument("--tolerances", default="1,2,5")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    _load_environment_file(args.env_file)
    cfg = _config_from_args(args)
    store = OutputStore(cfg.out_dir)
    manifest: pd.DataFrame | None = None
    explicit_sources = _explicit_source_uris(args)

    if args.cmd == "probe":
        if args.manifest:
            manifest = _import_video_manifest(args.manifest, store)
        elif explicit_sources:
            from .video_ingestion.probe import build_manifest_from_sources

            manifest = build_manifest_from_sources(cfg, store, explicit_sources)
        else:
            from .video_ingestion.probe import build_manifest

            manifest = build_manifest(cfg, store)
    elif args.cmd == "all":
        if args.manifest:
            manifest = _import_video_manifest(args.manifest, store)
        elif explicit_sources:
            from .video_ingestion.probe import build_manifest_from_sources

            manifest = build_manifest_from_sources(cfg, store, explicit_sources)
        elif store.manifest_path.exists() and not args.reprobe:
            from .video_ingestion.probe import load_manifest

            manifest = _normalise_video_manifest(load_manifest(cfg, store))
            print(
                f"[manifest] reusing {store.manifest_path}; pass --reprobe to scan --input-glob"
            )
        else:
            from .video_ingestion.probe import build_manifest

            manifest = build_manifest(cfg, store)
        if args.limit_hours:
            from .video_ingestion.probe import stratified_subset

            manifest = stratified_subset(manifest, args.limit_hours)
            args.limit = None
    if args.cmd in {"frames", "shots", "extract", "dense"}:
        manifest = _load_manifest_for_pipeline(cfg, store, args)

    needs_cuda_check = args.cmd in {"search", "benchmark"} or (
        (cfg.embed or cfg.dino_mode != "off") and args.cmd in {"extract", "all"}
    )
    if needs_cuda_check:
        from .gpu_check import assert_cuda_usable

        assert_cuda_usable(cfg.device)

    if args.cmd in {"frames", "all"}:
        from .keyframes.frame_manifest import run_frame_manifest

        assert manifest is not None
        run_frame_manifest(cfg, store, manifest, limit=args.limit)

    if args.cmd in {"shots", "all"}:
        from .shot_detection.shots import ensure_transnet_assets, run_pass_a

        assert manifest is not None
        if not args.no_sbd_download:
            ensure_transnet_assets(cfg)
        run_pass_a(cfg, store, manifest, limit=args.limit)

    if args.cmd in {"extract", "all"}:
        from .keyframes.extractor import run_pass_b

        assert manifest is not None
        run_pass_b(cfg, store, manifest, limit=args.limit)

    if args.cmd in {"index", "all"}:
        if cfg.embed:
            from .indexer import build_index

            build_index(cfg, store)
        else:
            print("[index] skipped (--no-embed)")

    if args.cmd == "benchmark" or (args.cmd == "all" and cfg.embed):
        from .indexer import benchmark

        if store.faiss_path.exists():
            benchmark(cfg, store, k=getattr(args, "k", 10), rounds=getattr(args, "rounds", 5))
        else:
            print("[benchmark] skipped (no index)")

    if args.cmd in {"report", "all"}:
        from .metadata_extraction.stats import build_report

        build_report(cfg, store)

    if args.cmd == "eval-btc":
        from .metadata_extraction.eval_btc import build_eval_report

        tolerances = tuple(float(value) for value in args.tolerances.split(","))
        build_eval_report(store, Path(args.btc_dir), tolerances)

    if args.cmd == "search":
        from .indexer import search

        hits = search(cfg, store, args.query, k=args.k)
        columns = [
            column
            for column in (
                "score",
                "video_id",
                "original_frame_id",
                "timestamp_ms",
                "n",
                "shot_id",
                "path",
            )
            if column in hits.columns
        ]
        print(hits[columns].to_string(index=False))
        if args.save_hits:
            _write_hits(hits, args.save_hits)
            print(f"[search] wrote hits -> {args.save_hits}")

    if args.cmd == "windows":
        from .keyframes.workflow import build_event_window_artifact

        output = build_event_window_artifact(
            store,
            args.hits,
            args.run_id,
            radius_ms=args.radius_ms,
            merge_gap_ms=args.merge_gap_ms,
            frame_manifest=args.frame_manifest,
            max_windows_per_video=args.max_windows_per_video,
        )
        count = len(pd.read_parquet(output))
        print(f"[windows] {count} event windows -> {output}")

    if args.cmd == "dense":
        from .keyframes.workflow import run_dense_event_windows

        assert manifest is not None
        windows = args.windows if args.windows else _manual_event_window(args)
        results = run_dense_event_windows(
            cfg,
            store,
            manifest,
            windows,
            event_scores=args.event_scores,
            resize=args.resize_long_edge,
            force=args.force,
        )
        for result in results:
            print(
                f"[dense] {result['event_window_id']}: "
                f"original_frame_id={result['original_frame_id']} "
                f"timestamp_ms={result['timestamp_ms']:.3f} ({result['status']})"
            )


if __name__ == "__main__":
    main()
