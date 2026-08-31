# Video Preprocessing and Keyframes

This module provides the frame-first foundation for video retrieval. It is not a
complete solver for Textual KIS, VQA, or TRAKE; query-specific event modeling,
OCR/ASR reasoning, and multi-event ordering belong to downstream modules.

## Two-stage processing

```text
source video
  -> probe + canonical frame manifest
  -> shot detection and sparse retrieval frames
  -> embedding/index for candidate-region search
  -> event window
  -> dense decode at the original FPS
  -> exact semantic keyframe
```

### Stage 1: sparse retrieval

Each video is decoded sequentially to create a complete manifest. The sparse
sampler combines:

- shot starts/ends and duration-based anchors;
- peaks in scene change, motion, and text-region change;
- quality scores (brightness, blur, contrast, and entropy);
- dHash and optional SigLIP cosine deduplication;
- optional DINOv2 for deduplication or cluster medoids.

Quality only determines the retrieval route
`retrieval_embedding` or `temporal_only`; it does not remove frames from the
timeline. Coverage repair adds only candidates that meet the required quality.
The dense stage does not quality-filter or deduplicate, because a blurry
transition frame can still be the exact answer.

### Stage 2: dense exact-frame alignment

A sparse hit is expanded into a half-open event window
`[start_frame_id, end_frame_id)`. The workflow reopens the immutable video,
seeks to a codec keyframe, decodes every source frame, joins PTS values with the
manifest, and selects exactly one semantic frame. The selector records
component scores for auditability; externally supplied event scores take
precedence over quality, motion, and target-frame hints.

## Canonical frame identity

`original_frame_id` is a zero-based integer assigned while decoding from the
beginning of the video:

```text
first frame  -> 0
second frame -> 1
...
```

The manifest stores PTS, time base, rational FPS, timestamp, codec-keyframe
flags, quality, and change signals for every frame.
`raw_pts_timestamp_ms` preserves the original PTS. `timestamp_ms` is the
normalized timeline value: it is finite, non-negative, starts at the origin,
and never decreases. Once the identity exists, do not round timestamps to
recreate a frame ID.

Dense decoding fails closed: if seeking does not recover the complete requested
range, the workflow retries from the beginning of the stream. If frames are
still missing, it reports an error instead of returning a shifted or partial
range.

## Installation

Python `3.11+` is required. The local installation does not install torch or
FAISS, keeping smoke tests lightweight:

```powershell
python -m pip install -r pipelines/preprocessing/requirements-local.txt
```

`ffmpeg` and `ffprobe` must be available in `PATH` when probing video or running
ASR. The DINOv2 lane additionally requires `torch` and `timm`; Kaggle
requirements already include `timm`.

## Run locally

From the repository root:

```powershell
python -m pipelines.preprocessing.cli probe `
  --input-glob "data/**/*.mp4" --out outputs

python -m pipelines.preprocessing.cli frames --out outputs
python -m pipelines.preprocessing.cli shots `
  --out outputs --device cpu --no-sbd-download
python -m pipelines.preprocessing.cli extract `
  --out outputs --device cpu --no-embed
python -m pipelines.preprocessing.cli index --out outputs --device cuda
```

`--no-embed` is suitable for a CPU smoke test. FAISS indexing requires
embeddings, so production runs normally use CUDA and omit this flag. Each stage
has per-video checkpoints and writes through a temporary file followed by an
atomic replace. A readable but structurally incomplete table is rebuilt instead
of being blindly resumed.

The `all` command selects a manifest in this order:

1. `--manifest FILE`, when provided;
2. `--source-uri` or `--source-uri-file`, to explicitly probe a source;
3. an existing `outputs/videos_manifest.parquet`;
4. `--input-glob`, to create a new manifest.

Examples:

```powershell
# Reuse a valid manifest and checkpoints.
python -m pipelines.preprocessing.cli all --out outputs

# Explicitly probe the glob again.
python -m pipelines.preprocessing.cli all --out outputs --reprobe `
  --input-glob "data/**/*.mp4"

# A curated manifest always takes precedence.
python -m pipelines.preprocessing.cli all --out outputs `
  --manifest manifests/r2_videos.parquet
```

`--reprobe` applies only to `all`. Use `probe` when you only want to rebuild the
video manifest. The standalone `frames`, `shots`, `extract`, and `dense`
commands also accept `--manifest` or an explicit source URI.

## Event windows and the dense stage

After retrieval hits are available as Parquet:

```powershell
python -m pipelines.preprocessing.cli windows `
  --out outputs --hits outputs/query_hits.parquet --run-id query_001

python -m pipelines.preprocessing.cli dense `
  --out outputs `
  --windows outputs/event_windows/query_001.parquet `
  --device cpu
```

Decode one window manually:

```powershell
python -m pipelines.preprocessing.cli dense `
  --out outputs --video-id L01_V001 `
  --start-frame 140 --end-frame 156 `
  --event-window-id manual_001 --target-frame 148
```

`--end-frame` is exclusive. Event scores must be finite, keyed by
`original_frame_id`, and cover every frame in the window exactly. Batch input
with multiple windows must also include `video_id` and `event_window_id`;
positional arrays are rejected. `run_id` should be path-safe and unique for
each retrieval run.

Dense checkpoints are fingerprinted by the window, resize, target hint, event
score, frame manifest, source identity, and selector version. Use
`dense --force` to rebuild deliberately.

## Local, R2, and S3

Raw video must remain accessible because the dense stage reopens it on demand.
The manifest accepts local paths, `file://`, `r2://`, and `s3://`:

```text
D:/datasets/L01_V001.mp4
file:///D:/datasets/L01_V001.mp4
r2://bucket/raw/L01_V001.mp4
s3://bucket/raw/L01_V001.mp4
```

R2/S3 uses a seekable byte-range reader. Before reading, the reader requires
`ContentLength` and either `VersionId` or `ETag`; every subsequent range request
is pinned to that identity. If an object is replaced at the same key, refresh
the manifest and checkpoints.

You can bridge credentials from an R2 console `.env` file without loading that
file automatically:

```powershell
python -m pipelines.preprocessing.cli all `
  --source-uri r2://my-bucket/raw/L01_V001.mp4 `
  --out outputs --env-file ../r2_console/.env `
  --device cpu --no-embed --no-sbd-download
```

Alternatively, use `--source-uri-file` with one URI per line and standard AWS
credential environment variables. Credentials must not appear in a URI or a
secret CLI flag. When outputs will be uploaded to object storage, provide a
stable prefix:

```powershell
python -m pipelines.preprocessing.cli all `
  --source-uri-file sources.txt `
  --out outputs --artifact-uri-prefix r2://bucket/aic-run
```

The pipeline does not upload raw video or set a retention policy. The complete
Kaggle/R2 runbook is at
[docs/keyframe_kaggle_r2_runbook.md](../../docs/keyframe_kaggle_r2_runbook.md).

## Output layout

```text
outputs/
├── videos_manifest.parquet
├── frame_manifests/{video_id}.parquet
├── shots/{video_id}.parquet
├── retrieval_candidates/{video_id}.parquet
├── retrieval_frames/{video_id}.parquet
├── keyframes/{video_id}/{n}.webp
├── map-keyframes/{video_id}.csv
├── features/{video_id}.npy
├── metadata/{video_id}.json
├── event_windows/{run_id}.parquet
├── dense_candidates/{event_window_id}.parquet
├── semantic_keyframes/{event_window_id}.json
└── index/
    ├── keyframes.faiss
    └── keyframes_index.parquet
```

`retrieval_candidates` keeps every candidate and its route.
`retrieval_frames` keeps only frames eligible for embedding after
retrieval-only deduplication. `dense_candidates` keeps metadata/evidence for
every decoded frame; RGB data exists only temporarily in memory.
`semantic_keyframes` records the selected exact frame and selector evidence.

## Module boundaries

Included: canonical manifests, sparse sampling, quality routing,
deduplication/coverage repair, optional DINO, embedding/index input, event
windows, dense decoding, the semantic selector, and local/S3-compatible source
readers.

Not included: learned event scoring, OCR recognition, ASR transcription,
multimodal fusion, tracking/pose/object state, Textual KIS/VQA handlers, or the
TRAKE sequence parser.

## Verification

```powershell
python -m unittest discover -s tests -q
```

When changing frame identity, outputs, or checkpoint fingerprints, update the
schema in [contracts/](../../contracts/README.md) and add a regression test.
