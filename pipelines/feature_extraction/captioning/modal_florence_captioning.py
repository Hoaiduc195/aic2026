"""Stream local keyframes to a single Modal GPU running Florence-2.

The local entrypoint owns filesystem discovery, resume, checkpointing, and
budget guardrails.  Modal only receives bounded image bytes and returns one
English caption per image.  Frames are never copied into a Modal Volume; a
small Volume is used only for the Hugging Face model cache.

Example::

    modal run modal_florence_captioning.py \
        --input-dir E:/aic2026/keyframes \
        --output-dir E:/aic2026/captioning \
        --batch-index 0 --num-batches 3 --budget-usd 25

The three team members should use batch indexes 0, 1, and 2.  Existing
non-empty ``.txt`` files are skipped unless ``--overwrite`` is supplied.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

try:
    import modal
except ModuleNotFoundError:  # Keep local utility tests independent of Modal SDK.
    modal = None  # type: ignore[assignment]


MODEL_NAME = "microsoft/Florence-2-base"
CAPTION_TASK = "<CAPTION>"
GPU_TYPE = "T4"
GPU_RATE_USD_PER_HOUR = 0.5904

# The GPU batch is fixed at deployment time.  ``batch_size`` in the local CLI
# is the bounded in-flight submission window, not the GPU batch size.
GPU_BATCH_SIZE = 8
GPU_BATCH_WAIT_MS = 25
DEFAULT_SUBMISSION_WINDOW = 128
MAX_SUBMISSION_WINDOW = 512
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_WINDOW_BYTES = 64 * 1024 * 1024
MAX_NEW_TOKENS = 128
DEFAULT_MAX_NEW_TOKENS = 32
DEFAULT_NUM_BEAMS = 1
MAX_NUM_BEAMS = 5
DEFAULT_MAX_RETRIES = 2
MAX_RETRIES = 5

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})
T = TypeVar("T")


def safe_print(message: str) -> None:
    """Print logs without crashing on a non-Unicode Windows console."""

    try:
        print(message)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        fallback = message.encode(encoding, errors="backslashreplace").decode(
            encoding
        )
        print(fallback)


@dataclass(frozen=True, slots=True)
class ImageJob:
    """An immutable image payload and its safe relative identity."""

    relative_path: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class JobLoadFailure:
    """A local input failure that must not abort all other frames."""

    relative_path: str
    error: str


@dataclass(frozen=True, slots=True)
class CostTracker:
    """Conservative, immutable estimate of one T4 run's compute cost."""

    budget_usd: float
    gpu_rate_usd_per_hour: float = GPU_RATE_USD_PER_HOUR
    remote_seconds: float = 0.0

    def __post_init__(self) -> None:
        if self.budget_usd <= 0:
            raise ValueError("budget_usd phải lớn hơn 0")
        if self.gpu_rate_usd_per_hour <= 0:
            raise ValueError("gpu_rate_usd_per_hour phải lớn hơn 0")
        if self.remote_seconds < 0:
            raise ValueError("remote_seconds không được âm")

    def add_remote_seconds(self, seconds: float) -> CostTracker:
        """Return a new tracker without mutating the previous one."""

        if seconds < 0:
            raise ValueError("seconds không được âm")
        return replace(self, remote_seconds=self.remote_seconds + seconds)

    @property
    def estimated_cost_usd(self) -> float:
        return self.remote_seconds * self.gpu_rate_usd_per_hour / 3600.0

    @property
    def over_budget(self) -> bool:
        return self.estimated_cost_usd >= self.budget_usd


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    """Sort zero-padded and non-zero-padded frame names naturally."""

    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(piece)) if piece.isdigit() else (1, piece.casefold())
        for piece in pieces
        if piece
    )


def _validate_relative_path(relative_path: str) -> str:
    """Reject absolute or traversing paths before using them as output keys."""

    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("relative_path phải là chuỗi không rỗng")
    if "\\" in relative_path:
        raise ValueError("relative_path phải dùng dấu /")
    parsed = PurePosixPath(relative_path)
    if parsed.is_absolute() or ".." in parsed.parts:
        raise ValueError("relative_path không được là absolute hoặc chứa ..")
    return parsed.as_posix()


def iter_video_ids(input_dir: Path) -> tuple[str, ...]:
    """Return immediate video-directory names in deterministic order."""

    if not input_dir.is_dir():
        raise FileNotFoundError(f"Không tìm thấy input directory: {input_dir}")
    return tuple(
        sorted(
            (path.name for path in input_dir.iterdir() if path.is_dir()),
            key=_natural_key,
        )
    )


def validate_directory_layout(input_dir: Path, output_dir: Path) -> None:
    """Require output storage to be a sibling or external directory."""

    input_root = input_dir.resolve()
    output_root = output_dir.resolve()
    if output_root == input_root or input_root in output_root.parents:
        raise ValueError(
            "output_dir không được trùng hoặc nằm bên trong input_dir; "
            "hãy dùng một folder output riêng"
        )


def partition_video_ids(
    video_ids: Sequence[str], *, batch_index: int, num_batches: int
) -> tuple[str, ...]:
    """Select one equal-sized deterministic partition of video IDs."""

    ids = tuple(video_ids)
    if not ids:
        raise ValueError("Không tìm thấy video directory nào")
    if len(set(ids)) != len(ids):
        raise ValueError("video IDs phải unique")
    if num_batches < 1:
        raise ValueError("num_batches phải lớn hơn 0")
    if batch_index < 0 or batch_index >= num_batches:
        raise ValueError("batch_index phải nằm trong khoảng 0..num_batches-1")
    if len(ids) % num_batches != 0:
        raise ValueError(
            f"{len(ids)} video không chia đều được cho {num_batches} batch"
        )

    per_batch = len(ids) // num_batches
    start = batch_index * per_batch
    return ids[start : start + per_batch]


def iter_images(
    input_dir: Path, video_ids: Sequence[str] | None = None
) -> tuple[Path, ...]:
    """Return supported frame paths for selected videos in stable order."""

    selected_ids = tuple(video_ids) if video_ids is not None else iter_video_ids(input_dir)
    paths: list[Path] = []
    for video_id in selected_ids:
        video_dir = input_dir / video_id
        if not video_dir.is_dir():
            raise FileNotFoundError(f"Không tìm thấy video directory: {video_dir}")
        paths.extend(
            path
            for path in video_dir.rglob("*")
            if path.is_file() and path.suffix.casefold() in IMAGE_EXTENSIONS
        )
    return tuple(sorted(paths, key=lambda path: _natural_key(path.relative_to(input_dir))))


def caption_path_for(input_dir: Path, output_dir: Path, image_path: Path) -> Path:
    """Map an input frame to an output text path without flattening videos."""

    relative_path = image_path.relative_to(input_dir)
    _validate_relative_path(relative_path.as_posix())
    return (output_dir / relative_path).with_suffix(".txt")


def is_complete_caption(caption_path: Path) -> bool:
    """Return true only for a readable, non-empty caption file."""

    try:
        return bool(caption_path.read_text(encoding="utf-8").strip())
    except (OSError, UnicodeError):
        return False


def chunked(items: Sequence[T], size: int) -> Iterator[tuple[T, ...]]:
    """Yield bounded immutable chunks without mutating the source sequence."""

    if size < 1:
        raise ValueError("chunk size phải lớn hơn 0")
    for start in range(0, len(items), size):
        yield tuple(items[start : start + size])


def bounded_path_chunks(
    paths: Sequence[Path], *, max_items: int, max_bytes: int = MAX_WINDOW_BYTES
) -> Iterator[tuple[Path, ...]]:
    """Chunk paths by count and approximate payload size to bound local RAM."""

    if max_items < 1 or max_bytes < 1:
        raise ValueError("max_items và max_bytes phải lớn hơn 0")

    current: list[Path] = []
    current_bytes = 0
    for path in paths:
        try:
            file_size = path.stat().st_size
        except OSError:
            file_size = max_bytes
        exceeds_bytes = current and current_bytes + file_size > max_bytes
        if current and (len(current) >= max_items or exceeds_bytes):
            yield tuple(current)
            current = []
            current_bytes = 0
        current.append(path)
        current_bytes += file_size
    if current:
        yield tuple(current)


def read_image_job(path: Path, relative_path: str) -> ImageJob:
    """Read a bounded local image payload for one remote request."""

    safe_relative_path = _validate_relative_path(relative_path)
    try:
        image_size = path.stat().st_size
    except OSError as error:
        raise OSError(f"Không stat được ảnh {safe_relative_path}") from error
    if image_size <= 0:
        raise ValueError(f"file ảnh rỗng: {safe_relative_path}")
    if image_size > MAX_IMAGE_BYTES:
        raise ValueError(
            f"file ảnh vượt giới hạn {MAX_IMAGE_BYTES // (1024 * 1024)} MiB: "
            f"{safe_relative_path}"
        )

    payload = path.read_bytes()
    if len(payload) != image_size:
        raise OSError(f"đọc thiếu dữ liệu ảnh: {safe_relative_path}")
    return ImageJob(relative_path=safe_relative_path, payload=payload)


def load_image_jobs(
    input_dir: Path, paths: Sequence[Path]
) -> tuple[tuple[ImageJob, ...], tuple[JobLoadFailure, ...]]:
    """Read one bounded window while retaining per-file failures."""

    jobs: list[ImageJob] = []
    failures: list[JobLoadFailure] = []
    for path in paths:
        relative_path = path.relative_to(input_dir).as_posix()
        try:
            jobs.append(read_image_job(path, relative_path))
        except (OSError, ValueError) as error:
            failures.append(JobLoadFailure(relative_path, str(error)))
    return tuple(jobs), tuple(failures)


def validate_options(
    *,
    batch_size: int,
    max_new_tokens: int,
    num_beams: int,
    max_retries: int,
    budget_usd: float,
    gpu_rate_usd_per_hour: float = GPU_RATE_USD_PER_HOUR,
) -> None:
    """Validate all local controls before any Modal request is made."""

    if not 1 <= batch_size <= MAX_SUBMISSION_WINDOW:
        raise ValueError(f"batch_size phải nằm trong khoảng 1..{MAX_SUBMISSION_WINDOW}")
    if not 1 <= max_new_tokens <= MAX_NEW_TOKENS:
        raise ValueError(f"max_new_tokens phải nằm trong khoảng 1..{MAX_NEW_TOKENS}")
    if not 1 <= num_beams <= MAX_NUM_BEAMS:
        raise ValueError(f"num_beams phải nằm trong khoảng 1..{MAX_NUM_BEAMS}")
    if not 0 <= max_retries <= MAX_RETRIES:
        raise ValueError(f"max_retries phải nằm trong khoảng 0..{MAX_RETRIES}")
    if budget_usd <= 0:
        raise ValueError("budget_usd phải lớn hơn 0")
    if gpu_rate_usd_per_hour <= 0:
        raise ValueError("gpu_rate_usd_per_hour phải lớn hơn 0")


def parse_remote_result(payload: str) -> tuple[str, str]:
    """Validate and unpack one JSON result returned by Modal."""

    try:
        record = json.loads(payload)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Modal trả về JSON không hợp lệ") from error
    if not isinstance(record, dict):
        raise TypeError("Modal result phải là object")
    relative_path = _validate_relative_path(record.get("relative_path", ""))
    caption = record.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        raise ValueError(f"caption rỗng cho {relative_path}")
    return relative_path, caption.strip()


def _write_text_atomic(path: Path, text: str) -> None:
    """Write one caption atomically so resume never treats a partial file as done."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(text.rstrip() + "\n", encoding="utf-8")
    temporary_path.replace(path)


def _append_manifest(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()


def _error_text(error: BaseException) -> str:
    return str(error).strip()[:500] or error.__class__.__name__


def _is_retryable_remote_error(error: BaseException) -> bool:
    """Retry only errors that look transient; auth/quota errors fail fast."""

    message = f"{error.__class__.__name__} {_error_text(error)}".casefold()
    permanent_markers = (
        "auth",
        "credential",
        "permission",
        "forbidden",
        "quota",
        "invalid argument",
        "bad request",
        "not found",
    )
    if any(marker in message for marker in permanent_markers):
        return False
    transient_markers = (
        "timeout",
        "temporar",
        "rate limit",
        "connection",
        "unavailable",
        "internal",
        "502",
        "503",
        "504",
    )
    return isinstance(error, (TimeoutError, ConnectionError)) or any(
        marker in message for marker in transient_markers
    )


def _isolateable_remote_error(error: BaseException | None) -> bool:
    """Identify failures likely caused by one malformed image in a batch."""

    if error is None:
        return False
    message = _error_text(error).casefold()
    image_markers = (
        "image",
        "decode",
        "pixel",
        "pil",
        "unsupported",
        "cannot identify",
        "invalid file",
    )
    return isinstance(error, (OSError, ValueError)) or any(
        marker in message for marker in image_markers
    )


def _remote_requests(
    jobs: Sequence[ImageJob], max_new_tokens: int, num_beams: int
) -> tuple[tuple[bytes, str, int, int], ...]:
    return tuple(
        (job.payload, job.relative_path, max_new_tokens, num_beams) for job in jobs
    )


async def _caption_remote_window(
    captioner: Any,
    jobs: Sequence[ImageJob],
    *,
    max_new_tokens: int,
    num_beams: int,
    max_retries: int,
) -> tuple[dict[str, str], tuple[ImageJob, ...], BaseException | None, float]:
    """Submit one bounded window and retry only unresolved transient requests."""

    results: dict[str, str] = {}
    remaining = tuple(jobs)
    last_error: BaseException | None = None
    started = time.perf_counter()

    for attempt in range(max_retries + 1):
        if not remaining:
            break
        try:
            requests = _remote_requests(remaining, max_new_tokens, num_beams)
            async for raw_result in captioner.caption_batch.starmap.aio(requests):
                relative_path, caption = parse_remote_result(raw_result)
                expected = {job.relative_path for job in remaining}
                if relative_path not in expected:
                    raise ValueError(
                        f"Modal trả về relative_path ngoài request: {relative_path}"
                    )
                results[relative_path] = caption
            remaining = tuple(
                job for job in remaining if job.relative_path not in results
            )
            if remaining:
                last_error = RuntimeError(
                    f"Modal thiếu {len(remaining)} kết quả trong window"
                )
                break
            last_error = None
        except Exception as error:  # noqa: BLE001 - Modal SDK exception types vary.
            last_error = error
            remaining = tuple(
                job for job in remaining if job.relative_path not in results
            )
            if not _is_retryable_remote_error(error):
                break
            if attempt < max_retries:
                await asyncio.sleep(2**attempt)

    return results, remaining, last_error, time.perf_counter() - started


async def _caption_remote_with_recovery(
    captioner: Any,
    jobs: Sequence[ImageJob],
    *,
    max_new_tokens: int,
    num_beams: int,
    max_retries: int,
) -> tuple[dict[str, str], tuple[ImageJob, ...], BaseException | None, float]:
    """Retry a failed image window by splitting only isolateable failures."""

    results, failures, error, elapsed = await _caption_remote_window(
        captioner,
        jobs,
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
        max_retries=max_retries,
    )
    if not failures or len(failures) == 1 or not _isolateable_remote_error(error):
        return results, failures, error, elapsed

    midpoint = len(failures) // 2
    left = await _caption_remote_with_recovery(
        captioner,
        failures[:midpoint],
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
        max_retries=max_retries,
    )
    right = await _caption_remote_with_recovery(
        captioner,
        failures[midpoint:],
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
        max_retries=max_retries,
    )
    merged_results = {**results, **left[0], **right[0]}
    merged_failures = (*left[1], *right[1])
    merged_error = right[2] or left[2] or error
    return merged_results, merged_failures, merged_error, elapsed + left[3] + right[3]


async def caption_directory(
    *,
    input_dir: Path,
    output_dir: Path,
    batch_index: int,
    num_batches: int,
    model_name: str = MODEL_NAME,
    batch_size: int = DEFAULT_SUBMISSION_WINDOW,
    max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
    num_beams: int = DEFAULT_NUM_BEAMS,
    max_retries: int = DEFAULT_MAX_RETRIES,
    budget_usd: float = 25.0,
    gpu_rate_usd_per_hour: float = GPU_RATE_USD_PER_HOUR,
    max_images: int = 0,
    overwrite: bool = False,
    dry_run: bool = False,
) -> None:
    """Caption pending frames in one deterministic video partition."""

    validate_options(
        batch_size=batch_size,
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
        max_retries=max_retries,
        budget_usd=budget_usd,
        gpu_rate_usd_per_hour=gpu_rate_usd_per_hour,
    )
    if model_name != MODEL_NAME:
        raise ValueError(
            f"Model hiện tại được cố định là {MODEL_NAME}; đổi MODEL_NAME trong "
            "module nếu muốn build image Modal cho model khác."
        )
    if max_images < 0:
        raise ValueError("max_images không được âm; dùng 0 để xử lý toàn bộ")

    validate_directory_layout(input_dir, output_dir)
    video_ids = iter_video_ids(input_dir)
    selected_video_ids = partition_video_ids(
        video_ids, batch_index=batch_index, num_batches=num_batches
    )
    all_images = iter_images(input_dir, selected_video_ids)
    pending_images = tuple(
        path
        for path in all_images
        if overwrite or not is_complete_caption(caption_path_for(input_dir, output_dir, path))
    )
    if max_images:
        pending_images = pending_images[:max_images]

    manifest_path = output_dir / f"run_batch_{batch_index}_of_{num_batches}.jsonl"
    safe_print(
        f"[plan] videos={len(selected_video_ids)}/{len(video_ids)} "
        f"frames={len(all_images)} pending={len(pending_images)} "
        f"batch_index={batch_index}"
    )
    if dry_run:
        safe_print("[dry-run] Không khởi tạo Modal và không ghi caption.")
        return
    if not pending_images:
        safe_print("[done] Không có frame mới cần caption.")
        return
    if Captioner is None:
        raise RuntimeError(
            "Thiếu Modal SDK. Cài requirements-modal.txt rồi chạy bằng "
            "`modal run modal_florence_captioning.py`."
        )

    captioner = Captioner()
    tracker = CostTracker(
        budget_usd=budget_usd,
        gpu_rate_usd_per_hour=gpu_rate_usd_per_hour,
    )
    completed = 0
    failed = 0

    for path_window in bounded_path_chunks(
        pending_images, max_items=batch_size, max_bytes=MAX_WINDOW_BYTES
    ):
        if tracker.over_budget:
            safe_print(
                f"[stop] Đạt budget ước tính ${tracker.estimated_cost_usd:.2f}; "
                "chạy lại để resume phần còn lại."
            )
            break

        jobs, local_failures = load_image_jobs(input_dir, path_window)
        for failure in local_failures:
            failed += 1
            _append_manifest(
                manifest_path,
                {
                    "relative_path": failure.relative_path,
                    "status": "error",
                    "stage": "local_read",
                    "error": failure.error,
                },
            )

        if not jobs:
            continue

        results, remote_failures, remote_error, elapsed = (
            await _caption_remote_with_recovery(
                captioner,
                jobs,
                max_new_tokens=max_new_tokens,
                num_beams=num_beams,
                max_retries=max_retries,
            )
        )
        tracker = tracker.add_remote_seconds(elapsed)
        for relative_path, caption in results.items():
            image_path = input_dir / Path(relative_path)
            caption_path = caption_path_for(input_dir, output_dir, image_path)
            try:
                _write_text_atomic(caption_path, caption)
                _append_manifest(
                    manifest_path,
                    {
                        "relative_path": relative_path,
                        "status": "ok",
                        "model": model_name,
                        "task": CAPTION_TASK,
                        "max_new_tokens": max_new_tokens,
                        "num_beams": num_beams,
                    },
                )
                completed += 1
            except OSError as error:
                failed += 1
                _append_manifest(
                    manifest_path,
                    {
                        "relative_path": relative_path,
                        "status": "error",
                        "stage": "local_write",
                        "error": _error_text(error),
                    },
                )

        for job in remote_failures:
            failed += 1
            _append_manifest(
                manifest_path,
                {
                    "relative_path": job.relative_path,
                    "status": "error",
                    "stage": "remote_inference",
                    "error": _error_text(remote_error) if remote_error else "unknown remote error",
                },
            )

        if remote_error and not results and not remote_failures:
            raise RuntimeError(f"Modal inference thất bại: {_error_text(remote_error)}")
        if (
            remote_error
            and remote_failures
            and len(remote_failures) == len(jobs)
            and not _isolateable_remote_error(remote_error)
        ):
            raise RuntimeError(f"Modal inference thất bại: {_error_text(remote_error)}")

        safe_print(
            f"[progress] completed={completed} failed={failed} "
            f"estimated_gpu_cost=${tracker.estimated_cost_usd:.2f} "
            f"remaining={len(pending_images) - completed - failed}"
        )

    safe_print(
        f"[done] completed={completed} failed={failed} "
        f"estimated_gpu_cost=${tracker.estimated_cost_usd:.2f}"
    )


app = None
Captioner: Any = None

if modal is not None:
    MODEL_CACHE_DIR = "/root/.cache/huggingface"
    model_cache = modal.Volume.from_name(
        "aic-florence2-model-cache", create_if_missing=True
    )
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .uv_pip_install(
            "torch>=2.2,<3",
            "transformers==4.49.0",
            "accelerate>=0.26,<1",
            "Pillow>=10,<13",
        )
        .env(
            {
                "HF_HOME": MODEL_CACHE_DIR,
                "HF_HUB_CACHE": f"{MODEL_CACHE_DIR}/hub",
            }
        )
    )
    app = modal.App(
        "aic-florence2-image-captioning",
        image=image,
        volumes={MODEL_CACHE_DIR: model_cache},
    )

    @app.cls(
        gpu=GPU_TYPE,
        memory=16_384,
        timeout=12 * 60 * 60,
        scaledown_window=60,
        max_containers=1,
    )
    class Captioner:
        """One long-lived Florence-2 worker with dynamic GPU batching."""

        @modal.enter()
        def load_model(self) -> None:
            import torch
            from transformers import (
                AutoModelForCausalLM,
                AutoProcessor,
                PretrainedConfig,
                PreTrainedTokenizerBase,
            )

            # Florence-2 remote code still reads these names on some recent
            # Transformers releases.  Keep the compatibility shim local to
            # the remote container and do not modify the user's environment.
            if not hasattr(PretrainedConfig, "forced_bos_token_id"):
                PretrainedConfig.forced_bos_token_id = None
            if not hasattr(PreTrainedTokenizerBase, "additional_special_tokens"):
                PreTrainedTokenizerBase.additional_special_tokens = property(
                    lambda tokenizer: list(tokenizer.extra_special_tokens),
                    lambda tokenizer, tokens: setattr(
                        tokenizer, "extra_special_tokens", tokens
                    ),
                )

            self.torch = torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if self.device == "cuda" else torch.float32
            self.processor = AutoProcessor.from_pretrained(
                MODEL_NAME,
                trust_remote_code=True,
                cache_dir=MODEL_CACHE_DIR,
            )
            self.model = AutoModelForCausalLM.from_pretrained(
                MODEL_NAME,
                torch_dtype=dtype,
                trust_remote_code=True,
                cache_dir=MODEL_CACHE_DIR,
            ).to(self.device)
            self.model.eval()
            model_cache.commit()
            safe_print(f"Loaded {MODEL_NAME} on {self.device}")

        @modal.batched(
            max_batch_size=GPU_BATCH_SIZE,
            wait_ms=GPU_BATCH_WAIT_MS,
        )
        async def caption_batch(
            self,
            image_bytes: list[bytes],
            relative_paths: list[str],
            max_new_tokens: list[int],
            num_beams: list[int],
        ) -> list[str]:
            from PIL import Image

            lengths = {
                len(image_bytes),
                len(relative_paths),
                len(max_new_tokens),
                len(num_beams),
            }
            if len(lengths) != 1 or not image_bytes:
                raise ValueError("Các input trong Modal batch không cùng số phần tử")
            if len(set(max_new_tokens)) != 1 or len(set(num_beams)) != 1:
                raise ValueError("Một GPU batch chỉ được dùng chung generation config")

            images = []
            for payload in image_bytes:
                if not payload:
                    raise ValueError("payload ảnh rỗng")
                with Image.open(BytesIO(payload)) as image:
                    images.append(image.convert("RGB"))

            prompts = [CAPTION_TASK] * len(images)
            inputs = self.processor(
                text=prompts,
                images=images,
                return_tensors="pt",
                padding=True,
            )
            moved_inputs = {}
            for name, value in inputs.items():
                if self.torch.is_floating_point(value):
                    moved_inputs[name] = value.to(
                        device=self.device, dtype=self.model.dtype
                    )
                else:
                    moved_inputs[name] = value.to(self.device)

            with self.torch.inference_mode():
                generated_ids = self.model.generate(
                    **moved_inputs,
                    max_new_tokens=max_new_tokens[0],
                    num_beams=num_beams[0],
                    do_sample=False,
                )
            generated_texts = self.processor.batch_decode(
                generated_ids,
                skip_special_tokens=False,
            )
            records: list[str] = []
            for relative_path, generated_text, image in zip(
                relative_paths, generated_texts, images
            ):
                parsed = self.processor.post_process_generation(
                    generated_text,
                    task=CAPTION_TASK,
                    image_size=image.size,
                )
                caption = parsed.get(CAPTION_TASK)
                if not isinstance(caption, str) or not caption.strip():
                    raise ValueError(f"Florence-2 trả caption rỗng: {relative_path}")
                records.append(
                    json.dumps(
                        {
                            "relative_path": _validate_relative_path(relative_path),
                            "caption": caption.strip(),
                        },
                        ensure_ascii=False,
                    )
                )
            return records

    @app.local_entrypoint()
    async def main(
        input_dir: str = "keyframes",
        output_dir: str = "captioning",
        batch_index: int = 0,
        num_batches: int = 3,
        model_name: str = MODEL_NAME,
        batch_size: int = DEFAULT_SUBMISSION_WINDOW,
        max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
        num_beams: int = DEFAULT_NUM_BEAMS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        budget_usd: float = 25.0,
        gpu_rate_usd_per_hour: float = GPU_RATE_USD_PER_HOUR,
        max_images: int = 0,
        overwrite: bool = False,
        dry_run: bool = False,
    ) -> None:
        """Run local orchestration while inference executes on Modal."""

        await caption_directory(
            input_dir=Path(input_dir),
            output_dir=Path(output_dir),
            batch_index=batch_index,
            num_batches=num_batches,
            model_name=model_name,
            batch_size=batch_size,
            max_new_tokens=max_new_tokens,
            num_beams=num_beams,
            max_retries=max_retries,
            budget_usd=budget_usd,
            gpu_rate_usd_per_hour=gpu_rate_usd_per_hour,
            max_images=max_images,
            overwrite=overwrite,
            dry_run=dry_run,
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cài Modal SDK rồi chạy: modal run modal_florence_captioning.py"
        )
    raise SystemExit("Hãy chạy file này bằng `modal run modal_florence_captioning.py`.")
