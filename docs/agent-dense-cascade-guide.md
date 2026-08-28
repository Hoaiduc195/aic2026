# Hướng dẫn sử dụng Agent tìm frame

Tài liệu này mô tả toàn bộ chức năng agent của hệ thống AIC 2026. Chế độ nên dùng
trong vòng thi là `temporal_zoom`; `dense` chỉ giữ lại để benchmark/offline.

## 1. Ba chế độ tìm frame

| Chế độ | Dữ liệu được xem | Tốc độ | Khi nào dùng |
|---|---|---:|---|
| `sparse` | Keyframe đã import | Rất nhanh | Kiểm tra sơ bộ |
| `temporal_zoom` | Các cửa sổ raw quanh hit retrieval | Nhanh | Mặc định khi thi |
| `dense` | Toàn bộ raw frame của video | Rất chậm | Benchmark hoặc kiểm tra sau cuộc thi |

Không nên dùng `dense` trong giới hạn 3 giờ/25 câu. Lần đo trước trên máy local cho
thấy 331.305 frame có thể mất hơn 5 giờ chỉ cho một query.

## 2. Temporal Zoom hoạt động thế nào?

```text
Query
  ↓
Retrieval CLIP/caption/OCR/ASR/object
  ↓
Top-k frame → xếp hạng video → lấy timestamp mốc
  ↓
Tạo và gộp cửa sổ quanh timestamp
  ↓
FFmpeg seek video R2, lấy mẫu 1–2 FPS
  ↓
Ghép tối đa 16 sample thành một storyboard
  ↓
Luna chọn cell/vùng thời gian phù hợp
  ↓
Decode raw frame trong vùng ±2 giây
  ↓
Prefilter nhẹ giữ tối đa 24 frame → MobileCLIP chọn shortlist
  ↓
Storyboard nhỏ → Luna xác nhận
  ↓
video_id + original_frame_id + score
```

Điểm khác biệt quan trọng:

- Không giải mã tuần tự toàn video.
- Video vẫn nằm trên R2; raw frame chỉ tồn tại trong RAM của worker.
- Một storyboard chứa nhiều frame nên giảm mạnh số image request gửi Luna.
- Vùng cuối có thể chứa khoảng 100 raw frame, nhưng MobileCLIP chỉ embed tối đa 24
  frame do prefilter nhẹ chọn; đây là giới hạn tốc độ riêng của chế độ thi.
- Vòng cuối vẫn dùng FPS gốc để trả `original_frame_id`.
- Worker dừng sớm khi có frame vượt ngưỡng hoặc hết deadline.

## 3. Khởi động hệ thống

Mở PowerShell tại repo:

```powershell
cd D:\VSCode\AIC\aic2026
.\scripts\start_all.ps1
```

Script sẽ:

1. Bật PostgreSQL, embedding service và agent-prefilter bằng Docker.
2. Chờ PostgreSQL healthy và tự chạy migration, gồm
   `008_agent_temporal_zoom.sql`.
3. Bật backend tại `http://localhost:4000`.
4. Bật frontend tại `http://localhost:3000`.

Model cache và database dùng Docker volume, nên không bị tải/làm lại từ đầu mỗi lần
container restart.

`apps/backend/.env` cần có cấu hình R2 và VLM. Không commit hoặc gửi file `.env`.

## 4. Chạy bằng giao diện

1. Mở `http://localhost:3000`.
2. Tìm phần **Tìm frame bằng Temporal Zoom Agent**.
3. Nhập query và chọn task.
4. Chọn profile **Competition Fast**.
5. Bấm **Tạo agent run**.
6. Copy lệnh PowerShell được UI sinh ra.
7. Mở terminal tại repo và chạy lệnh đó.

Nút **Tạo agent run** chỉ tạo kế hoạch và checkpoint trong database. Agent chỉ thật
sự gọi FFmpeg, MobileCLIP và Luna sau khi lệnh `run_agent.ps1` được chạy trong terminal.

Kết quả xuất hiện trong terminal và trong trạng thái run trên UI. Bấm **Làm mới** nếu
muốn cập nhật ngay, hoặc chờ UI tự refresh.

## 5. Profile nên dùng

### Competition Fast — mặc định

| Tham số | Giá trị |
|---|---:|
| Top-k retrieval | 30 |
| Video budget | 3 |
| Cửa sổ/video | 2 |
| Bán kính cửa sổ | ±20 giây |
| Sampling | 1 FPS |
| Storyboard | tối đa 16 frame |
| Zoom cuối | ±2 giây |
| Dừng sớm | 0,82 |
| Deadline | 300 giây |
| Luna | reasoning `none`, detail `low` |

Dùng profile này trước cho mỗi câu.

### Balanced fallback

Nếu Fast không tìm được frame tốt, tạo run mới bằng Balanced:

- Top 5 video;
- tối đa 3 cửa sổ/video;
- cửa sổ ±30 giây;
- lấy mẫu 2 FPS;
- 16 frame/storyboard, lưới 4×4, ảnh `detail=low`;
- reasoning `low`, completion budget ban đầu 768 token;
- deadline 420 giây.

### Accurate

Chỉ dùng cho câu khó hoặc khi còn nhiều thời gian. Profile mở rộng đến 10 video,
4 cửa sổ/video và deadline 10 phút. Mỗi storyboard chỉ có 4 frame theo lưới 2×2,
vẫn dùng `detail=low` để tránh provider timeout nhưng mỗi cell lớn hơn rõ rệt.
Profile này tăng số VLM call nên không phù hợp để chạy đồng loạt 25 câu.

## 6. Chạy trực tiếp bằng PowerShell

Chạy Competition Fast và tự tạo run:

```powershell
.\scripts\run_agent.ps1 `
  -Query "a person closes a motorcycle fuel cap" `
  -Task textual_kis `
  -Profile fast `
  -ScanMode temporal_zoom `
  -TopK 30 `
  -VideoBudget 3 `
  -BatchSize 16 `
  -TemporalWindowSeconds 20 `
  -TemporalWindowsPerVideo 2 `
  -TemporalSampleFps 1 `
  -TemporalFinalRadiusSeconds 2 `
  -TemporalStopScore 0.82 `
  -TemporalDeadlineSeconds 300 `
  -Yes
```

Resume run đã tạo từ UI:

```powershell
.\scripts\run_agent.ps1 `
  -RunId "RUN_ID_TREN_UI" `
  -WorkerId "worker-ui-1" `
  -Profile fast `
  -Yes
```

Test đúng một storyboard trước:

```powershell
.\scripts\run_agent.ps1 -RunId "RUN_ID" -Pilot -Yes
```

Sau pilot, chạy lại cùng `RunId`, bỏ `-Pilot`. Batch đã commit sẽ được bỏ qua.

## 7. Ý nghĩa tham số Temporal Zoom

| Tham số | Ý nghĩa | Tăng giá trị sẽ… |
|---|---|---|
| `TopK` | Số hit retrieval dùng làm seed | Có thêm timestamp nhưng retrieval lâu hơn |
| `VideoBudget` | Số video tối đa | Tăng recall và thời gian |
| `BatchSize` | Số cell/storyboard | Nên giữ 16 |
| `TemporalWindowSeconds` | Bán kính quanh seed | Bao quát hơn nhưng thêm sample |
| `TemporalMergeGapSeconds` | Khoảng cách để gộp hai cửa sổ | Giảm cửa sổ trùng nhau |
| `TemporalWindowsPerVideo` | Số vùng tối đa mỗi video | Bao quát hơn nhưng tăng Luna call |
| `TemporalSampleFps` | FPS vòng storyboard đầu | Bắt sự kiện ngắn tốt hơn nhưng chậm hơn |
| `TemporalFinalRadiusSeconds` | Vùng raw FPS vòng cuối | Tăng cơ hội bắt đúng khoảnh khắc |
| `TemporalStopScore` | Điểm đủ tốt để dừng sớm | Cao hơn chính xác hơn nhưng lâu hơn |
| `TemporalDeadlineSeconds` | Thời gian tối đa một worker | Chặn query chạy quá lâu |
| `MaxBatches` | Số checkpoint tối đa | `0` là theo score/deadline |
| `Pilot` | Kiểm tra một batch | Không dùng cho lượt chạy thật |

Với TRAKE hoặc sự kiện dưới một giây, ưu tiên `TemporalSampleFps=2`. Với cảnh tĩnh,
Textual KIS thông thường, 1 FPS tiết kiệm thời gian và token hơn.

## 8. Đọc kết quả

Worker lưu state tại:

```text
data/tmp/agent-worker/<worker-id>.json
```

Các metric chính:

| Metric | Ý nghĩa |
|---|---|
| `frames_processed` | Số sample thô đã checkpoint, không phải toàn bộ raw frame |
| `temporal_storyboard_calls` | Số storyboard đã gửi Luna |
| `temporal_best_score` | Điểm cao nhất worker tìm thấy |
| `vlm_final_calls` | Số ảnh được Luna xác nhận riêng |
| `vlm_usage.total_tokens` | Token provider báo cáo |
| `elapsed_ms` | Thời gian worker |

`GET /v1/agent/frame-search/<run_id>` trả các match theo điểm giảm dần. Kết quả cuối
cần quan tâm là:

```json
{
  "video_id": "L26_V100",
  "original_frame_id": 12345,
  "score": 0.91,
  "reason": "temporal_final:matching action"
}
```

Chỉ frame có `reason` bắt đầu bằng `temporal_final` mới được đưa vào `matches`.
Các điểm `temporal_storyboard_candidate` và `temporal_zoom_candidate` chỉ dùng để
định tuyến nội bộ; chúng được lưu để debug nhưng luôn có `relevant=false`. Quy tắc
này ngăn một storyboard độ phân giải thấp trở thành đáp án khi raw frame cuối đã
bác bỏ candidate.

## 9. Resume, dừng và lỗi mạng

- Worker commit sau mỗi storyboard.
- Mất mạng giữa storyboard: storyboard đó chạy lại, phần trước không mất.
- Resume bằng đúng `RunId`; có thể giữ `WorkerId` cũ.
- Muốn đổi từ Fast sang Balanced/Accurate phải **tạo run mới**. `-Profile` khi
  resume chỉ đổi cấu hình VLM, không đổi top-k, video budget và cửa sổ đã lưu trong run.
- Một run chỉ được một worker lease tại một thời điểm.
- Hai worker song song phải dùng hai `run_id` khác nhau.
- Bấm **Dừng run** hoặc gọi `/stop` sẽ giữ lại judgment đã có.

Nếu Luna lỗi HTTP 400/429/5xx, worker ghi `paused_error`, giải phóng lease và không
commit kết quả giả. Sửa model/key/rate limit rồi resume cùng `RunId`.

Nếu provider trả HTTP 200 nhưng `content` rỗng, worker tự retry tối đa hai lần và
tăng completion budget có giới hạn (tối đa 4096). Token của cả lần rỗng lẫn lần
thành công đều được cộng vào `vlm_usage`; worker không retry vô hạn.

Tạo run có timeout riêng 120 giây và không tự retry POST để tránh sinh hai run.
Temporal Zoom dùng `duration × FPS` khi video thiếu `frame_count`, không FFprobe toàn
bộ video trên R2. Chỉ chế độ Dense mới bắt buộc đếm frame chính xác.

## 10. Cách sử dụng trong 3 giờ thi

Quy trình khuyến nghị cho từng câu:

1. Người dùng vẫn search thủ công trên UI.
2. Đồng thời tạo một run Competition Fast cho agent.
3. Agent dừng sau tối đa 5 phút hoặc khi điểm đạt 0,82.
4. Người dùng kiểm tra các `temporal_final` match tốt nhất.
5. Nếu không có match hợp lý và câu quan trọng, chạy Balanced fallback.

Không chạy `dense` song song với lượt thi: nó chiếm CPU, R2 bandwidth và
agent-prefilter, làm cả search thủ công lẫn Temporal Zoom chậm theo.

## 11. Giới hạn hiện tại

- Temporal Zoom phụ thuộc việc video đúng nằm trong top retrieval.
- Sự kiện cực ngắn có thể lọt giữa hai sample 1 FPS; dùng 2 FPS cho TRAKE.
- Storyboard `detail=low` không phù hợp đọc chữ nhỏ; OCR branch phải tạo timestamp
  trước, sau đó agent zoom vào vùng đó. Accurate dùng lưới 2×2 để tăng kích thước
  cell nhưng vẫn không thay thế OCR.
- Ánh xạ `original_frame_id = timestamp × fps` chính xác nhất với video CFR. Video
  VFR cần frame manifest riêng để đảm bảo không lệch ID.
- `dense` vẫn tồn tại để đo recall, nhưng không còn là profile mặc định.

## 12. Kết quả kiểm thử thực tế ngày 28/08/2026

Query kiểm thử là cảnh các tài xế xe công nghệ tại trạm xăng, có hành động đóng nắp
bình xăng và dòng tin giá dầu mazut.

| Profile | Phạm vi pilot | Thời gian worker | Token | Kết quả |
|---|---:|---:|---:|---|
| Balanced | 1 storyboard, 16 sample | khoảng 38 giây | 4.038 | Final raw-frame bác bỏ false positive; `matches=[]` |
| Accurate | 1 storyboard, 4 sample | khoảng 14 giây | 701 | Bốn frame bản tin được chấm 0,05; `matches=[]` |

Kiểm tra ảnh thật cho thấy candidate Balanced cũ điểm 0,82 là cảnh đền Hùng, không
phải trạm xăng. Sau sửa, candidate storyboard vẫn có thể mang score nhiễu nhưng
không còn lọt vào `matches` nếu final raw-frame không xác nhận.

Đây là smoke test có kiểm tra ảnh thật, chưa phải accuracy benchmark. Muốn báo cáo
precision/recall cần một tập query có ground truth `video_id + original_frame_id`.

## 13. Preset tham số theo mode

Các giá trị dưới đây là điểm bắt đầu đã cân bằng theo kiến trúc hiện tại. Chúng
không phải hyperparameter tối ưu tuyệt đối; sau này phải hiệu chỉnh lại bằng tập
query có ground truth.

| Tham số | Competition Fast | Balanced | Accurate |
|---|---:|---:|---:|
| `TopK` | 30 | 50 | 100 |
| `VideoBudget` | 3 | 5 | 10 |
| `TemporalWindowSeconds` | 20 | 30 | 45 |
| `TemporalMergeGapSeconds` | 15 | 15 | 20 |
| `TemporalWindowsPerVideo` | 2 | 3 | 4 |
| `TemporalSampleFps` | 1 | 2 | 2 |
| `BatchSize` | 16 | 16 | 4 |
| Storyboard | 4×4 | 4×4 | 2×2 |
| `TemporalFinalRadiusSeconds` | 2 | 2 | 3 |
| `TemporalStopScore` | 0,82 | 0,78 | 0,88 |
| `TemporalDeadlineSeconds` | 300 | 420 | 600 |
| Luna reasoning | `none` | `low` | `low` |
| Image detail | `low` | `low` | `low` |
| Completion budget ban đầu | 512 | 768 | 1024 |
| Dùng khi | lượt đầu của mọi câu | Fast chưa đủ recall | vài câu khó nhất |

Completion budget là trần, không phải số token chắc chắn bị tính. Nếu Luna trả
`content` rỗng, worker mới tăng trần trong retry. Accurate không dùng `detail=high`
vì provider hiện tại hay timeout; lưới 2×2 giúp mỗi cell rõ hơn mà vẫn ổn định.

### Cách chọn mode nhanh

1. Bắt đầu bằng **Competition Fast** cho câu cảnh tĩnh hoặc có dấu hiệu nổi bật.
2. Chuyển sang **Balanced bằng một run mới** nếu đúng video có thể nằm ngoài top 3,
   timestamp seed chưa sát, hoặc hành động tương đối ngắn.
3. Chỉ dùng **Accurate** cho câu đếm, quan hệ không gian, nhiều sự kiện hoặc vài câu
   quan trọng mà Balanced chưa tìm được.
4. Không dùng `dense` trong lượt thi trừ khi đã biết chính xác một video ngắn và
   chấp nhận chi phí CPU/R2 lớn.

## 14. Preset theo dạng câu hỏi

| Dạng câu hỏi | Mode khuyên dùng | Tinh chỉnh nên bắt đầu | Lý do/lưu ý |
|---|---|---|---|
| Cảnh tĩnh, địa danh, vật thể lớn, màu sắc nổi bật | Fast | `TopK=30`, `VideoBudget=3`, cửa sổ 15–20s, 1 FPS, batch 16 | Một sample/giây thường đủ; ưu tiên tốc độ |
| Cảnh phổ biến, nhiều người/vật thể tương tự nhau | Balanced | `TopK=50`, `VideoBudget=5`, cửa sổ 25–30s, 3 window/video, 1–2 FPS | Mở rộng video và ngữ cảnh để giảm nhầm cảnh |
| Hành động rất ngắn dưới khoảng 1 giây | Balanced, sau đó Accurate | 3 FPS trước; nếu vẫn sót dùng 5 FPS, cửa sổ 15–25s, batch 8, final radius 1–1,5s | Tăng FPS để không lấy mẫu hụt hành động; giảm batch giúp cell lớn hơn |
| Trước/sau, chuỗi nhiều sự kiện, TRAKE | Accurate | `Task=trake`, `TopK=100`, `VideoBudget=10`, 4 window/video, cửa sổ 30–45s, merge gap 15–20s, 2 FPS, batch 4–8, final radius 3s | Cần giữ thứ tự và nhiều vùng thời gian; tốn nhiều call hơn |
| Chữ trên màn hình, biển hiệu, phụ đề, giá tiền | OCR retrieval trước, rồi Balanced | Query giữ nguyên cụm chữ đặc trưng; cửa sổ 10–15s, 1–2 FPS, batch 4–8, final radius 1–2s | VLM `detail=low` không thay OCR; OCR tìm timestamp, agent kiểm tra ngữ cảnh hình |
| Lời thoại hoặc âm thanh | ASR retrieval trước, rồi Fast/Balanced | Dùng cụm thoại đặc trưng; cửa sổ 10–20s, 1 FPS, final radius 2s | Agent hình ảnh không thể chứng minh nội dung âm thanh |
| Đếm người/vật, trái/phải, trước/sau, vật thể nhỏ | Accurate | `VideoBudget=5–10`, cửa sổ 15–25s, 1–2 FPS, batch 4, stop score 0,85–0,88 | Lưới 2×2 tăng kích thước cell; vẫn phải mở raw frame cuối để xác nhận |
| VQA cần tìm evidence frame | Balanced | `Task=vqa`, `TopK=50`, `VideoBudget=5`, 2 FPS; mô tả điều cần nhìn thấy thay vì đoán câu trả lời | Agent chỉ tìm frame; VQA handler mới sinh answer từ evidence |
| Query dài có nhiều chi tiết | Balanced | Đưa hành động/đối tượng phân biệt nhất lên đầu; giữ tối đa 2–4 dấu hiệu trực quan chính | Query quá dài dễ khiến VLM bám lời mô tả và sinh false positive |
| Query rất mơ hồ như “một người đi bộ” | Query Improver rồi Balanced | Thêm bối cảnh, trang phục, vật thể, hướng chuyển động hoặc chữ xuất hiện; chỉ tăng `TopK` sau khi cải thiện query | Tăng budget với query mơ hồ chủ yếu làm tăng nhiễu và token |

### Preset hành động ngắn

```powershell
.\scripts\run_agent.ps1 `
  -Query "a person quickly closes a motorcycle fuel cap" `
  -Task textual_kis `
  -Profile balanced `
  -TopK 50 `
  -VideoBudget 5 `
  -BatchSize 8 `
  -TemporalWindowSeconds 20 `
  -TemporalWindowsPerVideo 3 `
  -TemporalSampleFps 3 `
  -TemporalFinalRadiusSeconds 1.5 `
  -TemporalStopScore 0.80 `
  -Yes
```

Nếu hành động vẫn bị lọt giữa hai sample, tạo **run mới** với
`-TemporalSampleFps 5`. Không resume run cũ vì inventory sample đã được cố định lúc
tạo run.

### Preset TRAKE/nhiều sự kiện

```powershell
.\scripts\run_agent.ps1 `
  -Query "first the rider closes the fuel cap, then another rider crosses left to right" `
  -Task trake `
  -Profile accurate `
  -TopK 100 `
  -VideoBudget 10 `
  -BatchSize 4 `
  -TemporalWindowSeconds 45 `
  -TemporalMergeGapSeconds 20 `
  -TemporalWindowsPerVideo 4 `
  -TemporalSampleFps 2 `
  -TemporalFinalRadiusSeconds 3 `
  -TemporalStopScore 0.88 `
  -Yes
```

### Preset OCR kết hợp hình ảnh

Trước tiên search cụm chữ chính xác trên OCR, ví dụ `mazut fuel oil prices`. Sau đó
dùng query kết hợp chữ và ngữ cảnh:

```powershell
.\scripts\run_agent.ps1 `
  -Query "on-screen mazut fuel oil prices while motorcycle drivers wait at a gas station" `
  -Task textual_kis `
  -Profile balanced `
  -TopK 50 `
  -VideoBudget 5 `
  -BatchSize 8 `
  -TemporalWindowSeconds 15 `
  -TemporalSampleFps 2 `
  -TemporalFinalRadiusSeconds 1.5 `
  -Yes
```

## 15. Hiểu đúng tác dụng của từng tham số

| Khi gặp vấn đề | Nên chỉnh | Không nên chỉnh nhầm |
|---|---|---|
| Video đúng không nằm trong danh sách agent | Tăng `TopK`, sau đó `VideoBudget` | Tăng FPS không giúp tìm thêm video |
| Đúng video nhưng seed lệch thời gian | Tăng `TemporalWindowSeconds` hoặc `TemporalWindowsPerVideo` | Tăng `TopK` quá cao chỉ thêm seed nhiễu |
| Hành động quá nhanh bị bỏ sót | Tăng `TemporalSampleFps`, sau đó giảm `BatchSize` | Tăng final radius không giúp nếu coarse sample chưa bắt được vùng |
| Có đúng vùng nhưng sai frame sát khoảnh khắc | Tăng `TemporalFinalRadiusSeconds` | Không cần tăng toàn bộ video budget |
| Agent dừng quá sớm ở match trung bình | Tăng `TemporalStopScore` | `TemporalStopScore` không phải ngưỡng để một frame vào `matches` |
| Worker quá chậm/tốn token | Giảm video, window, FPS; dùng Fast | Giảm stop score có thể dừng nhanh nhưng tăng nguy cơ bỏ đáp án tốt hơn |
| Cần xem cell rõ hơn | Giảm `BatchSize` xuống 4–8 | `detail=high` hiện dễ timeout qua provider đang dùng |

Một raw frame chỉ vào `matches` khi final verifier trả `match=true` và điểm ít nhất
0,65. `TemporalStopScore` chỉ quyết định khi nào worker được phép dừng sớm sau một
kết quả tốt; đặt 0,88 nghĩa là worker tiếp tục tìm nếu mới chỉ có match 0,80.

`PrefilterCandidateRatio` và `VlmCandidateRatio` chủ yếu điều khiển **Dense Cascade**.
Trong `temporal_zoom`, vòng coarse dùng storyboard và vòng cuối dùng một shortlist
CLIP cố định, nên không cần chỉnh hai tỷ lệ này cho các preset thi đấu thông thường.

## 16. Chiến lược cho 25 câu trong 3 giờ

- Dùng Fast mặc định và vẫn search thủ công song song.
- Balanced dành cho câu Fast không có `temporal_final` hợp lý hoặc retrieval có vẻ
  chưa đưa đúng video vào top 3.
- Accurate chỉ dành cho khoảng vài câu khó/điểm cao; không chạy cho cả 25 câu.
- Dùng `-Pilot` hoặc `-MaxBatches 1` để kiểm tra key/model/provider, không dùng làm
  kết quả hoàn chỉnh.
- Mỗi worker phải có `run_id` riêng. Không cho hai worker cùng resume một run.
- Khi đổi FPS, window, batch, top-k hoặc video budget, luôn tạo run mới.
