"""Adaptive keyframe sampling (spec §3.2).

| Shot duration T   | Keyframes                              |
|-------------------|----------------------------------------|
| T < 3s            | 1 frame at the middle                  |
| 3s <= T <= 10s    | frames at 25% / 50% / 75%              |
| T > 10s           | 1 frame every 2s (then dedup later)    |

A single-shot fallback video (dashcam, static camera) lands in the T > 10s
rule automatically, which *is* the spec's fallback temporal sampling.
"""


def candidate_times_for_shot(start: float, end: float, cfg) -> list[float]:
    duration = end - start
    if duration <= 0:
        return [start]
    if duration < cfg.short_shot_max_s:
        return [start + duration / 2]
    if duration <= cfg.medium_shot_max_s:
        return [start + duration * f for f in (0.25, 0.50, 0.75)]
    period = cfg.long_shot_period_s
    times, t = [], start + period / 2
    while t < end:
        times.append(t)
        t += period
    return times or [start + duration / 2]


def build_candidates(shots_df, cfg) -> list[dict]:
    """Flat, time-ordered list of {shot_id, target_time} for one video."""
    cands = []
    for row in shots_df.itertuples():
        for t in candidate_times_for_shot(float(row.start_time), float(row.end_time), cfg):
            cands.append({"shot_id": int(row.shot_id), "target_time": t})
    cands.sort(key=lambda c: c["target_time"])
    return cands
