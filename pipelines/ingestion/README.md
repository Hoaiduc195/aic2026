# Refined artifact ingestion

`import_refined.py` là cầu nối giữa các artifact frame-first đã chuẩn hóa và
schema PostgreSQL trong [`apps/backend/sql/`](../../apps/backend/sql/). Importer
không chạy feature extraction; nó validate identity/provenance trước, sau đó
upsert dữ liệu theo transaction để có thể resume an toàn.

Luồng identity được giữ nguyên:

```text
video -> canonical frame -> frame_alias (keyframe occurrence) -> evidence
```

Ma trận visual embedding `.npy` được đọc từ local và ghi trực tiếp vào
`clip_embeddings.embedding` (`vector(1024)`), không cần upload embedding lên R2
cho workflow local. OCR tiếng Việt được normalize thành các row có polygon và
được map qua `(video_id, keyframe_no)`.

## Dependency

```powershell
python -m pip install -r pipelines/ingestion/requirements.txt
```

Backend migration phải được áp dụng trước. PostgreSQL cần extension `vector` và
`pg_trgm` theo schema backend.

## Input contract

`--data-root` mặc định là `data/refined`. Bộ artifact đầy đủ gồm:

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

Caption phải là tiếng Anh (`en`), OCR là tiếng Việt (`vi`), ASR dùng interval
nửa mở `[start_ms, end_ms)`, còn embedding phải là ma trận `float32`, L2
normalized và có đúng 1024 chiều. `embedding_index.parquet` phải khớp row index
với ma trận `.npy` và mapping canonical.

Nếu cần rebuild OCR normalized artifact từ JSONL nguồn:

```powershell
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.ocr_refined `
  --input D:\data\refined\ocr_source.jsonl `
  --output D:\data\refined\ocr.parquet
```

## Dry-run và import

Luôn validate read-only trước:

```powershell
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --dry-run
```

Import thật sau khi backend migration xong:

```powershell
$env:DATABASE_URL = 'postgresql://aic:<password>@127.0.0.1:5433/aic_local'
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --database-url $env:DATABASE_URL `
  --index-version aic2026-local-v1
```

Lệnh nhận `--video-id` lặp lại để import subset, `--limit-videos` để thử một
phần nhỏ và `--batch-size` để điều chỉnh memory. Các modality có thể bỏ qua
bằng `--skip-captions`, `--skip-ocr`, `--skip-asr`, `--skip-objects` hoặc
`--skip-embeddings`; chỉ dùng khi dataset thực sự không có artifact đó.

Importer là idempotent. Nó tạo `index_release` ở trạng thái staged, không tự
activate release và không tự tạo text-encoder revision giả. Khi metadata query
encoder đã chính xác, truyền:

```powershell
--text-encoder-name <checkpoint-name> `
--text-encoder-revision <immutable-revision>
```

Sau khi import hoàn tất, build index và verify từ `apps/backend`:

```powershell
Set-Location apps/backend
npm run db:build-indexes
npm run db:verify
```

Không build HNSW/GIN/trigram giữa chừng một bulk import lớn; index nên được tạo
sau phase ghi dữ liệu để giảm thời gian và tránh release nửa hoàn tất.

## Validation fail-closed

Trước khi mở transaction, importer kiểm tra:

- video ID duy nhất, duration hợp lệ và canonical frame không trùng;
- alias trỏ đúng canonical frame, thumbnail/storage identity không trùng;
- tất cả feature row trỏ tới alias tồn tại;
- interval ASR nằm trong duration video;
- OCR/object confidence, polygon và normalized bounding box hợp lệ;
- embedding matrix, dtype, dimension, normalization và row-index coverage;
- producer, pipeline, schema và model metadata không mâu thuẫn trong cùng
  modality.

Lỗi validation dừng import, không tạo partial candidate. Có thể dùng
`--video-id L25_V078` để điều tra riêng một video.

## Kiểm tra

```powershell
python -m unittest tests.test_import_refined tests.test_ocr_refined -v
```

Các contract tổng quát nằm trong [`contracts/README.md`](../../contracts/README.md);
backend schema và migration nằm tại [`apps/backend/sql/`](../../apps/backend/sql/).
