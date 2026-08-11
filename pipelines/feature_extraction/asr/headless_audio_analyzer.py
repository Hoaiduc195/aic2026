"""Headless DNSMOS adapter used by the vendored Sherpa pipeline.

The original desktop analyzer imports PyQt and owns UI worker threads.  The
CLI only needs the synchronous DNSMOS calculation, so this module keeps that
small interface without bringing a GUI dependency into the runtime.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np

SAMPLE_RATE = 16_000
DNSMOS_MODEL_NAME = "sig_bak_ovr.onnx"
DNSMOS_TARGET_SAMPLES = 144_160


class AudioQualityAnalyzer:
    """Synchronous DNSMOS calculator compatible with ``asr_engine.py``."""

    def __init__(self, offline_recognizer: Any = None, online_recognizer: Any = None, use_gpu: bool = False):
        del offline_recognizer, online_recognizer, use_gpu
        self._dnsmos_session: Any | None = None

    def _load_dnsmos(self) -> Any | None:
        if self._dnsmos_session is not None:
            return self._dnsmos_session
        try:
            import onnxruntime as ort
            from core.config import BASE_DIR
        except ImportError:
            return None

        model_path = Path(BASE_DIR) / "models" / "dnsmos" / DNSMOS_MODEL_NAME
        if not model_path.is_file():
            return None
        options = ort.SessionOptions()
        options.enable_cpu_mem_arena = False
        self._dnsmos_session = ort.InferenceSession(
            os.fspath(model_path), options, providers=["CPUExecutionProvider"]
        )
        return self._dnsmos_session

    def compute_dnsmos(self, audio: np.ndarray, sr: int = SAMPLE_RATE) -> dict[str, float] | None:
        del sr
        session = self._load_dnsmos()
        if session is None:
            return None

        audio_array = np.asarray(audio, dtype=np.float32)
        padded = np.zeros(DNSMOS_TARGET_SAMPLES, dtype=np.float32)
        padded[: min(len(audio_array), DNSMOS_TARGET_SAMPLES)] = audio_array[:DNSMOS_TARGET_SAMPLES]
        try:
            input_name = session.get_inputs()[0].name
            outputs = session.run(None, {input_name: padded.reshape(1, -1)})
            scores = np.asarray(outputs[0])
            scores = scores[0] if scores.ndim == 2 else scores
            if len(scores) < 3:
                return None

            p_ovr = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
            p_sig = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
            p_bak = np.poly1d([-0.13166888, 1.60915514, -0.39604546])
            return {
                "SIG": float(np.clip(p_sig(scores[0]), 1.0, 5.0)),
                "BAK": float(np.clip(p_bak(scores[1]), 1.0, 5.0)),
                "OVRL": float(np.clip(p_ovr(scores[2]), 1.0, 5.0)),
            }
        except (IndexError, TypeError, ValueError, RuntimeError):
            return None
