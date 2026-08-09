"""Sparse retrieval-frame sampling from temporal and visual signals."""

from collections import defaultdict

import pandas as pd


def candidate_times_for_shot(start: float, end: float, cfg) -> list[float]:
    """Baseline duration-aware sampling retained for backwards compatibility."""
    duration = end - start
    if duration <= 0:
        return [start]
    if duration < cfg.short_shot_max_s:
        return [start + duration / 2]
    if duration <= cfg.medium_shot_max_s:
        return [start + duration * f for f in (0.25, 0.50, 0.75)]
    period = cfg.long_shot_period_s
    times, value = [], start + period / 2
    while value < end:
        times.append(value)
        value += period
    return times or [start + duration / 2]


def _retrieval_role(_position: int, count: int) -> str:
    return "shot_anchor" if count == 1 else "uniform_anchor"


def _top_signal_frames(
    shot_frames: pd.DataFrame,
    column: str,
    *,
    minimum: float,
    limit: int,
    min_distance: int,
) -> list[int]:
    if column not in shot_frames.columns or limit <= 0:
        return []
    ranked = shot_frames[shot_frames[column].fillna(0) >= minimum].sort_values(
        column, ascending=False,
    )
    selected: list[int] = []
    for frame_id in ranked["original_frame_id"].astype(int):
        if all(abs(frame_id - existing) >= min_distance for existing in selected):
            selected.append(frame_id)
        if len(selected) >= limit:
            break
    return sorted(selected)


def _build_without_manifest(shots_df, cfg) -> list[dict]:
    candidates = []
    for row in shots_df.itertuples():
        times = candidate_times_for_shot(float(row.start_time), float(row.end_time), cfg)
        for position, target_time in enumerate(times):
            role = _retrieval_role(position, len(times))
            candidates.append({
                "shot_id": int(row.shot_id),
                "target_time": target_time,
                "retrieval_role": role,
                "retrieval_roles": [role],
            })
    candidates.sort(key=lambda candidate: candidate["target_time"])
    return candidates


def build_candidates(shots_df, cfg, frame_manifest: pd.DataFrame | None = None) -> list[dict]:
    """Return sparse candidates with explicit selection provenance.

    With a frame manifest, temporal targets are snapped to canonical source
    frames and augmented by shot-boundary, scene-change, motion and text-change
    peaks. Duplicate causes are merged into ``retrieval_roles``.
    """
    if frame_manifest is None:
        return _build_without_manifest(shots_df, cfg)
    required = {"original_frame_id", "timestamp_ms"}
    if missing := required - set(frame_manifest.columns):
        raise ValueError(f"frame manifest missing columns: {sorted(missing)}")

    frames = frame_manifest.sort_values("original_frame_id").copy()
    if frames.empty:
        return []
    if frames["original_frame_id"].duplicated().any():
        raise ValueError("frame manifest contains duplicate original_frame_id values")
    if frames["timestamp_ms"].isna().any():
        raise ValueError("frame manifest contains unavailable timestamp_ms values")
    frames["target_time"] = frames["timestamp_ms"].astype(float) / 1000.0
    by_frame: dict[int, dict] = {}
    roles_by_frame: dict[int, set[str]] = defaultdict(set)

    def add(frame_id: int, shot_id: int, role: str) -> None:
        matches = frames[frames["original_frame_id"] == frame_id]
        if matches.empty:
            return
        row = matches.iloc[0]
        by_frame.setdefault(frame_id, {
            "shot_id": int(shot_id),
            "target_frame_id": int(frame_id),
            "target_time": float(row["target_time"]),
        })
        roles_by_frame[frame_id].add(role)

    for shot in shots_df.itertuples():
        shot_id = int(shot.shot_id)
        start_frame = int(shot.start_frame)
        end_frame = int(shot.end_frame)
        shot_frames = frames[
            (frames["original_frame_id"] >= start_frame)
            & (frames["original_frame_id"] <= end_frame)
        ]
        if shot_frames.empty:
            continue

        times = candidate_times_for_shot(float(shot.start_time), float(shot.end_time), cfg)
        for position, target_time in enumerate(times):
            nearest_index = (shot_frames["target_time"] - target_time).abs().idxmin()
            nearest = shot_frames.loc[nearest_index]
            add(
                int(nearest["original_frame_id"]),
                shot_id,
                _retrieval_role(position, len(times)),
            )

        if getattr(cfg, "include_shot_boundaries", True):
            add(int(shot_frames["original_frame_id"].iloc[0]), shot_id, "shot_boundary")
            add(int(shot_frames["original_frame_id"].iloc[-1]), shot_id, "shot_boundary")

        if getattr(cfg, "signal_sampling", True):
            signal_specs = (
                ("scene_change_score", "scene_change_peak", cfg.scene_change_peak_min),
                ("motion_score", "motion_peak", cfg.motion_peak_min),
                ("text_change_score", "text_change_peak", cfg.text_change_peak_min),
            )
            for column, role, minimum in signal_specs:
                for frame_id in _top_signal_frames(
                    shot_frames,
                    column,
                    minimum=minimum,
                    limit=cfg.signal_peaks_per_shot,
                    min_distance=cfg.signal_min_distance_frames,
                ):
                    add(frame_id, shot_id, role)

    candidates = []
    for frame_id, candidate in by_frame.items():
        roles = sorted(roles_by_frame[frame_id])
        candidates.append({
            **candidate,
            "retrieval_role": roles[0],
            "retrieval_roles": roles,
        })
    candidates.sort(key=lambda candidate: candidate["target_frame_id"])
    return candidates
