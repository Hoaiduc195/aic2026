"""Single-file and directory orchestration for the headless ASR CLI."""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Protocol

from pipelines.feature_extraction.asr.io import write_canonical_asr_jsonl
from pipelines.feature_extraction.asr.models import TranscriptChunk

SUPPORTED_MEDIA_EXTENSIONS = frozenset(
    {".avi", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".wav", ".webm"}
)


class ChunkBackend(Protocol):
    model_version: str

    def transcribe(self, audio_path: Path) -> Iterable[TranscriptChunk]:
        """Return timestamped chunks for one media file."""


def transcribe_file(
    input_path: Path,
    output_path: Path,
    *,
    backend: ChunkBackend,
    overwrite: bool = False,
    video_id: str | None = None,
) -> Path | None:
    """Transcribe one file; return ``None`` when an existing output is skipped."""

    source = Path(input_path).expanduser().resolve()
    output = Path(output_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if output.exists() and not overwrite:
        return None

    chunks = tuple(backend.transcribe(source))
    write_canonical_asr_jsonl(
        chunks,
        output,
        video_id=_video_id(video_id or source.stem),
        model_version=getattr(backend, "model_version", "unknown"),
        pipeline_version=getattr(backend, "pipeline_version", "asr-cli-v1"),
    )
    return output


def batch_transcribe(
    input_dir: Path,
    output_dir: Path,
    *,
    backend: ChunkBackend,
    recursive: bool = False,
    overwrite: bool = False,
) -> list[Path]:
    """Transcribe supported media files, direct-only unless ``recursive`` is set."""

    source_root = Path(input_dir).expanduser().resolve()
    target_root = Path(output_dir).expanduser().resolve()
    if not source_root.is_dir():
        raise NotADirectoryError(source_root)

    iterator = source_root.rglob("*") if recursive else source_root.glob("*")
    media_files = tuple(
        sorted(
            path
            for path in iterator
            if path.is_file() and path.suffix.lower() in SUPPORTED_MEDIA_EXTENSIONS
        )
    )
    written: list[Path] = []
    for media_path in media_files:
        relative = media_path.relative_to(source_root)
        output_relative = relative.with_suffix(".asr.jsonl")
        output_path = target_root / output_relative
        video_id = relative.with_suffix("").as_posix()
        result = transcribe_file(
            media_path,
            output_path,
            backend=backend,
            overwrite=overwrite,
            video_id=video_id,
        )
        if result is not None:
            written.append(result)
    return written


def _video_id(stem: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_")
    return value or "video"
