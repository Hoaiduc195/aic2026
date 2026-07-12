"""Command-line entrypoint for ASR preprocessing."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from pipelines.feature_extraction.asr.io import (
    read_segments_json,
    write_asr_results_json,
    write_asr_results_jsonl,
    write_asr_results_parquet,
)
from pipelines.feature_extraction.asr.segment_mapping import map_transcripts_to_segments
from pipelines.feature_extraction.asr.transcriber import JsonTranscriptBackend, WhisperBackend, demux_audio_to_wav


def main() -> None:
    parser = argparse.ArgumentParser(description="Run ASR and emit contract-compatible rows.")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--segments", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--workdir", type=Path, default=Path("data/tmp/asr"))
    parser.add_argument("--backend", choices=["transcript-json", "faster-whisper", "openai-whisper"], default="faster-whisper")
    parser.add_argument("--transcript-json", type=Path)
    parser.add_argument("--model-name", default="small")
    parser.add_argument("--language", default="vi")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--format", choices=["jsonl", "json", "parquet"], default="jsonl")
    args = parser.parse_args()

    backend = _build_backend(args)
    audio_path = (
        Path("ignored.wav")
        if args.backend == "transcript-json"
        else _resolve_audio_path(args.video_id, args.audio, args.video, args.workdir)
    )
    transcripts = list(backend.transcribe(audio_path))
    segments = read_segments_json(args.segments)
    results = map_transcripts_to_segments(args.video_id, transcripts, segments)

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
        raise ValueError("video_id may contain only letters, numbers, '_' and '-'")
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
    main()
