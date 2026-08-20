# Refined database importer

`import_refined.py` imports the normalized frame-first artifacts into the
PostgreSQL schema in `apps/backend/sql/`. It uses the authoritative
`frame_aliases.parquet` mapping, preserves duplicate occurrences, and loads
the local `.npy` matrices into `clip_embeddings.embedding` (`vector(1024)`).
Embedding matrices do not need to be uploaded to R2 for this local workflow.
Vietnamese OCR is normalized to `ocr.parquet`; each accepted text detection
keeps its polygon in the evidence payload and is mapped through
`(video_id, keyframe_no)` before import.

Install the database driver once:

```powershell
python -m pip install -r pipelines/ingestion/requirements.txt
```

To rebuild the normalized OCR artifact from the retained source JSONL:

```powershell
$env:PYTHONPATH = 'D:\workspace\aic\src'
python -m pipelines.ingestion.ocr_refined `
  --input 'D:\workspace\aic\data\refined\ocr_source.jsonl' `
  --output 'D:\workspace\aic\data\refined\ocr.parquet'
```

Run a read-only validation first:

```powershell
$env:PYTHONPATH = 'D:\workspace\aic\src'
python -m pipelines.ingestion.import_refined `
  --data-root 'D:\workspace\aic\data\refined' `
  --dry-run
```

After the backend migrations have been applied and the local Docker database
is listening, import all modalities including OCR:

```powershell
$env:DATABASE_URL = 'postgres://aic:<password>@127.0.0.1:5433/aic_local'
$env:PYTHONPATH = 'D:\workspace\aic\src'
python -m pipelines.ingestion.import_refined `
  --data-root 'D:\workspace\aic\data\refined' `
  --database-url $env:DATABASE_URL `
  --index-version aic2026-local-v1
```

The operation is idempotent. A small trial can be run with
`--limit-videos 1` or repeated for one video with `--video-id L25_V078`.
Use `--skip-ocr` only when deliberately running a dataset without
`ocr.parquet`.
Indexes should be created only after the complete import:

```powershell
Set-Location D:\workspace\aic\src\apps\backend
npm run db:build-indexes
npm run db:verify
```

The importer creates a staged `index_release`; it does not activate it and it
does not fabricate a text-encoder revision. Configure the exact query encoder
with `--text-encoder-name` and `--text-encoder-revision` when that metadata is
available.
