import datetime
from pathlib import Path


class OutputStore:
    """Layout of the output directory (spec §7). Every stage writes its own
    per-video artifact so any stage can be re-run or resumed independently.

    outputs/
    ├── videos_manifest.parquet
    ├── failed_videos.log
    ├── shots/{video_id}.parquet          # Pass A checkpoint
    ├── keyframes/{video_id}/0001.webp
    ├── map-keyframes/{video_id}.csv      # n, frame_idx, pts_time, fps, shot_id, quality scores
    ├── features/{video_id}.npy           # (N, D) float16, row i == csv row i
    ├── metadata/{video_id}.json          # per-video funnel counts + timing
    └── index/keyframes.faiss + keyframes_index.parquet
    """

    SUBDIRS = ["shots", "keyframes", "map-keyframes", "features", "metadata", "index"]

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
        return self.root / "shots" / f"{video_id}.parquet"

    def keyframe_dir(self, video_id: str) -> Path:
        return self.root / "keyframes" / video_id

    def map_path(self, video_id: str) -> Path:
        return self.root / "map-keyframes" / f"{video_id}.csv"

    def features_path(self, video_id: str) -> Path:
        return self.root / "features" / f"{video_id}.npy"

    def metadata_path(self, video_id: str) -> Path:
        return self.root / "metadata" / f"{video_id}.json"

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
            f.write(f"{stamp} | {video_path} | {error}\n")
