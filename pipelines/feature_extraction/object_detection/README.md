# Modal Object Detection

`modal_yolo.py` processes a local directory of image frames with Ultralytics
YOLO running on a Modal GPU. The local process only enumerates files, uploads
bounded windows, and writes results; the detector and PyTorch runtime never run
on the local machine.

Defaults:

- Model: `yolo26n.pt`, pretrained on COCO;
- Ultralytics headless: `8.4.104`;
- GPU: T4;
- Input: `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`, recursively;
- Output: one `.json` per frame, preserving the input directory layout.

The detector returns bounding boxes, class IDs/names, confidence, pixel
coordinates (`bbox_xyxy`), and normalized coordinates (`bbox_normalized`).
Frames with no detection are still written as successful JSON records with an
empty `detections` list.

## Setup

Install only the local Modal CLI dependency and authenticate once:

```powershell
python -m pip install -r pipelines/feature_extraction/object_detection/requirements-modal.txt
modal token new
```

The headless Ultralytics distribution, PyTorch, Pillow, and the model runtime
are installed in the remote Modal image. The headless OpenCV variant avoids
GUI dependencies such as `libGL.so.1`. Downloaded weights are kept in the Modal Volume
`aic-ultralytics-model-cache`.

## Test a small sample

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --max-images 500
```

`--max-images` limits this invocation to the first N selected frames. Omit it
for the complete dataset. `--dry-run` prints the plan without starting Modal
or creating output files.

## Process all 177k frames

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-size 64
```

The command resumes completed frames automatically. Use `--overwrite` to
recompute existing JSON files. For deterministic sharding across separate
runs, use for example:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-index 0 `
  --num-batches 4 `
  --batch-size 64
```

Run the same command with `--batch-index 1`, `2`, and `3` for the other
partitions. Each partition writes a manifest and error log in the output
directory.

## GPU and model configuration

The default is T4. Select L4 for more throughput:

```powershell
$env:OBJECT_DETECTION_MODAL_GPU = "L4"
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection
```

The default `yolo26n.pt` favors throughput. Select a larger COCO checkpoint
when accuracy matters more:

```powershell
$env:OBJECT_DETECTION_MODEL = "yolo26s.pt"
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection
```

Useful controls are `--image-size`, `--confidence-threshold`,
`--iou-threshold`, and `--max-detections`. Larger image sizes and models
increase GPU time and memory usage.

Ultralytics model licensing is AGPL-3.0; check the license requirements before
using this pipeline in a commercial product.

## Output layout

For input `L21_V001/001.jpg`, the result is
`L21_V001/001.json`. Each record contains the model configuration and a
structure like:

```json
{
  "relative_path": "L21_V001/001.jpg",
  "model": "yolo26n.pt",
  "image_width": 1920,
  "image_height": 1080,
  "num_detections": 1,
  "detections": [
    {
      "class_id": 0,
      "class_name": "person",
      "confidence": 0.91,
      "bbox_xyxy": [100.0, 80.0, 420.0, 900.0],
      "bbox_normalized": [0.052, 0.074, 0.219, 0.833]
    }
  ]
}
```

`run_batch_*.jsonl` records completed frames. `errors_batch_*.jsonl` records
local read or remote inference failures. Both are append-only logs and can be
used to audit or retry a shard.

## Local tests

The tests use fake Modal responses and do not require Modal credentials,
Ultralytics, or a GPU:

```powershell
python -m unittest tests.test_object_detection_modal -v
```
