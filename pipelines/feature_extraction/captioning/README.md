# Modal Florence-2 image captioning

This module streams local keyframes to one Modal T4 container running
`microsoft/Florence-2-base`. It generates English captions; translation is a
separate downstream feature.

The local machine owns the input and output folders. Frames are not uploaded
to a Modal Volume. A small Modal Volume is used only for the Hugging Face
model cache, so reruns do not download model weights again.

## Input and output layout

The input folder must contain one directory per video:

```text
keyframes/
├── L21_V001/
│   ├── 001.jpg
│   └── 002.jpg
└── L21_V002/
    └── 001.jpg
```

Captions preserve this layout:

```text
captioning/
└── L21_V001/
    ├── 001.txt
    └── 002.txt
```

The script also appends local progress records to
`run_batch_<index>_of_<count>.jsonl`. Existing `.txt` files are resumed
automatically, including empty files.

## Installation

From this directory, install only the local Modal CLI dependency:

```powershell
python -m pip install -r requirements-modal.txt
modal token new
```

Florence-2, PyTorch, Transformers, Accelerate, and Pillow are installed in the
remote Modal image. The model is loaded once per container and requests are
dynamic-batched on the T4.

## Three-way split

The input directory currently contains 873 video directories. The script
requires an even split and deterministically selects 291 videos per batch:

```powershell
# Member 1
modal run modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 --budget-usd 25

# Member 2: use --batch-index 1
# Member 3: use --batch-index 2
```

Use different output folders if multiple members share the same machine, or
use disjoint batch indexes as shown above. Do not run two processes writing the
same output files concurrently.

## Pilot and resume

First inspect the selected partition without starting Modal:

```powershell
modal run modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 --max-images 500 --dry-run
```

For a real pilot, omit `--dry-run` and keep `--max-images 500`. Review a
sample of the English captions before processing the full batch. The default
greedy decoding (`--num-beams 1`) is chosen for throughput; use
`--num-beams 3` only if the pilot shows a quality problem.

Rerunning the same command is safe: any existing `.txt` caption file is
skipped, including an empty file. Use `--overwrite` when intentionally
regenerating completed or empty captions.

## Cost and throughput controls

- `--budget-usd 25` leaves approximately `$5` of the `$30` credit as a safety
  reserve.
- `--batch-size 128` bounds the local in-flight request window and RAM usage;
  the remote GPU batch is fixed at 8 for T4 safety.
- `--max-new-tokens 32` is sufficient for one-sentence captions and avoids
  unnecessarily long generation.
- `--max-retries 2` retries transient network/service failures only.
- `--gpu-rate-usd-per-hour 0.5904` is an estimate used by the local guardrail;
  adjust it if Modal changes its published T4 price.

The budget guard is intentionally conservative because it uses elapsed remote
window time rather than an undocumented billing API. It stops before sending a
new window once the estimate reaches the configured budget; completed files
remain available for the next resume run.

## Tests

Run the local utility tests from `src`:

```powershell
python -m unittest tests.test_captioning_modal -v
```

The tests do not require the Modal SDK or a GPU. A real Modal pilot is still
required to validate end-to-end model loading and caption quality.
