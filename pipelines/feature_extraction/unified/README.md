# Unified Feature Extraction on Modal

This pipeline processes one keyframe at a time on a Modal GPU and creates four
features together. It reduces cold starts compared with running each script
separately.

## Four features

| Feature | Default model | Output |
|---|---|---|
| English caption | Florence-2-base | `captioning/<video>/<frame>.txt` |
| Visual embedding | CLIPA ViT-H/14, 1024 dimensions | `embeddings/<video>/<frame>.npy` |
| Object detection | YOLO26n, COCO | `object_detection/<video>/<frame>.json` |
| Vietnamese OCR | PaddleOCR PP-OCRv6 | `ocr/<video>/<frame>.jsonl` |

ASR is not part of this pipeline because ASR reads the original video's audio
track rather than a keyframe image. Run it separately using
[`../asr/`](../asr/README.md).

## Installation and quick start

The local machine only needs the Modal CLI:

```powershell
python -m pip install -r pipelines/feature_extraction/unified/requirements-modal.txt
modal token new
```

Run the first partition:

```powershell
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data `
  --batch-index 0 --num-batches 3 --budget-usd 25
```

Three workers can use indexes `0`, `1`, and `2`. Do not let two workers write
to the same partition or output directory.

Use a dry-run to count pending frames and estimate cost without uploading:

```powershell
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data `
  --dry-run
```

## Resume and output

A frame is complete only when **all four output files** exist. Files are written
atomically; a partial frame is processed again on the next run. Use
`--overwrite` to deliberately rerun every frame in a partition.

```text
<data-root>/
├── captioning/<video>/<frame>.txt
├── embeddings/<video>/<frame>.npy
├── object_detection/<video>/<frame>.json
└── ocr/<video>/<frame>.jsonl
```

Inputs support `.jpg`, `.jpeg`, `.png`, `.webp`, and `.bmp` recursively.
`--max-images` limits pending frames (`0` = unlimited), `--batch-size` is the
number of frames in one local submission window, and `--max-retries` controls
retries for transient errors.

## GPU, models, and flags

The default GPU is L4 16 GB. Change the GPU or YOLO model before running:

```powershell
$env:UNIFIED_GPU = "A10G"
$env:UNIFIED_YOLO_MODEL = "yolo26s.pt"
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data
```

Main flags:

| Flag | Default | Meaning |
|---|---:|---|
| `--keyframe-dir` | `keyframes` | Input image root |
| `--data-root` | `data` | Root for the four outputs |
| `--batch-index` | `0` | Current partition |
| `--num-batches` | `1` | Total partitions |
| `--batch-size` | `8` | Frames per submission window |
| `--max-retries` | `2` | Retries per chunk |
| `--budget-usd` | `25` | Cost guardrail |
| `--max-images` | `0` | Frame limit; 0 = unlimited |
| `--overwrite` | disabled | Ignore resume state and rerun |
| `--dry-run` | disabled | Plan only |

Model names, thresholds, and output versions are centralized in
`unified/config.py`. If the model, projection, or normalization changes, update
the metadata contract and the corresponding downstream importer.

## When to use separate pipelines

Use the unified pipeline when the same keyframe set needs all four features and
you want to reduce cold starts. Use separate scripts when only one modality is
needed, retries must be independent, or each modality needs a different GPU or
model configuration.

## Verification

```powershell
python -m unittest discover -s tests -q
```

Utility tests do not require a Modal GPU. Always run a dry-run and a small pilot
before processing the full dataset.
