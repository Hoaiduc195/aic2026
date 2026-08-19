"""Extract ALL features for every keyframe in a single Modal GPU run.

Replaces the five separate Modal scripts:
  - modal_florence_captioning.py   (Florence-2 caption)
  - modal_clip_embedding.py        (CLIPA-H14 visual embedding)
  - modal_yolo.py                  (YOLO object detection)
  - modal_paddleocr.py             (PaddleOCR Vietnamese OCR)

ASR (speech-to-text) is NOT included because it reads from the original
video audio track, not from keyframe images.

Example::

    modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py \
        --keyframe-dir E:/aic2026/keyframes \
        --data-root   E:/aic2026/data \
        --batch-index 0 --num-batches 3 --budget-usd 25

Batch 2: just point --keyframe-dir at the new folder; existing output
files are automatically skipped (resume-safe, idempotent).

Override GPU with:  UNIFIED_GPU=A10G modal run ...
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any

try:
    import modal
except ModuleNotFoundError:
    modal = None  # type: ignore[assignment]

from pipelines.feature_extraction.unified.config import (
    CAPTIONING_SUBDIR,
    CLIPA_EMBEDDING_DIM,
    CLIPA_MODEL_NAME,
    CLIPA_NORMALIZED,
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_RETRIES,
    EMBEDDINGS_SUBDIR,
    FLORENCE2_CAPTION_TASK,
    FLORENCE2_MAX_NEW_TOKENS,
    FLORENCE2_MODEL_NAME,
    FLORENCE2_NUM_BEAMS,
    GPU_TYPE,
    IMAGE_EXTENSIONS,
    MAX_BATCH_SIZE,
    MAX_IMAGE_BYTES,
    MAX_RETRIES,
    MAX_WINDOW_BYTES,
    OBJECT_DETECTION_SUBDIR,
    OCR_CONFIDENCE_THRESHOLD,
    OCR_LANGUAGE,
    OCR_SUBDIR,
    OPEN_CLIP_VERSION,
    PADDLE_BASE_IMAGE,
    PADDLEOCR_VERSION,
    PRODUCER_TAG,
    ULTRALYTICS_DISTRIBUTION,
    ULTRALYTICS_VERSION,
    UNIFIED_PIPELINE_VERSION,
    YOLO_CONFIDENCE_THRESHOLD,
    YOLO_FP16,
    YOLO_IMAGE_SIZE,
    YOLO_IOU_THRESHOLD,
    YOLO_MAX_DETECTIONS,
    YOLO_MODEL_NAME,
    YOLO_PIPELINE_VERSION,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def safe_print(message: str) -> None:
    """Print without crashing on non-Unicode Windows consoles."""
    try:
        print(message)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(message.encode(enc, errors="backslashreplace").decode(enc))


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(p)) if p.isdigit() else (1, p.casefold())
        for p in pieces if p
    )


def _validate_relative_path(rp: str) -> str:
    if not isinstance(rp, str) or not rp.strip():
        raise ValueError("relative_path phai la chuoi khong rong")
    if "\\" in rp:
        raise ValueError("relative_path phai dung dau /")
    parsed = PurePosixPath(rp)
    if (
        parsed.is_absolute()
        or ".." in parsed.parts
        or (parsed.parts and ":" in parsed.parts[0])
    ):
        raise ValueError("relative_path khong duoc la absolute hoac chua ..")
    if parsed.as_posix() != rp:
        raise ValueError("relative_path phai o dang chuan")
    return rp


def _write_atomic(path: Path, content: bytes | str) -> None:
    """Write a file atomically so a partial write is never treated as done."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    if isinstance(content, str):
        tmp.write_text(content, encoding="utf-8")
    else:
        tmp.write_bytes(content)
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class ImageJob:
    relative_path: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class UnifiedResult:
    """All four features for one keyframe returned from the Modal container."""
    relative_path: str
    caption: str | None = None
    embedding: list[float] | None = None
    detections: list[dict[str, Any]] | None = None
    image_width: int | None = None
    image_height: int | None = None
    ocr_lines: list[dict[str, Any]] | None = None
    error_caption: str | None = None
    error_embedding: str | None = None
    error_detection: str | None = None
    error_ocr: str | None = None
    duration_ms: float = 0.0


# ---------------------------------------------------------------------------
# Output path helpers (mirror exact paths import_refined.py expects)
# ---------------------------------------------------------------------------

def _caption_path(kf_dir: Path, dr: Path, img: Path) -> Path:
    return (dr / CAPTIONING_SUBDIR / img.relative_to(kf_dir)).with_suffix(".txt")


def _embedding_path(kf_dir: Path, dr: Path, img: Path) -> Path:
    return (dr / EMBEDDINGS_SUBDIR / img.relative_to(kf_dir)).with_suffix(".npy")


def _detection_path(kf_dir: Path, dr: Path, img: Path) -> Path:
    return (dr / OBJECT_DETECTION_SUBDIR / img.relative_to(kf_dir)).with_suffix(".json")


def _ocr_path(kf_dir: Path, dr: Path, img: Path) -> Path:
    return (dr / OCR_SUBDIR / img.relative_to(kf_dir)).with_suffix(".jsonl")


def _all_outputs_exist(kf_dir: Path, dr: Path, img: Path) -> bool:
    """A frame is considered done only when ALL four output files exist."""
    return (
        _caption_path(kf_dir, dr, img).is_file()
        and _embedding_path(kf_dir, dr, img).is_file()
        and _detection_path(kf_dir, dr, img).is_file()
        and _ocr_path(kf_dir, dr, img).is_file()
    )


# ---------------------------------------------------------------------------
# Local filesystem helpers
# ---------------------------------------------------------------------------

def iter_images(kf_dir: Path) -> tuple[Path, ...]:
    if not kf_dir.is_dir():
        raise FileNotFoundError(f"Khong tim thay keyframe dir: {kf_dir}")
    return tuple(sorted(
        (p for p in kf_dir.rglob("*") if p.is_file() and p.suffix.casefold() in IMAGE_EXTENSIONS),
        key=lambda p: _natural_key(p.relative_to(kf_dir)),
    ))


def partition_paths(
    paths: Sequence[Path], *, batch_index: int, num_batches: int
) -> tuple[Path, ...]:
    if num_batches < 1:
        raise ValueError("num_batches phai lon hon 0")
    if not 0 <= batch_index < num_batches:
        raise ValueError("batch_index phai nam trong khoang 0..num_batches-1")
    return tuple(paths[batch_index::num_batches])


def bounded_chunks(
    paths: Sequence[Path], *, max_items: int, max_bytes: int = MAX_WINDOW_BYTES
) -> Iterator[tuple[Path, ...]]:
    current: list[Path] = []
    current_bytes = 0
    for path in paths:
        try:
            size = path.stat().st_size
        except OSError:
            size = max_bytes
        if current and (len(current) >= max_items or current_bytes + size > max_bytes):
            yield tuple(current)
            current, current_bytes = [], 0
        current.append(path)
        current_bytes += size
    if current:
        yield tuple(current)


def load_jobs(kf_dir: Path, paths: Sequence[Path]) -> tuple[list[ImageJob], list[str]]:
    jobs: list[ImageJob] = []
    errors: list[str] = []
    for path in paths:
        rp = path.relative_to(kf_dir).as_posix()
        try:
            _validate_relative_path(rp)
            size = path.stat().st_size
            if size <= 0:
                raise ValueError(f"file anh rong: {rp}")
            if size > MAX_IMAGE_BYTES:
                raise ValueError(f"file anh qua lon ({size // (1024*1024)}MiB): {rp}")
            jobs.append(ImageJob(relative_path=rp, payload=path.read_bytes()))
        except (OSError, ValueError) as exc:
            errors.append(f"{rp}: {exc}")
    return jobs, errors


# ---------------------------------------------------------------------------
# Write one UnifiedResult to disk (backward-compatible with each pipeline)
# ---------------------------------------------------------------------------

def write_result(
    kf_dir: Path, dr: Path, img_path: Path, r: UnifiedResult
) -> list[str]:
    """Write up to four output files. Returns list of feature names written."""
    written: list[str] = []

    if r.caption is not None and r.error_caption is None:
        _write_atomic(_caption_path(kf_dir, dr, img_path), r.caption.rstrip() + "\n")
        written.append("caption")

    if r.embedding is not None and r.error_embedding is None:
        import numpy as np
        ep = _embedding_path(kf_dir, dr, img_path)
        ep.parent.mkdir(parents=True, exist_ok=True)
        tmp = ep.with_name(f".{ep.name}.tmp")
        np.save(str(tmp), np.array(r.embedding, dtype=np.float32))
        tmp.replace(ep)
        written.append("embedding")

    if r.detections is not None and r.error_detection is None:
        record = {
            "relative_path": r.relative_path,
            "image_width": r.image_width,
            "image_height": r.image_height,
            "detections": r.detections,
            "model_name": YOLO_MODEL_NAME,
            "pipeline_version": YOLO_PIPELINE_VERSION,
            "producer": PRODUCER_TAG,
        }
        _write_atomic(
            _detection_path(kf_dir, dr, img_path),
            json.dumps(record, ensure_ascii=False),
        )
        written.append("detection")

    if r.ocr_lines is not None and r.error_ocr is None:
        lines_str = "\n".join(
            json.dumps(line, ensure_ascii=False) for line in r.ocr_lines
        )
        _write_atomic(_ocr_path(kf_dir, dr, img_path), lines_str + ("\n" if r.ocr_lines else ""))
        written.append("ocr")

    return written


# ---------------------------------------------------------------------------
# Modal application
# ---------------------------------------------------------------------------

if modal is not None:
    APP_NAME = "aic-unified-feature-extraction"
    MODEL_CACHE_DIR = "/model_cache"

    _model_cache = modal.Volume.from_name(
        f"{APP_NAME}-model-cache", create_if_missing=True
    )

    _unified_image = (
        modal.Image.from_registry(PADDLE_BASE_IMAGE, add_python="3.11")
        .run_commands(
            "apt-get update -qq && apt-get install -y --no-install-recommends "
            "libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 && rm -rf /var/lib/apt/lists/*",
        )
        .pip_install(
            f"paddleocr[doc-parser]=={PADDLEOCR_VERSION}",
            "PyYAML>=6.0,<7",
            f"{ULTRALYTICS_DISTRIBUTION}=={ULTRALYTICS_VERSION}",
            f"open_clip_torch=={OPEN_CLIP_VERSION}",
            "transformers>=4.40",
            "timm",
            "einops",
            "sentencepiece",
            "accelerate",
            "pillow",
            "numpy<2",
        )
    )

    app = modal.App(APP_NAME)

    @app.cls(
        gpu=GPU_TYPE,
        image=_unified_image,
        volumes={MODEL_CACHE_DIR: _model_cache},
        timeout=600,
    )
    class UnifiedExtractor:
        """Modal container: loads all four models once, reuses for the entire batch."""

        @modal.enter()
        def load_models(self) -> None:
            import torch
            from transformers import AutoModelForCausalLM, AutoProcessor
            import open_clip
            from ultralytics import YOLO
            from paddleocr import PaddleOCR

            self.torch = torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if self.device == "cuda" else torch.float32

            safe_print(f"[unified] Loading models on {self.device} (GPU={GPU_TYPE})")

            # Florence-2
            self.f2_processor = AutoProcessor.from_pretrained(
                FLORENCE2_MODEL_NAME, trust_remote_code=True, cache_dir=MODEL_CACHE_DIR
            )
            self.f2_model = (
                AutoModelForCausalLM.from_pretrained(
                    FLORENCE2_MODEL_NAME,
                    torch_dtype=dtype,
                    trust_remote_code=True,
                    cache_dir=MODEL_CACHE_DIR,
                )
                .to(self.device)
                .eval()
            )

            # CLIPA-H14
            clip_model, _, clip_preprocess = open_clip.create_model_and_transforms(
                CLIPA_MODEL_NAME, cache_dir=MODEL_CACHE_DIR
            )
            self.clip_model = clip_model.to(self.device).eval()
            self.clip_preprocess = clip_preprocess

            # YOLO
            self.yolo_model = YOLO(YOLO_MODEL_NAME)
            if self.device == "cuda" and YOLO_FP16:
                self.yolo_model.model.half()

            # PaddleOCR (Vietnamese)
            self.ocr_engine = PaddleOCR(
                use_angle_cls=True,
                lang=OCR_LANGUAGE,
                show_log=False,
            )

            safe_print("[unified] All models loaded and ready.")

        @modal.method()
        def process_batch(
            self, jobs: list[dict[str, Any]]
        ) -> list[dict[str, Any]]:
            """Extract caption, embedding, detections, and OCR for a batch of frames."""
            import numpy as np
            from PIL import Image as PILImage

            results: list[dict[str, Any]] = []

            for job in jobs:
                rp: str = job["relative_path"]
                payload: bytes = job["payload"]
                t0 = time.monotonic()

                caption: str | None = None
                embedding: list[float] | None = None
                detections: list[dict[str, Any]] | None = None
                image_width: int | None = None
                image_height: int | None = None
                ocr_lines: list[dict[str, Any]] | None = None
                err_cap = err_emb = err_det = err_ocr = None

                # Decode image once
                try:
                    img = PILImage.open(BytesIO(payload)).convert("RGB")
                    image_width, image_height = img.size
                except Exception as exc:
                    results.append({"relative_path": rp, "error_caption": f"decode: {exc}"})
                    continue

                # Florence-2 caption
                try:
                    inputs = self.f2_processor(
                        text=[FLORENCE2_CAPTION_TASK],
                        images=[img],
                        return_tensors="pt",
                        padding=True,
                    )
                    moved = {
                        k: (v.to(device=self.device, dtype=self.f2_model.dtype)
                            if self.torch.is_floating_point(v) else v.to(self.device))
                        for k, v in inputs.items()
                    }
                    with self.torch.inference_mode():
                        ids = self.f2_model.generate(
                            **moved,
                            max_new_tokens=FLORENCE2_MAX_NEW_TOKENS,
                            num_beams=FLORENCE2_NUM_BEAMS,
                            do_sample=False,
                        )
                    text = self.f2_processor.batch_decode(ids, skip_special_tokens=False)[0]
                    parsed = self.f2_processor.post_process_generation(
                        text, task=FLORENCE2_CAPTION_TASK, image_size=img.size
                    )
                    caption = (parsed.get(FLORENCE2_CAPTION_TASK) or "").strip() or None
                except Exception as exc:
                    err_cap = str(exc)

                # CLIPA embedding
                try:
                    img_t = self.clip_preprocess(img).unsqueeze(0).to(self.device)
                    with self.torch.inference_mode():
                        vec = self.clip_model.encode_image(img_t)
                        if CLIPA_NORMALIZED:
                            vec = self.torch.nn.functional.normalize(vec, dim=-1)
                    embedding = vec.squeeze(0).cpu().float().tolist()
                except Exception as exc:
                    err_emb = str(exc)

                # YOLO object detection
                try:
                    yolo_out = self.yolo_model.predict(
                        img,
                        imgsz=YOLO_IMAGE_SIZE,
                        conf=YOLO_CONFIDENCE_THRESHOLD,
                        iou=YOLO_IOU_THRESHOLD,
                        max_det=YOLO_MAX_DETECTIONS,
                        half=(self.device == "cuda" and YOLO_FP16),
                        verbose=False,
                    )
                    detections = []
                    for r in yolo_out:
                        for box, conf, cls_id in zip(
                            r.boxes.xyxy.cpu().tolist(),
                            r.boxes.conf.cpu().tolist(),
                            r.boxes.cls.cpu().tolist(),
                        ):
                            x1, y1, x2, y2 = box
                            detections.append({
                                "class_id": int(cls_id),
                                "class_name": r.names[int(cls_id)],
                                "confidence": round(float(conf), 4),
                                "bbox_xyxy": [round(v, 2) for v in [x1, y1, x2, y2]],
                                "bbox_normalized": [
                                    round(x1 / image_width, 4), round(y1 / image_height, 4),
                                    round(x2 / image_width, 4), round(y2 / image_height, 4),
                                ],
                            })
                except Exception as exc:
                    err_det = str(exc)

                # PaddleOCR
                try:
                    img_np = np.array(img)
                    ocr_raw = self.ocr_engine.ocr(img_np, cls=True)
                    ocr_lines = []
                    for group in (ocr_raw or []):
                        for line in (group or []):
                            bbox_pts, (txt, conf_val) = line
                            if conf_val >= OCR_CONFIDENCE_THRESHOLD and txt.strip():
                                ocr_lines.append({
                                    "text": txt.strip(),
                                    "confidence": round(float(conf_val), 4),
                                    "bbox_points": [
                                        [round(x, 1), round(y, 1)] for x, y in bbox_pts
                                    ],
                                })
                except Exception as exc:
                    err_ocr = str(exc)

                duration_ms = round((time.monotonic() - t0) * 1000, 1)
                results.append({
                    "relative_path": rp,
                    "caption": caption,
                    "embedding": embedding,
                    "detections": detections,
                    "image_width": image_width,
                    "image_height": image_height,
                    "ocr_lines": ocr_lines,
                    "error_caption": err_cap,
                    "error_embedding": err_emb,
                    "error_detection": err_det,
                    "error_ocr": err_ocr,
                    "duration_ms": duration_ms,
                })

            return results

    # -----------------------------------------------------------------------
    # Local entrypoint
    # -----------------------------------------------------------------------

    @app.local_entrypoint()
    async def main(  # noqa: PLR0912, PLR0915
        keyframe_dir: str = "keyframes",
        data_root: str = "data",
        batch_index: int = 0,
        num_batches: int = 1,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_retries: int = DEFAULT_MAX_RETRIES,
        budget_usd: float = 25.0,
        gpu_rate_usd_per_hour: float = 1.17,  # L4 on-demand USD/h
        max_images: int = 0,
        overwrite: bool = False,
        dry_run: bool = False,
    ) -> None:
        """Discover frames, partition, submit to Modal, write four output files."""

        kf_dir = Path(keyframe_dir)
        dr = Path(data_root)

        if not 1 <= batch_size <= MAX_BATCH_SIZE:
            raise ValueError(f"batch_size phai nam trong khoang 1..{MAX_BATCH_SIZE}")

        safe_print(f"[unified] Quet keyframe dir: {kf_dir}")
        all_images = iter_images(kf_dir)
        safe_print(f"[unified] Tim thay {len(all_images):,} anh tong cong")

        my_images = partition_paths(
            all_images, batch_index=batch_index, num_batches=num_batches
        )
        safe_print(
            f"[unified] Partition {batch_index}/{num_batches}: {len(my_images):,} anh"
        )

        pending = (
            list(my_images)
            if overwrite
            else [p for p in my_images if not _all_outputs_exist(kf_dir, dr, p)]
        )
        if max_images > 0:
            pending = pending[:max_images]

        safe_print(
            f"[unified] Can xu ly: {len(pending):,} anh "
            f"(skip {len(my_images) - len(pending):,} da co du 4 output)"
        )

        if dry_run or not pending:
            safe_print("[unified] Dry run xong hoac khong co gi can xu ly.")
            return

        # Rough cost estimate
        est_hours = (len(pending) / batch_size) * 30 / 3600
        est_cost = est_hours * gpu_rate_usd_per_hour
        safe_print(f"[unified] Uoc tinh chi phi: ${est_cost:.2f} / budget ${budget_usd:.2f}")
        if est_cost > budget_usd * 1.5:
            raise RuntimeError(
                f"Uoc tinh (${est_cost:.2f}) vuot budget ${budget_usd}. "
                "Tang --budget-usd hoac giam --max-images."
            )

        extractor = UnifiedExtractor()
        total_done = total_errors = 0
        t_start = time.monotonic()

        for chunk_paths in bounded_chunks(pending, max_items=batch_size):
            jobs, load_errs = load_jobs(kf_dir, chunk_paths)
            for e in load_errs:
                safe_print(f"[load-error] {e}")
                total_errors += 1
            if not jobs:
                continue

            raw_results: list[dict[str, Any]] | None = None
            for attempt in range(max_retries + 1):
                try:
                    raw_results = await asyncio.to_thread(
                        extractor.process_batch.remote,
                        [{"relative_path": j.relative_path, "payload": j.payload} for j in jobs],
                    )
                    break
                except Exception as exc:
                    if attempt == max_retries:
                        safe_print(
                            f"[modal-error] Chunk that bai sau {max_retries} lan: {exc}"
                        )
                        total_errors += len(jobs)
                    else:
                        wait = 8 * (attempt + 1)
                        safe_print(f"[retry] {exc} -- doi {wait}s...")
                        await asyncio.sleep(wait)

            if raw_results is None:
                continue

            for raw, img_path in zip(raw_results, chunk_paths):
                result = UnifiedResult(
                    relative_path=raw.get("relative_path", ""),
                    caption=raw.get("caption"),
                    embedding=raw.get("embedding"),
                    detections=raw.get("detections"),
                    image_width=raw.get("image_width"),
                    image_height=raw.get("image_height"),
                    ocr_lines=raw.get("ocr_lines"),
                    error_caption=raw.get("error_caption"),
                    error_embedding=raw.get("error_embedding"),
                    error_detection=raw.get("error_detection"),
                    error_ocr=raw.get("error_ocr"),
                    duration_ms=raw.get("duration_ms", 0.0),
                )
                written = write_result(kf_dir, dr, img_path, result)
                failed = [
                    k for k in ("caption", "embedding", "detection", "ocr")
                    if raw.get(f"error_{k}")
                ]
                if failed:
                    safe_print(
                        f"[partial] {result.relative_path} -- loi: {failed} "
                        f"-- viet thanh cong: {written}"
                    )
                    total_errors += 1
                else:
                    total_done += 1

            elapsed = time.monotonic() - t_start
            rate = total_done / elapsed if elapsed > 0 else 0.0
            safe_print(
                f"[progress] done={total_done:,} errors={total_errors} "
                f"rate={rate:.1f} frames/s elapsed={elapsed:.0f}s"
            )

        elapsed = time.monotonic() - t_start
        safe_print(
            f"[unified] HOAN THANH. done={total_done:,} errors={total_errors} "
            f"total_time={elapsed:.1f}s"
        )


if __name__ == "__main__":
    if modal is None:
        raise SystemExit(
            "Cai Modal SDK truoc: pip install modal\n"
            "Roi chay: modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py"
        )
    raise SystemExit(
        "Hay chay bang: "
        "modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py"
    )
