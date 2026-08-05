"""Quality filters (spec §4) — cheap CPU checks so expensive models only ever
see clean frames. All metrics are computed on the 720px-long-edge grayscale so
thresholds are comparable across source resolutions."""

import cv2
import numpy as np


def resize_long_edge(img: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1.0:
        return img
    return cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def quality_scores(rgb: np.ndarray) -> dict:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return {
        "brightness": float(gray.mean()),                       # spec §4.1
        "blur_score": float(cv2.Laplacian(gray, cv2.CV_64F).var()),  # spec §4.2
        "std_score": float(gray.std()),                         # spec §4.3
    }


def passes(scores: dict, cfg) -> tuple[bool, str]:
    """Returns (ok, drop_reason)."""
    if not (cfg.brightness_min <= scores["brightness"] <= cfg.brightness_max):
        return False, "brightness"
    if scores["std_score"] < cfg.std_min:
        return False, "low_info"
    if scores["blur_score"] < cfg.blur_min:
        return False, "blur"
    return True, ""
