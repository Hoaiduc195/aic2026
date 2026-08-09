from dataclasses import dataclass, asdict

from .video_source import validate_endpoint_url


@dataclass
class PipelineConfig:
    # --- IO ---
    input_glob: str = "videos/**/*.mp4"
    out_dir: str = "outputs"
    # S3-compatible endpoint for ``r2://`` raw-video URIs. Credentials are
    # intentionally not config fields; boto3 resolves them from its normal
    # environment/profile/instance-role chain.
    r2_endpoint_url: str | None = None
    r2_region_name: str | None = None
    s3_endpoint_url: str | None = None
    s3_region_name: str | None = None
    artifact_uri_prefix: str | None = None

    # --- Shot Boundary Detection (Pass A, spec §3.1) ---
    sbd_threshold: float = 0.3          # TransNetV2 cut probability (0.1 too noisy, 0.5 misses gradual cuts on news)
    sbd_min_shot_frames: int = 8        # shots shorter than this are merged into the previous one
    sbd_weights: str = "transnetv2-pytorch-weights.pth"

    # --- Adaptive sampling (spec §3.2) ---
    short_shot_max_s: float = 3.0       # T < 3s   -> 1 frame at shot middle
    medium_shot_max_s: float = 4.0      # 3..4s    -> frames at 25/50/75%
    long_shot_period_s: float = 1.0     # T > 4s   -> 1 frame every 1s
    window_radius: int = 2              # pick sharpest frame within ±N frames of each target
    include_shot_boundaries: bool = True
    signal_sampling: bool = True
    signal_peaks_per_shot: int = 1
    signal_min_distance_frames: int = 8
    motion_peak_min: float = 8.0
    scene_change_peak_min: float = 0.15
    text_change_peak_min: float = 4.0
    frame_signal_long_edge: int = 320

    # --- Coarse event windows / dense alignment ---
    event_window_radius_ms: float = 2_000.0
    event_window_merge_gap_ms: float = 500.0

    # --- Quality filters (spec §4), measured on the 720px-long-edge grayscale ---
    brightness_min: float = 15.0
    brightness_max: float = 240.0
    blur_min: float = 100.0             # Laplacian variance threshold
    std_min: float = 10.0               # low-information / flat-image threshold

    # --- Dedup ---
    phash_hamming_max: int = 4          # sequential dHash; preserve motion granularity
    cosine_dup_threshold: float = 0.93  # global dedup tuned for motion coverage
    max_gap_s: float = 8.0              # maximum retrieval coverage hole (0 = disabled)

    # Optional DINOv2 structural lane. ``dedup`` keeps the earliest global
    # representative; ``cluster_medoids`` selects a structural medoid per
    # cosine-connected component. ``off`` retains SigLIP cosine dedup when the
    # retrieval embedder is enabled.
    dino_mode: str = "off"
    dino_model: str = "vit_small_patch14_dinov2.lvd142m"
    dino_batch_size: int = 16
    dino_similarity_threshold: float = 0.90

    # --- Visual embedding ---
    embed: bool = True
    embed_model: str = "ViT-B-16-SigLIP"
    embed_pretrained: str = "webli"
    embed_batch_size: int = 64
    device: str = "cuda"

    # --- Keyframe output ---
    webp_long_edge: int = 720
    webp_quality: int = 90

    def validate(self) -> None:
        """Fail fast on values that would make sampling or routing ambiguous."""
        if self.short_shot_max_s <= 0:
            raise ValueError("short_shot_max_s must be positive")
        if self.medium_shot_max_s < self.short_shot_max_s:
            raise ValueError("medium_shot_max_s must be >= short_shot_max_s")
        if self.long_shot_period_s <= 0:
            raise ValueError("long_shot_period_s must be positive")
        if self.window_radius < 0:
            raise ValueError("window_radius must be non-negative")
        if self.signal_peaks_per_shot < 0 or self.signal_min_distance_frames < 0:
            raise ValueError("signal peak count/distance must be non-negative")
        if min(
            self.motion_peak_min,
            self.scene_change_peak_min,
            self.text_change_peak_min,
        ) < 0:
            raise ValueError("signal peak thresholds must be non-negative")
        if self.frame_signal_long_edge <= 0 or self.webp_long_edge <= 0:
            raise ValueError("frame image sizes must be positive")
        if self.event_window_radius_ms < 0 or self.event_window_merge_gap_ms < 0:
            raise ValueError("event-window radius/gap must be non-negative")
        if not (0 <= self.brightness_min <= self.brightness_max <= 255):
            raise ValueError("brightness bounds must satisfy 0 <= min <= max <= 255")
        if self.blur_min < 0 or self.std_min < 0:
            raise ValueError("blur_min and std_min must be non-negative")
        if self.phash_hamming_max < 0:
            raise ValueError("phash_hamming_max must be non-negative")
        if not (-1.0 <= self.cosine_dup_threshold <= 1.0):
            raise ValueError("cosine_dup_threshold must be between -1 and 1")
        if self.max_gap_s < 0:
            raise ValueError("max_gap_s must be non-negative")
        if self.dino_mode not in {"off", "dedup", "cluster_medoids"}:
            raise ValueError("dino_mode must be off, dedup, or cluster_medoids")
        if not isinstance(self.dino_model, str) or not self.dino_model.strip():
            raise ValueError("dino_model must be a non-empty string")
        if self.dino_batch_size <= 0:
            raise ValueError("dino_batch_size must be positive")
        if not (-1.0 <= self.dino_similarity_threshold <= 1.0):
            raise ValueError("dino_similarity_threshold must be between -1 and 1")
        if self.embed_batch_size <= 0:
            raise ValueError("embed_batch_size must be positive")
        if not (0 <= self.webp_quality <= 100):
            raise ValueError("webp_quality must be between 0 and 100")
        for endpoint in (self.r2_endpoint_url, self.s3_endpoint_url):
            if endpoint is not None:
                validate_endpoint_url(endpoint)
        if self.artifact_uri_prefix is not None:
            prefix = self.artifact_uri_prefix
            if not prefix.startswith(("file://", "r2://", "s3://", "http://", "https://")):
                raise ValueError("artifact_uri_prefix must be a file/r2/s3/http(s) URI")
            if any(character in prefix for character in ("?", "#", "@")):
                raise ValueError("artifact_uri_prefix must not contain credentials/query/fragment")

    def video_source_kwargs(self, uri: str) -> dict:
        """Return credential-safe reader options for one URI scheme.

        Programmatic callers may attach ``video_source_client`` as either one
        boto3-compatible client or a ``{"r2": client, "s3": client}`` mapping.
        It is intentionally not a dataclass field so it can never be serialized
        by :meth:`to_dict`.
        """
        lower = str(uri).lower()
        scheme = "r2" if lower.startswith("r2://") else "s3" if lower.startswith("s3://") else None
        if scheme is None:
            return {}
        options: dict = {}
        clients = getattr(self, "video_source_client", None)
        if isinstance(clients, dict):
            client = clients.get(scheme)
        else:
            client = clients
        if client is not None:
            options["client"] = client
        if scheme == "r2":
            if self.r2_endpoint_url:
                options["endpoint_url"] = self.r2_endpoint_url
            if self.r2_region_name:
                options["region_name"] = self.r2_region_name
        else:
            if self.s3_endpoint_url:
                options["endpoint_url"] = self.s3_endpoint_url
            if self.s3_region_name:
                options["region_name"] = self.s3_region_name
        return options

    def to_dict(self) -> dict:
        return asdict(self)
