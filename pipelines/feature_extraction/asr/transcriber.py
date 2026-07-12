"""ASR backends and audio preparation helpers."""

from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, Protocol

from pipelines.feature_extraction.asr.models import TranscriptChunk


class TranscriptionBackend(Protocol):
    """Backend interface used by the ASR pipeline."""

    def transcribe(self, audio_path: Path) -> Iterable[TranscriptChunk]:
        """Transcribe an audio file into timestamped chunks."""


def demux_audio_to_wav(
    video_path: Path,
    output_path: Path,
    *,
    sample_rate: int = 16000,
    timeout_seconds: float = 300,
    max_duration_seconds: float = 21600,
) -> Path:
    """Extract mono WAV audio for Whisper-compatible ASR.

    Requires ``ffmpeg`` to be available on PATH.
    """

    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if not math.isfinite(max_duration_seconds) or max_duration_seconds <= 0:
        raise ValueError("max_duration_seconds must be positive")
    if not video_path.exists():
        raise FileNotFoundError(video_path)

    duration = _probe_duration_seconds(video_path, min(timeout_seconds, 30))
    if duration > max_duration_seconds:
        raise ValueError(
            f"media duration {duration:.1f}s exceeds limit {max_duration_seconds:.1f}s"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_path.name}.", dir=output_path.parent
    ) as staging_directory:
        temporary_path = Path(staging_directory) / "audio.wav"
        command = [
            "ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar",
            str(sample_rate), "-f", "wav", str(temporary_path),
        ]
        subprocess.run(command, check=True, timeout=timeout_seconds)
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise RuntimeError("ffmpeg did not produce a non-empty WAV file")
        os.replace(temporary_path, output_path)
    return output_path


class JsonTranscriptBackend:
    """Load timestamped transcript chunks from JSON for tests or checkpoints."""

    def __init__(self, transcript_path: Path) -> None:
        self.transcript_path = transcript_path

    def transcribe(self, audio_path: Path) -> Iterable[TranscriptChunk]:
        del audio_path
        raw = json.loads(self.transcript_path.read_text(encoding="utf-8"))
        rows = raw["segments"] if isinstance(raw, dict) and "segments" in raw else raw
        if not isinstance(rows, list):
            raise ValueError("transcript JSON must be a list or an object with segments")
        return [_chunk_from_json(row) for row in rows]


class WhisperBackend:
    """Lazy Whisper integration.

    ``implementation="faster-whisper"`` uses the faster-whisper package.
    ``implementation="openai-whisper"`` uses the original whisper package.
    """

    def __init__(
        self,
        *,
        model_name: str = "small",
        language: str | None = "vi",
        device: str = "auto",
        implementation: str = "faster-whisper",
    ) -> None:
        self.model_name = model_name
        self.language = language
        self.device = device
        self.implementation = implementation
        self._model: Any | None = None

    def transcribe(self, audio_path: Path) -> Iterable[TranscriptChunk]:
        if self.implementation == "faster-whisper":
            return self._transcribe_with_faster_whisper(audio_path)
        if self.implementation == "openai-whisper":
            return self._transcribe_with_openai_whisper(audio_path)
        raise ValueError(f"Unsupported Whisper implementation: {self.implementation}")

    def _transcribe_with_faster_whisper(self, audio_path: Path) -> list[TranscriptChunk]:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "Install faster-whisper to use implementation='faster-whisper'"
            ) from exc

        if self._model is None:
            self._model = WhisperModel(self.model_name, device=self.device)
        model = self._model
        segments, _info = model.transcribe(
            str(audio_path),
            language=self.language,
            vad_filter=True,
        )
        return [
            TranscriptChunk(
                start_ms=_seconds_to_ms(segment.start),
                end_ms=_seconds_to_ms(segment.end),
                text=segment.text.strip(),
                confidence=_confidence_from_faster_whisper(segment),
            )
            for segment in segments
            if segment.text.strip()
        ]

    def _transcribe_with_openai_whisper(self, audio_path: Path) -> list[TranscriptChunk]:
        try:
            import whisper
        except ImportError as exc:
            raise RuntimeError(
                "Install openai-whisper to use implementation='openai-whisper'"
            ) from exc

        if self._model is None:
            self._model = whisper.load_model(
                self.model_name, device=None if self.device == "auto" else self.device
            )
        model = self._model
        result = model.transcribe(str(audio_path), language=self.language)
        return [
            _chunk_from_json(segment)
            for segment in result.get("segments", [])
            if str(segment.get("text", "")).strip()
        ]


def _chunk_from_json(row: Any) -> TranscriptChunk:
    if not isinstance(row, dict):
        raise ValueError("transcript segment must be an object")

    start_ms = _timestamp_to_ms(row, "start_ms", "start")
    end_ms = _timestamp_to_ms(row, "end_ms", "end")
    text = str(row.get("text", "")).strip()
    confidence = _confidence_from_row(row)
    return TranscriptChunk(
        start_ms=start_ms,
        end_ms=end_ms,
        text=text,
        confidence=confidence,
    )


def _timestamp_to_ms(row: dict[str, Any], ms_key: str, seconds_key: str) -> int:
    if ms_key in row:
        return int(row[ms_key])
    if seconds_key in row:
        return _seconds_to_ms(float(row[seconds_key]))
    raise ValueError(f"missing timestamp field: {ms_key} or {seconds_key}")


def _seconds_to_ms(value: float) -> int:
    return int(round(value * 1000))


def _probe_duration_seconds(media_path: Path, timeout_seconds: float) -> float:
    command = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(media_path),
    ]
    completed = subprocess.run(
        command, check=True, capture_output=True, text=True, timeout=timeout_seconds
    )
    try:
        duration = float(completed.stdout.strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("ffprobe returned an invalid media duration") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("media duration must be a positive finite number")
    return duration


def _confidence_from_faster_whisper(segment: Any) -> float:
    avg_logprob = getattr(segment, "avg_logprob", None)
    if isinstance(avg_logprob, (int, float)) and math.isfinite(avg_logprob):
        return max(0.0, min(1.0, math.exp(float(avg_logprob))))
    return 0.0


def _confidence_from_row(row: dict[str, Any]) -> float:
    if "confidence" in row or "avg_confidence" in row:
        return float(row.get("confidence", row.get("avg_confidence")))
    avg_logprob = row.get("avg_logprob")
    if isinstance(avg_logprob, (int, float)) and math.isfinite(avg_logprob):
        return max(0.0, min(1.0, math.exp(float(avg_logprob))))
    return 0.0
