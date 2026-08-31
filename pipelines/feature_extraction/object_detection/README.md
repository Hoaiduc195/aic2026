# YOLO Object Detection on Modal

`modal_yolo.py` scans a local frame directory, sends bounded upload windows to
Ultralytics YOLO on a Modal GPU, and writes one JSON result per image. PyTorch,
the detector, and model weights do not run on the local machine.

## Defaults

| Property | Value |
|---|---|
| Model | `yolo26n.pt`, pretrained on COCO |
| Ultralytics | Headless `8.4.104` |
| GPU | T4 |
| Input | `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp` recursively |
| Output | JSON matching the input layout |

Each detection includes a class ID/name, confidence, pixel box
`bbox_xyxy`, and normalized box `bbox_normalized`. A frame with no objects still
gets a successful record with `detections: []`.

Ultralytics model distribution uses the AGPL-3.0 license. Review the license
obligations before using this pipeline in a commercial product.

## Installation

```powershell
python -m pip install -r pipelines/feature_extraction/object_detection/requirements-modal.txt
modal token new
```

The headless runtime, PyTorch, Pillow, and weights are installed in the Modal
image. Weights are kept in the `aic-ultralytics-model-cache` volume so reruns do
not download them again. The headless OpenCV build avoids GUI dependencies such
as `libGL`.

## Run a pilot

`--dry-run` only prints the plan; it does not initialize Modal or write output:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --max-images 500 --dry-run
```

Run a real sample:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --max-images 500
```

Remove `--max-images` to process the full dataset:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-size 64
```

Completed output resumes automatically. Use `--overwrite` to recompute it.

## Sharding and tuning

Split the input deterministically across workers:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-index 0 --num-batches 4 --batch-size 64
```

Run again with indexes `1`, `2`, and `3`. Each partition has its own manifest
and error log; do not let two workers write to the same partition.

The default is T4. Choose L4 or a larger model when throughput or accuracy is
more important:

```powershell
$env:OBJECT_DETECTION_MODAL_GPU = "L4"
$env:OBJECT_DETECTION_MODEL = "yolo26s.pt"
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection
```

The `--image-size`, `--confidence-threshold`, `--iou-threshold`, and
`--max-detections` flags control the accuracy/time/memory trade-off.

## Output

For input `L21_V001/001.jpg`, the output is `L21_V001/001.json`:

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

`run_batch_*.jsonl` records completed frames, while `errors_batch_*.jsonl`
records local-read or remote-inference errors. Both are append-only logs for
auditing and shard retries.

## Verification

```powershell
python -m unittest tests.test_object_detection_modal -v
```

Tests use a fake Modal response and therefore do not require credentials,
Ultralytics, or a GPU.
