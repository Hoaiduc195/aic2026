# Video preprocessing and keyframes

This package implements the two-stage keyframe foundation used by retrieval
tasks:

1. **Sparse retrieval** reduces each video to representative, indexable frames
   so a query can quickly identify likely videos and time regions.
2. **Dense temporal alignment** reopens the original video for a retrieved
   event window, decodes every source frame in that interval, and selects one
   exact semantic frame with an explainable baseline score.

This is a keyframe pipeline, not a complete Textual KIS, VQA, or TRAKE solver.
The query-specific event model, OCR/ASR reasoning, and ordered multi-event
sequence handler remain downstream responsibilities.

## Source layout

```text
preprocessing/
|-- cli.py                         # stage orchestration
|-- config.py                      # versionable parameters
|-- store.py                       # artifact paths/checkpoints
|-- video_source.py                # local/file/R2/S3 seekable inputs
|-- video_ingestion/
|   `-- probe.py                   # one row per source video
|-- shot_detection/
|   |-- shots.py                   # TransNetV2 + temporal fallback
|   `-- vendor/
|-- keyframes/
|   |-- frame_manifest.py          # one canonical row per decoded frame
|   |-- mapping.py                 # fixed-FPS compatibility mappings
|   |-- sampling.py                # temporal + signal-based sparse sampling
|   |-- quality.py                 # quality scores and routing
|   |-- dedup.py                   # retrieval-only dedup + coverage repair
|   |-- structural.py              # optional DINOv2 dedup/cluster medoids
|   |-- extractor.py               # sparse retrieval-frame extraction
|   |-- event_windows.py           # sparse hits -> dense frame intervals
|   |-- dense.py                   # exact decode + semantic-frame selector
|   `-- workflow.py                # window/dense artifacts and checkpoints
|-- embed.py                       # SigLIP image/text encoder
|-- indexer.py                     # FAISS build/search/benchmark
`-- metadata_extraction/           # reports and BTC coverage evaluation
```

## Canonical frame identity

`original_frame_id` is a zero-based identity assigned during a sequential
decode from the start of the raw video:

```text
first decoded source frame  -> original_frame_id = 0
second decoded source frame -> original_frame_id = 1
...
```

The full frame manifest is the authority for this identity. It stores codec
PTS and time base, fractional FPS, timestamps, codec-keyframe flags, quality
measurements, and lightweight change signals for every decoded frame.

`raw_pts_timestamp_ms` retains `PTS * time_base`. Canonical `timestamp_ms` is
that PTS timeline normalised to the video origin so it is finite,
non-negative, and non-decreasing; a fractional-FPS timestamp is retained only
as a diagnostic/fallback. Code must not round a timestamp back into a
submission frame when an `original_frame_id` is already available; this
matters for fractional-FPS and variable-frame-rate videos.

Dense decode seeks backward to a codec keyframe, joins decoded PTS values back
to the canonical manifest, and returns exactly the requested half-open range:

```text
[start_frame_id, end_frame_id)
```

If a seeked decode cannot recover every requested ID, it retries from stream
start. It raises an error rather than returning a partial or shifted window.

## Stage 1: sparse retrieval frames

The offline flow is:

```text
probe
  -> frames (full canonical frame manifest)
  -> shots
  -> extract retrieval candidates/frames
  -> index SigLIP embeddings in FAISS
```

Sparse sampling combines:

- duration-aware shot anchors;
- shot start/end boundaries;
- scene-change peaks;
- motion peaks;
- text-region change peaks.

The text-change signal is a cheap edge-change proxy, not OCR. DINO is an
optional post-sampling structural lane; it does not create signal peaks.

### Quality routing, not hard deletion

Brightness, blur, contrast, and entropy scores decide whether a sparse
candidate is eligible for the expensive embedding/index lane:

```text
quality passes -> quality_route = retrieval_embedding
quality fails  -> quality_route = temporal_only
```

A `temporal_only` frame is not promoted into FAISS by coverage repair, but its
canonical row remains in the full frame manifest. Dense decoding also performs
no quality deletion and no deduplication: a blurry transition frame can still
be the exact answer to a short event.

dHash and optional SigLIP cosine deduplication apply only to retrieval frames.
For stronger structural grouping, `--dino-mode dedup` performs global DINOv2
cosine deduplication, while `--dino-mode cluster_medoids` builds
cosine-connected components and keeps their deterministic medoids. Coverage
repair still adds only quality-eligible sparse candidates when compaction
would otherwise leave a configured temporal gap. DINO features are never
written into the SigLIP/FAISS retrieval index.

## Stage 2: event windows and dense alignment

Stage 1 search hits are expanded and merged into event windows. Each window
contains a `video_id` and a canonical frame interval. Stage 2 then:

```text
sparse retrieval hits
  -> event window
  -> reopen immutable raw video
  -> seek to preceding codec keyframe
  -> decode every frame in the window
  -> map each image to canonical original_frame_id
  -> score candidates
  -> write one semantic keyframe selection
```

The deterministic selector accepts optional external event scores. Its default
baseline weights external/event evidence first, then image quality, local
motion, and an optional target-frame proximity hint. It emits the component
score for every candidate so the decision can be audited.

Without external event scores, this is only a generic quality/motion baseline;
it does not understand a query such as “the instant the hand releases the
object.” A task-specific model should provide those event scores.

## Run the offline stages

From the repository root with Python 3.11+:

```bash
python -m pip install -r pipelines/preprocessing/requirements-local.txt

python -m pipelines.preprocessing.cli probe \
  --input-glob "data/**/*.mp4" --out outputs

python -m pipelines.preprocessing.cli frames --out outputs

python -m pipelines.preprocessing.cli shots \
  --out outputs --device cpu --no-sbd-download

python -m pipelines.preprocessing.cli extract \
  --out outputs --device cpu --no-embed

python -m pipelines.preprocessing.cli index --out outputs --device cuda
```

Use `--no-embed` for a CPU extraction smoke test. A FAISS index requires
embeddings, so production indexing normally uses CUDA and omits that flag.
Stages keep per-video artifacts and can resume without recomputing valid
checkpoints. Checkpoint files are written to sibling temporary files and
atomically replaced; readable-but-incomplete tables are structurally validated
and rebuilt instead of being silently resumed.

The optional DINOv2 lane requires `torch` and `timm` plus access to its
pretrained weights. Kaggle requirements include `timm`; for a local DINO run,
install those optional packages and choose one mode explicitly:

```bash
python -m pipelines.preprocessing.cli extract --out outputs --device cuda \
  --dino-mode cluster_medoids --dino-similarity-threshold 0.90
```

The `all` command resolves its video manifest in this order:

1. `--manifest FILE` imports a local table whose rows may reference local,
   R2, or S3 videos;
2. `--source-uri`/`--source-uri-file` probes those explicit local/R2/S3
   sources and creates the manifest;
3. otherwise, an existing `outputs/videos_manifest.parquet` is reused;
4. otherwise, `--input-glob` is probed to create the manifest.

This prevents a curated R2 manifest from being overwritten by a local glob.
Use `--reprobe` with `all` only when replacing the existing manifest is
intentional:

```bash
# Reuse outputs/videos_manifest.parquet and valid per-stage checkpoints.
python -m pipelines.preprocessing.cli all --out outputs

# Deliberately discard manifest reuse and scan the glob again.
python -m pipelines.preprocessing.cli all --out outputs --reprobe \
  --input-glob "data/**/*.mp4"

# Import a canonical manifest; this takes priority over reuse and --reprobe.
python -m pipelines.preprocessing.cli all --out outputs \
  --manifest manifests/r2_videos.parquet
```

Standalone `frames`, `shots`, `extract`, and `dense` also reuse the output
manifest, import one supplied with `--manifest`, or probe explicit source URIs.
The `--reprobe` behavior is specific to `all`; use the `probe` command when
only the video manifest should be rebuilt. Video IDs must be unique, path-safe
artifact IDs.

## Run event-window and dense stages

After retrieval hits have been written to Parquet, create event windows and
then decode/select their exact frames:

```bash
python -m pipelines.preprocessing.cli windows \
  --out outputs --hits outputs/query_hits.parquet --run-id query_001

python -m pipelines.preprocessing.cli dense \
  --out outputs \
  --windows outputs/event_windows/query_001.parquet \
  --device cpu
```

Use `python -m pipelines.preprocessing.cli windows --help` and `dense --help`
for window radius, merge gap, storage endpoint, external event-score, resize,
and overwrite options. To decode one window manually instead of a table:

```bash
python -m pipelines.preprocessing.cli dense \
  --out outputs --video-id L01_V001 \
  --start-frame 140 --end-frame 156 \
  --event-window-id manual_001 --target-frame 148
```

`--end-frame` is exclusive. Output `original_frame_id` values come from the
full manifest rather than timestamp rounding. An optional per-frame event model
can be supplied with `--event-scores scores.parquet`.

Event scores must cover every frame in a dense window and be keyed by
`original_frame_id`; positional arrays are rejected. A score table used for
multiple windows must also contain `video_id` and `event_window_id`, preventing
scores from one query/video being reused for another. The windows stage embeds
`run_id` in every event-window ID, and dense checkpoints carry an input
fingerprint so stale query results are rebuilt rather than silently reused.

For a multi-window run, the score table therefore has this shape:

```text
event_window_id                 video_id   original_frame_id   event_score
query_001_L01_V001_event_0000  L01_V001  140                 0.12
query_001_L01_V001_event_0000  L01_V001  141                 0.91
...                             ...        ...                 ...
```

Scores must be finite numbers. If `--event-scores` is supplied, every frame in
each half-open window must have exactly one score; missing or duplicate IDs are
rejected. A single manual window may use an unscoped two-column table, but a
batch with multiple windows requires both scope columns shown above.

Choose a distinct, path-safe `--run-id` for each retrieval run. It namespaces
generated event-window IDs and therefore their dense/semantic artifact names.
Before reusing a dense checkpoint, the workflow verifies its full frame range,
video/window IDs, and a fingerprint covering the window, resize, target hint,
event scores, frame-manifest identity, source identity, and selector version.
A mismatch rebuilds the artifact; `dense --force` always rebuilds it.

## Local and R2/S3 raw video

Raw video must remain available because Stage 2 reopens it on demand. A video
manifest row may point to a local `path` or a credential-free `storage_uri`:

```text
D:/datasets/L01_V001.mp4
file:///D:/datasets/L01_V001.mp4
r2://bucket/raw/L01_V001.mp4
s3://bucket/raw/L01_V001.mp4
```

Local files are opened directly. R2/S3 objects use a seekable, cached byte-range
reader through an S3-compatible client. Programmatic callers can inject that
client; the CLI uses boto3's normal environment/profile/instance-role credential
chain together with `--r2-endpoint-url` or the corresponding S3 endpoint flags.
The reader first performs
`HeadObject` and requires both `ContentLength` and at least one immutable object
identity: `VersionId` or `ETag`. Each subsequent range request is pinned with
that `VersionId`, or with `If-Match: ETag` when no version ID exists.

The `.env` format used by the companion R2 console is supported explicitly;
it is never loaded implicitly. `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` are bridged in memory to boto3's credential chain, and
`R2_ACCOUNT_ID` derives the standard Cloudflare endpoint:

```bash
python -m pipelines.preprocessing.cli all \
  --source-uri r2://my-bucket/raw/L01_V001.mp4 \
  --out outputs --env-file ../r2_console/.env \
  --device cpu --no-embed --no-sbd-download
```

Repeat `--source-uri` for several objects, or pass
`--source-uri-file sources.txt` with one URI per line. Remote probing reads
container metadata through the same range reader and creates the canonical
manifest automatically; it does not download the whole object first. For an
embedding/index production run, use a CUDA device and omit `--no-embed`.

Alternatively, export standard `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` variables and pass `--r2-endpoint-url`. Credentials
must never appear inside `r2://` URIs or command-line secret flags.

Every response must report the exact requested HTTP `Content-Range` and byte
count. A reported ETag change, a missing/mismatched range, or an object with
neither `VersionId` nor `ETag` fails the decode instead of mixing bytes from
different object revisions. Credentials are configuration, never part of the
URI or generated artifacts. The pipeline does not upload or enforce retention of raw
videos; deployment must keep each referenced object immutable and accessible
for later dense decode.

For remote videos, keep `size_bytes` plus `etag` and/or `version_id` in the
canonical video manifest. Every frame, shot, extraction, and dense open
verifies and pins that declared identity. If those fields are initially
missing, the full-frame stage writes its observed remote identity and exact
byte/frame counts back to the manifest, then pins the decode to that same
revision. If an object is intentionally replaced at the same URI, refresh the
manifest metadata or run the affected stages with fresh checkpoints.

When outputs will be uploaded to object storage, pass a stable prefix such as
`--artifact-uri-prefix r2://bucket/aic-run`. Retrieval-frame Parquet then
records that durable URI instead of a temporary local `file://` location; the
deployment/upload job remains responsible for copying the files there.

Programmatic dense decoding can pass remote options explicitly:

```python
frames = decode_window(
    "r2://aic-raw/L01_V001.mp4",
    "outputs/frame_manifests/L01_V001.parquet",
    140,
    156,
    source_options={
        "client": r2_client,
        "expected_etag": manifest_etag,
        "expected_version_id": manifest_version_id,
    },
)
```

## Outputs

```text
outputs/
|-- videos_manifest.parquet
|-- frame_manifests/{video_id}.parquet
|-- shots/{video_id}.parquet
|-- retrieval_candidates/{video_id}.parquet
|-- retrieval_frames/{video_id}.parquet
|-- keyframes/{video_id}/{n}.webp
|-- map-keyframes/{video_id}.csv
|-- features/{video_id}.npy
|-- metadata/{video_id}.json
|-- event_windows/{run_id}.parquet
|-- dense_candidates/{event_window_id}.parquet
|-- semantic_keyframes/{event_window_id}.json
`-- index/
    |-- keyframes.faiss
    `-- keyframes_index.parquet
```

`retrieval_candidates` records every sampled candidate and its route.
`retrieval_frames` contains only frames eligible for embedding and selected
after retrieval-only deduplication. `dense_candidates` contains image-free
metadata and evidence for every decoded frame in an event window; RGB arrays
remain transient. `semantic_keyframes` records the chosen exact frame and the
selector evidence. `map-keyframes` is retained for older organizer tooling.

## Scope boundaries

Implemented in the keyframe package:

- full source-frame manifest and PTS-aware exact identity;
- sparse temporal, boundary, motion, scene-change, and text-change sampling;
- quality routing without timeline deletion;
- retrieval-only deduplication and coverage repair;
- optional DINOv2 global structural deduplication and cluster-medoid routing;
- sparse embeddings/index inputs;
- event-window construction;
- dense original-FPS window decoding;
- deterministic semantic-frame selection and serializers;
- local and S3-compatible/R2 source access.

Outside the keyframe package:

- the learned/query-specific event scorer used to improve semantic alignment;
- OCR text recognition (the current text-change score is not OCR);
- ASR transcription and multimodal evidence fusion;
- tracking, pose, and object-state models;
- Textual KIS/VQA answer handlers;
- TRAKE multi-event parsing and DP/Viterbi sequence ordering.

The keyframe module supplies exact frame candidates to those systems; it does
not by itself make any of those tasks end-to-end complete.
