"""Offline, chunked Vietnamese OCR for large video-frame datasets on Modal.

The local entrypoint only discovers files, reads bounded chunks, submits
chunk-sized Modal calls, and atomically writes JSONL results. Each Modal
container loads PaddleOCR once in the container-enter hook and then reuses the
models for many chunks.

The fast path is intentionally explicit:

    full-resolution frame
        -> PP-OCRv6 text detection
        -> perspective crop and optional crop-only upscale
        -> batched PP-OCRv6 recognition
        -> confidence filter
        -> optional PaddleOCR-VL crop fallback

Run with modal run rather than python. Source frames are never resized before
detection; PaddleOCR may still normalize tensors internally as required by its
model implementation.
"""

import asyncio
import json
import math
import os
import re
import sys
import time
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

try:
    import modal
except ModuleNotFoundError:  # Keep local utility tests independent of Modal SDK.
    modal = None  # type: ignore[assignment]


APP_NAME = "aic-vietnamese-ocr"
PADDLEPADDLE_VERSION = "3.2.1"
PADDLE_BASE_IMAGE = (
    f"paddlepaddle/paddle:{PADDLEPADDLE_VERSION}-gpu-cuda11.8-cudnn8.9"
)
PADDLEOCR_VERSION = "3.7.0"
PADDLEOCR_REQUIREMENT = f"paddleocr[doc-parser]=={PADDLEOCR_VERSION}"
PYYAML_REQUIREMENT = "PyYAML>=6.0,<7"
PYYAML_BOOTSTRAP_OPTIONS = "--ignore-installed"
OPENCV_SYSTEM_PACKAGES = (
    "libgl1",
    "libglib2.0-0",
    "libsm6",
    "libxext6",
    "libxrender1",
)

SUPPORTED_GPUS = frozenset({"T4", "L4", "A10"})
DEFAULT_GPU_TYPE = "L4"
SUPPORTED_LANGUAGES = ("vi",)
LANGUAGE = "vi"
DETECTION_MODEL_VERSION = "PP-OCRv6"
DETECTION_MODEL_NAME = os.environ.get(
    "OCR_DETECTION_MODEL", "PP-OCRv6_medium_det"
)
RECOGNITION_BACKEND = "paddleocr"
RECOGNITION_MODEL_NAME = os.environ.get(
    "OCR_RECOGNITION_MODEL", "PP-OCRv6_medium_rec"
)
MODEL_VERSION = f"{DETECTION_MODEL_NAME}+{RECOGNITION_MODEL_NAME}"
VLM_MODEL_VERSION = "PaddleOCR-VL-1.6"
PIPELINE_VERSION = "ocr-modal-ppocrv6-vi-batched-v4"

DEFAULT_BATCH_SIZE = 8
DEFAULT_CHUNK_SIZE = 512
DEFAULT_RECOGNITION_BATCH_SIZE = 128
DEFAULT_VLM_BATCH_SIZE = 1
DEFAULT_CPU_WORKERS = max(1, min(8, os.cpu_count() or 4))
DEFAULT_MAX_CONTAINERS = 8
DEFAULT_MAX_RETRIES = 2
DEFAULT_DETECTION_THRESHOLD = 0.30
DEFAULT_CONFIDENCE_THRESHOLD = 0.75
DEFAULT_MIN_CROP_HEIGHT = 32
DEFAULT_CROP_UPSCALE_FACTOR = 2.0
DEFAULT_MAX_CROP_UPSCALE = 4.0
DEFAULT_CROP_PADDING = 2
DEFAULT_MAX_CHUNK_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 128 * 1024 * 1024
MODEL_CACHE_DIR = "/root/.paddlex"
T = TypeVar("T")

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})


@dataclass(frozen=True, slots=True)
class ImageJob:
    """Compatibility value object for one bounded image payload."""

    relative_path: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class JobLoadFailure:
    """A local input failure that must not discard other frames."""

    relative_path: str
    error: str


@dataclass(frozen=True, slots=True)
class FrameRef:
    """Stable frame identity used for deterministic chunking and resume."""

    frame_id: int
    relative_path: str
    path: Path
    size_bytes: int


@dataclass(frozen=True, slots=True)
class ChunkSpec:
    """A bounded, deterministic group of frame references."""

    chunk_id: int
    frames: tuple[FrameRef, ...]


@dataclass(frozen=True, slots=True)
class CropTask:
    """One detected polygon mapped to a rectified recognition crop."""

    frame_position: int
    box_position: int
    crop: Any
    bbox: list[list[float | int]]
    detection_confidence: float
    paddle_text: str = ""
    paddle_confidence: float = 0.0


def safe_print(message: str) -> None:
    """Print without failing on a non-Unicode Windows console."""

    try:
        print(message)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        fallback = message.encode(encoding, errors="backslashreplace").decode(
            encoding
        )
        print(fallback)


def format_fps(frame_count: int, elapsed_seconds: float) -> str:
    """Format a finite frames-per-second value."""

    if frame_count <= 0 or elapsed_seconds <= 0:
        return "0.00"
    if not math.isfinite(elapsed_seconds):
        return "0.00"
    return f"{frame_count / elapsed_seconds:.2f}"


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    """Sort frame names naturally while remaining deterministic."""

    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(piece)) if piece.isdigit() else (1, piece.casefold())
        for piece in pieces
        if piece
    )


def _validate_relative_path(relative_path: str) -> str:
    """Reject absolute, traversing, and Windows-drive paths."""

    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("relative path phải là chuỗi không rỗng")
    if "\\" in relative_path:
        raise ValueError("relative path phải dùng dấu /")
    parsed = PurePosixPath(relative_path)
    if (
        parsed.is_absolute()
        or ".." in parsed.parts
        or (parsed.parts and ":" in parsed.parts[0])
    ):
        raise ValueError("relative path không được là absolute hoặc chứa ..")
    return parsed.as_posix()


def validate_gpu(gpu: str) -> str:
    """Validate the supported single-GPU Modal allocation."""

    normalized = str(gpu).upper()
    if normalized not in SUPPORTED_GPUS:
        choices = ", ".join(sorted(SUPPORTED_GPUS))
        raise ValueError(f"gpu phải là một trong {choices}; nhận được {gpu!r}")
    return normalized


def iter_images(input_dir: Path) -> tuple[Path, ...]:
    """Return supported images recursively in deterministic order."""

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
    """Select a deterministic round-robin partition for legacy callers."""

    if num_batches < 1:
        raise ValueError("num_batches phải lớn hơn 0")
    if batch_index < 0 or batch_index >= num_batches:
        raise ValueError("batch_index phải nằm trong khoảng 0..num_batches-1")
    if len(set(paths)) != len(paths):
        raise ValueError("input paths phải unique")
    return tuple(paths[batch_index::num_batches])


def validate_directory_layout(input_dir: Path, output_dir: Path) -> None:
    """Prevent output writes from modifying or nesting inside input."""

    input_root = input_dir.resolve()
    output_root = output_dir.resolve()
    if output_root == input_root or input_root in output_root.parents:
        raise ValueError(
            "output_dir không được trùng hoặc nằm bên trong input_dir; "
            "hãy dùng một folder output riêng"
        )


def ocr_path_for(input_dir: Path, output_dir: Path, image_path: Path) -> Path:
    """Map one input frame to a stable per-frame JSON path for compatibility."""

    relative_path = _validate_relative_path(
        image_path.relative_to(input_dir).as_posix()
    )
    return (output_dir / PurePosixPath(relative_path)).with_suffix(".json")


def ocr_file_exists(result_path: Path) -> bool:
    """Return whether an atomic result path is non-empty."""

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


def validate_options(
    *,
    batch_size: int,
    max_retries: int = DEFAULT_MAX_RETRIES,
    max_images: int = 0,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    recognition_batch_size: int = DEFAULT_RECOGNITION_BATCH_SIZE,
    gpu: str = DEFAULT_GPU_TYPE,
    cpu_workers: int = DEFAULT_CPU_WORKERS,
    max_containers: int = DEFAULT_MAX_CONTAINERS,
    benchmark_frames: int = 0,
) -> None:
    """Validate local controls before a Modal request is made."""

    if not 1 <= batch_size <= 256:
        raise ValueError("batch_size phải nằm trong khoảng 1..256")
    if not 1 <= chunk_size <= 10_000:
        raise ValueError("chunk_size phải nằm trong khoảng 1..10000")
    if not 1 <= recognition_batch_size <= 2048:
        raise ValueError("recognition_batch_size phải nằm trong khoảng 1..2048")
    if not 0 <= max_retries <= 10:
        raise ValueError("max_retries phải nằm trong khoảng 0..10")
    if max_images < 0:
        raise ValueError("max_images không được âm; dùng 0 để xử lý toàn bộ")
    if benchmark_frames < 0:
        raise ValueError("benchmark_frames không được âm")
    if cpu_workers < 1 or cpu_workers > 64:
        raise ValueError("cpu_workers phải nằm trong khoảng 1..64")
    if max_containers < 1 or max_containers > 256:
        raise ValueError("max_containers phải nằm trong khoảng 1..256")
    validate_gpu(gpu)


def normalize_text(value: str) -> str:
    """Normalize Vietnamese Unicode and collapse OCR whitespace."""

    return " ".join(unicodedata.normalize("NFC", value).split())


def _to_builtin(value: Any) -> Any:
    """Convert numpy arrays/scalars and Paddle result objects to JSON values."""

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


def _result_payload(raw_result: Any) -> Mapping[str, Any]:
    """Read the current PaddleOCR Result.json shape."""

    payload = getattr(raw_result, "json", raw_result)
    if callable(payload):
        payload = payload()
    payload = _to_builtin(payload)
    if not isinstance(payload, Mapping):
        raise TypeError("PaddleOCR result phải là object")
    result = payload.get("res", payload)
    if not isinstance(result, Mapping):
        raise TypeError("PaddleOCR result.res phải là object")
    return result


def extract_recognition_result(raw_result: Any) -> tuple[str, float]:
    """Extract recognizer text and score without losing Vietnamese Unicode."""

    result = _result_payload(raw_result)
    raw_text = result.get("rec_text", "")
    text = "" if raw_text is None else str(raw_text)
    raw_score = result.get("rec_score", 0.0)
    try:
        score = float(raw_score)
    except (TypeError, ValueError):
        score = 0.0
    if not math.isfinite(score):
        score = 0.0
    return normalize_text(text), min(1.0, max(0.0, score))


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


def extract_detection_result(
    raw_result: Any,
) -> tuple[list[list[list[float | int]]], list[float]]:
    """Extract detection polygons and scores from a Paddle Result object."""

    result = _result_payload(raw_result)
    raw_polys = _to_builtin(result.get("dt_polys", []))
    raw_scores = _to_builtin(result.get("dt_scores", []))
    if not isinstance(raw_polys, list):
        raw_polys = []
    if not isinstance(raw_scores, list):
        raw_scores = []
    polygons: list[list[list[float | int]]] = []
    scores: list[float] = []
    for index, polygon in enumerate(raw_polys):
        if not _valid_polygon(polygon):
            continue
        raw_score = raw_scores[index] if index < len(raw_scores) else 0.0
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            score = 0.0
        if not math.isfinite(score):
            score = 0.0
        polygons.append(polygon)
        scores.append(min(1.0, max(0.0, score)))
    ordered = sorted(
        zip(polygons, scores),
        key=lambda item: (
            min(float(point[1]) for point in item[0]),
            min(float(point[0]) for point in item[0]),
        ),
    )
    return [item[0] for item in ordered], [item[1] for item in ordered]


def assemble_recognition_result(
    detection_result: Mapping[str, Any],
    recognized_texts: Sequence[str],
    recognition_scores: Sequence[float],
) -> dict[str, Any]:
    """Combine detection polygons with recognizer outputs."""

    result = detection_result.get("res", detection_result)
    if not isinstance(result, Mapping):
        raise TypeError("Paddle text detection result phải là object")
    polygons = _to_builtin(result.get("dt_polys", []))
    if not isinstance(polygons, list):
        polygons = []
    if len(polygons) != len(recognized_texts):
        raise ValueError("Số polygon và text recognizer không khớp")
    if len(polygons) != len(recognition_scores):
        raise ValueError("Số polygon và score recognizer không khớp")
    return {
        "dt_polys": polygons,
        "rec_texts": [normalize_text(str(text)) for text in recognized_texts],
        "rec_scores": [
            min(1.0, max(0.0, float(score))) for score in recognition_scores
        ],
    }


def _decode_image_preserving_resolution(payload: bytes) -> Any:
    """Decode an input image without thumbnailing or resampling the frame."""

    import numpy as np
    from PIL import Image

    with Image.open(BytesIO(payload)) as image:
        image.load()
        return np.array(image.convert("RGB"), copy=True)


def _ordered_quad(points: Any) -> Any:
    """Normalize a quadrilateral to top-left, top-right, bottom-right, bottom-left."""

    import numpy as np

    values = np.asarray(points, dtype=np.float32)
    sums = values.sum(axis=1)
    differences = np.diff(values, axis=1).reshape(-1)
    return np.array(
        [
            values[np.argmin(sums)],
            values[np.argmin(differences)],
            values[np.argmax(sums)],
            values[np.argmax(differences)],
        ],
        dtype=np.float32,
    )


def _perspective_crop(
    image: Any,
    polygon: Sequence[Sequence[float | int]],
    *,
    padding: int = DEFAULT_CROP_PADDING,
) -> Any | None:
    """Rectify one detected quadrilateral without changing full-frame pixels."""

    import cv2
    import numpy as np

    if not _valid_polygon(_to_builtin(polygon)):
        return None
    points = _ordered_quad(polygon)
    top_width = float(np.linalg.norm(points[1] - points[0]))
    bottom_width = float(np.linalg.norm(points[2] - points[3]))
    left_height = float(np.linalg.norm(points[3] - points[0]))
    right_height = float(np.linalg.norm(points[2] - points[1]))
    width = max(1, round(max(top_width, bottom_width)))
    height = max(1, round(max(left_height, right_height)))
    destination = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(points, destination)
    warped = cv2.warpPerspective(
        np.asarray(image),
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    if warped.size == 0:
        return None
    if padding > 0:
        warped = cv2.copyMakeBorder(
            warped,
            padding,
            padding,
            padding,
            padding,
            cv2.BORDER_REPLICATE,
        )
    return warped


def _upscale_crop(
    crop: Any,
    *,
    min_height: int,
    scale_factor: float,
    max_scale: float,
) -> Any:
    """Upscale only a small text crop before recognition."""

    import cv2

    height, width = crop.shape[:2]
    if height <= 0 or width <= 0 or height >= min_height:
        return crop
    required_scale = min_height / float(height)
    scale = min(max_scale, max(1.0, required_scale, scale_factor))
    if scale <= 1.0:
        return crop
    return cv2.resize(
        crop,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_CUBIC,
    )


def _image_sharpness(image: Any) -> float:
    """Return a lightweight variance-of-Laplacian sharpness estimate."""

    import cv2
    import numpy as np

    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _is_cuda_oom(error: BaseException) -> bool:
    """Identify CUDA/Paddle memory failures for an actionable message."""

    message = f"{error.__class__.__name__} {error}".casefold()
    return any(
        marker in message
        for marker in (
            "out of memory",
            "cuda out of memory",
            "resource exhausted",
            "cudamalloc",
            "memory allocation",
        )
    )


def _error_text(error: BaseException) -> str:
    return str(error).strip()[:1000] or error.__class__.__name__


def _is_retryable_remote_error(error: BaseException) -> bool:
    """Classify transient errors for compatibility callers."""

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
    """Return whether a remote failure may be caused by one bad image."""

    if error is None:
        return False
    message = _error_text(error).casefold()
    return isinstance(error, (OSError, ValueError)) or any(
        marker in message
        for marker in (
            "image",
            "decode",
            "pixel",
            "pil",
            "unsupported",
            "cannot identify",
            "invalid file",
        )
    )


def build_ocr_record(
    relative_path: str, raw_result: Mapping[str, Any]
) -> dict[str, Any]:
    """Build the legacy compact record used by local result helpers."""

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
    text_parts: list[str] = []
    boxes: list[dict[str, Any]] = []
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
        "producer": "ocr:modal-ppocrv6-vi",
        "model_version": MODEL_VERSION,
        "pipeline_version": PIPELINE_VERSION,
    }


def _validate_frame_record(record: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and copy the JSONL frame contract."""

    copied = dict(record)
    frame_path = copied.get("frame_path")
    if not isinstance(frame_path, str):
        raise TypeError("frame result thiếu frame_path")
    copied["frame_path"] = _validate_relative_path(frame_path)
    frame_id = copied.get("frame_id")
    if not isinstance(frame_id, int) or frame_id < 0:
        raise ValueError("frame result có frame_id không hợp lệ")
    texts = copied.get("texts")
    if not isinstance(texts, list):
        raise TypeError("frame result thiếu texts")
    return copied


def parse_remote_result(payload: str) -> dict[str, Any]:
    """Validate either the new frame contract or the legacy compact record."""

    try:
        record = json.loads(payload)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Modal trả về JSON không hợp lệ") from error
    if not isinstance(record, dict):
        raise TypeError("Modal result phải là object")
    if "frame_path" in record:
        return _validate_frame_record(record)
    copied = dict(record)
    copied["relative_path"] = _validate_relative_path(
        copied.get("relative_path", "")
    )
    if not isinstance(copied.get("text"), str):
        raise TypeError("Modal result thiếu text")
    if not isinstance(copied.get("normalized_text"), str):
        raise TypeError("Modal result thiếu normalized_text")
    if not isinstance(copied.get("boxes"), list):
        raise TypeError("Modal result thiếu boxes")
    confidence = copied.get("confidence")
    if not isinstance(confidence, (int, float)) or not math.isfinite(
        float(confidence)
    ):
        raise ValueError("Modal result có confidence không hợp lệ")
    if not 0.0 <= float(confidence) <= 1.0:
        raise ValueError("Modal result có confidence ngoài khoảng 0..1")
    return copied


def _write_json_atomic(path: Path, record: Mapping[str, Any]) -> None:
    """Write a single JSON record atomically."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _write_jsonl_atomic(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    """Write one complete chunk atomically; partial JSONL is never resumable."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    with temporary_path.open("w", encoding="utf-8", newline="\n") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()
    temporary_path.replace(path)


def _append_jsonl(path: Path, record: Mapping[str, Any]) -> None:
    """Append one flushed JSONL record for compatibility callers."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()


def _chunk_result_path(output_dir: Path, chunk_id: int) -> Path:
    return output_dir / "chunks" / f"chunk_{chunk_id:08d}.jsonl"


def _chunk_error_path(output_dir: Path, chunk_id: int) -> Path:
    return output_dir / "errors" / f"chunk_{chunk_id:08d}.jsonl"


def _build_frame_error(
    frame_path: str,
    frame_id: int,
    stage: str,
    error: BaseException | str,
) -> dict[str, Any]:
    return {
        "frame_path": _validate_relative_path(frame_path),
        "frame_id": int(frame_id),
        "status": "error",
        "texts": [],
        "error_stage": stage,
        "error": _error_text(error)
        if isinstance(error, BaseException)
        else str(error)[:1000],
        "model_version": MODEL_VERSION,
        "pipeline_version": PIPELINE_VERSION,
    }


def _build_frame_record(
    frame: Mapping[str, Any],
    texts: Sequence[Mapping[str, Any]],
    *,
    width: int,
    height: int,
    processing_time: float,
    sharpness: float | None,
) -> dict[str, Any]:
    return {
        "frame_path": _validate_relative_path(str(frame["frame_path"])),
        "frame_id": int(frame["frame_id"]),
        "texts": list(texts),
        "width": int(width),
        "height": int(height),
        "processing_time": round(max(0.0, float(processing_time)), 6),
        "sharpness": sharpness,
        "language": LANGUAGE,
        "model_version": MODEL_VERSION,
        "pipeline_version": PIPELINE_VERSION,
    }


def _read_frame_payload(
    ref: FrameRef,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Read one frame without allowing a bad file to abort its chunk."""

    try:
        if ref.size_bytes <= 0:
            raise ValueError("file ảnh rỗng")
        if ref.size_bytes > MAX_IMAGE_BYTES:
            raise ValueError(
                f"file ảnh vượt giới hạn {MAX_IMAGE_BYTES // (1024 * 1024)} MiB"
            )
        payload = ref.path.read_bytes()
        if len(payload) != ref.size_bytes:
            raise OSError("đọc thiếu dữ liệu ảnh")
        return (
            {
                "frame_id": ref.frame_id,
                "frame_path": ref.relative_path,
                "payload": payload,
            },
            None,
        )
    except (OSError, ValueError) as error:
        return (
            None,
            _build_frame_error(ref.relative_path, ref.frame_id, "local_read", error),
        )


def _load_chunk_payload(spec: ChunkSpec, *, cpu_workers: int) -> dict[str, Any]:
    """Load only one bounded chunk with CPU concurrency."""

    with ThreadPoolExecutor(max_workers=cpu_workers) as executor:
        loaded = tuple(executor.map(_read_frame_payload, spec.frames))
    frames = [item for item, error in loaded if item is not None]
    local_errors = [error for item, error in loaded if error is not None]
    return {
        "chunk_id": spec.chunk_id,
        "frames": frames,
        "local_errors": local_errors,
    }


def _build_chunk_specs(
    input_dir: Path,
    paths: Sequence[Path],
    *,
    chunk_size: int,
    max_chunk_bytes: int,
    max_images: int,
) -> tuple[ChunkSpec, ...]:
    """Create stable frame chunks bounded by both count and file bytes."""

    if max_chunk_bytes < 1:
        raise ValueError("max_chunk_bytes phải lớn hơn 0")
    specs: list[ChunkSpec] = []
    current: list[FrameRef] = []
    current_bytes = 0
    chunk_id = 0
    for frame_id, path in enumerate(paths):
        if max_images and frame_id >= max_images:
            break
        relative_path = _validate_relative_path(
            path.relative_to(input_dir).as_posix()
        )
        try:
            size_bytes = max(0, path.stat().st_size)
        except OSError:
            size_bytes = 0
        if current and (
            len(current) >= chunk_size
            or current_bytes + size_bytes > max_chunk_bytes
        ):
            specs.append(ChunkSpec(chunk_id, tuple(current)))
            chunk_id += 1
            current = []
            current_bytes = 0
        current.append(FrameRef(frame_id, relative_path, path, size_bytes))
        current_bytes += size_bytes
    if current:
        specs.append(ChunkSpec(chunk_id, tuple(current)))
    return tuple(specs)


def read_image_job(path: Path, relative_path: str) -> ImageJob:
    """Read one bounded image payload for compatibility callers."""

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


async def _ocr_remote_window(
    worker: Any,
    jobs: Sequence[ImageJob],
    *,
    max_retries: int,
) -> tuple[
    dict[str, dict[str, Any]],
    tuple[ImageJob, ...],
    BaseException | None,
    float,
]:
    """Compatibility helper for the previous dynamic-batching worker API."""

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
                relative_path = record["relative_path"]
                expected = {job.relative_path for job in remaining}
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
        except Exception as error:  # noqa: BLE001 - SDK error types vary.
            last_error = error
            remaining = tuple(
                job for job in remaining if job.relative_path not in results
            )
            if not _is_retryable_remote_error(error):
                break
            if attempt < max_retries:
                await asyncio.sleep(2**attempt)
    return results, remaining, last_error, time.perf_counter() - started


def _extract_vlm_text(raw_result: Any) -> str:
    """Extract only transcription content from an OCR-mode VLM result."""

    result = _result_payload(raw_result)
    parsing_results = result.get("parsing_res_list", [])
    if not isinstance(parsing_results, list):
        return ""
    parts: list[str] = []
    for item in parsing_results:
        if not isinstance(item, Mapping):
            continue
        content = item.get("block_content", "")
        if isinstance(content, str):
            text = normalize_text(content)
            if text:
                parts.append(text)
    return normalize_text(" ".join(parts))


def _make_crop_task(
    frame_position: int,
    box_position: int,
    image: Any,
    polygon: list[list[float | int]],
    detection_confidence: float,
    *,
    padding: int,
    min_crop_height: int,
    crop_upscale_factor: float,
    max_crop_upscale: float,
) -> CropTask | None:
    crop = _perspective_crop(image, polygon, padding=padding)
    if crop is None:
        return None
    crop = _upscale_crop(
        crop,
        min_height=min_crop_height,
        scale_factor=crop_upscale_factor,
        max_scale=max_crop_upscale,
    )
    return CropTask(
        frame_position=frame_position,
        box_position=box_position,
        crop=crop,
        bbox=polygon,
        detection_confidence=detection_confidence,
    )


def _accepted_paddle_box(
    task: CropTask, text: str, score: float
) -> dict[str, Any]:
    return {
        "text": normalize_text(text),
        "confidence": round(float(score), 6),
        "bbox": task.bbox,
        "source": "paddle",
        "accepted": True,
        "detection_confidence": round(task.detection_confidence, 6),
    }


def _low_confidence_paddle_box(
    task: CropTask,
    text: str,
    score: float,
    *,
    error: str | None = None,
) -> dict[str, Any] | None:
    cleaned = normalize_text(text)
    if not cleaned:
        return None
    box: dict[str, Any] = {
        "text": cleaned,
        "confidence": round(float(score), 6),
        "bbox": task.bbox,
        "source": "paddle",
        "accepted": False,
        "detection_confidence": round(task.detection_confidence, 6),
    }
    if error:
        box["fallback_error"] = error[:500]
    return box


def _vlm_box(task: CropTask, text: str) -> dict[str, Any] | None:
    cleaned = normalize_text(text)
    if not cleaned:
        return None
    return {
        "text": cleaned,
        "confidence": None,
        "fast_confidence": round(task.paddle_confidence, 6),
        "bbox": task.bbox,
        "source": "vlm",
        "accepted": True,
        "detection_confidence": round(task.detection_confidence, 6),
    }


if modal is not None:
    model_cache = modal.Volume.from_name(
        "aic-paddleocr-model-cache",
        create_if_missing=True,
    )
    image = (
        modal.Image.from_registry(PADDLE_BASE_IMAGE)
        .apt_install(*OPENCV_SYSTEM_PACKAGES)
        .entrypoint([])
        .pip_install(
            PYYAML_REQUIREMENT,
            extra_options=PYYAML_BOOTSTRAP_OPTIONS,
        )
        .pip_install(
            PADDLEOCR_REQUIREMENT,
            "Pillow>=10,<13",
        )
        .env(
            {
                "PADDLE_PDX_CACHE_HOME": MODEL_CACHE_DIR,
                "PADDLE_PDX_MODEL_SOURCE": os.environ.get(
                    "PADDLE_PDX_MODEL_SOURCE", "BOS"
                ),
            }
        )
    )
    app = modal.App(APP_NAME)

    @app.cls(
        image=image,
        gpu=DEFAULT_GPU_TYPE,
        cpu=DEFAULT_CPU_WORKERS,
        memory=16_384,
        timeout=12 * 60 * 60,
        startup_timeout=30 * 60,
        scaledown_window=120,
        max_containers=DEFAULT_MAX_CONTAINERS,
        retries=DEFAULT_MAX_RETRIES,
        volumes={MODEL_CACHE_DIR: model_cache},
    )
    class OcrWorker:
        """Long-lived one-GPU worker for chunk-level Modal map calls."""

        detection_model: str = modal.parameter(default=DETECTION_MODEL_NAME)
        recognition_model: str = modal.parameter(default=RECOGNITION_MODEL_NAME)
        batch_size: int = modal.parameter(default=DEFAULT_BATCH_SIZE)
        recognition_batch_size: int = modal.parameter(
            default=DEFAULT_RECOGNITION_BATCH_SIZE
        )
        detection_threshold: str = modal.parameter(
            default=str(DEFAULT_DETECTION_THRESHOLD)
        )
        confidence_threshold: str = modal.parameter(
            default=str(DEFAULT_CONFIDENCE_THRESHOLD)
        )
        min_crop_height: int = modal.parameter(default=DEFAULT_MIN_CROP_HEIGHT)
        crop_upscale_factor: str = modal.parameter(
            default=str(DEFAULT_CROP_UPSCALE_FACTOR)
        )
        max_crop_upscale: str = modal.parameter(
            default=str(DEFAULT_MAX_CROP_UPSCALE)
        )
        cpu_workers: int = modal.parameter(default=DEFAULT_CPU_WORKERS)
        enable_vlm: bool = modal.parameter(default=False)
        vlm_batch_size: int = modal.parameter(default=DEFAULT_VLM_BATCH_SIZE)
        vlm_pipeline_version: str = modal.parameter(default="v1.6")
        engine: str = modal.parameter(default="paddle_static")
        enable_hpi: bool = modal.parameter(default=False)
        use_tensorrt: bool = modal.parameter(default=False)
        precision: str = modal.parameter(default="fp32")
        compute_sharpness: bool = modal.parameter(default=False)

        @modal.enter()
        def load_models(self) -> None:
            import paddle
            from paddleocr import TextDetection, TextRecognition

            self._paddle = paddle
            self._detection_threshold = float(self.detection_threshold)
            self._confidence_threshold = float(self.confidence_threshold)
            self._crop_upscale_factor = float(self.crop_upscale_factor)
            self._max_crop_upscale = float(self.max_crop_upscale)
            self._engine = self.engine or None
            self._executor_workers = max(1, int(self.cpu_workers))

            common_options = {
                "device": "gpu:0",
                "engine": self._engine,
                "enable_hpi": bool(self.enable_hpi),
                "use_tensorrt": bool(self.use_tensorrt),
                "precision": self.precision,
            }
            self.detector = TextDetection(
                model_name=self.detection_model,
                limit_side_len=None,
                limit_type=None,
                max_side_limit=None,
                thresh=self._detection_threshold,
                box_thresh=self._detection_threshold,
                **common_options,
            )
            self.recognizer = TextRecognition(
                model_name=self.recognition_model,
                **common_options,
            )

            self.vlm = None
            if self.enable_vlm:
                from paddleocr import PaddleOCRVL

                pipeline_version = (
                    self.vlm_pipeline_version
                    if self.vlm_pipeline_version in {"v1", "v1.5", "v1.6"}
                    else "v1.6"
                )
                self.vlm = PaddleOCRVL(
                    pipeline_version=pipeline_version,
                    device="gpu:0",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_layout_detection=False,
                    use_queues=True,
                    enable_hpi=bool(self.enable_hpi),
                    use_tensorrt=bool(self.use_tensorrt),
                    precision=self.precision,
                    temperature=0.0,
                    top_p=0.1,
                    max_new_tokens=128,
                )

            model_cache.commit()
            safe_print(
                "[models] "
                f"detector={self.detection_model} "
                f"recognizer={self.recognition_model} "
                f"language={LANGUAGE} "
                f"engine={self._engine or 'default'} "
                f"hpi={bool(self.enable_hpi)} "
                f"tensorrt={bool(self.use_tensorrt)} "
                f"precision={self.precision} "
                f"vlm={bool(self.vlm)} "
                f"paddle={paddle.__version__}"
            )

        def _synchronize_gpu(self) -> None:
            try:
                self._paddle.device.synchronize()
            except Exception:  # noqa: BLE001 - best-effort timing only.
                return

        def _predict_detection(
            self, images: Sequence[Any]
        ) -> list[Any | BaseException]:
            """Run detection as a batch and isolate non-OOM bad images."""

            if not images:
                return []
            try:
                self._synchronize_gpu()
                results = list(
                    self.detector.predict(
                        input=list(images),
                        batch_size=len(images),
                    )
                )
                self._synchronize_gpu()
                if len(results) != len(images):
                    raise RuntimeError(
                        "Paddle detector trả số kết quả không khớp số frame"
                    )
                return results
            except Exception as error:
                if _is_cuda_oom(error):
                    raise RuntimeError(
                        "CUDA OOM khi detection; giảm --batch-size "
                        f"(hiện tại {self.batch_size}) hoặc dùng GPU lớn hơn"
                    ) from error
                isolated: list[Any | BaseException] = []
                for image_item in images:
                    try:
                        isolated_result = list(
                            self.detector.predict(
                                input=[image_item],
                                batch_size=1,
                            )
                        )
                        isolated.append(isolated_result[0])
                    except Exception as isolated_error:  # noqa: BLE001
                        isolated.append(isolated_error)
                return isolated

        def _predict_recognition(
            self, tasks: Sequence[CropTask]
        ) -> list[tuple[CropTask, str, float, BaseException | None]]:
            """Recognize crops in large batches, isolating only failed batches."""

            import numpy as np

            output: list[tuple[CropTask, str, float, BaseException | None]] = []
            for start in range(0, len(tasks), int(self.recognition_batch_size)):
                task_batch = tuple(
                    tasks[start : start + int(self.recognition_batch_size)]
                )
                arrays = [np.asarray(task.crop) for task in task_batch]
                try:
                    self._synchronize_gpu()
                    results = list(
                        self.recognizer.predict(
                            input=arrays,
                            batch_size=len(arrays),
                        )
                    )
                    self._synchronize_gpu()
                    if len(results) != len(task_batch):
                        raise RuntimeError(
                            "Paddle recognizer trả số kết quả không khớp số crop"
                        )
                    for task, result in zip(task_batch, results):
                        text, score = extract_recognition_result(result)
                        output.append((task, text, score, None))
                except Exception as error:
                    if _is_cuda_oom(error):
                        raise RuntimeError(
                            "CUDA OOM khi recognition; giảm "
                            f"--recognition-batch-size (hiện tại "
                            f"{self.recognition_batch_size}) hoặc --batch-size"
                        ) from error
                    for task, array in zip(task_batch, arrays):
                        try:
                            result = next(
                                iter(
                                    self.recognizer.predict(
                                        input=[array],
                                        batch_size=1,
                                    )
                                )
                            )
                            text, score = extract_recognition_result(result)
                            output.append((task, text, score, None))
                        except Exception as isolated_error:  # noqa: BLE001
                            output.append((task, "", 0.0, isolated_error))
            return output

        def _predict_vlm(
            self, tasks: Sequence[CropTask]
        ) -> tuple[dict[tuple[int, int], str], int]:
            """Run OCR-mode VLM only on low-confidence crops."""

            if not tasks or self.vlm is None:
                return {}, 0
            import numpy as np

            texts: dict[tuple[int, int], str] = {}
            errors = 0
            batch_size = max(1, int(self.vlm_batch_size))
            for start in range(0, len(tasks), batch_size):
                task_batch = tuple(tasks[start : start + batch_size])
                try:
                    self._synchronize_gpu()
                    results = list(
                        self.vlm.predict(
                            input=[np.asarray(task.crop) for task in task_batch],
                            use_doc_orientation_classify=False,
                            use_doc_unwarping=False,
                            use_layout_detection=False,
                            prompt_label="ocr",
                            temperature=0.0,
                            top_p=0.1,
                            max_new_tokens=128,
                        )
                    )
                    self._synchronize_gpu()
                    if len(results) != len(task_batch):
                        raise RuntimeError(
                            "PaddleOCR-VL trả số kết quả không khớp số crop"
                        )
                    for task, result in zip(task_batch, results):
                        text = _extract_vlm_text(result)
                        if text:
                            texts[(task.frame_position, task.box_position)] = text
                except Exception as error:
                    if _is_cuda_oom(error):
                        raise RuntimeError(
                            "CUDA OOM khi VLM fallback; giảm "
                            f"--vlm-batch-size (hiện tại {self.vlm_batch_size}) "
                            "hoặc tắt --enable-vlm"
                        ) from error
                    errors += len(task_batch)
            return texts, errors

        def _prepare_images(
            self, frames: Sequence[Mapping[str, Any]]
        ) -> tuple[
            list[Mapping[str, Any]],
            list[Any],
            list[dict[str, Any]],
        ]:
            """Decode a micro-batch concurrently and retain per-frame errors."""

            def decode(
                frame: Mapping[str, Any],
            ) -> tuple[Any | None, BaseException | None]:
                try:
                    return _decode_image_preserving_resolution(frame["payload"]), None
                except Exception as error:  # noqa: BLE001 - PIL/OpenCV vary.
                    return None, error

            with ThreadPoolExecutor(
                max_workers=self._executor_workers
            ) as executor:
                decoded = tuple(executor.map(decode, frames))
            valid_frames: list[Mapping[str, Any]] = []
            images: list[Any] = []
            errors: list[dict[str, Any]] = []
            for frame, (image, error) in zip(frames, decoded):
                if error is not None or image is None:
                    errors.append(
                        _build_frame_error(
                            str(frame["frame_path"]),
                            int(frame["frame_id"]),
                            "decode",
                            error or "không giải mã được ảnh",
                        )
                    )
                    continue
                valid_frames.append(frame)
                images.append(image)
            return valid_frames, images, errors

        def _process_frame_batch(
            self, frames: Sequence[Mapping[str, Any]]
        ) -> tuple[list[dict[str, Any]], dict[str, int]]:
            """Detect, crop, recognize, and optionally fallback one micro-batch."""

            batch_started = time.perf_counter()
            valid_frames, images, records = self._prepare_images(frames)
            metrics = {
                "text_crops": 0,
                "vlm_fallbacks": 0,
                "vlm_errors": 0,
                "processed_frames": 0,
                "error_frames": len(records),
            }
            if not valid_frames:
                return records, metrics

            detection_results = self._predict_detection(images)
            box_results: list[list[dict[str, Any]]] = [
                [] for _ in valid_frames
            ]
            crop_inputs: list[
                tuple[int, int, Any, list[list[float | int]], float]
            ] = []
            frame_metadata: list[tuple[int, int, float | None]] = []
            failed_detection_positions: set[int] = set()

            for frame_position, (frame, image, detection) in enumerate(
                zip(valid_frames, images, detection_results)
            ):
                height, width = image.shape[:2]
                sharpness = (
                    _image_sharpness(image) if self.compute_sharpness else None
                )
                frame_metadata.append((width, height, sharpness))
                if isinstance(detection, BaseException):
                    failed_detection_positions.add(frame_position)
                    metrics["error_frames"] += 1
                    records.append(
                        _build_frame_error(
                            str(frame["frame_path"]),
                            int(frame["frame_id"]),
                            "detection",
                            detection,
                        )
                    )
                    continue
                try:
                    polygons, detection_scores = extract_detection_result(
                        detection
                    )
                except Exception as error:  # noqa: BLE001
                    failed_detection_positions.add(frame_position)
                    metrics["error_frames"] += 1
                    records.append(
                        _build_frame_error(
                            str(frame["frame_path"]),
                            int(frame["frame_id"]),
                            "detection_result",
                            error,
                        )
                    )
                    continue
                for box_position, (polygon, detection_score) in enumerate(
                    zip(polygons, detection_scores)
                ):
                    if detection_score < float(self._detection_threshold):
                        continue
                    crop_inputs.append(
                        (
                            frame_position,
                            box_position,
                            image,
                            polygon,
                            detection_score,
                        )
                    )

            def make_crop(
                item: tuple[int, int, Any, list[list[float | int]], float]
            ) -> CropTask | None:
                try:
                    return _make_crop_task(
                        item[0],
                        item[1],
                        item[2],
                        item[3],
                        item[4],
                        padding=DEFAULT_CROP_PADDING,
                        min_crop_height=int(self.min_crop_height),
                        crop_upscale_factor=self._crop_upscale_factor,
                        max_crop_upscale=self._max_crop_upscale,
                    )
                except Exception:  # noqa: BLE001 - bad crop must be isolated.
                    return None

            with ThreadPoolExecutor(
                max_workers=self._executor_workers
            ) as executor:
                crop_results = tuple(
                    executor.map(make_crop, crop_inputs)
                )
            tasks = [task for task in crop_results if task is not None]
            metrics["text_crops"] = len(tasks)

            low_confidence_tasks: list[CropTask] = []
            recognition_results = self._predict_recognition(tasks)
            for task, text, score, error in recognition_results:
                updated_task = CropTask(
                    task.frame_position,
                    task.box_position,
                    task.crop,
                    task.bbox,
                    task.detection_confidence,
                    normalize_text(text),
                    score,
                )
                if error is None and text and score >= self._confidence_threshold:
                    box_results[task.frame_position].append(
                        _accepted_paddle_box(updated_task, text, score)
                    )
                else:
                    low_confidence_tasks.append(updated_task)

            vlm_texts, vlm_errors = self._predict_vlm(low_confidence_tasks)
            metrics["vlm_fallbacks"] = (
                len(low_confidence_tasks) if self.vlm is not None else 0
            )
            metrics["vlm_errors"] = vlm_errors
            for task in low_confidence_tasks:
                key = (task.frame_position, task.box_position)
                if key in vlm_texts:
                    box = _vlm_box(task, vlm_texts[key])
                    if box is not None:
                        box_results[task.frame_position].append(box)
                        continue
                fallback_error = (
                    "VLM không trả nội dung"
                    if self.vlm is not None and not task.paddle_text
                    else None
                )
                box = _low_confidence_paddle_box(
                    task,
                    task.paddle_text,
                    task.paddle_confidence,
                    error=fallback_error,
                )
                if box is not None:
                    box_results[task.frame_position].append(box)

            for boxes in box_results:
                boxes.sort(
                    key=lambda box: (
                        min(float(point[1]) for point in box["bbox"]),
                        min(float(point[0]) for point in box["bbox"]),
                    )
                )

            elapsed = time.perf_counter() - batch_started
            per_frame_time = elapsed / max(1, len(valid_frames))
            for frame_position, (frame, image) in enumerate(
                zip(valid_frames, images)
            ):
                if frame_position in failed_detection_positions:
                    continue
                width, height, sharpness = frame_metadata[frame_position]
                records.append(
                    _build_frame_record(
                        frame,
                        box_results[frame_position],
                        width=width,
                        height=height,
                        processing_time=per_frame_time,
                        sharpness=sharpness,
                    )
                )
                metrics["processed_frames"] += 1
            return records, metrics

        @modal.method()
        def process_chunk(self, chunk_payload: Mapping[str, Any]) -> dict[str, Any]:
            """Process one chunk; internal micro-batches bound GPU/RAM usage."""

            chunk_id = int(chunk_payload.get("chunk_id", -1))
            raw_frames = chunk_payload.get("frames", [])
            raw_local_errors = chunk_payload.get("local_errors", [])
            if not isinstance(raw_frames, list):
                raise TypeError("chunk.frames phải là list")
            frames = [frame for frame in raw_frames if isinstance(frame, Mapping)]
            records: list[dict[str, Any]] = [
                dict(error)
                for error in raw_local_errors
                if isinstance(error, Mapping)
            ]
            metrics = {
                "text_crops": 0,
                "vlm_fallbacks": 0,
                "vlm_errors": 0,
                "processed_frames": 0,
                "error_frames": len(records),
            }
            started = time.perf_counter()
            self._synchronize_gpu()
            for frame_batch in chunked(frames, int(self.batch_size)):
                batch_records, batch_metrics = self._process_frame_batch(
                    frame_batch
                )
                records.extend(batch_records)
                for key, value in batch_metrics.items():
                    metrics[key] += value
            self._synchronize_gpu()
            records.sort(key=lambda record: int(record.get("frame_id", -1)))
            return {
                "chunk_id": chunk_id,
                "records": records,
                "metrics": metrics,
                "gpu_processing_time": time.perf_counter() - started,
            }

else:
    app = None
    OcrWorker: Any = None


def _validate_chunk_response(
    response: Mapping[str, Any], spec: ChunkSpec
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    """Validate a worker response before committing it to disk."""

    returned_chunk_id = response.get("chunk_id")
    if returned_chunk_id != spec.chunk_id:
        raise ValueError(
            f"Modal trả chunk_id={returned_chunk_id}, cần {spec.chunk_id}"
        )
    raw_records = response.get("records")
    if not isinstance(raw_records, list):
        raise TypeError("Modal chunk thiếu records")
    records = [_validate_frame_record(record) for record in raw_records]
    expected_paths = {frame.relative_path for frame in spec.frames}
    returned_paths = {str(record["frame_path"]) for record in records}
    if returned_paths != expected_paths:
        missing = sorted(expected_paths - returned_paths)
        extra = sorted(returned_paths - expected_paths)
        raise ValueError(f"Modal chunk lệch frame; missing={missing}, extra={extra}")
    metrics = response.get("metrics", {})
    if not isinstance(metrics, Mapping):
        metrics = {}
    return records, metrics


def _make_chunk_failure_records(
    spec: ChunkSpec, error: BaseException
) -> list[dict[str, Any]]:
    return [
        _build_frame_error(
            frame.relative_path,
            frame.frame_id,
            "modal_chunk",
            error,
        )
        for frame in spec.frames
    ]


def _metric_int(metrics: Mapping[str, Any], key: str) -> int:
    try:
        return max(0, int(metrics.get(key, 0)))
    except (TypeError, ValueError):
        return 0


async def ocr_directory(
    *,
    input_dir: Path,
    output_dir: Path,
    batch_size: int = DEFAULT_BATCH_SIZE,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    gpu: str = DEFAULT_GPU_TYPE,
    overwrite: bool = False,
    detection_model: str = DETECTION_MODEL_NAME,
    recognition_model: str = RECOGNITION_MODEL_NAME,
    recognition_batch_size: int = DEFAULT_RECOGNITION_BATCH_SIZE,
    detection_threshold: float = DEFAULT_DETECTION_THRESHOLD,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    min_crop_height: int = DEFAULT_MIN_CROP_HEIGHT,
    crop_upscale_factor: float = DEFAULT_CROP_UPSCALE_FACTOR,
    max_crop_upscale: float = DEFAULT_MAX_CROP_UPSCALE,
    enable_vlm: bool = False,
    vlm_batch_size: int = DEFAULT_VLM_BATCH_SIZE,
    vlm_pipeline_version: str = "v1.6",
    engine: str = "paddle_static",
    enable_hpi: bool = False,
    use_tensorrt: bool = False,
    precision: str = "fp32",
    cpu_workers: int = DEFAULT_CPU_WORKERS,
    max_containers: int = DEFAULT_MAX_CONTAINERS,
    max_chunk_bytes: int = DEFAULT_MAX_CHUNK_BYTES,
    compute_sharpness: bool = False,
    max_images: int = 0,
    benchmark: bool = False,
    benchmark_frames: int = 1000,
    gpu_price_per_hour: float | None = None,
    dry_run: bool = False,
) -> None:
    """Discover, submit, resume, and summarize a large OCR run."""

    normalized_gpu = validate_gpu(gpu)
    validate_options(
        batch_size=batch_size,
        max_images=max_images,
        chunk_size=chunk_size,
        recognition_batch_size=recognition_batch_size,
        gpu=normalized_gpu,
        cpu_workers=cpu_workers,
        max_containers=max_containers,
        benchmark_frames=benchmark_frames,
    )
    if detection_threshold <= 0 or detection_threshold > 1:
        raise ValueError("detection_threshold phải nằm trong khoảng 0..1")
    if confidence_threshold <= 0 or confidence_threshold > 1:
        raise ValueError("confidence_threshold phải nằm trong khoảng 0..1")
    if min_crop_height < 1:
        raise ValueError("min_crop_height phải lớn hơn 0")
    if crop_upscale_factor < 1 or max_crop_upscale < 1:
        raise ValueError("crop upscale factors phải >= 1")
    if crop_upscale_factor > max_crop_upscale:
        raise ValueError("crop_upscale_factor không được lớn hơn max_crop_upscale")
    if vlm_batch_size < 1:
        raise ValueError("vlm_batch_size phải lớn hơn 0")
    if precision not in {"fp32", "fp16"}:
        raise ValueError("precision phải là fp32 hoặc fp16")
    if gpu_price_per_hour is not None and gpu_price_per_hour < 0:
        raise ValueError("gpu_price_per_hour không được âm")
    validate_directory_layout(input_dir, output_dir)

    all_images = iter_images(input_dir)
    effective_max_images = (
        benchmark_frames if benchmark and benchmark_frames else max_images
    )
    specs = _build_chunk_specs(
        input_dir,
        all_images,
        chunk_size=chunk_size,
        max_chunk_bytes=max_chunk_bytes,
        max_images=effective_max_images,
    )
    pending_specs = tuple(
        spec
        for spec in specs
        if overwrite
        or not ocr_file_exists(_chunk_result_path(output_dir, spec.chunk_id))
    )
    skipped_frames = sum(
        len(spec.frames) for spec in specs if spec not in pending_specs
    )
    total_selected_frames = sum(len(spec.frames) for spec in specs)
    safe_print(
        "[plan] "
        f"frames={total_selected_frames} chunks={len(specs)} "
        f"pending_chunks={len(pending_specs)} skipped_frames={skipped_frames} "
        f"gpu={normalized_gpu} batch={batch_size} chunk={chunk_size} "
        f"recognition_batch={recognition_batch_size} "
        f"model={detection_model}+{recognition_model} "
        f"vlm={enable_vlm} benchmark={benchmark}"
    )
    if dry_run:
        safe_print("[dry-run] Không khởi tạo Modal và không ghi output.")
        return
    if not pending_specs:
        safe_print("[done] Không có chunk mới cần OCR.")
        return
    if OcrWorker is None:
        raise RuntimeError(
            "Thiếu Modal SDK. Cài requirements-modal.txt rồi chạy bằng "
            "modal run pipelines/feature_extraction/ocr/modal_paddleocr.py."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    aggregate = {
        "processed_frames": 0,
        "error_frames": 0,
        "text_crops": 0,
        "vlm_fallbacks": 0,
        "vlm_errors": 0,
        "gpu_processing_time": 0.0,
        "completed_chunks": 0,
        "failed_chunks": 0,
    }

    def payload_iterator() -> Iterator[dict[str, Any]]:
        for spec in pending_specs:
            yield _load_chunk_payload(spec, cpu_workers=cpu_workers)

    worker_cls = OcrWorker.with_options(
        gpu=normalized_gpu,
        max_containers=max_containers,
    )
    worker = worker_cls(
        detection_model=detection_model,
        recognition_model=recognition_model,
        batch_size=batch_size,
        recognition_batch_size=recognition_batch_size,
        detection_threshold=str(detection_threshold),
        confidence_threshold=str(confidence_threshold),
        min_crop_height=min_crop_height,
        crop_upscale_factor=str(crop_upscale_factor),
        max_crop_upscale=str(max_crop_upscale),
        cpu_workers=cpu_workers,
        enable_vlm=enable_vlm,
        vlm_batch_size=vlm_batch_size,
        vlm_pipeline_version=vlm_pipeline_version,
        engine=engine,
        enable_hpi=enable_hpi,
        use_tensorrt=use_tensorrt,
        precision=precision,
        compute_sharpness=compute_sharpness,
    )

    try:
        responses = worker.process_chunk.map.aio(
            payload_iterator(),
            order_outputs=True,
            return_exceptions=True,
        )
        completed_index = 0
        async for response in responses:
            completed_index += 1
            if completed_index > len(pending_specs):
                raise RuntimeError("Modal trả nhiều kết quả hơn số chunk đã gửi")
            spec = pending_specs[completed_index - 1]
            if isinstance(response, BaseException):
                failed_records = _make_chunk_failure_records(spec, response)
                _write_jsonl_atomic(
                    _chunk_error_path(output_dir, spec.chunk_id),
                    failed_records,
                )
                aggregate["error_frames"] += len(failed_records)
                aggregate["failed_chunks"] += 1
                safe_print(
                    "[chunk-error] "
                    f"chunk={spec.chunk_id} frames={len(spec.frames)} "
                    f"error={_error_text(response)}"
                )
                continue
            try:
                records, metrics = _validate_chunk_response(response, spec)
            except Exception as error:  # noqa: BLE001 - contract validation.
                failed_records = _make_chunk_failure_records(spec, error)
                _write_jsonl_atomic(
                    _chunk_error_path(output_dir, spec.chunk_id),
                    failed_records,
                )
                aggregate["error_frames"] += len(failed_records)
                aggregate["failed_chunks"] += 1
                safe_print(
                    "[chunk-error] "
                    f"chunk={spec.chunk_id} response validation failed: "
                    f"{_error_text(error)}"
                )
                continue

            _write_jsonl_atomic(
                _chunk_result_path(output_dir, spec.chunk_id),
                records,
            )
            aggregate["processed_frames"] += _metric_int(
                metrics, "processed_frames"
            )
            aggregate["error_frames"] += _metric_int(metrics, "error_frames")
            aggregate["text_crops"] += _metric_int(metrics, "text_crops")
            aggregate["vlm_fallbacks"] += _metric_int(
                metrics, "vlm_fallbacks"
            )
            aggregate["vlm_errors"] += _metric_int(metrics, "vlm_errors")
            try:
                aggregate["gpu_processing_time"] += float(
                    response.get("gpu_processing_time", 0.0)
                )
            except (TypeError, ValueError):
                pass
            aggregate["completed_chunks"] += 1
            elapsed = time.perf_counter() - started
            handled = aggregate["processed_frames"] + aggregate["error_frames"]
            safe_print(
                "[progress] "
                f"chunk={completed_index}/{len(pending_specs)} "
                f"processed={aggregate['processed_frames']} "
                f"errors={aggregate['error_frames']} "
                f"crops={aggregate['text_crops']} "
                f"fallbacks={aggregate['vlm_fallbacks']} "
                f"fps={format_fps(handled, elapsed)}"
            )
        if completed_index != len(pending_specs):
            raise RuntimeError(
                "Modal trả thiếu kết quả chunk: "
                f"received={completed_index} expected={len(pending_specs)}"
            )
    except Exception as error:
        raise RuntimeError(
            "Modal map thất bại trước khi hoàn tất; các chunk JSONL đã commit "
            "vẫn được giữ để resume."
        ) from error

    elapsed = time.perf_counter() - started
    handled_frames = aggregate["processed_frames"] + aggregate["error_frames"]
    gpu_seconds = aggregate["gpu_processing_time"]
    summary: dict[str, Any] = {
        "status": "completed" if aggregate["failed_chunks"] == 0 else "partial",
        "total_frames": total_selected_frames,
        "processed_frames": aggregate["processed_frames"],
        "error_frames": aggregate["error_frames"],
        "skipped_frames": skipped_frames,
        "completed_chunks": aggregate["completed_chunks"],
        "failed_chunks": aggregate["failed_chunks"],
        "total_text_crops": aggregate["text_crops"],
        "vlm_fallback_count": aggregate["vlm_fallbacks"],
        "vlm_error_count": aggregate["vlm_errors"],
        "wall_clock_seconds": round(elapsed, 6),
        "gpu_processing_seconds_approx": round(gpu_seconds, 6),
        "gpu_hours_approx": round(gpu_seconds / 3600.0, 6),
        "frames_per_second": float(
            format_fps(aggregate["processed_frames"], elapsed)
        ),
        "handled_frames_per_second": float(format_fps(handled_frames, elapsed)),
        "crops_per_second": float(format_fps(aggregate["text_crops"], elapsed)),
        "average_ocr_time_seconds": round(
            gpu_seconds / max(1, handled_frames), 6
        ),
        "gpu": normalized_gpu,
        "language": LANGUAGE,
        "detection_model": detection_model,
        "recognition_model": recognition_model,
        "vlm_enabled": enable_vlm,
        "batch_size": batch_size,
        "chunk_size": chunk_size,
        "recognition_batch_size": recognition_batch_size,
        "confidence_threshold": confidence_threshold,
        "pipeline_version": PIPELINE_VERSION,
        "benchmark": benchmark,
    }
    if gpu_price_per_hour is not None:
        estimated_cost = gpu_seconds / 3600.0 * gpu_price_per_hour
        summary["gpu_price_per_hour"] = gpu_price_per_hour
        summary["estimated_gpu_cost"] = round(estimated_cost, 6)
        summary["estimated_cost_per_100k_frames"] = round(
            estimated_cost * 100_000 / max(1, handled_frames),
            6,
        )
    _write_json_atomic(output_dir / "summary.json", summary)
    safe_print(
        "[done] "
        f"status={summary['status']} total={total_selected_frames} "
        f"processed={aggregate['processed_frames']} "
        f"errors={aggregate['error_frames']} skipped={skipped_frames} "
        f"crops={aggregate['text_crops']} "
        f"vlm_fallbacks={aggregate['vlm_fallbacks']} "
        f"wall={elapsed:.1f}s "
        f"fps={summary['handled_frames_per_second']:.2f}"
    )


if modal is not None:

    @app.local_entrypoint()
    async def main(
        input_dir: str = "frames",
        output_dir: str = "ocr",
        batch_size: int = DEFAULT_BATCH_SIZE,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        gpu: str = DEFAULT_GPU_TYPE,
        overwrite: bool = False,
        detection_model: str = DETECTION_MODEL_NAME,
        recognition_model: str = RECOGNITION_MODEL_NAME,
        recognition_batch_size: int = DEFAULT_RECOGNITION_BATCH_SIZE,
        detection_threshold: float = DEFAULT_DETECTION_THRESHOLD,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
        min_crop_height: int = DEFAULT_MIN_CROP_HEIGHT,
        crop_upscale_factor: float = DEFAULT_CROP_UPSCALE_FACTOR,
        max_crop_upscale: float = DEFAULT_MAX_CROP_UPSCALE,
        enable_vlm: bool = False,
        vlm_batch_size: int = DEFAULT_VLM_BATCH_SIZE,
        vlm_pipeline_version: str = "v1.6",
        engine: str = "paddle_static",
        enable_hpi: bool = False,
        use_tensorrt: bool = False,
        precision: str = "fp32",
        cpu_workers: int = DEFAULT_CPU_WORKERS,
        max_containers: int = DEFAULT_MAX_CONTAINERS,
        max_chunk_bytes: int = DEFAULT_MAX_CHUNK_BYTES,
        compute_sharpness: bool = False,
        max_images: int = 0,
        benchmark: bool = False,
        benchmark_frames: int = 1000,
        gpu_price_per_hour: float | None = None,
        dry_run: bool = False,
    ) -> None:
        await ocr_directory(
            input_dir=Path(input_dir),
            output_dir=Path(output_dir),
            batch_size=batch_size,
            chunk_size=chunk_size,
            gpu=gpu,
            overwrite=overwrite,
            detection_model=detection_model,
            recognition_model=recognition_model,
            recognition_batch_size=recognition_batch_size,
            detection_threshold=detection_threshold,
            confidence_threshold=confidence_threshold,
            min_crop_height=min_crop_height,
            crop_upscale_factor=crop_upscale_factor,
            max_crop_upscale=max_crop_upscale,
            enable_vlm=enable_vlm,
            vlm_batch_size=vlm_batch_size,
            vlm_pipeline_version=vlm_pipeline_version,
            engine=engine,
            enable_hpi=enable_hpi,
            use_tensorrt=use_tensorrt,
            precision=precision,
            cpu_workers=cpu_workers,
            max_containers=max_containers,
            max_chunk_bytes=max_chunk_bytes,
            compute_sharpness=compute_sharpness,
            max_images=max_images,
            benchmark=benchmark,
            benchmark_frames=benchmark_frames,
            gpu_price_per_hour=gpu_price_per_hour,
            dry_run=dry_run,
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cài Modal SDK rồi chạy bằng "
            "modal run pipelines/feature_extraction/ocr/modal_paddleocr.py."
        )
    raise SystemExit(
        "Hãy chạy file này bằng modal run "
        "pipelines/feature_extraction/ocr/modal_paddleocr.py."
    )
