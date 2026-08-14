# GIẢI THÍCH VÀ TIẾN ĐỘ RETRIEVAL

**Cập nhật:** 15/08/2026  
**Nhánh làm việc:** `main`  
**Commit nền trước khi sửa:** `bff80b0`  
**Phạm vi lượt này:** P0-2, R0-03 → R0-06, R2-01 → R2-06 và R3-02 → R3-09. Không triển khai database/importer hoặc CLIP index thật.

---

## 1. Kết quả ngắn gọn

Đã hoàn thành phần code có thể làm độc lập với database:

- Contract runtime của `QueryPlan`, `BranchResult`, `SearchResponse` và version manifest.
- Query planner deterministic có query atoms, query view theo channel, `object_terms`, count/spatial/negative constraints.
- Ontology object COCO với alias tiếng Anh/Việt.
- Soft routing và fallback visual + caption.
- Caption/OCR/ASR lexical baseline có normalization, FTS, trigram, exact phrase bonus và diagnostics.
- Object retrieval có canonical terms, class filter, confidence threshold và scoring đúng ý nghĩa.
- Canonical segment aggregation trước fusion.
- Weighted RRF lấy trọng số từ QueryPlan.
- `fusion_trace` giải thích đóng góp từng channel.
- Timeout thật cho từng branch và branch-failure isolation.
- Test trực tiếp payload runtime qua JSON Schema.
- Version identity có artifact/model/index version, checksum và trạng thái staged/active/retired.
- Backend dependencies, test, typecheck và build đã chạy được.

Chưa hoàn thành end-to-end trên dữ liệu thật vì các mục sau phải chờ nhóm thống nhất database/index:

- Visual embedding đang có nguy cơ lệch 768 chiều ở SigLIP và 512 chiều trong pgvector/query service.
- Chưa có importer từ caption/OCR/ASR/object/embedding artifact vào PostgreSQL.
- Chưa có PostgreSQL/index thật để integration-test các câu SQL retrieval.
- Chưa được phép đánh dấu version manifest là `active`; hiện để `staged` có chủ đích.

---

## 2. Tiến độ theo checklist

### Phase R0

- [ ] **R0-01 — BLOCKED:** Chưa chốt model visual và embedding dimension; chờ team database/model.
- [ ] **R0-02 — BLOCKED:** Chưa migrate pgvector 512 ↔ 768; chờ quyết định R0-01 và database.
- [x] **R0-03 — DONE:** Schema đã có đầy đủ field runtime: fusion/display K, fusion method, index version, query views, object terms/constraints, channel weights, candidate time/preview và diagnostics.
- [x] **R0-04 — DONE:** `runtime-contracts.test.ts` validate payload thật do `RetrievalService` và PostgreSQL object branch sinh ra; SearchResponse thật cũng được validate.
- [x] **R0-05 — DONE ở mức contract/runtime:** Có version manifest, checksum rule, artifact/model/index identity và state machine `staged/active/retired`.
- [x] **R0-06 — DONE:** Đã cài dependencies, chạy backend test/typecheck/build. Repo khai báo Node `>=20`; Vite được pin về dòng 6 để bộ test có thể khởi động ổn định.

Lưu ý R0-05: file `configs/retrieval/version-manifest.staged.json` cố ý mang trạng thái `staged`. Runtime sẽ từ chối `active` nếu chưa có index version thật và SHA-256 của index. Code quản lý version đã hoàn thành, nhưng hành động activate index phải đợi team database.

### Phase R1

- [ ] **R1 — TẠM BỎ QUA:** Dữ liệu đã có nhưng schema DB/importer cần bàn lại với team. Không tự ý viết migration hoặc ingest dữ liệu trong lượt này.

### Phase R2

- [x] **R2-01:** Parser deterministic tách visual concepts, visible text, spoken text, object, temporal và negative atoms.
- [x] **R2-02:** Sinh query view riêng cho clip/visual, caption, OCR, ASR và object.
- [x] **R2-03:** Ontology COCO + alias Việt/Anh; chuẩn hóa object label và nhận count/spatial cơ bản.
- [x] **R2-04:** Soft routing theo tín hiệu query, có fallback visual + caption.
- [x] **R2-05:** QueryPlan được log có cấu trúc với planner/index version, transformations, branch list và weights.
- [x] **R2-06:** Có unit test cho hình ảnh/hành động, chữ, lời nói, object/count/spatial, temporal và phủ định.

### Phase R3

- [ ] **R3-01 — BLOCKED:** CLIP/SigLIP trên index thật để sau; cần database và quyết định dimension.
- [x] **R3-02 — DONE code:** Caption lexical baseline = PostgreSQL FTS + pg_trgm + exact phrase bonus; trả diagnostics và elapsed time. Dense caption index chưa làm vì lựa chọn baseline cho phép lexical-only có measurement.
- [x] **R3-03 — DONE code:** OCR/ASR lexical dùng query view đã normalize, FTS/trigram và exact bonus. Semantic branch là optional: planner chỉ route nếu một semantic branch thật được đăng ký là available.
- [x] **R3-04 — DONE code:** Object retriever nhận canonical terms/aliases, class list và minimum confidence; confidence chỉ điều chỉnh quality, không thay độ liên quan query.
- [x] **R3-05:** Mọi frame/evidence hit được gom về khóa `video_id + segment_id` trước fusion.
- [x] **R3-06:** Nhiều hit cùng channel/segment được aggregate bằng max + top-3 mean + occurrence bonus có cap.
- [x] **R3-07:** RRF lấy `channel_weights` từ QueryPlan, không còn equal-weight hard-code.
- [x] **R3-08:** Search result trả `fusion_trace` cho từng segment.
- [x] **R3-09:** Mỗi branch có deadline thật; timeout/failure trả degraded result và không làm sập request.

Các mục R3-02, R3-03 và R3-04 đã có unit test với database giả để kiểm tra SQL parameterization và mapping. Vẫn cần integration test trên PostgreSQL thật sau khi schema/index được team chốt.

---

## 3. Fallback visual + caption là gì?

Fallback có nghĩa là dù planner không chắc query thuộc OCR, ASR hay object, hệ thống vẫn thử hai đường tổng quát:

1. **Visual CLIP/SigLIP:** tìm ảnh có nội dung thị giác giống mô tả.
2. **Caption:** tìm câu mô tả keyframe giống query.

Ví dụ:

```text
Query: "một vận động viên chạy qua vạch đích"
```

Query không có dấu hiệu rõ là hỏi chữ, lời nói hay lớp vật thể COCO cụ thể. Planner tạo:

```json
{
  "branches": ["clip", "caption"],
  "query_views": {
    "clip": "một vận động viên chạy qua vạch đích",
    "caption": "một vận động viên chạy qua vạch đích"
  }
}
```

Nếu query có thêm `bảng ghi "FINISH"`, OCR mới được bật. Nếu có `người dẫn chương trình nói "bắt đầu"`, ASR mới được bật. Nếu có `hai chiếc xe đạp`, object branch được bật với `object_terms=["bicycle"]` và `counts={"bicycle":2}`.

Fallback không bảo đảm hai branch đều hoạt động. Nếu CLIP index chưa cấu hình, CLIP trả `unavailable`, caption vẫn chạy và response được đánh dấu `degraded` thay vì request bị lỗi hoàn toàn.

---

## 4. Hình dung Query Planner hoạt động

Query ví dụ:

```text
Hai người đứng bên trái xe đạp trước bảng có chữ "HỘI THI AI"
và nói "xin chào", sau đó rời đi.
```

Planner thực hiện:

```text
Normalize Unicode/whitespace
→ nhận diện ngôn ngữ
→ tách quoted phrases
→ nhận diện tín hiệu OCR/ASR
→ map người/xe đạp sang person/bicycle
→ nhận diện count=2 và spatial=left
→ nhận diện temporal after/sequence
→ tạo query atoms
→ tạo query view riêng
→ chọn branch và channel weight
→ log QueryPlan để replay
```

Kết quả rút gọn:

```json
{
  "object_terms": ["person", "bicycle"],
  "object_constraints": {
    "class_filters": ["person", "bicycle"],
    "excluded_classes": [],
    "min_confidence": 0.25,
    "counts": {"person": 2},
    "spatial": ["left"]
  },
  "temporal_relations": ["after", "sequence"],
  "branches": ["clip", "caption", "ocr_lexical", "asr_lexical", "object"]
}
```

Phủ định cũng được tách riêng:

```text
"một căn phòng không có người"
```

Sinh `excluded_classes=["person"]`, không đưa `person` vào positive `object_terms`. Phần dùng negative evidence để trừ điểm thuộc phase reranking R4; R2 chỉ có trách nhiệm không hiểu sai phủ định thành positive filter.

---

## 5. Hình dung quá trình test R2

Test không cần video hay database. Nó đưa câu query vào planner rồi kiểm tra output có đúng quy tắc hay không.

| Nhóm test | Query ví dụ | Điều cần đúng |
|---|---|---|
| Hành động | `vận động viên chạy qua vạch đích` | Có fallback clip + caption |
| OCR | `bảng có chữ "HỘI THI AI"` | Có OCR branch và OCR view chứa exact phrase |
| ASR | `người đàn ông nói "xin chào"` | Có ASR branch và ASR view chứa lời nói |
| Object | `hai người bên trái xe đạp` | `person`, `bicycle`, count 2, spatial left |
| Temporal | `mở cửa trước khi đặt chai, sau đó rời đi` | before, after, sequence atoms |
| Phủ định | `phòng không có người` | person nằm trong excluded, không nằm trong positive terms |

Nếu một thay đổi ontology làm từ `cầm` bị hiểu nhầm thành quả `cam`, test object terms sẽ fail. Lượt này đã phát hiện đúng trường hợp đó và alias mơ hồ đã được sửa thành `quả cam`.

---

## 6. Giải thích Phase R3

### R3-01 — CLIP/SigLIP branch trên index thật

Branch này biến query text thành vector rồi tìm image vector gần nhất trong pgvector. Nó chưa thể hoàn tất vì image vector hiện có thể là 768 chiều, trong khi backend/migration đang giả định 512. Hai phía phải cùng model, dimension và normalization; không được cắt vector cho vừa.

### R3-02 — Caption lexical baseline

Caption của ảnh là câu như `a man riding a bicycle near a shop`. Baseline hiện tìm bằng:

- PostgreSQL full-text search;
- pg_trgm cho typo/gần giống;
- cộng exact phrase bonus `0.25` khi caption chứa nguyên query view.

Raw score chỉ xếp hạng trong caption branch. `diagnostics` ghi mode, normalized query, số candidate và scoring components. Measurement online nằm ở `elapsed_ms` và `timing.branch_candidate_counts`.

Dense caption retrieval chưa được tuyên bố hoàn thành. Theo yêu cầu R3-02 dùng lựa chọn “lexical baseline có measurement rõ”; dense sẽ chỉ thêm sau khi team quyết định text embedding index.

### R3-03 — OCR và ASR lexical

Hai nhánh dùng cùng lexical engine nhưng nhận query view khác nhau:

- OCR nhận chuỗi nhìn thấy trên màn hình/bảng hiệu.
- ASR nhận lời nói/âm thanh.

Ví dụ câu đầy đủ không còn bị đưa nguyên xi vào OCR. Semantic fallback là optional: khi repo có branch `ocr_semantic` hoặc `asr_semantic` thật và đánh dấu available, planner tự route thêm; hiện branch giả `unavailable` không được bật để tránh tốn thời gian vô ích.

### R3-04 — Object retrieval

Không tìm `similarity(label, nguyên câu query)` nữa. Query planner biến:

```text
"người cầm chai cạnh xe đạp"
```

thành:

```text
person, bottle, bicycle
```

SQL ưu tiên exact canonical label, dùng trigram làm fallback, lọc `confidence >= min_confidence`, rồi điều chỉnh:

```text
object_score = label_relevance × (0.75 + 0.25 × detection_confidence)
```

Nhờ vậy detection confidence 0.99 của nhãn không liên quan không thể thắng query relevance như công thức `GREATEST(similarity, confidence)` cũ.

### R3-05 — Canonical segment trước fusion

Một segment có thể có nhiều keyframe và nhiều evidence. Nếu fusion theo frame, cùng một khoảnh khắc sẽ chiếm nhiều vị trí top K. Code mới dùng khóa:

```text
video_id + segment_id
```

Hai frame trong cùng segment trở thành một candidate trước khi các channel được trộn.

### R3-06 — Aggregate trong từng channel

Với nhiều hit cùng channel trong một segment:

```text
aggregate_score = 0.7 × max_score
                + 0.3 × mean(top 3 scores)
                + min(0.02 × (occurrences - 1), 0.10)
```

- `max_score` giữ evidence tốt nhất.
- Top-3 mean thưởng segment được xác nhận nhiều lần nhưng không để hàng chục frame lặp chi phối.
- Occurrence bonus bị chặn tối đa 0.10.
- Score này chỉ dùng để xếp rank bên trong channel.

### R3-07 — Weighted RRF

Sau khi mỗi channel có ranked list riêng:

```text
contribution(channel, segment) = channel_weight / (60 + channel_rank)
fused_score(segment) = tổng contribution
```

Ví dụ object quan trọng có weight `1.2`, caption weight `1.0`. Object rank 1 đóng góp `1.2/61`, caption rank 1 đóng góp `1.0/61`. Không cộng trực tiếp cosine, BM25 và confidence vì ba thang điểm không cùng ý nghĩa.

### R3-08 — `fusion_trace` là gì?

`fusion_trace` là “phiếu giải trình” cho điểm fusion. Ví dụ:

```json
{
  "segment_id": "L26_V100_seg_0042",
  "score": 0.0361,
  "fusion_trace": [
    {
      "branch": "object",
      "channel_rank": 1,
      "channel_weight": 1.2,
      "rrf_contribution": 0.01967,
      "aggregated_raw_score": 0.91,
      "occurrence_count": 3,
      "evidence_ids": ["obj-1", "obj-2", "obj-3"],
      "matched_terms": ["bottle"]
    },
    {
      "branch": "caption",
      "channel_rank": 2,
      "channel_weight": 1.0,
      "rrf_contribution": 0.01613,
      "aggregated_raw_score": 0.77,
      "occurrence_count": 1,
      "evidence_ids": ["cap-9"],
      "matched_terms": []
    }
  ]
}
```

Nhìn trace có thể trả lời: segment lên top vì channel nào, rank bao nhiêu, weight bao nhiêu và evidence nào góp điểm. Đây là dữ liệu debug/evaluation, không phải xác suất đúng.

### R3-09 — Timeout và failure isolation

Các branch chạy song song. Mỗi branch bị giới hạn bởi `latency_budget_ms`:

- hoàn thành đúng hạn → `completed`;
- quá hạn → `timed_out`, candidate rỗng, recoverable error;
- ném exception → `failed`, lỗi được cô lập;
- branch chưa cấu hình → `unavailable`.

Fusion chỉ dùng branch `completed`. API vẫn trả kết quả từ các branch còn lại và đánh dấu `degraded`.

Giới hạn kỹ thuật hiện tại: Promise bị timeout không thể hủy câu SQL/HTTP đang chạy ở tầng driver; request không chờ nó nữa nhưng cancellation thật cần bổ sung AbortSignal hoặc PostgreSQL statement timeout khi team tích hợp DB.

---

## 7. Các file chính đã thay đổi

- `contracts/schemas/query_plan/schema.json`
- `contracts/schemas/branch_result/schema.json`
- `contracts/schemas/search_response/schema.json`
- `contracts/schemas/version_manifest/schema.json`
- `contracts/schemas/object_result/schema.json`
- `apps/backend/src/retrieval/query-planner.ts`
- `apps/backend/src/retrieval/object-ontology.ts`
- `apps/backend/src/retrieval/postgres-branches.ts`
- `apps/backend/src/retrieval/fusion.ts`
- `apps/backend/src/retrieval/retrieval.service.ts`
- `apps/backend/src/common/version-manifest.ts`
- `configs/retrieval/version-manifest.staged.json`
- Các test mới: `query-planner`, `fusion`, `runtime-contracts`, `version-manifest`.

---

## 8. Kết quả kiểm thử

Đã chạy:

```powershell
cd D:\VSCode\AIC\aic2026\apps\backend
npm test
npm run typecheck
npm run build

cd D:\VSCode\AIC\aic2026
python -m unittest tests.test_qualification_contracts -v
```

Kết quả tại thời điểm cập nhật:

- Backend full suite: **49/49 pass**.
- TypeScript typecheck: **PASS**.
- Backend build: **PASS**.
- Production dependency audit (`npm audit --omit=dev`): **0 vulnerability**.
- Python qualification contracts: **11/11 pass**.
- Tất cả JSON schema/config đọc được: **PASS**.
- Python full discovery: **205 test pass, 1 lỗi import ngoài phạm vi retrieval** vì `tests/test_upload_keyframes_r2.py` tham chiếu file không tồn tại `tmp/upload_keyframes_r2.py`; qualification contract suite vẫn xanh hoàn toàn.

Môi trường:

- Repo yêu cầu Node `>=20` vì NestJS/AWS SDK hiện tại; `.nvmrc` chốt `20.19.0` cho môi trường phát triển/CI.
- Máy local đang gọi Node 18 ở PATH; test/build vẫn chạy sau khi pin Vite 6, nhưng production/CI phải dùng Node 20 hoặc 22.

---

## 9. Việc cần team database quyết định tiếp

- [ ] Chọn SigLIP 768 hay model 512 và đóng băng model/dimension/normalization.
- [ ] Chốt migration pgvector và dimension.
- [ ] Chốt schema/importer cho artifact caption, OCR, ASR, object và embedding.
- [ ] Chốt caption dense index và OCR/ASR semantic index có làm ngay hay không.
- [ ] Chạy SQL branch tests trên PostgreSQL thật với dữ liệu thật.
- [ ] Sinh checksum index thật rồi đổi version manifest từ `staged` sang `active`.
- [ ] Thêm statement timeout/cancellation ở database driver.

Cho tới khi các mục này hoàn tất, không nên tuyên bố retrieval đã chạy end-to-end hoặc activate index production.
