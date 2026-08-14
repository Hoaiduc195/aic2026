# Modal Vietnamese OCR

`modal_paddleocr.py` processes a local directory of image frames with
PaddleOCR running on a Modal GPU. The local process only enumerates files,
uploads bounded batches, and writes results; it does not load PaddleOCR or a
GPU model locally.

The default remote configuration is:

- PaddleOCR `3.2.0` on the official PaddlePaddle GPU image;
- PP-OCRv5 with `lang=vi`;
- `PP-OCRv5_mobile_det` and the Latin/Vietnamese recognizer;
- one long-lived T4 worker with dynamic batches of eight images.

## Input and output

Any supported image files (`jpg`, `jpeg`, `png`, `webp`, `bmp`) may be nested
under the input directory. The output preserves the relative layout and
writes one JSON result per frame:

```text
frames/
└── L21_V001/
    └── 001.jpg

ocr/
├── L21_V001/
│   └── 001.json
├── run_batch_0_of_1.jsonl
└── errors_batch_0_of_1.jsonl
```

Each result contains `relative_path`, recognized `text`, NFC-normalized
`normalized_text`, text polygons, per-box confidence, aggregate confidence,
language, model version, and pipeline version. Empty frames are successful
results with empty text and zero confidence; malformed/unreadable frames are
recorded separately in the errors JSONL.

## Installation

Install only the Modal CLI dependency in the local environment:

```powershell
python -m pip install -r pipelines/feature_extraction/ocr/requirements-modal.txt
modal token new
```

PaddlePaddle, PaddleOCR, Pillow, and the GPU runtime are installed in the
remote Modal image. The model cache is kept in the Modal Volume
`aic-paddleocr-model-cache` so repeated runs do not redownload model files.

## Run a pilot

Use `--dry-run` first. This discovers and counts files without starting a
Modal container:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500 `
  --dry-run
```

Then run the pilot:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500
```

Inspect the JSON output and Vietnamese diacritics before removing
`--max-images` for the full dataset.

## Process all frames and resume

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --batch-size 64
```

Existing non-empty JSON result files are skipped. Use `--overwrite` only when
intentionally regenerating results. `--batch-size` is the local upload window;
the remote GPU batch remains bounded at eight.

For independent runs, split the deterministic input list. Uneven partitions
are supported:

```powershell
# First worker
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr `
  --batch-index 0 --num-batches 3

# Repeat with --batch-index 1 and --batch-index 2.
```

Do not run multiple workers writing the same output directory and the same
partition at the same time.

## Select T4 or L4

The default is T4. Select L4 through the environment before invoking Modal:

```powershell
$env:OCR_MODAL_GPU = "L4"
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr
```

The GPU selection is a deployment setting because Modal binds it in the class
decorator before the local entrypoint starts.

## Tests

The tests use fake Modal responses and do not require Modal credentials,
PaddleOCR, or a GPU:

```powershell
python -m unittest tests.test_ocr_modal -v
```

The first real run should remain a small pilot. For subtitle-heavy videos,
pre-filtering unchanged frames or cropping the subtitle region will reduce
upload and inference cost substantially.
