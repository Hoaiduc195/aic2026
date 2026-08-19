# Visual Embedding Pipeline (CLIPA-v2 / CLIP)

This module extracts dense visual vector embeddings from Retrieval-Eligible Keyframes using CLIPA-v2 Vision Encoder (default: `hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B` with OpenCLIP) or Hugging Face CLIP.

The output consists of a dense NumPy matrix (`.npy`) containing the L2-normalized visual vectors, and a corresponding Parquet manifest matching each vector back to its source `video_id`, `original_frame_id`, and `timestamp_ms` conforming to `contracts/schemas/embedding_result/schema.json`.

## Configuration
The module can be configured via environment variables:
- `CLIP_MODEL_NAME` (default: `"hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"`)
- `CLIP_BATCH_SIZE` (default: `32`)
- `CLIP_DEVICE` (default: `"cuda"` if available, otherwise `"cpu"`)

## Usage

### 1. Run locally via standard CLI:
```bash
python -m pipelines.feature_extraction.visual_embedding.cli \
  --input-dir /path/to/keyframe_manifests \
  --output-dir /path/to/embedding_outputs \
  --overwrite
```

### 2. Run on Modal Serverless GPU (CLIPA-v2 ViT-H/14):
```bash
modal run pipelines/feature_extraction/visual_embedding/modal_clip_embedding.py \
  --input-dir /path/to/keyframe_manifests \
  --output-dir /path/to/embedding_outputs \
  --budget-usd 20 \
  --overwrite
```
