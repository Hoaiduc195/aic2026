# CLIPA-v2 Visual Embeddings

This module creates visual vectors for retrieval-eligible keyframes using the
CLIPA-v2 Vision Encoder. Vectors are stored as a NumPy matrix and a Parquet
manifest, with each row mapped to the source frame's `video_id` and
`original_frame_id`.

The default model is
`hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B`. Standard output is
`float32`, 1024-dimensional, and L2-normalized for compatibility with the
query embedding service and backend pgvector. The text query encoder must use
the same checkpoint, projection, and normalization.

## Two execution options

### Local CLI

`cli.py` accepts a directory containing one `<video_id>.parquet` file per video.
Each Parquet file describes keyframes and the local image `storage_uri`/`path`:

```powershell
python -m pip install -r pipelines/requirements.txt
python -m pipelines.feature_extraction.visual_embedding.cli `
  --input-dir data/keyframe_manifests `
  --output-dir data/embeddings `
  --overwrite
```

The local CLI reads images in batches and writes `<video_id>.npy` and
`<video_id>.parquet`. Do not pass credential-bearing URIs or paths outside the
allowed layout.

### Modal GPU

`modal_clip_embedding.py` can discover a `.zip`, a directory of Parquet files,
or a directory of images organized by video:

```powershell
python -m pip install -r pipelines/feature_extraction/embedding/requirements-modal.txt
modal token new
modal run pipelines/feature_extraction/visual_embedding/modal_clip_embedding.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\data\embeddings `
  --budget-usd 30
```

`--dry-run` only scans the input. `--overwrite` rewrites existing output.
`--video-ids V001,V002` limits the run to selected videos.
`--submission-window` and `--concurrency` control the number of local work
items in flight. The Modal worker uses A10G by default, a GPU batch size of 64,
and a model cache in a volume.

## Local configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLIP_MODEL_NAME` | CLIPA checkpoint above | OpenCLIP model identifier |
| `CLIP_BATCH_SIZE` | `32` | Images per local inference batch |
| `CLIP_DEVICE` | `cuda` when available, otherwise `cpu` | Local device |

Do not change `CLIP_MODEL_NAME` while reusing an existing index. When the
checkpoint, projection, or normalization changes, recreate both the image index
and the corresponding query embeddings.

## Output contract

```text
<output-dir>/
├── <video_id>.npy       # shape (N, 1024)
└── <video_id>.parquet   # metadata in matrix row order
```

The manifest stores model/pipeline version, dimension, dtype, normalization,
storage URI, and source-frame identity. Ingestion fails closed when the matrix
does not match the row count, row indexes, dimension, or model contract.

## Verification

```powershell
python -m unittest tests.test_visual_embedding_modal tests.test_modal_clip_embedding -v
```

Utility tests do not require a GPU when using a fake Modal response. Run a small
pilot before creating the full index to verify row order and vector quality.
