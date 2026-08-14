"""Run Ultralytics YOLO object detection on local frames through Modal.

The local process only discovers files, uploads bounded image windows, and
writes JSON results.  Ultralytics, PyTorch, and all model inference run inside
a Modal GPU container.

Example::

    modal run pipelines/feature_extraction/object_detection/modal_yolo.py \
        --input-dir E:/aic2026/frames \
        --output-dir E:/aic2026/object_detection \
        --max-images 500

Set ``OBJECT_DETECTION_MODAL_GPU=L4`` before ``modal run`` to use an L4
instead of the default T4.  Output JSON files preserve the input directory
layout and are written atomically, so rerunning the command resumes completed
frames.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

try:
    import modal
except ModuleNotFoundError:  # Keep local utility tests independent of Modal SDK.
    modal = None  # type: ignore[assignment]


MODEL_NAME = os.environ.get("OBJECT_DETECTION_MODEL", "yolo26n.pt")
ULTRALYTICS_VERSION = "8.4.104"
ULTRALYTICS_DISTRIBUTION = "ultralytics-opencv-headless"
PRODUCER = "object-detection:modal-ultralytics"
PIPELINE_VERSION = "object-detection-modal-v1"
GPU_TYPE = os.environ.get("OBJECT_DETECTION_MODAL_GPU", "T4").upper()

REMOTE_GPU_BATCH_SIZE = 8
GPU_BATCH_WAIT_MS = 25
DEFAULT_SUBMISSION_WINDOW = 64
MAX_SUBMISSION_WINDOW = 256
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_WINDOW_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_RETRIES = 2
MAX_RETRIES = 5

DEFAULT_IMAGE_SIZE = 640
DEFAULT_CONFIDENCE_THRESHOLD = 0.25
DEFAULT_IOU_THRESHOLD = 0.45
DEFAULT_MAX_DETECTIONS = 100
INFERENCE_QUANTIZE = 16  # FP16 on CUDA; replaces deprecated half=True.
MIN_IMAGE_SIZE = 32
MAX_IMAGE_SIZE = 4096

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
    normalized = parsed.as_posix()
    if normalized != relative_path:
        raise ValueError("relative_path phải ở dạng chuẩn")
    return normalized


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


def result_path_for(input_dir: Path, output_dir: Path, image_path: Path) -> Path:
    """Map one input frame to a JSON result without flattening directories."""

    relative_path = image_path.relative_to(input_dir).as_posix()
    safe_relative_path = _validate_relative_path(relative_path)
    return (output_dir / PurePosixPath(safe_relative_path)).with_suffix(".json")


def result_file_exists(result_path: Path) -> bool:
    """Return true for a non-empty atomically written result file."""

    try:
        return result_path.is_file() and result_path.stat().st_size > 0
    except OSError:
        return False


def bounded_path_chunks(
    paths: Sequence[Path], *, max_items: int, max_bytes: int = MAX_WINDOW_BYTES
) -> Iterator[tuple[Path, ...]]:
    """Yield bounded immutable chunks by both path count and file size."""

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


def validate_options(
    *,
    batch_size: int,
    max_retries: int,
    max_images: int,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
    image_size: int = DEFAULT_IMAGE_SIZE,
    max_detections: int = DEFAULT_MAX_DETECTIONS,
) -> None:
    """Validate local controls before any Modal request is made."""

    if not 1 <= batch_size <= MAX_SUBMISSION_WINDOW:
        raise ValueError(f"batch_size phải nằm trong khoảng 1..{MAX_SUBMISSION_WINDOW}")
    if not 0 <= max_retries <= MAX_RETRIES:
        raise ValueError(f"max_retries phải nằm trong khoảng 0..{MAX_RETRIES}")
    if max_images < 0:
        raise ValueError("max_images không được âm; dùng 0 để xử lý toàn bộ")
    if not 0.0 <= confidence_threshold <= 1.0:
        raise ValueError("confidence_threshold phải nằm trong khoảng 0..1")
    if not 0.0 <= iou_threshold <= 1.0:
        raise ValueError("iou_threshold phải nằm trong khoảng 0..1")
    if not MIN_IMAGE_SIZE <= image_size <= MAX_IMAGE_SIZE:
        raise ValueError(
            f"image_size phải nằm trong khoảng {MIN_IMAGE_SIZE}..{MAX_IMAGE_SIZE}"
        )
    if not 1 <= max_detections <= 300:
        raise ValueError("max_detections phải nằm trong khoảng 1..300")


def _as_sequence(value: Any, field_name: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise TypeError(f"{field_name} phải là sequence")
    return value


def _finite_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{field_name} không được là bool")
    try:
        converted = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} phải là số") from error
    if not math.isfinite(converted):
        raise ValueError(f"{field_name} phải là số hữu hạn")
    return converted


def _positive_dimension(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{field_name} phải là số nguyên dương")
    return value


def _normalized_box(
    box: Any, *, image_width: int, image_height: int, index: int
) -> tuple[list[float], list[float]]:
    values = _as_sequence(box, f"boxes[{index}]")
    if len(values) != 4:
        raise ValueError(f"boxes[{index}] phải có 4 tọa độ")
    x1, y1, x2, y2 = (
        _finite_float(value, f"boxes[{index}][{coordinate}]")
        for coordinate, value in enumerate(values)
    )
    if not 0.0 <= x1 <= x2 <= float(image_width):
        raise ValueError(f"boxes[{index}] có trục x không hợp lệ")
    if not 0.0 <= y1 <= y2 <= float(image_height):
        raise ValueError(f"boxes[{index}] có trục y không hợp lệ")
    pixel_box = [x1, y1, x2, y2]
    normalized_box = [
        x1 / image_width,
        y1 / image_height,
        x2 / image_width,
        y2 / image_height,
    ]
    return pixel_box, normalized_box


def build_detection_record(
    relative_path: str,
    raw_result: Mapping[str, Any],
    *,
    model_name: str = MODEL_NAME,
    image_size: int = DEFAULT_IMAGE_SIZE,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
) -> dict[str, Any]:
    """Build a stable JSON record from normalized detector arrays."""

    safe_relative_path = _validate_relative_path(relative_path)
    image_width = _positive_dimension(raw_result.get("image_width"), "image_width")
    image_height = _positive_dimension(raw_result.get("image_height"), "image_height")
    boxes = _as_sequence(raw_result.get("boxes", []), "boxes")
    confidences = _as_sequence(
        raw_result.get("confidences", []), "confidences"
    )
    class_ids = _as_sequence(raw_result.get("class_ids", []), "class_ids")
    class_names = _as_sequence(raw_result.get("class_names", []), "class_names")
    field_lengths = {len(boxes), len(confidences), len(class_ids), len(class_names)}
    if len(field_lengths) != 1:
        raise ValueError("các mảng detection phải cùng độ dài")

    detections: list[dict[str, Any]] = []
    for index, (box, confidence, class_id, class_name) in enumerate(
        zip(boxes, confidences, class_ids, class_names)
    ):
        pixel_box, normalized_box = _normalized_box(
            box,
            image_width=image_width,
            image_height=image_height,
            index=index,
        )
        confidence_value = _finite_float(confidence, f"confidences[{index}]")
        if not 0.0 <= confidence_value <= 1.0:
            raise ValueError(f"confidences[{index}] phải nằm trong khoảng 0..1")
        class_id_value = _finite_float(class_id, f"class_ids[{index}]")
        if class_id_value < 0 or not class_id_value.is_integer():
            raise ValueError(f"class_ids[{index}] phải là số nguyên không âm")
        if not isinstance(class_name, str) or not class_name.strip():
            raise ValueError(f"class_names[{index}] phải là chuỗi không rỗng")
        detections.append(
            {
                "class_id": int(class_id_value),
                "class_name": class_name,
                "confidence": confidence_value,
                "bbox_xyxy": pixel_box,
                "bbox_normalized": normalized_box,
            }
        )

    return {
        "relative_path": safe_relative_path,
        "producer": PRODUCER,
        "pipeline_version": PIPELINE_VERSION,
        "model": model_name,
        "image_width": image_width,
        "image_height": image_height,
        "inference": {
            "image_size": image_size,
            "confidence_threshold": confidence_threshold,
            "iou_threshold": iou_threshold,
        },
        "num_detections": len(detections),
        "detections": detections,
    }


def _to_builtin(value: Any) -> Any:
    """Convert torch/numpy-like values to plain Python containers."""

    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "tolist"):
        value = value.tolist()
    return value


def _class_name(names: Any, class_id: int) -> str:
    if isinstance(names, Mapping):
        value = names.get(class_id, names.get(str(class_id), class_id))
    elif isinstance(names, Sequence) and not isinstance(names, (str, bytes)):
        value = names[class_id] if 0 <= class_id < len(names) else class_id
    else:
        value = class_id
    return str(value)


def _record_from_ultralytics_result(
    relative_path: str,
    result: Any,
    *,
    model_name: str,
    image_size: int,
    confidence_threshold: float,
    iou_threshold: float,
) -> dict[str, Any]:
    """Convert one Ultralytics Results object to the stable JSON contract."""

    boxes_object = getattr(result, "boxes", None)
    if boxes_object is None:
        raise TypeError("Ultralytics result thiếu boxes")
    shape = _to_builtin(getattr(result, "orig_shape", None))
    if not isinstance(shape, Sequence) or len(shape) != 2:
        raise TypeError("Ultralytics result thiếu orig_shape hợp lệ")
    image_height = int(shape[0])
    image_width = int(shape[1])
    raw_boxes = _to_builtin(getattr(boxes_object, "xyxy", []))
    raw_confidences = _to_builtin(getattr(boxes_object, "conf", []))
    raw_class_ids = _to_builtin(getattr(boxes_object, "cls", []))
    if raw_boxes is None:
        raw_boxes = []
    if raw_confidences is None:
        raw_confidences = []
    if raw_class_ids is None:
        raw_class_ids = []
    class_ids = [int(_finite_float(value, "class_id")) for value in raw_class_ids]
    names = getattr(result, "names", {})
    class_names = [_class_name(names, class_id) for class_id in class_ids]
    return build_detection_record(
        relative_path,
        {
            "image_width": image_width,
            "image_height": image_height,
            "boxes": raw_boxes,
            "confidences": raw_confidences,
            "class_ids": class_ids,
            "class_names": class_names,
        },
        model_name=model_name,
        image_size=image_size,
        confidence_threshold=confidence_threshold,
        iou_threshold=iou_threshold,
    )


def parse_remote_result(payload: str) -> dict[str, Any]:
    """Validate one JSON result before it is allowed to reach the filesystem."""

    try:
        record = json.loads(payload)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Modal trả về JSON không hợp lệ") from error
    if not isinstance(record, dict):
        raise TypeError("Modal result phải là object")
    relative_path = record.get("relative_path")
    if _validate_relative_path(relative_path) != relative_path:
        raise ValueError("Modal result có relative_path không chuẩn")
    _positive_dimension(record.get("image_width"), "image_width")
    _positive_dimension(record.get("image_height"), "image_height")
    detections = record.get("detections")
    if not isinstance(detections, list):
        raise TypeError("Modal result thiếu detections list")
    if record.get("num_detections") != len(detections):
        raise ValueError("Modal result có num_detections không khớp")
    for index, detection in enumerate(detections):
        if not isinstance(detection, dict):
            raise TypeError(f"Modal detection {index} phải là object")
        _finite_float(detection.get("confidence"), f"detections[{index}].confidence")
        confidence = float(detection["confidence"])
        if not 0.0 <= confidence <= 1.0:
            raise ValueError(f"detections[{index}].confidence ngoài khoảng 0..1")
        for field_name in ("bbox_xyxy", "bbox_normalized"):
            box = detection.get(field_name)
            values = _as_sequence(box, f"detections[{index}].{field_name}")
            if len(values) != 4:
                raise ValueError(f"detections[{index}].{field_name} không hợp lệ")
            for coordinate in values:
                _finite_float(coordinate, f"detections[{index}].{field_name}")
    return record


def _write_json_atomic(path: Path, record: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _append_jsonl(path: Path, record: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}".strip()


def _is_retryable_remote_error(error: BaseException) -> bool:
    return not isinstance(error, (ValueError, TypeError, KeyError))


def _isolateable_remote_error(error: BaseException | None) -> bool:
    if error is None:
        return False
    message = _error_text(error).casefold()
    return any(
        marker in message
        for marker in (
            "image",
            "decode",
            "corrupt",
            "unidentified",
            "pil",
            "jpeg",
            "png",
        )
    )


async def _call_remote_window(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    image_size: int,
    confidence_threshold: float,
    iou_threshold: float,
    max_detections: int,
) -> dict[str, dict[str, Any]]:
    requests = tuple(
        (
            job.payload,
            job.relative_path,
            image_size,
            confidence_threshold,
            iou_threshold,
            max_detections,
        )
        for job in jobs
    )
    expected_paths = {job.relative_path for job in jobs}
    records: dict[str, dict[str, Any]] = {}
    async for payload in worker.detect_batch.starmap.aio(requests):
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        record = parse_remote_result(payload)
        relative_path = record["relative_path"]
        if relative_path not in expected_paths:
            raise ValueError(f"Modal trả relative_path ngoài request: {relative_path}")
        if relative_path in records:
            raise ValueError(f"Modal trả trùng relative_path: {relative_path}")
        records[relative_path] = record
    missing = expected_paths.difference(records)
    if missing:
        raise ValueError(f"Modal thiếu {len(missing)} kết quả trong window")
    return records


async def _detect_remote_window(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    max_retries: int,
    image_size: int = DEFAULT_IMAGE_SIZE,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
    max_detections: int = DEFAULT_MAX_DETECTIONS,
) -> tuple[dict[str, dict[str, Any]], tuple[ImageJob, ...], BaseException | None, float]:
    """Run one remote window with bounded retries and per-window timing."""

    started = time.perf_counter()
    last_error: BaseException | None = None
    for attempt in range(max_retries + 1):
        try:
            records = await _call_remote_window(
                worker,
                jobs,
                image_size=image_size,
                confidence_threshold=confidence_threshold,
                iou_threshold=iou_threshold,
                max_detections=max_detections,
            )
            return records, (), None, time.perf_counter() - started
        except Exception as error:  # noqa: BLE001 - Modal SDK exception types vary.
            last_error = error
            if attempt >= max_retries or not _is_retryable_remote_error(error):
                break
            await asyncio.sleep(min(2**attempt, 8))
    return {}, tuple(jobs), last_error, time.perf_counter() - started


async def _detect_remote_with_recovery(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    max_retries: int,
    image_size: int = DEFAULT_IMAGE_SIZE,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
    max_detections: int = DEFAULT_MAX_DETECTIONS,
) -> tuple[dict[str, dict[str, Any]], tuple[ImageJob, ...], BaseException | None, float]:
    """Retry a window and split it when a single malformed image is suspected."""

    records, failures, error, elapsed = await _detect_remote_window(
        worker,
        jobs,
        max_retries=max_retries,
        image_size=image_size,
        confidence_threshold=confidence_threshold,
        iou_threshold=iou_threshold,
        max_detections=max_detections,
    )
    if not error or len(jobs) < 2 or not _isolateable_remote_error(error):
        return records, failures, error, elapsed

    midpoint = len(jobs) // 2
    left_result = await _detect_remote_with_recovery(
        worker,
        jobs[:midpoint],
        max_retries=max_retries,
        image_size=image_size,
        confidence_threshold=confidence_threshold,
        iou_threshold=iou_threshold,
        max_detections=max_detections,
    )
    right_result = await _detect_remote_with_recovery(
        worker,
        jobs[midpoint:],
        max_retries=max_retries,
        image_size=image_size,
        confidence_threshold=confidence_threshold,
        iou_threshold=iou_threshold,
        max_detections=max_detections,
    )
    left_records, left_failures, left_error, left_elapsed = left_result
    right_records, right_failures, right_error, right_elapsed = right_result
    return (
        {**left_records, **right_records},
        (*left_failures, *right_failures),
        left_error or right_error,
        elapsed + left_elapsed + right_elapsed,
    )


async def detect_directory(
    *,
    input_dir: Path,
    output_dir: Path,
    batch_index: int = 0,
    num_batches: int = 1,
    batch_size: int = DEFAULT_SUBMISSION_WINDOW,
    max_retries: int = DEFAULT_MAX_RETRIES,
    max_images: int = 0,
    image_size: int = DEFAULT_IMAGE_SIZE,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
    max_detections: int = DEFAULT_MAX_DETECTIONS,
    overwrite: bool = False,
    dry_run: bool = False,
) -> None:
    """Detect objects for one deterministic local input partition."""

    validate_options(
        batch_size=batch_size,
        max_retries=max_retries,
        max_images=max_images,
        confidence_threshold=confidence_threshold,
        iou_threshold=iou_threshold,
        image_size=image_size,
        max_detections=max_detections,
    )
    validate_directory_layout(input_dir, output_dir)
    all_images = iter_images(input_dir)
    selected_images = partition_paths(
        all_images,
        batch_index=batch_index,
        num_batches=num_batches,
    )
    if max_images:
        selected_images = selected_images[:max_images]
    pending_images = tuple(
        path
        for path in selected_images
        if overwrite or not result_file_exists(result_path_for(input_dir, output_dir, path))
    )
    safe_print(
        f"[plan] discovered={len(all_images)} selected={len(selected_images)} "
        f"pending={len(pending_images)} batch={batch_index}/{num_batches} "
        f"model={MODEL_NAME} gpu={GPU_TYPE}"
    )
    if dry_run:
        safe_print("[dry-run] Không khởi tạo Modal và không ghi detection result.")
        return
    if not pending_images:
        safe_print("[done] Không có frame mới cần object detection.")
        return
    if ObjectDetectionWorker is None:
        raise RuntimeError(
            "Thiếu Modal SDK. Cài requirements-modal.txt rồi chạy bằng "
            "`modal run pipelines/feature_extraction/object_detection/modal_yolo.py`."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / f"run_batch_{batch_index}_of_{num_batches}.jsonl"
    errors_path = output_dir / f"errors_batch_{batch_index}_of_{num_batches}.jsonl"
    worker = ObjectDetectionWorker()
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
            await _detect_remote_with_recovery(
                worker,
                jobs,
                max_retries=max_retries,
                image_size=image_size,
                confidence_threshold=confidence_threshold,
                iou_threshold=iou_threshold,
                max_detections=max_detections,
            )
        )
        total_remote_seconds += elapsed
        for relative_path, record in records.items():
            result_path = (output_dir / PurePosixPath(relative_path)).with_suffix(
                ".json"
            )
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
            raise RuntimeError(
                f"Modal object detection thất bại: {_error_text(remote_error)}"
            )

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
ObjectDetectionWorker: Any = None

if modal is not None:
    MODEL_CACHE_DIR = "/root/.cache/ultralytics"
    model_cache = modal.Volume.from_name(
        "aic-ultralytics-model-cache",
        create_if_missing=True,
    )
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .pip_install(
            f"{ULTRALYTICS_DISTRIBUTION}=={ULTRALYTICS_VERSION}",
            "Pillow>=10,<13",
        )
        .env(
            {
                "YOLO_CONFIG_DIR": MODEL_CACHE_DIR,
                "TORCH_HOME": MODEL_CACHE_DIR,
            }
        )
    )
    app = modal.App(
        "aic-object-detection",
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
    class ObjectDetectionWorker:
        """Long-lived YOLO worker with Modal dynamic batching."""

        @modal.enter()
        def load_model(self) -> None:
            from ultralytics import YOLO

            self.model = YOLO(MODEL_NAME)
            model_cache.commit()
            safe_print(
                f"Loaded {MODEL_NAME} with Ultralytics {ULTRALYTICS_VERSION} "
                f"on Modal {GPU_TYPE}"
            )

        @modal.batched(
            max_batch_size=REMOTE_GPU_BATCH_SIZE,
            wait_ms=GPU_BATCH_WAIT_MS,
        )
        async def detect_batch(
            self,
            image_bytes: list[bytes],
            relative_paths: list[str],
            image_sizes: list[int],
            confidence_thresholds: list[float],
            iou_thresholds: list[float],
            max_detections: list[int],
        ) -> list[str]:
            lengths = {
                len(image_bytes),
                len(relative_paths),
                len(image_sizes),
                len(confidence_thresholds),
                len(iou_thresholds),
                len(max_detections),
            }
            if len(lengths) != 1:
                raise ValueError("Các input trong Modal batch không cùng số phần tử")
            if not image_bytes:
                return []
            settings = (
                image_sizes[0],
                confidence_thresholds[0],
                iou_thresholds[0],
                max_detections[0],
            )
            if any(
                candidate
                != (
                    image_sizes[0],
                    confidence_thresholds[index],
                    iou_thresholds[index],
                    max_detections[index],
                )
                for index, candidate in enumerate(
                    zip(
                        image_sizes,
                        confidence_thresholds,
                        iou_thresholds,
                        max_detections,
                    )
                )
            ):
                raise ValueError("Modal batch chứa nhiều cấu hình inference")

            import numpy as np
            from PIL import Image

            images = []
            for payload in image_bytes:
                with Image.open(BytesIO(payload)) as image:
                    images.append(np.array(image.convert("RGB"), copy=True))

            results = list(
                self.model.predict(
                    source=images,
                    imgsz=settings[0],
                    conf=settings[1],
                    iou=settings[2],
                    max_det=settings[3],
                    device=0,
                    quantize=INFERENCE_QUANTIZE,
                    verbose=False,
                )
            )
            if len(results) != len(relative_paths):
                raise RuntimeError(
                    f"Ultralytics trả {len(results)} kết quả cho "
                    f"{len(relative_paths)} ảnh"
                )
            return [
                json.dumps(
                    _record_from_ultralytics_result(
                        relative_path,
                        result,
                        model_name=MODEL_NAME,
                        image_size=settings[0],
                        confidence_threshold=settings[1],
                        iou_threshold=settings[2],
                    ),
                    ensure_ascii=False,
                )
                for relative_path, result in zip(relative_paths, results)
            ]

    @app.local_entrypoint()
    async def main(
        input_dir: str = "frames",
        output_dir: str = "object_detection",
        batch_index: int = 0,
        num_batches: int = 1,
        batch_size: int = DEFAULT_SUBMISSION_WINDOW,
        max_retries: int = DEFAULT_MAX_RETRIES,
        max_images: int = 0,
        image_size: int = DEFAULT_IMAGE_SIZE,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
        iou_threshold: float = DEFAULT_IOU_THRESHOLD,
        max_detections: int = DEFAULT_MAX_DETECTIONS,
        overwrite: bool = False,
        dry_run: bool = False,
    ) -> None:
        await detect_directory(
            input_dir=Path(input_dir),
            output_dir=Path(output_dir),
            batch_index=batch_index,
            num_batches=num_batches,
            batch_size=batch_size,
            max_retries=max_retries,
            max_images=max_images,
            image_size=image_size,
            confidence_threshold=confidence_threshold,
            iou_threshold=iou_threshold,
            max_detections=max_detections,
            overwrite=overwrite,
            dry_run=dry_run,
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cài Modal SDK rồi chạy: "
            "modal run pipelines/feature_extraction/object_detection/modal_yolo.py"
        )
    raise SystemExit(
        "Hãy chạy file này bằng `modal run "
        "pipelines/feature_extraction/object_detection/modal_yolo.py`."
    )
