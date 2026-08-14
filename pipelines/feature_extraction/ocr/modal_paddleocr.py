"""Run Vietnamese PaddleOCR on a local frame directory through Modal.

The local entrypoint is deliberately limited to filesystem discovery,
bounded image uploads, resume bookkeeping, and output writes.  PaddleOCR and
all model inference run inside a Modal GPU container.

Example::

    modal run pipelines/feature_extraction/ocr/modal_paddleocr.py \
        --input-dir E:/aic2026/frames \
        --output-dir E:/aic2026/ocr \
        --max-images 500

Set ``OCR_MODAL_GPU=L4`` before ``modal run`` to use an L4 instead of the
default T4.  Output JSON files preserve the input directory layout and are
written atomically, so rerunning the command resumes completed frames.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

try:
    import modal
except ModuleNotFoundError:  # Keep local utility tests independent of Modal SDK.
    modal = None  # type: ignore[assignment]


MODEL_VERSION = "PP-OCRv5"
LANGUAGE = "vi"
PRODUCER = "ocr:modal-paddleocr"
PIPELINE_VERSION = "ocr-modal-v1"
GPU_TYPE = os.environ.get("OCR_MODAL_GPU", "T4").upper()
DETECTION_MODEL_NAME = os.environ.get(
    "OCR_DETECTION_MODEL", "PP-OCRv5_mobile_det"
)

REMOTE_GPU_BATCH_SIZE = 8
GPU_BATCH_WAIT_MS = 25
DEFAULT_SUBMISSION_WINDOW = 64
MAX_SUBMISSION_WINDOW = 256
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_WINDOW_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_RETRIES = 2
MAX_RETRIES = 5

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})
T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class ImageJob:
    """One bounded image payload and its safe relative identity."""

    relative_path: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class JobLoadFailure:
    """A local input failure that should not discard other frames."""

    relative_path: str
    error: str


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


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    """Sort zero-padded and non-zero-padded frame names naturally."""

    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(piece)) if piece.isdigit() else (1, piece.casefold())
        for piece in pieces
        if piece
    )


def _validate_relative_path(relative_path: str) -> str:
    """Reject absolute, traversing, and Windows-drive paths."""

    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("relative_path phải là chuỗi không rỗng")
    if "\\" in relative_path:
        raise ValueError("relative_path phải dùng dấu /")
    parsed = PurePosixPath(relative_path)
    if (
        parsed.is_absolute()
        or ".." in parsed.parts
        or (parsed.parts and ":" in parsed.parts[0])
    ):
        raise ValueError("relative_path không được là absolute hoặc chứa ..")
    return parsed.as_posix()


def iter_images(input_dir: Path) -> tuple[Path, ...]:
    """Return supported image paths recursively in deterministic order."""

    if not input_dir.is_dir():
        raise FileNotFoundError(f"Không tìm thấy input directory: {input_dir}")
    return tuple(
        sorted(
            (
                path
                for path in input_dir.rglob("*")
                if path.is_file() and path.suffix.casefold() in IMAGE_EXTENSIONS
            ),
            key=lambda path: _natural_key(path.relative_to(input_dir)),
        )
    )


def partition_paths(
    paths: Sequence[Path], *, batch_index: int, num_batches: int
) -> tuple[Path, ...]:
    """Select a deterministic, disjoint round-robin partition of paths."""

    if num_batches < 1:
        raise ValueError("num_batches phải lớn hơn 0")
    if batch_index < 0 or batch_index >= num_batches:
        raise ValueError("batch_index phải nằm trong khoảng 0..num_batches-1")
    if len(set(paths)) != len(paths):
        raise ValueError("input paths phải unique")
    return tuple(paths[batch_index::num_batches])


def validate_directory_layout(input_dir: Path, output_dir: Path) -> None:
    """Prevent output writes from modifying or nesting inside the input tree."""

    input_root = input_dir.resolve()
    output_root = output_dir.resolve()
    if output_root == input_root or input_root in output_root.parents:
        raise ValueError(
            "output_dir không được trùng hoặc nằm bên trong input_dir; "
            "hãy dùng một folder output riêng"
        )


def ocr_path_for(input_dir: Path, output_dir: Path, image_path: Path) -> Path:
    """Map one input frame to a JSON result without flattening directories."""

    relative_path = image_path.relative_to(input_dir).as_posix()
    safe_relative_path = _validate_relative_path(relative_path)
    return (output_dir / PurePosixPath(safe_relative_path)).with_suffix(".json")


def ocr_file_exists(result_path: Path) -> bool:
    """Return true for a non-empty atomically written result file."""

    try:
        return result_path.is_file() and result_path.stat().st_size > 0
    except OSError:
        return False


def chunked(items: Sequence[T], size: int) -> Iterator[tuple[T, ...]]:
    """Yield bounded immutable chunks."""

    if size < 1:
        raise ValueError("chunk size phải lớn hơn 0")
    for start in range(0, len(items), size):
        yield tuple(items[start : start + size])


def bounded_path_chunks(
    paths: Sequence[Path], *, max_items: int, max_bytes: int = MAX_WINDOW_BYTES
) -> Iterator[tuple[Path, ...]]:
    """Bound local RAM by both path count and approximate file size."""

    if max_items < 1 or max_bytes < 1:
        raise ValueError("max_items và max_bytes phải lớn hơn 0")

    current: list[Path] = []
    current_bytes = 0
    for path in paths:
        try:
            file_size = path.stat().st_size
        except OSError:
            file_size = max_bytes
        exceeds_bytes = bool(current) and current_bytes + file_size > max_bytes
        if current and (len(current) >= max_items or exceeds_bytes):
            yield tuple(current)
            current = []
            current_bytes = 0
        current.append(path)
        current_bytes += file_size
    if current:
        yield tuple(current)


def read_image_job(path: Path, relative_path: str) -> ImageJob:
    """Read one bounded image payload for a remote request."""

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
    """Read a bounded window while retaining per-file failures."""

    jobs: list[ImageJob] = []
    failures: list[JobLoadFailure] = []
    for path in paths:
        relative_path = path.relative_to(input_dir).as_posix()
        try:
            jobs.append(read_image_job(path, relative_path))
        except (OSError, ValueError) as error:
            failures.append(JobLoadFailure(relative_path, str(error)))
    return tuple(jobs), tuple(failures)


def validate_options(*, batch_size: int, max_retries: int, max_images: int) -> None:
    """Validate local controls before any Modal request is made."""

    if not 1 <= batch_size <= MAX_SUBMISSION_WINDOW:
        raise ValueError(f"batch_size phải nằm trong khoảng 1..{MAX_SUBMISSION_WINDOW}")
    if not 0 <= max_retries <= MAX_RETRIES:
        raise ValueError(f"max_retries phải nằm trong khoảng 0..{MAX_RETRIES}")
    if max_images < 0:
        raise ValueError("max_images không được âm; dùng 0 để xử lý toàn bộ")


def normalize_text(value: str) -> str:
    """Normalize Vietnamese Unicode and collapse OCR whitespace."""

    return " ".join(unicodedata.normalize("NFC", value).split())


def _to_builtin(value: Any) -> Any:
    """Convert numpy arrays/scalars returned by PaddleOCR to JSON values."""

    if isinstance(value, Mapping):
        return {str(key): _to_builtin(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_builtin(item) for item in value]
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return _to_builtin(tolist())
    item = getattr(value, "item", None)
    if callable(item):
        return _to_builtin(item())
    return value


def _valid_polygon(value: Any) -> bool:
    """Return true for a four-point polygon with numeric coordinates."""

    if not isinstance(value, list) or len(value) != 4:
        return False
    return all(
        isinstance(point, list)
        and len(point) == 2
        and all(isinstance(coordinate, (int, float)) for coordinate in point)
        for point in value
    )


def build_ocr_record(relative_path: str, raw_result: Mapping[str, Any]) -> dict[str, Any]:
    """Convert one PaddleOCR result into a compact, stable JSON record."""

    safe_relative_path = _validate_relative_path(relative_path)
    result = raw_result.get("res", raw_result)
    if not isinstance(result, Mapping):
        raise TypeError("PaddleOCR result phải là object")

    raw_texts = _to_builtin(result.get("rec_texts", []))
    raw_scores = _to_builtin(result.get("rec_scores", []))
    raw_polys = _to_builtin(result.get("rec_polys", result.get("dt_polys", [])))
    if not isinstance(raw_texts, list):
        raise TypeError("PaddleOCR rec_texts phải là list")
    if not isinstance(raw_scores, list):
        raw_scores = []
    if not isinstance(raw_polys, list):
        raw_polys = []

    boxes: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for index, raw_text in enumerate(raw_texts):
        text = normalize_text(str(raw_text))
        if not text:
            continue
        score = 0.0
        if index < len(raw_scores):
            try:
                score = min(1.0, max(0.0, float(raw_scores[index])))
            except (TypeError, ValueError):
                score = 0.0
        polygon = raw_polys[index] if index < len(raw_polys) else []
        if not _valid_polygon(polygon):
            continue
        text_parts.append(text)
        boxes.append(
            {
                "text": text,
                "box": polygon,
                "confidence": score,
            }
        )

    text = normalize_text(" ".join(text_parts))
    confidence = (
        sum(float(box["confidence"]) for box in boxes) / len(boxes)
        if boxes
        else 0.0
    )
    return {
        "relative_path": safe_relative_path,
        "text": text,
        "normalized_text": text.casefold(),
        "boxes": boxes,
        "confidence": confidence,
        "language": LANGUAGE,
        "producer": PRODUCER,
        "model_version": MODEL_VERSION,
        "pipeline_version": PIPELINE_VERSION,
    }


def parse_remote_result(payload: str) -> dict[str, Any]:
    """Validate one JSON record returned by the Modal worker."""

    try:
        record = json.loads(payload)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Modal trả về JSON không hợp lệ") from error
    if not isinstance(record, dict):
        raise TypeError("Modal result phải là object")
    record["relative_path"] = _validate_relative_path(
        record.get("relative_path", "")
    )
    if not isinstance(record.get("text"), str):
        raise TypeError("Modal result thiếu text")
    if not isinstance(record.get("normalized_text"), str):
        raise TypeError("Modal result thiếu normalized_text")
    if not isinstance(record.get("boxes"), list):
        raise TypeError("Modal result thiếu boxes")
    confidence = record.get("confidence")
    if not isinstance(confidence, (int, float)) or not math.isfinite(float(confidence)):
        raise ValueError("Modal result có confidence không hợp lệ")
    if not 0.0 <= float(confidence) <= 1.0:
        raise ValueError("Modal result có confidence ngoài khoảng 0..1")
    return record


def _write_json_atomic(path: Path, record: Mapping[str, Any]) -> None:
    """Write one result atomically so resume never sees a partial JSON file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _append_jsonl(path: Path, record: Mapping[str, Any]) -> None:
    """Append a flushed progress/error record."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()


def _error_text(error: BaseException) -> str:
    return str(error).strip()[:500] or error.__class__.__name__


def _is_retryable_remote_error(error: BaseException) -> bool:
    """Retry transient network/service failures but fail fast on auth errors."""

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
    """Identify failures likely caused by one malformed image."""

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


async def _ocr_remote_window(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    max_retries: int,
) -> tuple[dict[str, dict[str, Any]], tuple[ImageJob, ...], BaseException | None, float]:
    """Submit one bounded window and retry unresolved transient requests."""

    results: dict[str, dict[str, Any]] = {}
    remaining = tuple(jobs)
    last_error: BaseException | None = None
    started = time.perf_counter()

    for attempt in range(max_retries + 1):
        if not remaining:
            break
        try:
            requests = tuple(
                (job.payload, job.relative_path) for job in remaining
            )
            async for raw_result in worker.ocr_batch.starmap.aio(requests):
                record = parse_remote_result(raw_result)
                expected = {job.relative_path for job in remaining}
                relative_path = record["relative_path"]
                if relative_path not in expected:
                    raise ValueError(
                        f"Modal trả về relative_path ngoài request: {relative_path}"
                    )
                results[relative_path] = record
            remaining = tuple(
                job for job in remaining if job.relative_path not in results
            )
            if remaining:
                last_error = RuntimeError(
                    f"Modal thiếu {len(remaining)} kết quả trong window"
                )
                break
            last_error = None
        except Exception as error:  # noqa: BLE001 - Modal SDK types vary.
            last_error = error
            remaining = tuple(
                job for job in remaining if job.relative_path not in results
            )
            if not _is_retryable_remote_error(error):
                break
            if attempt < max_retries:
                await asyncio.sleep(2**attempt)

    return results, remaining, last_error, time.perf_counter() - started


async def _ocr_remote_with_recovery(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    max_retries: int,
) -> tuple[dict[str, dict[str, Any]], tuple[ImageJob, ...], BaseException | None, float]:
    """Split a failed image window to isolate malformed input frames."""

    results, failures, error, elapsed = await _ocr_remote_window(
        worker, jobs, max_retries=max_retries
    )
    if not failures or len(failures) == 1 or not _isolateable_remote_error(error):
        return results, failures, error, elapsed

    midpoint = len(failures) // 2
    left = await _ocr_remote_with_recovery(
        worker, failures[:midpoint], max_retries=max_retries
    )
    right = await _ocr_remote_with_recovery(
        worker, failures[midpoint:], max_retries=max_retries
    )
    merged_results = {**results, **left[0], **right[0]}
    merged_failures = (*left[1], *right[1])
    merged_error = right[2] or left[2] or error
    return merged_results, merged_failures, merged_error, elapsed + left[3] + right[3]


async def ocr_directory(
    *,
    input_dir: Path,
    output_dir: Path,
    batch_index: int = 0,
    num_batches: int = 1,
    batch_size: int = DEFAULT_SUBMISSION_WINDOW,
    max_retries: int = DEFAULT_MAX_RETRIES,
    max_images: int = 0,
    overwrite: bool = False,
    dry_run: bool = False,
) -> None:
    """OCR pending frames through one long-lived Modal GPU worker."""

    validate_options(
        batch_size=batch_size,
        max_retries=max_retries,
        max_images=max_images,
    )
    validate_directory_layout(input_dir, output_dir)
    all_images = iter_images(input_dir)
    selected_images = partition_paths(
        all_images,
        batch_index=batch_index,
        num_batches=num_batches,
    )
    pending_images = tuple(
        path
        for path in selected_images
        if overwrite or not ocr_file_exists(ocr_path_for(input_dir, output_dir, path))
    )
    if max_images:
        pending_images = pending_images[:max_images]

    safe_print(
        f"[plan] total={len(all_images)} selected={len(selected_images)} "
        f"pending={len(pending_images)} batch={batch_index}/{num_batches} "
        f"gpu={GPU_TYPE} model={MODEL_VERSION}"
    )
    if dry_run:
        safe_print("[dry-run] Không khởi tạo Modal và không ghi OCR result.")
        return
    if not pending_images:
        safe_print("[done] Không có frame mới cần OCR.")
        return
    if OcrWorker is None:
        raise RuntimeError(
            "Thiếu Modal SDK. Cài requirements-modal.txt rồi chạy bằng "
            "`modal run pipelines/feature_extraction/ocr/modal_paddleocr.py`."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / f"run_batch_{batch_index}_of_{num_batches}.jsonl"
    errors_path = output_dir / f"errors_batch_{batch_index}_of_{num_batches}.jsonl"
    worker = OcrWorker()
    completed = 0
    failed = 0
    total_remote_seconds = 0.0

    for path_window in bounded_path_chunks(
        pending_images,
        max_items=batch_size,
        max_bytes=MAX_WINDOW_BYTES,
    ):
        jobs, local_failures = load_image_jobs(input_dir, path_window)
        for failure in local_failures:
            failed += 1
            _append_jsonl(
                errors_path,
                {
                    "relative_path": failure.relative_path,
                    "stage": "local_read",
                    "error": failure.error,
                },
            )
        if not jobs:
            continue

        records, remote_failures, remote_error, elapsed = (
            await _ocr_remote_with_recovery(
                worker,
                jobs,
                max_retries=max_retries,
            )
        )
        total_remote_seconds += elapsed
        for relative_path, record in records.items():
            result_path = output_dir / PurePosixPath(relative_path)
            result_path = result_path.with_suffix(".json")
            _write_json_atomic(result_path, record)
            _append_jsonl(
                manifest_path,
                {
                    "relative_path": relative_path,
                    "result_path": result_path.relative_to(output_dir).as_posix(),
                    "status": "completed",
                },
            )
            completed += 1
        for failure in remote_failures:
            failed += 1
            _append_jsonl(
                errors_path,
                {
                    "relative_path": failure.relative_path,
                    "stage": "modal_inference",
                    "error": _error_text(remote_error)
                    if remote_error is not None
                    else "Modal không trả kết quả",
                },
            )

        if (
            remote_error is not None
            and remote_failures
            and len(remote_failures) == len(jobs)
            and not _isolateable_remote_error(remote_error)
        ):
            raise RuntimeError(f"Modal OCR thất bại: {_error_text(remote_error)}")

        safe_print(
            f"[progress] completed={completed} failed={failed} "
            f"remaining={len(pending_images) - completed - failed} "
            f"remote_seconds={total_remote_seconds:.1f}"
        )

    safe_print(
        f"[done] completed={completed} failed={failed} "
        f"remote_seconds={total_remote_seconds:.1f}"
    )


app = None
OcrWorker: Any = None

if modal is not None:
    MODEL_CACHE_DIR = "/root/.paddlex"
    model_cache = modal.Volume.from_name(
        "aic-paddleocr-model-cache",
        create_if_missing=True,
    )
    image = (
        modal.Image.from_registry(
            "paddlepaddle/paddle:3.0.0-gpu-cuda11.8-cudnn8.9-trt8.6"
        )
        .entrypoint([])
        .pip_install(
            "paddleocr==3.2.0",
            "Pillow>=10,<13",
        )
        .env(
            {
                "PADDLE_PDX_CACHE_HOME": MODEL_CACHE_DIR,
            }
        )
    )
    app = modal.App(
        "aic-vietnamese-ocr",
        image=image,
        volumes={MODEL_CACHE_DIR: model_cache},
    )

    @app.cls(
        gpu=GPU_TYPE,
        memory=16_384,
        timeout=12 * 60 * 60,
        scaledown_window=120,
        max_containers=1,
    )
    class OcrWorker:
        """Long-lived PP-OCRv5 worker with Modal dynamic batching."""

        @modal.enter()
        def load_model(self) -> None:
            from paddleocr import PaddleOCR

            self.ocr = PaddleOCR(
                lang=LANGUAGE,
                ocr_version=MODEL_VERSION,
                device="gpu:0",
                text_detection_model_name=DETECTION_MODEL_NAME,
                text_recognition_model_name="latin_PP-OCRv5_mobile_rec",
                text_recognition_batch_size=REMOTE_GPU_BATCH_SIZE,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            model_cache.commit()
            safe_print(
                f"Loaded {MODEL_VERSION} ({LANGUAGE}) on Modal {GPU_TYPE}; "
                f"detector={DETECTION_MODEL_NAME}"
            )

        @modal.batched(
            max_batch_size=REMOTE_GPU_BATCH_SIZE,
            wait_ms=GPU_BATCH_WAIT_MS,
        )
        async def ocr_batch(
            self,
            image_bytes: list[bytes],
            relative_paths: list[str],
        ) -> list[str]:
            if len(image_bytes) != len(relative_paths):
                raise ValueError("image_bytes và relative_paths không cùng độ dài")

            import numpy as np
            from PIL import Image

            images = []
            for payload in image_bytes:
                with Image.open(BytesIO(payload)) as image:
                    images.append(np.array(image.convert("RGB"), copy=True))

            results = list(self.ocr.predict(images))
            if len(results) != len(relative_paths):
                raise RuntimeError(
                    f"PaddleOCR trả {len(results)} kết quả cho "
                    f"{len(relative_paths)} ảnh"
                )
            return [
                json.dumps(
                    build_ocr_record(relative_path, result.json),
                    ensure_ascii=False,
                )
                for relative_path, result in zip(relative_paths, results)
            ]

    @app.local_entrypoint()
    async def main(
        input_dir: str = "frames",
        output_dir: str = "ocr",
        batch_index: int = 0,
        num_batches: int = 1,
        batch_size: int = DEFAULT_SUBMISSION_WINDOW,
        max_retries: int = DEFAULT_MAX_RETRIES,
        max_images: int = 0,
        overwrite: bool = False,
        dry_run: bool = False,
    ) -> None:
        await ocr_directory(
            input_dir=Path(input_dir),
            output_dir=Path(output_dir),
            batch_index=batch_index,
            num_batches=num_batches,
            batch_size=batch_size,
            max_retries=max_retries,
            max_images=max_images,
            overwrite=overwrite,
            dry_run=dry_run,
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cài Modal SDK rồi chạy: "
            "modal run pipelines/feature_extraction/ocr/modal_paddleocr.py"
        )
    raise SystemExit(
        "Hãy chạy file này bằng `modal run "
        "pipelines/feature_extraction/ocr/modal_paddleocr.py`."
    )
