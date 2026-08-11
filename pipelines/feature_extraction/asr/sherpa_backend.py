"""Headless adapter around the pure-Python Sherpa transcription pipeline."""

from __future__ import annotations

import importlib
import math
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from statistics import fmean
from typing import Any

from pipelines.feature_extraction.asr.config import SherpaAsrConfig, resolve_model_path
from pipelines.feature_extraction.asr.models import (
    QualityInfo,
    TranscriptChunk,
    WordTiming,
)


class SherpaRuntimeError(RuntimeError):
    """Raised when the vendored core or its external runtime is unavailable."""


class SherpaBackend:
    """Use Sherpa's headless ``TranscriberPipeline`` as a chunk backend."""

    model_version: str

    def __init__(self, config: SherpaAsrConfig) -> None:
        if config.model_dir is None:
            raise ValueError("model_dir is required for the Sherpa backend")
        self.config = config
        self.model_path = resolve_model_path(config.model_dir, config.model_name)
        self.model_version = config.model_name

    def transcribe(self, audio_path: Path) -> list[TranscriptChunk]:
        pipeline_class = _load_pipeline_class(self.model_path)
        runtime_config = _pipeline_config(self.config)
        progress_callback = _progress_callback
        with _prepend_path(self.config.ffmpeg_dir):
            try:
                pipeline = pipeline_class(
                    os.fspath(audio_path),
                    os.fspath(self.model_path),
                    runtime_config,
                    progress_callback=progress_callback,
                )
                result = pipeline.run()
            except (FileNotFoundError, ImportError, OSError, RuntimeError) as exc:
                raise SherpaRuntimeError(f"Sherpa transcription failed: {exc}") from exc
        return _chunks_from_result(result, language=self.config.language, include_quality=self.config.quality)


def check_sherpa_runtime(config: SherpaAsrConfig) -> dict[str, str]:
    """Validate model/vendor paths without initializing an ONNX session."""

    if config.model_dir is None:
        raise ValueError("model_dir is required")
    model_path = resolve_model_path(config.model_dir, config.model_name)
    vendor_core = Path(__file__).with_name("vendor") / "core"
    if not (vendor_core / "asr_engine.py").is_file():
        raise FileNotFoundError(
            f"headless Sherpa core not installed at {vendor_core}; run install_sherpa_asr.py"
        )
    if config.ffmpeg_dir is not None:
        _validate_ffmpeg_dir(config.ffmpeg_dir)
    return {
        "model": os.fspath(model_path),
        "vendor_core": os.fspath(vendor_core),
        "execution_provider": config.execution_provider,
    }


def _load_pipeline_class(model_path: Path) -> Any:
    vendor_root = Path(__file__).with_name("vendor").resolve()
    core_dir = vendor_root / "core"
    if not (core_dir / "asr_engine.py").is_file():
        raise SherpaRuntimeError(
            f"headless Sherpa core not installed at {core_dir}; run install_sherpa_asr.py"
        )

    vendor_text = os.fspath(vendor_root)
    if vendor_text not in sys.path:
        sys.path.insert(0, vendor_text)
    importlib.invalidate_caches()

    _evict_foreign_core(vendor_text)
    try:
        config_module = importlib.import_module("core.config")
        runtime_root = _runtime_root(model_path)
        config_module.BASE_DIR = os.fspath(runtime_root)
        config_module.CONFIG_FILE = os.fspath(runtime_root / "config.ini")
        engine_module = importlib.import_module("core.asr_engine")
    except (ImportError, ModuleNotFoundError) as exc:
        raise SherpaRuntimeError(
            "Sherpa runtime dependencies are missing; install the ASR requirements"
        ) from exc
    pipeline_class = getattr(engine_module, "TranscriberPipeline", None)
    if pipeline_class is None:
        raise SherpaRuntimeError("vendored Sherpa core has no TranscriberPipeline")
    return pipeline_class


def _evict_foreign_core(vendor_root: str) -> None:
    loaded = sys.modules.get("core")
    if loaded is None:
        return
    loaded_path = getattr(loaded, "__path__", [])
    if any(os.fspath(path).startswith(vendor_root) for path in loaded_path):
        return
    for name in tuple(sys.modules):
        if name == "core" or name.startswith("core."):
            del sys.modules[name]


def _runtime_root(model_path: Path) -> Path:
    model_parent = model_path.parent
    if model_parent.name.lower() == "models":
        return model_parent.parent
    return model_parent


def _pipeline_config(config: SherpaAsrConfig) -> dict[str, Any]:
    return {
        "cpu_threads": config.cpu_threads,
        "execution_provider": config.execution_provider,
        "stage_execution_providers": {},
        "restore_punctuation": config.punctuation,
        "punctuation_confidence": 0.3,
        "case_confidence": 0.0,
        "speaker_diarization": False,
        "overlap_separation": False,
        "auto_analyze_quality": config.quality,
        "bypass_vad": config.bypass_vad,
        "save_ram": config.save_ram,
        "preprocess_rms_normalize": config.preprocess_rms_normalize,
    }


def _chunks_from_result(
    result: Any,
    *,
    language: str,
    include_quality: bool,
) -> list[TranscriptChunk]:
    if not isinstance(result, dict):
        raise SherpaRuntimeError("Sherpa pipeline returned an invalid result")
    global_confidence = _optional_confidence(result.get("asr_confidence"))
    quality = _quality_from_result(result, global_confidence) if include_quality else None
    chunks: list[TranscriptChunk] = []
    for segment in result.get("segments", []):
        if not isinstance(segment, dict):
            continue
        text = str(segment.get("text", "")).strip()
        start_ms = _seconds_to_ms(segment.get("start", 0.0))
        end_ms = _seconds_to_ms(segment.get("end", 0.0))
        if not text or end_ms <= start_ms:
            continue
        words = _word_timings(segment.get("raw_words", []))
        confidence = _chunk_confidence(segment, words, global_confidence)
        raw_text = " ".join(word.text for word in words) or text
        chunks.append(
            TranscriptChunk(
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                confidence=confidence,
                words=words,
                text_raw=raw_text,
                language=language,
                no_speech_probability=_optional_confidence(segment.get("no_speech_prob")),
                quality=quality,
            )
        )
    return chunks


def _word_timings(raw_words: Any) -> tuple[WordTiming, ...]:
    if not isinstance(raw_words, list):
        return ()
    words: list[WordTiming] = []
    for raw_word in raw_words:
        if not isinstance(raw_word, dict):
            continue
        text = str(raw_word.get("text", "")).strip()
        start_ms = _seconds_to_ms(raw_word.get("start", raw_word.get("local_start", 0.0)))
        end_ms = _seconds_to_ms(raw_word.get("end", raw_word.get("local_end", 0.0)))
        if not text or end_ms <= start_ms:
            continue
        confidence = _optional_confidence(
            raw_word.get("prob", raw_word.get("confidence"))
        )
        words.append(WordTiming(text, start_ms, end_ms, confidence or 0.0))
    return tuple(words)


def _chunk_confidence(
    segment: dict[str, Any],
    words: tuple[WordTiming, ...],
    fallback: float | None,
) -> float:
    direct = _optional_confidence(segment.get("confidence"))
    if direct is not None:
        return direct
    if words:
        return fmean(word.confidence for word in words)
    return fallback if fallback is not None else 0.0


def _quality_from_result(result: dict[str, Any], confidence: float | None) -> QualityInfo:
    raw = result.get("quality_info")
    if not isinstance(raw, dict):
        return QualityInfo(asr_confidence=confidence)
    overall = _optional_score(raw.get("dnsmos_ovrl"), 5.0)
    effective_confidence = confidence
    ready = None
    if effective_confidence is not None:
        ready = effective_confidence >= 0.60 and (overall is None or overall >= 2.5)
    suggestions: list[str] = []
    if effective_confidence is not None and effective_confidence < 0.60:
        suggestions.append("confidence thấp")
    if overall is not None and overall < 2.5:
        suggestions.append("chất lượng âm thanh thấp")
    return QualityInfo(
        asr_confidence=effective_confidence,
        dnsmos_sig=_optional_score(raw.get("dnsmos_sig", raw.get("SIG")), 5.0),
        dnsmos_bak=_optional_score(raw.get("dnsmos_bak", raw.get("BAK")), 5.0),
        dnsmos_ovrl=overall,
        ready=ready,
        suggestions=tuple(suggestions),
    )


def _seconds_to_ms(value: Any) -> int:
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise SherpaRuntimeError("Sherpa returned an invalid timestamp") from exc
    if seconds < 0:
        raise SherpaRuntimeError("Sherpa returned a negative timestamp")
    return round(seconds * 1000)


def _optional_confidence(value: Any) -> float | None:
    return _optional_score(value, 1.0)


def _optional_score(value: Any, maximum: float) -> float | None:
    if value is None:
        return None
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(score) or score < 0 or score > maximum:
        return None
    return score


@contextmanager
def _prepend_path(directory: Path | None) -> Iterator[None]:
    if directory is None:
        yield
        return
    _validate_ffmpeg_dir(directory)
    old_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.fspath(Path(directory).resolve()) + os.pathsep + old_path
    try:
        yield
    finally:
        os.environ["PATH"] = old_path


def _validate_ffmpeg_dir(directory: Path) -> None:
    path = Path(directory).expanduser().resolve()
    if not path.is_dir():
        raise NotADirectoryError(path)
    names = {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"}
    if not any((path / name).is_file() for name in names if name.startswith("ffmpeg")):
        raise FileNotFoundError(f"ffmpeg not found in {path}")
    if not any((path / name).is_file() for name in names if name.startswith("ffprobe")):
        raise FileNotFoundError(f"ffprobe not found in {path}")


def _progress_callback(message: str) -> None:
    if message:
        print(message)
