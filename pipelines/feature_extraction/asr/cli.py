"""CLI for timeline-only ASR transcription."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import replace
from pathlib import Path

from pipelines.feature_extraction.asr.config import (
    SherpaAsrConfig,
    config_from_environment,
    load_sherpa_config,
)
from pipelines.feature_extraction.asr.io import (
    chunks_to_results,
    write_asr_results_json,
    write_asr_results_jsonl,
    write_asr_results_parquet,
)
from pipelines.feature_extraction.asr.runner import batch_transcribe, transcribe_file
from pipelines.feature_extraction.asr.sherpa_backend import (
    SherpaBackend,
    check_sherpa_runtime,
)
from pipelines.feature_extraction.asr.transcriber import (
    JsonTranscriptBackend,
    WhisperBackend,
    demux_audio_to_wav,
)


def main(argv: list[str] | None = None) -> int | None:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        _build_sherpa_parser().print_help()
        return 0
    if arguments[0] in {"-h", "--help"}:
        _build_sherpa_parser().print_help()
        return 0
    if arguments[0] not in {"check", "transcribe", "batch"}:
        return _legacy_main(arguments)

    parser = _build_sherpa_parser()
    args = parser.parse_args(arguments)
    try:
        config = _config_from_args(args)
        if args.command == "check":
            details = check_sherpa_runtime(config)
            for key, value in details.items():
                print(f"{key}: {value}")
            return 0

        backend = SherpaBackend(config)
        if args.command == "transcribe":
            output = args.output or args.input.with_suffix(".asr.jsonl")
            result = transcribe_file(
                args.input,
                output,
                backend=backend,
                overwrite=args.overwrite,
            )
            if result is None:
                print(f"skip: {output}")
            else:
                print(f"written: {result}")
            return 0

        written = batch_transcribe(
            args.input_dir,
            args.output_dir,
            backend=backend,
            recursive=args.recursive,
            overwrite=args.overwrite,
        )
        print(f"written: {len(written)} file(s)")
        return 0
    except (FileNotFoundError, NotADirectoryError, RuntimeError, ValueError) as exc:
        parser.error(str(exc))
        return 2


def _build_sherpa_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pipelines.feature_extraction.asr.cli",
        description="Headless Vietnamese Sherpa ASR CLI",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "transcribe", "batch"):
        command_parser = subparsers.add_parser(command)
        _add_runtime_arguments(command_parser)

    transcribe_parser = subparsers.choices["transcribe"]
    transcribe_parser.add_argument("input", type=Path)
    transcribe_parser.add_argument("--output", type=Path)
    transcribe_parser.add_argument("--overwrite", action="store_true")

    batch_parser = subparsers.choices["batch"]
    batch_parser.add_argument("input_dir", type=Path)
    batch_parser.add_argument("--output-dir", type=Path, required=True)
    batch_parser.add_argument("--recursive", action="store_true")
    batch_parser.add_argument("--overwrite", action="store_true")
    return parser


def _add_runtime_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--model-name")
    parser.add_argument("--ffmpeg-dir", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--cpu-threads", type=int)
    parser.add_argument("--language")
    parser.add_argument("--device", dest="execution_provider")
    parser.add_argument("--disable-punctuation", action="store_true")
    parser.add_argument("--disable-quality", action="store_true")


def _config_from_args(args: argparse.Namespace) -> SherpaAsrConfig:
    config_path = args.config or Path(__file__).with_name("config.ini")
    config = config_from_environment(
        load_sherpa_config(config_path if config_path.is_file() else None)
    )
    updates = {}
    for field_name in ("model_dir", "model_name", "ffmpeg_dir", "cpu_threads", "language", "execution_provider"):
        value = getattr(args, field_name, None)
        if value is not None:
            updates[field_name] = value
    if args.disable_punctuation:
        updates["punctuation"] = False
    if args.disable_quality:
        updates["quality"] = False
    return replace(config, **updates)


def _legacy_main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Run ASR and emit timeline-only contract rows.")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--workdir", type=Path, default=Path("data/tmp/asr"))
    parser.add_argument(
        "--backend",
        choices=["transcript-json", "faster-whisper", "openai-whisper"],
        default="faster-whisper",
    )
    parser.add_argument("--transcript-json", type=Path)
    parser.add_argument("--model-name", default="small")
    parser.add_argument("--language", default="vi")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--format", choices=["jsonl", "json", "parquet"], default="jsonl")
    args = parser.parse_args(argv)

    backend = _build_backend(args)
    audio_path = (
        Path("ignored.wav")
        if args.backend == "transcript-json"
        else _resolve_audio_path(args.video_id, args.audio, args.video, args.workdir)
    )
    transcripts = list(backend.transcribe(audio_path))
    results = chunks_to_results(
        transcripts,
        video_id=args.video_id,
        model_version=args.model_name,
        producer=f"asr:{args.backend}",
        pipeline_version="asr-cli-v2",
    )

    if args.format == "jsonl":
        write_asr_results_jsonl(results, args.output)
    elif args.format == "json":
        write_asr_results_json(results, args.output)
    else:
        write_asr_results_parquet(results, args.output)


def _resolve_audio_path(
    video_id: str,
    audio_path: Path | None,
    video_path: Path | None,
    workdir: Path,
) -> Path:
    if re.fullmatch(r"[A-Za-z0-9_-]+", video_id) is None:
        raise ValueError("video_id may contain only letters, numbers, '_' and '-' ")
    if audio_path is not None:
        return audio_path
    if video_path is None:
        raise ValueError("Provide either --audio or --video")
    resolved_workdir = workdir.resolve()
    output_path = (resolved_workdir / f"{video_id}.16k_mono.wav").resolve()
    if not output_path.is_relative_to(resolved_workdir):
        raise ValueError("video_id resolves outside workdir")
    return demux_audio_to_wav(video_path, output_path)


def _build_backend(args: argparse.Namespace) -> JsonTranscriptBackend | WhisperBackend:
    if args.backend == "transcript-json":
        if args.transcript_json is None:
            raise ValueError("--transcript-json is required for backend=transcript-json")
        return JsonTranscriptBackend(args.transcript_json)
    return WhisperBackend(
        model_name=args.model_name,
        language=args.language,
        device=args.device,
        implementation=args.backend,
    )


if __name__ == "__main__":
    raise SystemExit(main() or 0)
