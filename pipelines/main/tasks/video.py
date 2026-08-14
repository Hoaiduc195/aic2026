"""Video probing and deterministic frame decoding primitives."""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path
from typing import Any


def require_cv2() -> Any:
    try:
        import cv2
    except ImportError as error:  # pragma: no cover - dependency boundary
        raise RuntimeError("opencv-python is required for local video processing") from error
    return cv2


def safe_video_id(path: Path) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", path.stem).strip("._-")
    return value or "video"


def rational_fps(value: float) -> tuple[int, int]:
    if not math.isfinite(value) or value <= 0:
        return 25, 1
    fraction = Fraction(str(value)).limit_denominator(100_000)
    return fraction.numerator, fraction.denominator


def probe_video(path: Path, *, video_id: str) -> dict[str, Any]:
    cv2 = require_cv2()
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError(f"cannot open video: {path}")
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps_num, fps_den = rational_fps(fps)
        duration_ms = round(count * 1000 * fps_den / fps_num) if count > 0 else 0
        return {
            "video_id": video_id,
            "original_filename": path.name,
            "storage_uri": path.resolve().as_uri(),
            "duration_ms": duration_ms,
            "fps_str": f"{fps_num}/{fps_den}",
            "width": max(width, 1),
            "height": max(height, 1),
            "size_bytes": path.stat().st_size,
            "frame_count": count if count >= 0 else None,
            "created_at": _now(),
            "codec": "opencv",
            "container_format": path.suffix.lower().lstrip("."),
            "has_audio": False,
            "is_variable_fps": False,
            "decode_status": "pending",
            "processing_status": "pending",
            "pipeline_version": "main-v1.0.0",
            "schema_version": "1.0.0",
            "n_frames_est": max(count, 0),
        }
    finally:
        capture.release()


def decode_frames(path: Path, manifest: dict[str, Any]) -> Iterator[tuple[dict[str, Any], Any]]:
    cv2 = require_cv2()
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError(f"cannot open video: {path}")
    fps_num, fps_den = (int(part) for part in str(manifest["fps_str"]).split("/", 1))
    previous_gray = None
    frame_index = 0
    try:
        while True:
            ok, image = capture.read()
            if not ok:
                break
            timestamp_ms = round(frame_index * 1000 * fps_den / fps_num)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            brightness = float(gray.mean())
            contrast = float(gray.std())
            blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            entropy = _entropy(gray)
            motion = 0.0
            scene_change = 0.0
            text_change = 0.0
            if previous_gray is not None:
                difference = cv2.absdiff(gray, previous_gray)
                motion = float(difference.mean())
                scene_change = min(1.0, motion / 64.0)
                text_change = float(cv2.Canny(difference, 50, 150).mean())
            previous_gray = gray
            yield (
                {
                    "video_id": manifest["video_id"],
                    "original_frame_id": frame_index,
                    "decoded_frame_index": frame_index,
                    "pts": None,
                    "time_base_num": None,
                    "time_base_den": None,
                    "fps_num": fps_num,
                    "fps_den": fps_den,
                    "raw_pts_timestamp_ms": None,
                    "pts_origin_ms": None,
                    "pts_timestamp_ms": None,
                    "cfr_timestamp_ms": timestamp_ms,
                    "timestamp_ms": timestamp_ms,
                    "timestamp_source": "cfr_fallback",
                    "is_codec_keyframe": False,
                    "decode_status": "success",
                    "width": int(image.shape[1]),
                    "height": int(image.shape[0]),
                    "brightness_score": brightness,
                    "blur_score": max(0.0, blur),
                    "contrast_score": max(0.0, contrast),
                    "entropy_score": max(0.0, entropy),
                    "motion_score": max(0.0, motion),
                    "scene_change_score": max(0.0, scene_change),
                    "text_change_score": max(0.0, text_change),
                    "frame_id": f"{manifest['video_id']}:{frame_index}",
                    "quality_tier": _quality_tier(brightness, blur, contrast),
                    "pipeline_version": "main-v1.0.0",
                    "schema_version": "1.0.0",
                },
                image,
            )
            frame_index += 1
    finally:
        capture.release()


def _quality_tier(brightness: float, blur: float, contrast: float) -> str:
    if brightness < 10 or brightness > 245 or contrast < 5:
        return "low"
    if blur < 30:
        return "medium"
    return "high"


def _entropy(gray: Any) -> float:
    import numpy as np

    histogram = np.bincount(gray.ravel(), minlength=256).astype(float)
    probabilities = histogram / max(float(histogram.sum()), 1.0)
    probabilities = probabilities[probabilities > 0]
    return float(-(probabilities * np.log2(probabilities)).sum())


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
