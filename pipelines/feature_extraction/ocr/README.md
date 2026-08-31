# Vietnamese OCR on Modal

`modal_paddleocr.py` detects and recognizes text in frames using PaddleOCR on a
Modal GPU. The local machine only scans files, sends bounded batches, and
writes JSON; detection does not run locally.

## Default model/runtime

- PaddleOCR `3.7.0`;
- detector `PP-OCRv6_small_det` (switch to `PP-OCRv6_medium_det` for higher
  accuracy);
- recognizer `latin_PP-OCRv5_mobile_rec` for Latin/Vietnamese;
- PaddlePaddle `3.2.1`, CUDA 11.8, FP32 inference;
- detector batch size 8 frames and recognition batch size up to 64 crops on T4.

The model cache is stored in the Modal Volume
`aic-paddleocr-model-cache` so reruns do not download the weights again.

## Input and output

Input recursively accepts `.jpg`, `.jpeg`, `.png`, `.webp`, and `.bmp` under
the frame directory. Output keeps the relative layout and creates one JSON per
frame:

```text
frames/L21_V001/001.jpg
ocr/
├── L21_V001/001.json
├── run_batch_0_of_1.jsonl
└── errors_batch_0_of_1.jsonl
```

A record contains `relative_path`, raw text, and NFC-normalized
`normalized_text`, polygons, per-box confidence, aggregate confidence,
language, model, and pipeline version. A frame with no text still receives a
successful record with empty text and confidence `0`. File-read or inference
errors go to `errors_batch_*.jsonl`.

## Installation

```powershell
python -m pip install -r pipelines/feature_extraction/ocr/requirements-modal.txt
modal token new
```

PaddlePaddle, PaddleOCR, Pillow, and the GPU runtime are installed in the Modal
image.

## Pilot before the full dataset

A dry-run only discovers/counts inputs; it does not create a container or output:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500 --dry-run
```

Run a real pilot and check Vietnamese diacritics and the JSON:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500
```

Then remove `--max-images` to process the entire dataset:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --batch-size 64
```

`--max-images 0` means unlimited. Existing non-empty JSON files are skipped;
use `--overwrite` to regenerate them. `--batch-size` is the local upload
window, while detector and recognizer GPU batch sizes remain separately capped.

## Sharding and GPU/model selection

Independent runs use deterministic partitions:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr `
  --batch-index 0 --num-batches 3
```

Run again with indexes `1` and `2`. Do not let multiple workers write to the
same partition/output at the same time.

T4 is the default; choose L4 with:

```powershell
$env:OCR_MODAL_GPU = "L4"
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr
```

Change the recognizer or detector through environment variables before calling
Modal:

```powershell
$env:OCR_RECOGNITION_MODEL = "latin_PP-OCRv5_mobile_rec"
$env:OCR_DETECTION_MODEL = "PP-OCRv6_medium_det"
```

## Verification

```powershell
python -m unittest tests.test_ocr_modal -v
```

Tests use a fake Modal response and therefore do not require credentials,
PaddleOCR, or a GPU. Subtitle-heavy video can reduce cost by removing unchanged
frames or cropping the subtitle region before upload.
