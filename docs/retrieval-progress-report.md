# BÁO CÁO TIẾN ĐỘ HỆ THỐNG RETRIEVAL

**Ngày cập nhật:** 15/08/2026
**Nhánh:** `main`
**Commit triển khai gần nhất:** `d8566e4 feat(retrieval): add query planning and weighted fusion`

## 1. Tóm tắt

Phần retrieval có thể phát triển độc lập với database đã được hoàn thành ở mức code, contract và unit test. Hệ thống hiện đã hiểu query, chọn các kênh tìm kiếm phù hợp, tìm kiếm lexical trên caption/OCR/ASR/object, gom kết quả theo segment và hợp nhất kết quả có giải thích.

Team đã chốt visual model là **ViT-B/32 (`vit32b`) với vector 1024 chiều** và đã có artifact embedding. Hệ thống chưa thể kiểm thử end-to-end trên dữ liệu thật vì còn thiếu Neon schema đã triển khai, importer và text query encoder tương thích đúng không gian embedding.

## 2. Các phần đã hoàn thành

### Contract và runtime

- [x] Đồng bộ `QueryPlan`, `BranchResult` và `SearchResponse` giữa JSON Schema và runtime.
- [x] Bổ sung runtime fields: query views, object terms/constraints, channel weights, fusion/display K, index version, thời gian segment, preview URI và diagnostics.
- [x] Bổ sung version manifest cho dataset, model, artifact và index.
- [x] Kiểm tra payload thật do service sinh ra bằng JSON Schema.
- [x] Khai báo môi trường Node.js `>=20` và khóa dependency cần thiết.

### Query Planner

- [x] Chuẩn hóa Unicode và khoảng trắng, nhận biết query tiếng Việt/Anh.
- [x] Tách query thành visual, caption, OCR, ASR, object, temporal và negative atoms.
- [x] Sinh query riêng cho từng retrieval channel.
- [x] Sinh `object_terms` theo class canonical của COCO.
- [x] Hỗ trợ alias object Việt/Anh, số lượng, vị trí và object bị phủ định.
- [x] Soft routing theo tín hiệu query.
- [x] Fallback qua visual và caption khi query không có tín hiệu chuyên biệt rõ ràng.
- [x] Log QueryPlan có cấu trúc để debug và đo lường.

### Retrieval branches

- [x] Caption lexical retrieval bằng PostgreSQL FTS, `pg_trgm` và exact phrase bonus.
- [x] OCR/ASR lexical retrieval với normalization và exact phrase bonus.
- [x] Cho phép đăng ký semantic fallback sau này mà không làm hỏng lexical baseline.
- [x] Object retrieval dùng canonical class/alias, class filter và confidence threshold.
- [x] Object confidence chỉ điều chỉnh độ tin cậy, không thay thế độ liên quan với query.
- [x] Kết nối feature object detection vào Query Planner và object retrieval ở mức contract/runtime.

### Fusion và độ ổn định

- [x] Quy mọi frame/evidence hit về khóa canonical `video_id + segment_id` trước fusion.
- [x] Aggregate nhiều hit cùng channel bằng max, trung bình top-3 và occurrence bonus có chặn trần.
- [x] Weighted RRF lấy trọng số channel từ QueryPlan.
- [x] Trả `fusion_trace`: rank, weight, đóng góp RRF và evidence của từng channel.
- [x] Áp dụng deadline cho từng branch.
- [x] Một branch timeout hoặc lỗi không làm hỏng toàn bộ request.
- [x] Trả timing và trạng thái của từng branch để theo dõi hiệu năng.

## 3. Kết quả kiểm tra hiện tại

- Backend unit/integration tests dùng mock: **49/49 pass**.
- TypeScript typecheck: **pass**.
- Backend build: **pass**.
- Retrieval/qualification contract tests: **11/11 pass**.
- Dependency audit production: **0 vulnerability**.
- Các câu SQL lexical/object đã được test bằng database giả; chưa phải integration test với PostgreSQL thật.

## 4. Các phần đang bị chặn

- [x] **R0-01:** Đã chốt ViT-B/32 (`vit32b`) theo artifact của team.
- [x] **R0-02:** Đã chốt 1024 chiều; migration và query runtime đã chuyển từ mặc định 512 sang 1024.
- [ ] **R1:** Đã có migration baseline `001_initial.sql`, nhưng chưa triển khai/kiểm chứng trên Neon và chưa có importer thống nhất cho caption, OCR, ASR, object, segment và embedding.
- [ ] **R3-01:** Thành viên phụ trách đã sinh file embedding; còn thiếu import vào pgvector và text query encoder tương thích để chạy branch trên index thật.
- [ ] Chưa có integration test và benchmark trên PostgreSQL/pgvector thật.
- [ ] Version manifest mới ở trạng thái `staged`, chưa được phép chuyển sang `active` khi index thật chưa tồn tại.

## 5. Những quyết định team cần chốt

| Mã | Quyết định cần chốt | Các lựa chọn chính | Ảnh hưởng |
|---|---|---|---|
| D1 | Visual model chuẩn | **Đã chốt:** ViT-B/32 (`vit32b`) | Cần bổ sung exact checkpoint/revision/checksum vào manifest |
| D2 | Vector dimension | **Đã chốt:** 1024 | DB dùng `vector(1024)`; query encoder bắt buộc trả đúng 1024 chiều |
| D3 | Canonical segment | Cách tạo `segment_id`, mốc `start_ms/end_ms`, mapping frame → segment | Tất cả branch phải quy về cùng segment trước fusion |
| D4 | Database schema | Bảng riêng cho caption/OCR/ASR/object hay một bảng evidence thống nhất | Quyết định migration, index và SQL runtime |
| D5 | Artifact importer | Nguồn artifact, khóa idempotency, checkpoint và cách update lại dữ liệu | Cần để đưa dữ liệu preprocessing vào database an toàn |
| D6 | Object storage format | Object theo frame hay segment; bbox chuẩn hóa; lưu alias hay chỉ canonical label | Ảnh hưởng object query, evidence và dung lượng DB |
| D7 | Dense caption retrieval | Giữ lexical baseline hay bổ sung dense/hybrid ngay | Ảnh hưởng model/index mới và kế hoạch benchmark |
| D8 | Index activation | Quy tắc tạo checksum, publish và rollback version | Cần trước khi đổi manifest từ `staged` sang `active` |

## 6. Đề nghị phân công tiếp theo

### Team database/data

- [ ] Chốt D3–D6; D1 và D2 đã được quyết định.
- [ ] Review và chạy migration baseline `apps/backend/sql/001_initial.sql` trên Neon development branch.
- [ ] Cung cấp một database dev có dữ liệu mẫu.
- [ ] Xây hoặc thống nhất importer idempotent.
- [ ] Cung cấp mapping frame/keyframe/object/caption/OCR/ASR → canonical segment.

### Team retrieval

- [x] Đồng bộ migration và retrieval runtime sang vector 1024 chiều.
- [ ] Cung cấp text query encoder dùng đúng joint embedding space với image embedding ViT-B/32 của team.
- [ ] Kết nối các branch hiện có với schema DB thật.
- [ ] Chạy contract + integration test trên dữ liệu thật.
- [ ] Benchmark recall/latency cho caption lexical và phương án hybrid nếu D7 được chọn.
- [ ] Kiểm tra object confidence threshold theo dữ liệu thực tế.
- [ ] Publish version manifest và chuyển sang `active` sau khi index vượt kiểm tra.

## 7. Tiêu chí để coi retrieval chạy end-to-end

- [ ] Một query đi qua Query Planner và sinh đúng channel/query view.
- [ ] Mỗi channel truy vấn được index thật và trả canonical segment.
- [ ] Fusion trả kết quả kèm `fusion_trace` đầy đủ.
- [ ] Một branch lỗi vẫn trả được degraded response từ các branch còn lại.
- [ ] SearchResponse vượt JSON Schema validation.
- [ ] Index/model/artifact version khớp version manifest đang `active`.
- [ ] Có báo cáo Recall@K, MRR/nDCG và p50/p95 latency trên tập query đánh giá chung.

## 8. Ảnh hưởng của vector 1024 tới kiến trúc cũ

Kiến trúc Query Planner → retrieval branches → canonical segment → weighted RRF không thay đổi. Các điểm kỹ thuật phải đồng bộ là:

1. PostgreSQL dùng `vector(1024)` thay cho `vector(512)`.
2. HNSW index phải được build trên cột 1024 chiều.
3. Text query encoder phải trả đúng 1024 số hữu hạn.
4. Query vector và image vector phải dùng cùng checkpoint, projection và normalization.
5. Importer phải từ chối vector sai dimension, NaN/infinity hoặc sai model version.
6. Đổi model/vector/index phải tạo index version và checksum mới.

Riêng payload một vector tăng từ khoảng 2.056 byte ở 512 chiều lên khoảng 4.104 byte ở 1024 chiều, chưa tính row và HNSW overhead. 1024 vẫn nằm trong giới hạn 2.000 chiều của HNSW đối với kiểu `vector`.

> `vit32b` chưa phải model identity đầy đủ. Trước khi activate cần ghi exact checkpoint/revision, thư viện, preprocessing, normalization, dtype và checksum artifact. Chỉ cùng 1024 chiều chưa đủ để hai vector so sánh có ý nghĩa.

## 9. Hướng dẫn setup Neon

### 9.1. Trình tự thực hiện

1. Tạo project `aic2026-retrieval` trên Neon.
2. Dùng branch `development` để thử migration/import trước production.
3. Lấy pooled URL cho backend runtime và direct URL cho migration/import.
4. Điền URL vào `.env` local, tuyệt đối không commit secret.
5. Chạy migration baseline.
6. Kiểm tra extensions, tables và `vector(1024)`.
7. Xây importer rồi import theo đúng thứ tự foreign key.
8. Chạy integration test và benchmark.
9. Chỉ chuyển version manifest sang `active` sau khi index vượt kiểm tra.

Neon khuyến nghị dùng direct connection cho migration và pooled connection cho application runtime.

### 9.2. Cấu hình `.env`

Tạo `apps/backend/.env` từ `.env.example`:

```dotenv
DATABASE_URL=postgresql://<role>:<password>@<pooled-host>/<database>?sslmode=require
DATABASE_DIRECT_URL=postgresql://<role>:<password>@<direct-host>/<database>?sslmode=require

EMBEDDING_SERVICE_URL=
EMBEDDING_SERVICE_TOKEN=
EMBEDDING_DIMENSIONS=1024

DATASET_ID=aic2026
DATASET_VERSION=<dataset-version>
PIPELINE_VERSION=<pipeline-version>
ARTIFACT_VERSION=<artifact-version>
INDEX_VERSION=not-configured
INDEX_CHECKSUM=
VERSION_STATUS=staged
MODEL_VERSIONS_JSON={"visual":"vit-b-32-1024","caption":"florence-2-base","object":"yolo26n-coco"}
```

Giữ `EMBEDDING_SERVICE_URL` trống cho đến khi có text encoder đúng joint space với image embedding.

### 9.3. Chạy migration

```powershell
cd D:\VSCode\AIC\aic2026\apps\backend
Copy-Item .env.example .env
# Điền Neon URLs vào .env.
npm install
npm run db:migrate
```

Migration bật `vector`, `pg_trgm` và tạo bảng baseline. Nếu một database cũ đã có `clip_embeddings vector(512)`, không import vector mới vào đó; dùng database/branch sạch hoặc migration versioned để rebuild index.

### 9.4. Kiểm tra migration trong Neon SQL Editor

```sql
SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('vector', 'pg_trgm');

SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relname = 'clip_embeddings'
  AND a.attname = 'embedding'
  AND NOT a.attisdropped;

SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

`embedding_type` bắt buộc là `vector(1024)`.

### 9.5. Dữ liệu cần lưu trong DB

Nguyên tắc: database giữ dữ liệu cần filter/join/search; R2 giữ raw video, ảnh và artifact lớn.

| Dữ liệu | Bảng baseline | Dữ liệu chính |
|---|---|---|
| Video | `videos` | ID, R2 object key, duration, FPS, frame count, dataset version |
| Segment | `segments` | canonical segment ID, video, `start_ms/end_ms`, ordinal |
| Keyframe | `frames` | exact `original_frame_id`, timestamp, thumbnail object key |
| Evidence chung | `evidence` | type, segment/frame, interval, confidence, producer/model version |
| Caption | `text_evidence` + `evidence(type=caption)` | raw/normalized caption, language |
| OCR | `text_evidence` + `evidence(type=ocr)` | text, bbox/timestamp trong payload |
| ASR | `text_evidence` + `evidence(type=asr)` | transcript, exact interval, confidence |
| Object | `object_evidence` + `evidence(type=object)` | canonical label, confidence, bbox, track ID |
| Embedding | `clip_embeddings` | vector 1024 và exact model version |
| Retrieval | `retrieval_runs`, `retrieval_candidates` | QueryPlan và snapshot kết quả |
| Manual | `manual_selections` | revision lựa chọn và ghi chú |

Raw video, ảnh và `.npy` nguồn nằm ở R2. Tuy nhiên vector cần search phải được import vào pgvector; chỉ lưu URI tới `.npy` thì không thể chạy vector search.

### 9.6. Thứ tự import

```text
videos
  → segments
    → frames
      → evidence
        → text_evidence / object_evidence / clip_embeddings
```

Importer phải idempotent, resume được, giữ exact frame/timestamp, map mọi evidence vào canonical segment, kiểm tra dimension/model/checksum và ghi thống kê inserted/updated/skipped/failed.

### 9.7. Kiểm tra embedding sau import

```sql
SELECT COUNT(*) AS embedding_count,
       COUNT(DISTINCT e.video_id) AS video_count,
       MIN(vector_dims(c.embedding)) AS min_dim,
       MAX(vector_dims(c.embedding)) AS max_dim
FROM clip_embeddings c
JOIN evidence e ON e.evidence_id = c.evidence_id;

SELECT model_version, COUNT(*)
FROM clip_embeddings
GROUP BY model_version;

SELECT pg_size_pretty(pg_relation_size('clip_embeddings_hnsw_idx')) AS hnsw_size;
```

`min_dim` và `max_dim` phải cùng bằng 1024.

## 10. LLM và VLM được dùng ở đâu?

### Trạng thái hiện tại

- Query Planner đang deterministic, không cần LLM để chạy baseline.
- Florence-2 đã được dùng offline để sinh caption; đây là VLM preprocessing, không chạy lại cho mọi query.
- Visual/text encoder tạo embedding không phải generative LLM.
- Backend đã có interface `LanguageModel` và `VisionLanguageModel`, nhưng chưa có provider/runtime wiring.

### LLM — optional

LLM chỉ nên dùng cho query decomposition khó, parse chuỗi TRAKE, synonym expansion có kiểm soát và tóm tắt evidence. Nếu LLM lỗi, timeout hoặc trả sai schema, hệ thống phải fallback về deterministic planner.

Cấu hình dự kiến, hiện chưa wiring:

```dotenv
LLM_ENABLED=false
LLM_PROVIDER=<provider>
LLM_MODEL=<exact-model-version>
LLM_BASE_URL=
LLM_API_KEY=
LLM_TIMEOUT_MS=3000
LLM_PROMPT_VERSION=query-planner-v1
```

### VLM — optional trên top-N

VLM dùng để verify/rerank top 50–100 segment, giải VQA từ evidence pack hoặc kiểm tra count/relation khó. Không dùng VLM quét toàn bộ database tại query time.

Cấu hình dự kiến, hiện chưa wiring:

```dotenv
VLM_ENABLED=false
VLM_PROVIDER=<provider-or-self-hosted>
VLM_MODEL=<exact-model-version>
VLM_BASE_URL=
VLM_API_KEY=
VLM_TIMEOUT_MS=8000
VLM_TOP_N=50
VLM_PROMPT_VERSION=segment-verifier-v1
```

Mọi output LLM/VLM cần lưu model version, prompt version, latency và evidence IDs. Không commit API keys.

## 11. Các mục còn lại của Phase R4

- [ ] **R4-01:** Coverage score trên query atoms.
- [ ] **R4-02:** Exact-match bonus thống nhất cho OCR/ASR/caption phrase và object alias. Branch lexical đã có bonus cục bộ nhưng chưa có rerank score chung.
- [ ] **R4-03:** Temporal relation scoring cho before/after/then/while.
- [ ] **R4-04:** Object-aware score cho count, persistence và spatial constraints.
- [ ] **R4-05:** Dedup theo segment/time overlap và per-video cap.
- [ ] **R4-06:** MMR/diversification trên top segment.
- [ ] **R4-07:** Representative frame selection và neighbor expansion từ dense frame manifest.
- [ ] **R4-08:** Trả exact `original_frame_id`, `timestamp_ms`, preview và evidence; không suy timestamp từ segment start.

Chỉ nên bắt đầu R4 sau khi candidate union trên database thật đạt recall mục tiêu. VLM verification chỉ bật nếu benchmark chứng minh có lợi.

## 12. Các mục còn lại của Phase R5

- [ ] **R5-01:** Tạo validation set có query ID, target video, target interval và evidence chính.
- [ ] **R5-02:** Đo segment/frame Recall@K, MRR, oracle recall, duplicate rate và p50/p95 latency.
- [ ] **R5-03:** Báo cáo recall từng channel và candidate union.
- [ ] **R5-04:** Ablation visual; +caption; +OCR; +ASR; +object; +rerank; +diversification; +VLM nếu có.
- [ ] **R5-05:** Object evaluation: class recall, false-positive rate và gain theo loại query.
- [ ] **R5-06:** Regression gate theo dataset/index/model version.
- [ ] **R5-07:** Dashboard/log branch latency, failures, candidate counts, active version và degraded mode.
- [ ] **R5-08:** Runbook rebuild/activate/rollback index.

## 13. Điều kiện chuyển version từ staged sang active

- [ ] Neon migration thành công.
- [ ] Importer hoàn tất, không còn lỗi chưa giải thích.
- [ ] Vector đúng 1024 chiều và cùng model version.
- [ ] Text encoder tương thích với image embedding.
- [ ] HNSW index và sample query hoạt động.
- [ ] Integration tests pass.
- [ ] Recall/latency đạt ngưỡng team thống nhất.
- [ ] Có `INDEX_VERSION`, `INDEX_CHECKSUM` và phương án rollback.

## 14. Context để gửi GPT hướng dẫn thao tác

Copy toàn bộ khối sau vào một cuộc chat mới:

```text
Tôi đang setup Neon PostgreSQL/pgvector cho repo:
https://github.com/Hoaiduc195/aic2026

Môi trường local:
- Windows PowerShell
- Repo: D:\VSCode\AIC\aic2026
- Backend: D:\VSCode\AIC\aic2026\apps\backend
- Node.js yêu cầu >= 20

Trạng thái kỹ thuật:
- Visual model đã chốt: ViT-B/32, team gọi là vit32b.
- Image embedding đã được thành viên khác sinh, dimension = 1024.
- Migration baseline: apps/backend/sql/001_initial.sql.
- Migration đã dùng clip_embeddings.embedding vector(1024), HNSW cosine.
- Backend runtime dùng EMBEDDING_DIMENSIONS=1024.
- Caption dùng Florence-2; object detection dùng YOLO COCO.
- Caption/OCR/ASR retrieval dùng PostgreSQL FTS + pg_trgm.
- Object retrieval dùng canonical COCO label + confidence.
- Fusion dùng canonical segment và weighted RRF.
- Chưa có importer artifact vào DB.
- Chưa có text query encoder được xác nhận cùng joint embedding space với image embedding.
- Version manifest phải giữ staged cho đến khi import/index/test hoàn tất.

Mục tiêu của tôi:
1. Tạo Neon project và development branch.
2. Lấy pooled DATABASE_URL cho runtime và direct DATABASE_DIRECT_URL cho migration.
3. Điền apps/backend/.env mà không lộ hoặc commit secret.
4. Chạy npm run db:migrate.
5. Kiểm tra vector, pg_trgm, tables và vector(1024).
6. Chẩn đoán lỗi nếu migration hoặc kết nối thất bại.
7. Sau đó lên kế hoạch importer theo thứ tự videos → segments → frames → evidence → text_evidence/object_evidence/clip_embeddings.

Yêu cầu cách hướng dẫn:
- Hướng dẫn từng bước một, chờ tôi gửi kết quả rồi mới sang bước tiếp theo.
- Dùng câu lệnh PowerShell khi thao tác local.
- Với thao tác Neon UI, nói chính xác nút/menu cần bấm.
- Không yêu cầu tôi gửi password hoặc toàn bộ connection string; nếu cần kiểm tra chỉ cho tôi cách tự che secret.
- Không tự ý chạy migration production hoặc xóa database.
- Trước migration phải xác nhận đang dùng development branch và embedding column là vector(1024).
- Khi có lỗi, giải thích nguyên nhân rồi mới đề xuất lệnh sửa.

Bắt đầu bằng việc hướng dẫn tôi tạo Neon project/development branch và lấy hai connection strings an toàn.
```

## 15. Tài liệu tham khảo

- [Neon — tạo project và database branch](https://neon.com/docs/get-started/signing-up)
- [Neon — pooled và direct connection](https://neon.com/docs/connect/connection-pooling)
- [Neon — pgvector](https://neon.com/docs/ai/ai-concepts)
- [pgvector — HNSW, vector dimension và recall](https://github.com/pgvector/pgvector)

## 16. Kết luận gửi team

Phần logic retrieval trước database đã sẵn sàng, visual model/dimension đã chốt và runtime đã chuyển sang 1024. Việc ưu tiên tiếp theo là dựng Neon development database, review canonical segment/schema, xây importer và kết nối text query encoder tương thích. Sau đó team mới chạy integration test, benchmark, R4 rerank và R5 evaluation trước khi activate index.
