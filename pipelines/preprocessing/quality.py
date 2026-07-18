"""Soft image quality routing scores; valid evidence is never hard deleted."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class QualityAssessment:
    score: float
    tier: str
    reasons: tuple[str, ...]
    hard_drop: bool = False


def score_quality(*, brightness: float, blur_score: float, contrast: float) -> QualityAssessment:
    values = (brightness, blur_score, contrast)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        raise ValueError("quality inputs must be finite numbers")
    if not 0 <= brightness <= 255 or blur_score < 0 or contrast < 0:
        raise ValueError("quality inputs are outside valid ranges")
    exposure = max(0.0, 1.0 - abs(float(brightness) - 127.5) / 127.5)
    sharpness = min(1.0, float(blur_score) / 100.0)
    contrast_score = min(1.0, float(contrast) / 64.0)
    score = round(0.35 * exposure + 0.4 * sharpness + 0.25 * contrast_score, 6)
    reasons: list[str] = []
    if brightness < 20:
        reasons.append("dark")
    elif brightness > 235:
        reasons.append("overexposed")
    if blur_score < 10:
        reasons.append("blurred")
    if contrast < 8:
        reasons.append("low_contrast")
    tier = "high" if score >= 0.7 else "medium" if score >= 0.35 else "low"
    return QualityAssessment(score, tier, tuple(reasons))
