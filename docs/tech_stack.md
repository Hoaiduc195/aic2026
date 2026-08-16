# Technical stack

## Runtime

- Python 3.11+ for decoding, frame manifests and feature extraction.
- TypeScript/NestJS for retrieval API, fusion, persistence and health checks.
- Next.js/React for the operator workbench.
- PostgreSQL, `pg_trgm` and pgvector for evidence search.
- Cloudflare R2 through the S3-compatible API for videos, keyframes and feature artifacts.

## Storage model

The database stores metadata, exact frame identity, evidence provenance and
retrieval snapshots. Large media and matrices stay in R2. A response contains
an object key-derived URI; the backend signs it using environment secrets.

## Feature identity

Image modalities use `(video_id, original_frame_id)`. ASR uses integer
millisecond intervals. Every feature set records producer, model name/version,
pipeline version, schema version, dimensions, dtype, normalization and checksum.

## Verification

```powershell
cd apps/backend
npm test
npm run typecheck
npm run build
cd ../frontend
npm test
```

Python contract and normalization tests run with `python -m unittest` (or the
project virtual environment when Parquet dependencies are needed).
