import datetime
import re
from pathlib import Path


_SAFE_ARTIFACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _artifact_id(value: str, name: str = "artifact_id") -> str:
    text = str(value)
    if not _SAFE_ARTIFACT_ID.fullmatch(text) or text in {".", ".."}:
        raise ValueError(
            f"{name} must contain only letters, digits, dot, underscore, or hyphen"
        )
    return text


def _redact_uri_secrets(value: str) -> str:
    text = str(value)
    if "://" not in text:
        return text
    text = re.sub(r"(://)[^/@\s]+@", r"\1[redacted]@", text)
    return re.sub(r"([?#])[^\s|]+", r"\1[redacted]", text)


class OutputStore:
    """Layout of the output directory (spec §7). Every stage writes its own
    per-video artifact so any stage can be re-run or resumed independently.

    outputs/
    ├── videos_manifest.parquet
    ├── failed_videos.log
    ├── frame_manifests/{video_id}.parquet       # every decoded source frame
    ├── shots/{video_id}.parquet          # Pass A checkpoint
    ├── keyframes/{video_id}/0001.webp
    ├── retrieval_candidates/{video_id}.parquet  # all sparse candidates + routing
    ├── retrieval_frames/{video_id}.parquet      # canonical selected-frame schema
    ├── map-keyframes/{video_id}.csv      # compatibility export for older tooling
    ├── features/{video_id}.npy           # (N, D) float16, row i == csv row i
    ├── metadata/{video_id}.json          # per-video funnel counts + timing
    ├── event_windows/{query_or_run_id}.parquet
    ├── dense_candidates/{event_window_id}.parquet
    ├── semantic_keyframes/{event_window_id}.json
    └── index/keyframes.faiss + keyframes_index.parquet
    """

    SUBDIRS = [
        "frame_manifests", "frame_manifest_stats", "shots", "keyframes", "retrieval_candidates",
        "retrieval_frames", "map-keyframes", "features", "metadata",
        "event_windows", "dense_candidates", "semantic_keyframes", "index",
    ]

    def __init__(self, out_dir: str):
        self.root = Path(out_dir)
        for d in self.SUBDIRS:
            (self.root / d).mkdir(parents=True, exist_ok=True)

    # --- top-level files ---
    @property
    def manifest_path(self) -> Path:
        return self.root / "videos_manifest.parquet"

    @property
    def failed_log(self) -> Path:
        return self.root / "failed_videos.log"

    @property
    def report_path(self) -> Path:
        return self.root / "REPORT.md"

    # --- per-video artifacts ---
    def shots_path(self, video_id: str) -> Path:
        return self.root / "shots" / f"{_artifact_id(video_id, 'video_id')}.parquet"

    def frame_manifest_path(self, video_id: str) -> Path:
        return self.root / "frame_manifests" / f"{_artifact_id(video_id, 'video_id')}.parquet"

    def frame_manifest_stats_path(self, video_id: str) -> Path:
        return self.root / "frame_manifest_stats" / f"{_artifact_id(video_id, 'video_id')}.json"

    def keyframe_dir(self, video_id: str) -> Path:
        return self.root / "keyframes" / _artifact_id(video_id, "video_id")

    def map_path(self, video_id: str) -> Path:
        return self.root / "map-keyframes" / f"{_artifact_id(video_id, 'video_id')}.csv"

    def retrieval_candidates_path(self, video_id: str) -> Path:
        return self.root / "retrieval_candidates" / f"{_artifact_id(video_id, 'video_id')}.parquet"

    def retrieval_frames_path(self, video_id: str) -> Path:
        return self.root / "retrieval_frames" / f"{_artifact_id(video_id, 'video_id')}.parquet"

    def features_path(self, video_id: str) -> Path:
        return self.root / "features" / f"{_artifact_id(video_id, 'video_id')}.npy"

    def metadata_path(self, video_id: str) -> Path:
        return self.root / "metadata" / f"{_artifact_id(video_id, 'video_id')}.json"

    def event_windows_path(self, run_id: str) -> Path:
        return self.root / "event_windows" / f"{_artifact_id(run_id, 'run_id')}.parquet"

    def dense_candidates_path(self, event_window_id: str) -> Path:
        return self.root / "dense_candidates" / f"{_artifact_id(event_window_id, 'event_window_id')}.parquet"

    def semantic_keyframe_path(self, event_window_id: str) -> Path:
        return self.root / "semantic_keyframes" / f"{_artifact_id(event_window_id, 'event_window_id')}.json"

    # --- index artifacts ---
    @property
    def faiss_path(self) -> Path:
        return self.root / "index" / "keyframes.faiss"

    @property
    def index_table_path(self) -> Path:
        return self.root / "index" / "keyframes_index.parquet"

    @property
    def index_meta_path(self) -> Path:
        return self.root / "index" / "index_meta.json"

    def log_failed(self, video_path: str, error: str) -> None:
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        with open(self.failed_log, "a", encoding="utf-8") as f:
            f.write(
                f"{stamp} | {_redact_uri_secrets(video_path)} | "
                f"{_redact_uri_secrets(error)}\n"
            )
