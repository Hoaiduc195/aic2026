"""Shared configuration constants for the unified feature extraction pipeline.

All four models (Florence-2, YOLO, CLIPA-H14, PaddleOCR) are configured here
so that each model's hyperparameters are visible in one place.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Hardware
# ---------------------------------------------------------------------------

# L4 (16 GB VRAM) comfortably fits all four models (~6.3 GB combined).
# Override with UNIFIED_GPU=A10G for larger batches.
GPU_TYPE: str = os.environ.get("UNIFIED_GPU", "L4").upper()

# Shared image size constraint applied before uploading to Modal.
MAX_IMAGE_BYTES: int = 20 * 1024 * 1024  # 20 MiB per frame
MAX_WINDOW_BYTES: int = 64 * 1024 * 1024  # 64 MiB per submission window

IMAGE_EXTENSIONS: frozenset[str] = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})

# ---------------------------------------------------------------------------
# Modal batching
# ---------------------------------------------------------------------------

# Number of frames submitted to Modal per remote call.
DEFAULT_BATCH_SIZE: int = 8
MAX_BATCH_SIZE: int = 32

GPU_BATCH_WAIT_MS: int = 50
DEFAULT_MAX_RETRIES: int = 2
MAX_RETRIES: int = 5

# ---------------------------------------------------------------------------
# Florence-2 (caption)
# ---------------------------------------------------------------------------

FLORENCE2_MODEL_NAME: str = "microsoft/Florence-2-base"
FLORENCE2_CAPTION_TASK: str = "<CAPTION>"
FLORENCE2_MAX_NEW_TOKENS: int = 32
FLORENCE2_NUM_BEAMS: int = 1

# ---------------------------------------------------------------------------
# CLIPA-H14 (visual embedding)
# ---------------------------------------------------------------------------

CLIPA_MODEL_NAME: str = "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
CLIPA_MODEL_VERSION: str = "visual-embedding-clipa-v2-h14"
CLIPA_EMBEDDING_DIM: int = 1024
CLIPA_DTYPE: str = "float32"
CLIPA_NORMALIZED: bool = True
OPEN_CLIP_VERSION: str = "2.31.0"

# ---------------------------------------------------------------------------
# YOLO (object detection)
# ---------------------------------------------------------------------------

YOLO_MODEL_NAME: str = os.environ.get("UNIFIED_YOLO_MODEL", "yolo26n.pt")
ULTRALYTICS_VERSION: str = "8.4.104"
ULTRALYTICS_DISTRIBUTION: str = "ultralytics-opencv-headless"
YOLO_CONFIDENCE_THRESHOLD: float = 0.25
YOLO_IOU_THRESHOLD: float = 0.45
YOLO_IMAGE_SIZE: int = 640
YOLO_MAX_DETECTIONS: int = 100
YOLO_FP16: bool = True
YOLO_PIPELINE_VERSION: str = "object-detection-modal-v1"

# ---------------------------------------------------------------------------
# PaddleOCR (Vietnamese text recognition)
# ---------------------------------------------------------------------------

PADDLEPADDLE_VERSION: str = "3.2.1"
PADDLE_BASE_IMAGE: str = (
    f"paddlepaddle/paddle:{PADDLEPADDLE_VERSION}-gpu-cuda11.8-cudnn8.9"
)
PADDLEOCR_VERSION: str = "3.7.0"
OCR_LANGUAGE: str = "vi"
OCR_DETECTION_MODEL: str = os.environ.get("OCR_DETECTION_MODEL", "PP-OCRv6_medium_det")
OCR_RECOGNITION_MODEL: str = os.environ.get("OCR_RECOGNITION_MODEL", "PP-OCRv6_medium_rec")
OCR_RECOGNITION_BATCH_SIZE: int = 128
OCR_CONFIDENCE_THRESHOLD: float = 0.3
OCR_PIPELINE_VERSION: str = "ocr-modal-ppocrv6-vi-batched-v4"

# ---------------------------------------------------------------------------
# Output / resume
# ---------------------------------------------------------------------------

# Sub-directory names under --data-root that each feature is written to.
# These match the paths expected by pipelines/ingestion/import_refined.py.
CAPTIONING_SUBDIR: str = "captioning"
OBJECT_DETECTION_SUBDIR: str = "object_detection"
OCR_SUBDIR: str = "ocr"
EMBEDDINGS_SUBDIR: str = "embeddings"

# Pipeline producer tags written into result files for traceability.
UNIFIED_PIPELINE_VERSION: str = "unified-feature-extraction-v1"
PRODUCER_TAG: str = "unified-pipeline:modal-gpu"