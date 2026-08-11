"""Configuration and model-path validation for the headless Sherpa backend."""

from __future__ import annotations

import configparser
import os
from dataclasses import dataclass, replace
from pathlib import Path

DEFAULT_MODEL_NAME = "sherpa-onnx-zipformer-vi-2025-04-20"
DEFAULT_PIPELINE_VERSION = "asr-cli-v1"


@dataclass(frozen=True)
class SherpaAsrConfig:
    """Validated runtime settings; model and binaries stay outside the repo."""

    model_dir: Path | None = None
    model_name: str = DEFAULT_MODEL_NAME
    cpu_threads: int = 4
    language: str = "vi"
    punctuation: bool = True
    quality: bool = True
    ffmpeg_dir: Path | None = None
    execution_provider: str = "cpu"
    bypass_vad: bool = False
    save_ram: bool = False
    preprocess_rms_normalize: bool = False
    pipeline_version: str = DEFAULT_PIPELINE_VERSION

    def __post_init__(self) -> None:
        if self.cpu_threads <= 0:
            raise ValueError("cpu_threads must be positive")
        if not self.model_name.strip():
            raise ValueError("model_name must be non-empty")
        if not self.language.strip():
            raise ValueError("language must be non-empty")
        if not self.execution_provider.strip():
            raise ValueError("execution_provider must be non-empty")
        if not self.pipeline_version.strip():
            raise ValueError("pipeline_version must be non-empty")

    def with_runtime_paths(
        self, *, model_dir: Path | None = None, ffmpeg_dir: Path | None = None
    ) -> SherpaAsrConfig:
        return replace(
            self,
            model_dir=model_dir if model_dir is not None else self.model_dir,
            ffmpeg_dir=ffmpeg_dir if ffmpeg_dir is not None else self.ffmpeg_dir,
        )


def load_sherpa_config(path: Path | None = None) -> SherpaAsrConfig:
    """Load the optional INI file without downloading or mutating runtime assets."""

    parser = configparser.ConfigParser()
    if path is not None:
        config_path = Path(path)
        if not config_path.is_file():
            raise FileNotFoundError(config_path)
        parser.read(config_path, encoding="utf-8")

    section = parser["asr"] if parser.has_section("asr") else {}
    model_dir = _optional_path(section.get("model_dir"))
    ffmpeg_dir = _optional_path(section.get("ffmpeg_dir"))
    return SherpaAsrConfig(
        model_dir=model_dir,
        model_name=section.get("model_name", DEFAULT_MODEL_NAME).strip(),
        cpu_threads=_parse_positive_int(section.get("cpu_threads", "4"), "cpu_threads"),
        language=section.get("language", "vi").strip(),
        punctuation=_parse_bool(section.get("punctuation", "true"), "punctuation"),
        quality=_parse_bool(section.get("quality", "true"), "quality"),
        ffmpeg_dir=ffmpeg_dir,
        execution_provider=section.get("execution_provider", "cpu").strip(),
        bypass_vad=_parse_bool(section.get("bypass_vad", "false"), "bypass_vad"),
        save_ram=_parse_bool(section.get("save_ram", "false"), "save_ram"),
        preprocess_rms_normalize=_parse_bool(
            section.get("preprocess_rms_normalize", "false"),
            "preprocess_rms_normalize",
        ),
        pipeline_version=section.get(
            "pipeline_version", DEFAULT_PIPELINE_VERSION
        ).strip(),
    )


def config_from_environment(config: SherpaAsrConfig) -> SherpaAsrConfig:
    """Apply the documented environment overrides to an immutable config."""

    model_dir = _optional_path(os.environ.get("ASR_MODEL_DIR")) or config.model_dir
    ffmpeg_dir = (
        _optional_path(os.environ.get("ASR_FFMPEG_DIR"))
        or _optional_path(os.environ.get("ASR_FFMPEG"))
        or config.ffmpeg_dir
    )
    model_name = os.environ.get("ASR_MODEL_NAME", config.model_name).strip()
    pipeline_version = os.environ.get(
        "ASR_PIPELINE_VERSION", config.pipeline_version
    ).strip()
    threads = os.environ.get("ASR_CPU_THREADS")
    cpu_threads = (
        _parse_positive_int(threads, "ASR_CPU_THREADS")
        if threads is not None
        else config.cpu_threads
    )
    return replace(
        config,
        model_dir=model_dir,
        ffmpeg_dir=ffmpeg_dir,
        model_name=model_name,
        cpu_threads=cpu_threads,
        pipeline_version=pipeline_version,
    )


def resolve_model_path(model_dir: Path, model_name: str) -> Path:
    """Resolve either a model root plus name or a direct model directory."""

    root = Path(model_dir).expanduser().resolve()
    if _looks_like_model_dir(root):
        return root

    candidate = (root / model_name).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("model_name resolves outside model_dir")
    if _looks_like_model_dir(candidate):
        return candidate
    raise FileNotFoundError(
        f"model assets not found for '{model_name}' under {root}"
    )


def _looks_like_model_dir(path: Path) -> bool:
    if not path.is_dir() or not (path / "tokens.txt").is_file():
        return False
    return all(any(path.glob(f"{prefix}-*.onnx")) for prefix in ("encoder", "decoder", "joiner"))


def _optional_path(value: str | None) -> Path | None:
    if value is None or not value.strip():
        return None
    return Path(value).expanduser()


def _parse_positive_int(value: str, field_name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a positive integer") from exc
    if parsed <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return parsed


def _parse_bool(value: str, field_name: str) -> bool:
    normalized = str(value).strip().lower()
    if normalized not in {"1", "true", "yes", "on", "0", "false", "no", "off"}:
        raise ValueError(f"{field_name} must be boolean")
    return normalized in {"1", "true", "yes", "on"}
