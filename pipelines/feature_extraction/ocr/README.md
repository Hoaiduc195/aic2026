# Modal Vietnamese OCR with PP-OCRv6 + PP-OCRv5 Mobile

`modal_paddleocr.py` processes a local directory of image frames with
PaddleOCR text detection and lightweight PaddleOCR recognition running on a
Modal GPU. The
local process only enumerates files, uploads bounded batches, and writes
results; it does not load OCR models locally.

The default remote configuration is:

- PaddleOCR `3.7.0` `PP-OCRv6_small_det` for fast text detection;
- PaddleOCR `latin_PP-OCRv5_mobile_rec` for Latin-script recognition,
  including Vietnamese, with a 14 MB model;
- PaddlePaddle `3.2.1` with CUDA 11.8 as the inference runtime;
- OpenCV Linux runtime libraries (`libgl1`, `libglib2.0-0`, `libsm6`,
  `libxext6`, `libxrender1`);
- detector batches of eight frames and recognition batches of up to 64 crops;
- standard Paddle inference in FP32 on one long-lived T4 worker.

Set `OCR_DETECTION_MODEL=PP-OCRv6_medium_det` when accuracy is more important
than detection throughput. The default `PP-OCRv6_small_det` is chosen for the
177k-frame throughput target.

The command accepts `--input-dir` and `--output-dir`. `--max-images 0` is the
default, so omitting that option processes every supported frame, including a
dataset of approximately 177k frames.

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
remote Modal image. The model cache is kept in the Modal
Volume `aic-paddleocr-model-cache` so repeated runs do not redownload model
files.
The image first installs a wheel-based `PyYAML>=6.0,<7` with
`--ignore-installed`; this works around the distutils-installed PyYAML package
included in the PaddlePaddle base image.

The base image is pinned to PaddlePaddle `3.2.1`. It also installs the Linux
runtime libraries required by the non-headless OpenCV wheel. If an older Modal
image logs `Type of attribute: strides is not right` or
`libGL.so.1: cannot open shared object file`, rerun after the image rebuilds.

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

There is no `--max-images` flag in this full-run command, so all frames are
processed. The local process keeps only a bounded upload window in memory; it
does not load all 177k images at once.

Existing non-empty JSON result files are skipped. Use `--overwrite` only when
intentionally regenerating results. `--batch-size` is the local upload window;
the detector GPU batch remains bounded at eight and recognition is batched
separately in groups of up to 64 text crops. Progress logs include
`batch_fps` for the latest window, `fps` for end-to-end completed frames, and
`remote_fps` for remote inference time excluding local file writes.

To regenerate JSON files produced by the previous recognizer, pass `--overwrite`
or use a new output directory. To test another PaddleOCR recognition model,
set its model name before running:

```powershell
$env:OCR_RECOGNITION_MODEL = "latin_PP-OCRv5_mobile_rec"
```

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
