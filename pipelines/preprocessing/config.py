from dataclasses import dataclass, asdict


@dataclass
class PipelineConfig:
    # --- IO ---
    input_glob: str = "videos/**/*.mp4"
    out_dir: str = "outputs"

    # --- Shot Boundary Detection (Pass A, spec §3.1) ---
    sbd_threshold: float = 0.3          # TransNetV2 cut probability (0.1 too noisy, 0.5 misses gradual cuts on news)
    sbd_min_shot_frames: int = 8        # shots shorter than this are merged into the previous one
    sbd_weights: str = "transnetv2-pytorch-weights.pth"

    # --- Adaptive sampling (spec §3.2) ---
    short_shot_max_s: float = 3.0       # T < 3s   -> 1 frame at shot middle
    medium_shot_max_s: float = 4.0      # 3..4s    -> frames at 25/50/75%
    long_shot_period_s: float = 1.0     # T > 4s   -> 1 frame every 1s
    window_radius: int = 2              # pick sharpest frame within ±N frames of each target

    # --- Quality filters (spec §4), measured on the 720px-long-edge grayscale ---
    brightness_min: float = 15.0
    brightness_max: float = 240.0
    blur_min: float = 100.0             # Laplacian variance threshold
    std_min: float = 10.0               # low-information / flat-image threshold

    # --- Dedup ---
    phash_hamming_max: int = 4          # spec §4.4, sequential dHash
    cosine_dup_threshold: float = 0.93  # global within-video embedding dedup (0.93 preserves motion granularity)
    max_gap_s: float = 8.0              # coverage guarantee: never let dedup open a temporal hole > 8s

    # --- Visual embedding ---
    embed: bool = True
    embed_model: str = "ViT-B-16-SigLIP"
    embed_pretrained: str = "webli"
    embed_batch_size: int = 64
    device: str = "cuda"

    # --- Keyframe output ---
    webp_long_edge: int = 720
    webp_quality: int = 90

    def to_dict(self) -> dict:
        return asdict(self)
