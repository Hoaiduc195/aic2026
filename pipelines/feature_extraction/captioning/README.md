# Florence-2 Image Captioning on Modal

This module sends local keyframes in bounded batches to a Modal GPU running
`microsoft/Florence-2-base` and writes one English caption per image. Frames are
not copied to a Modal Volume; the volume stores only the Hugging Face model
cache.

English captions are the canonical artifacts consumed by ingestion. Vietnamese
translation is an independent downstream step, and the `captioning_vi/` output
is not loaded by the canonical importer.

## Input and output

Input must contain one directory per video:

```text
keyframes/
├── L21_V001/
│   ├── 001.jpg
│   └── 002.jpg
└── L21_V002/
    └── 001.jpg
```

The output keeps the same layout:

```text
captioning/
├── L21_V001/001.txt
├── L21_V001/002.txt
└── run_batch_0_of_3.jsonl
```

JSONL is an append-only progress/error manifest. An existing `.txt` file,
including an empty file, is considered processed and skipped unless
`--overwrite` is used.

## Install and authenticate with Modal

```powershell
python -m pip install -r pipelines/feature_extraction/captioning/requirements-modal.txt
modal token new
```

Florence-2, PyTorch, Transformers, Accelerate, and Pillow are installed in the
remote image. The worker keeps the model in memory and uses dynamic batching on
T4.

## Run a pilot

Always dry-run one partition first:

```powershell
modal run pipelines/feature_extraction/captioning/modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 `
  --max-images 500 --dry-run
```

Run a real pilot by removing `--dry-run` and keeping `--max-images 500` to
inspect caption quality. After reviewing the sample, process the full dataset:

```powershell
modal run pipelines/feature_extraction/captioning/modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 `
  --budget-usd 25
```

Independent workers use `--batch-index` values from `0` through
`--num-batches - 1`. Do not let two processes write to the same output
partition. Repeating the command resumes missing files; use `--overwrite` only
when deliberately regenerating output.

## Throughput and cost tuning

- `--batch-size` is the local submission window, not a fixed GPU batch size;
- `--max-new-tokens` and `--num-beams` change generation quality and runtime;
- `--max-retries` should be used only for transient errors;
- `--budget-usd` is a remote-time estimate guardrail, not an official Modal
  invoice;
- `--gpu-rate-usd-per-hour` calibrates the estimate when GPU prices change.

Greedy decoding (`--num-beams 1`) is the default for throughput. Increase the
beam count only when a pilot shows that quality needs improvement.

## Translate into Vietnamese

Install the local translation dependency:

```powershell
python -m pip install -r pipelines/feature_extraction/captioning/requirements-translation.txt
```

The translator uses the pinned model `Helsinki-NLP/opus-mt-en-vi`, deduplicates
repeated captions before inference, preserves the English files, and resumes
Vietnamese output files:

```powershell
python -m pipelines.feature_extraction.captioning.translate_captions `
  --input-dir E:\aic2026\captioning `
  --output-dir E:\aic2026\captioning_vi `
  --batch-size 64 --device auto
```

You can split deterministic partitions with `--batch-index` and
`--num-batches`. Use `--overwrite` to translate existing output again. CUDA
is used when available; otherwise the translator runs on CPU.

## Verification

```powershell
python -m unittest tests.test_captioning_modal tests.test_translation_captions -v
```

Local tests do not require the Modal SDK or a GPU. Run a real Modal pilot to
confirm model loading, quota, and caption quality before a full run.
