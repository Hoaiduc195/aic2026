# Unified Feature Extraction Pipeline

Extract **all four features** for every keyframe in a **single Modal GPU run**,
instead of running five separate scripts.

## Features extracted per keyframe

| Feature | Model | Output file |
|---------|-------|-------------|
| Caption | Florence-2-base | `captioning/<video>/<frame>.txt` |
| Visual Embedding | CLIPA-ViT-H-14-336 (1024-dim) | `embeddings/<video>/<frame>.npy` |
| Object Detection | YOLO26n (COCO-80) | `object_detection/<video>/<frame>.json` |
| Vietnamese OCR | PaddleOCR PP-OCRv6 | `ocr/<video>/<frame>.jsonl` |

> **ASR** is NOT included (it reads from the video audio track, not keyframes).
> Run `pipelines/feature_extraction/asr` separately.

## Quick start

`ash
# Install Modal SDK (once per machine)
pip install modal
modal setup

# Process batch 0 of 3 (round-robin; 3 team members run batch 0, 1, 2)
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py \
    --keyframe-dir E:/aic2026/keyframes \
    --data-root   E:/aic2026/data \
    --batch-index 0 --num-batches 3 --budget-usd 25

# Dry run -- count pending frames and estimate cost without uploading anything
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py \
    --keyframe-dir E:/aic2026/keyframes \
    --data-root   E:/aic2026/data \
    --dry-run
`

## Batch 2 (when BTC releases new data)

Point `--keyframe-dir` at the new folder. The script automatically skips any
frame that already has all four output files, so Batch 1 is never re-processed.

`ash
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py \
    --keyframe-dir E:/aic2026/keyframes_batch2 \
    --data-root   E:/aic2026/data \
    --batch-index 0 --num-batches 3
`

## Resume safety

A frame is considered **done** only when **all four output files** exist.
Partially written frames are re-processed on the next run.

## GPU

Default: **L4** (16 GB VRAM) -- comfortably fits all four models (~6.3 GB combined).
Override: `UNIFIED_GPU=A10G modal run ...`

## CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--keyframe-dir` | `keyframes` | Directory containing keyframe `.jpg` files |
| `--data-root` | `data` | Root where output subdirs are written |
| `--batch-index` | `0` | Round-robin partition index (0-based) |
| `--num-batches` | `1` | Total number of partitions |
| `--batch-size` | `8` | Frames per Modal call |
| `--max-retries` | `2` | Retry count per chunk on Modal error |
| `--budget-usd` | `25.0` | Hard cost guard |
| `--max-images` | `0` | Limit frames processed (0 = unlimited) |
| `--overwrite` | false | Re-process frames even if output exists |
| `--dry-run` | false | Estimate without calling Modal |

## Compared to running scripts separately

| | Separate scripts | Unified pipeline |
|---|---|---|
| Scripts to run | 4 (+ ASR separately) | 1 (+ ASR separately) |
| GPU cold-starts | 4 | 1 |
| Progress view | 4 terminals | 1 terminal |
| Batch 2 support | Re-run each script | Same command, new --keyframe-dir |