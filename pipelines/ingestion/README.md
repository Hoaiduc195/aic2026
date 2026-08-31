# Refined Artifact Ingestion

`import_refined.py` bridges normalized frame-first artifacts and the PostgreSQL
schema in [`apps/backend/sql/`](../../apps/backend/sql/). The importer does not
run feature extraction; it validates identity and provenance first, then
upserts data in a transaction so the operation can be resumed safely.

The identity flow is preserved:

```text
video -> canonical frame -> frame_alias (keyframe occurrence) -> evidence
```

Visual embedding matrices are read from local storage and written directly to
`clip_embeddings.embedding` (`vector(1024)`). The local workflow does not need
to upload embeddings to R2. Vietnamese OCR is normalized into rows with polygons
and mapped through `(video_id, keyframe_no)`.

## Dependencies

```powershell
python -m pip install -r pipelines/ingestion/requirements.txt
```

Backend migrations must be applied first. PostgreSQL requires the `vector` and
`pg_trgm` extensions from the backend schema.

## Input contract

`--data-root` defaults to `data/refined`. The complete artifact set is:

```text
<data-root>/
├── videos_manifest.parquet
├── canonical_frame_candidates.parquet
├── frame_aliases.parquet
├── captions_en.parquet
├── ocr.parquet
├── asr_spans.parquet
├── objects.parquet
├── object_frame_manifest.parquet
├── embedding_index.parquet
└── embeddings/<video_id>.npy
```

Captions must be in English (`en`), OCR in Vietnamese (`vi`), ASR must use
half-open intervals `[start_ms, end_ms)`, and embeddings must be an
L2-normalized `float32` matrix with exactly 1024 dimensions.
`embedding_index.parquet` must match the row indexes in the `.npy` matrix and
the canonical mapping.

To rebuild a normalized OCR artifact from source JSONL:

```powershell
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.ocr_refined `
  --input D:\data\refined\ocr_source.jsonl `
  --output D:\data\refined\ocr.parquet
```

## Dry-run and import

Always validate in read-only mode first:

```powershell
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --dry-run
```

After backend migrations are complete, run the real import:

```powershell
$env:DATABASE_URL = 'postgresql://aic:<password>@127.0.0.1:5433/aic_local'
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --database-url $env:DATABASE_URL `
  --index-version aic2026-local-v1
```

The command accepts repeated `--video-id` values to import a subset,
`--limit-videos` to test a smaller portion, and `--batch-size` to control
memory use. Modalities can be skipped with `--skip-captions`,
`--skip-ocr`, `--skip-asr`, `--skip-objects`, or `--skip-embeddings`; use these
only when the dataset genuinely lacks the corresponding artifact.

The importer is idempotent. It creates an `index_release` in `staged` status,
does not activate the release automatically, and does not create a fake
text-encoder revision. When query-encoder metadata is correct, provide:

```powershell
--text-encoder-name <checkpoint-name> `
--text-encoder-revision <immutable-revision>
```

After the import finishes, build indexes and verify from `apps/backend`:

```powershell
Set-Location apps/backend
npm run db:build-indexes
npm run db:verify
```

Do not build HNSW/GIN/trigram indexes during a large bulk import. Create them
after the data-writing phase to reduce runtime and avoid a half-complete
release.

## Fail-closed validation

Before opening a transaction, the importer checks:

- unique video IDs, valid durations, and non-duplicated canonical frames;
- aliases that point to the correct canonical frame, with unique
  thumbnail/storage identities;
- every feature row points to an existing alias;
- ASR intervals fall within the video duration;
- valid OCR/object confidences, polygons, and normalized bounding boxes;
- embedding matrix shape, dtype, dimension, normalization, and row-index
  coverage;
- consistent producer, pipeline, schema, and model metadata within each
  modality.

A validation error stops the import and creates no partial candidates. Use
`--video-id L25_V078` to investigate one video separately.

## Verification

```powershell
python -m unittest tests.test_import_refined tests.test_ocr_refined -v
```

General contracts are documented in [`contracts/README.md`](../../contracts/README.md);
the backend schema and migrations are in [`apps/backend/sql/`](../../apps/backend/sql/).
