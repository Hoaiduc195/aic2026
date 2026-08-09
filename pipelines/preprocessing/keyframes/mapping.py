"""Canonical zero-based source-frame and fixed-FPS timestamp mapping."""

from fractions import Fraction


def parse_fps(value: Fraction | str | int | float) -> Fraction:
    """Return an exact positive FPS fraction.

    Decimal float input is converted through ``str`` to avoid preserving its
    binary floating-point representation.
    """
    fps = value if isinstance(value, Fraction) else Fraction(str(value))
    if fps <= 0:
        raise ValueError("fps must be positive")
    return fps


def exact_timestamp_ms(
    original_frame_id: int,
    fps: Fraction | str | int | float,
) -> float:
    """Map a zero-based source frame id to milliseconds at fixed FPS."""
    if original_frame_id < 0:
        raise ValueError("original_frame_id must be non-negative")
    value = Fraction(original_frame_id * 1000, 1) / parse_fps(fps)
    return round(float(value), 3)


def frame_id_from_timestamp_ms(
    timestamp_ms: int | float,
    fps: Fraction | str | int | float,
    frame_count: int,
) -> int:
    """Map a timestamp to the closest valid zero-based source frame id."""
    if timestamp_ms < 0:
        raise ValueError("timestamp_ms must be non-negative")
    if frame_count <= 0:
        raise ValueError("frame_count must be positive")
    frame_id = round(float(Fraction(str(timestamp_ms)) * parse_fps(fps) / 1000))
    return max(0, min(frame_id, frame_count - 1))
