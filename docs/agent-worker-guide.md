# Hướng dẫn chạy Agent tìm frame

## 1. Kiến trúc đang dùng

Agent worker không đưa toàn bộ frame vào hội thoại Codex/MCP. Luồng thực tế:

1. Backend search caption, OCR, ASR, object và CLIP trên feature local.
2. Top-k frame được gom thành danh sách video tiềm năng.
3. Worker duyệt frame của từng video theo batch.
4. CLIP tự loại score thấp và tự nhận score cao.
5. Chỉ frame nằm giữa hai ngưỡng mới gửi sang VLM.
6. Judgment và cursor được lưu trong PostgreSQL local theo `run_id`.

Video/keyframe vẫn nằm trên R2. Feature và pgvector nằm local. Hai worker phải
dùng hai `run_id` và `worker_id` khác nhau.

## 2. Chọn model và reasoning

Khuyến nghị mặc định:

```text
model             = gpt-5.6-luna
reasoning effort  = low
image detail      = low
max output tokens = 128
VLM concurrency   = 2
```

Luna nhận image input và được OpenAI định vị cho workload nhiều request, nhạy
chi phí. Giá tài liệu hiện tại là 0,20 USD/1M input token và 1,20 USD/1M output
token. Luna hỗ trợ `none`, `low`, `medium`, `high`, `xhigh`, `max`.

| Mức | Khi nào dùng | Đánh đổi |
|---|---|---|
| `none` | Pilot, frame rất rõ, cần tốc độ tối đa | Dễ sai hơn với quan hệ hành động hoặc cảnh mơ hồ |
| `low` | Mặc định cho binary frame relevance | Cân bằng tốt nhất cho batch lớn |
| `medium` | Câu query nhiều vật thể, quan hệ không gian/thời gian | Chậm và nhiều reasoning token hơn |
| `high` trở lên | Chỉ kiểm tra lại vài frame quan trọng | Không phù hợp chạy trên hàng nghìn frame |

Không nên dùng `high/xhigh/max` cho toàn bộ pipeline. Nếu Luna `low` chưa đủ,
phương án tốt hơn là giữ Luna cho pass đầu và dùng `gpt-5.6-terra` cho một tập
borderline rất nhỏ. Terra được OpenAI định vị là model cân bằng chất lượng và
chi phí, nhưng giá text hiện tại cao hơn Luna khoảng 10 lần.

Nguồn chính thức:

- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Hướng dẫn chọn GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)

## 3. Cấu hình secret

Trong `apps/backend/.env`:

```env
AGENT_WORKER_VLM_BASE_URL=https://api.openai.com/v1
AGENT_WORKER_VLM_API_KEY=<OPENAI_API_KEY>
AGENT_WORKER_VLM_MODEL=gpt-5.6-luna
AGENT_WORKER_REASONING_EFFORT=low
AGENT_WORKER_IMAGE_DETAIL=low
AGENT_WORKER_VLM_TIMEOUT_MS=45000
AGENT_WORKER_VLM_MAX_TOKENS=128
AGENT_WORKER_VLM_CONCURRENCY=2
```

Không gửi API key cho thành viên khác và không commit `.env`.

## 4. Cách chạy đơn giản nhất

Từ thư mục repo:

```powershell
.\scripts\run_agent.ps1
```

Script sẽ hỏi query và hiển thị cấu hình trước khi chạy. Nếu backend chưa chạy,
script tự khởi động backend ở chế độ nền. PostgreSQL, embedding service local và
R2 vẫn phải được cấu hình đúng.

Chạy pilot một batch:

```powershell
.\scripts\run_agent.ps1 `
  -Query "a person walking outdoors" `
  -Profile balanced `
  -VideoBudget 1 `
  -BatchSize 4 `
  -Pilot
```

Chạy đầy đủ:

```powershell
.\scripts\run_agent.ps1 `
  -Query "a person walking outdoors" `
  -Task textual_kis `
  -Profile balanced `
  -TopK 10 `
  -VideoBudget 10 `
  -BatchSize 8
```

Resume từ checkpoint:

```powershell
.\scripts\run_agent.ps1 -RunId <run_id> -WorkerId worker-1
```

## 5. Ba profile có sẵn

| Profile | Model mặc định | Reasoning | Detail | Tokens | Concurrency | Mục đích |
|---|---|---:|---:|---:|---:|---|
| `fast` | Luna | `none` | `low` | 80 | 4 | Pilot và latency thấp |
| `balanced` | Luna | `low` | `low` | 128 | 2 | Mặc định khi thi |
| `accurate` | Luna | `medium` | `high` | 192 | 1 | Kiểm tra tập nhỏ khó |

Đổi sang Terra cho lượt kiểm tra khó:

```powershell
.\scripts\run_agent.ps1 `
  -RunId <run_id> `
  -Model gpt-5.6-terra `
  -Profile accurate `
  -MaxBatches 1
```

## 6. Giải thích argument

| Argument | Mặc định | Ý nghĩa |
|---|---:|---|
| `-Query` | hỏi khi chạy | Câu mô tả frame cần tìm. Không dùng khi chỉ resume |
| `-Task` | `textual_kis` | Một trong `textual_kis`, `vqa`, `trake` |
| `-Profile` | `balanced` | Bộ cấu hình tốc độ/chất lượng VLM |
| `-Model` | `gpt-5.6-luna` | Model VLM nhận các frame mơ hồ |
| `-TopK` | `10` | Số frame seed từ retrieval trước khi gom video |
| `-VideoBudget` | `10` | Số video tối đa worker sẽ duyệt sâu |
| `-BatchSize` | `8` | Số frame lấy và commit trong mỗi batch |
| `-MaxBatches` | `0` | `0` là chạy hết; số dương giới hạn batch của lượt này |
| `-Pilot` | tắt | Tự đặt `MaxBatches=1` nếu chưa chỉ định |
| `-RunId` | trống | Resume checkpoint đã có, không tạo coarse search mới |
| `-WorkerId` | sinh ngẫu nhiên | Danh tính process sở hữu lease của run |
| `-Yes` | tắt | Bỏ bước hỏi xác nhận, dùng cho automation |
| `-AutoStartBackend` | `$true` | Cho phép script tự chạy backend nếu cổng 4000 chưa sẵn sàng |

### Tác động của các tham số retrieval

- `TopK` quá thấp có thể bỏ sót video đúng; quá cao làm tăng số video nhiễu.
- `VideoBudget` quyết định trực tiếp coverage và tổng thời gian.
- `BatchSize` không thay đổi tổng frame, nhưng batch nhỏ checkpoint thường xuyên
  hơn; batch lớn giảm số REST call nhưng mất nhiều việc hơn nếu process bị dừng.
- `MaxBatches` là phanh an toàn để pilot hoặc đánh giá chi phí.

### Tác động của các biến môi trường

- `AGENT_CLIP_REJECT_BELOW`: dưới ngưỡng này không gọi VLM và đánh dấu không khớp.
- `AGENT_CLIP_ACCEPT_ABOVE`: trên ngưỡng này không gọi VLM và đánh dấu khớp.
- Khoảng giữa hai ngưỡng là vùng VLM review. Ngưỡng phải được calibrate trên
  ground truth; không tăng auto-accept chỉ để làm pipeline nhanh hơn.
- `AGENT_WORKER_VLM_CONCURRENCY`: số request VLM chạy song song. Luna có thể chịu
  throughput cao, nhưng nên bắt đầu từ 2 để tránh rate limit và nghẽn mạng.
- `AGENT_WORKER_REASONING_EFFORT`: lượng reasoning trước khi trả judgment.
- `AGENT_WORKER_IMAGE_DETAIL`: `low` giảm token/latency; `high` dành cho chữ nhỏ,
  vật thể nhỏ hoặc khác biệt tinh tế.

## 7. Đọc kết quả

Cuối lượt chạy, worker in:

- `frames_processed`: số frame đã commit;
- `clip_auto_rejected` và `clip_auto_accepted`: số frame không gọi VLM;
- `vlm_reviewed`: số frame thực sự gửi sang Luna;
- `elapsed_ms`: thời gian lượt chạy;
- `paused_by_limit`: dừng vì `Pilot/MaxBatches`, có thể resume cùng `run_id`.

Đánh giá đúng cần theo dõi thêm recall/precision trên query có ground truth,
không chỉ nhìn tốc độ hoặc số lượt VLM giảm.
