# Florence-2 image captioning trên Modal

Module gửi keyframe local theo batch giới hạn tới một Modal GPU chạy
`microsoft/Florence-2-base` và ghi một caption tiếng Anh cho mỗi ảnh. Frame
không được copy vào Modal Volume; volume chỉ giữ Hugging Face model cache.

Caption tiếng Anh là artifact canonical được ingestion sử dụng. Dịch tiếng
Việt là bước downstream độc lập và output `captioning_vi/` không được importer
canonical nạp vào database.

## Input và output

Input phải có một thư mục cho mỗi video:

```text
keyframes/
├── L21_V001/
│   ├── 001.jpg
│   └── 002.jpg
└── L21_V002/
    └── 001.jpg
```

Output giữ nguyên layout:

```text
captioning/
├── L21_V001/001.txt
├── L21_V001/002.txt
└── run_batch_0_of_3.jsonl
```

JSONL là progress/error manifest append-only. File `.txt` đã tồn tại, kể cả
file rỗng, được xem là đã xử lý và bỏ qua trừ khi có `--overwrite`.

## Cài đặt và xác thực Modal

```powershell
python -m pip install -r pipelines/feature_extraction/captioning/requirements-modal.txt
modal token new
```

Florence-2, PyTorch, Transformers, Accelerate và Pillow được cài trong remote
image. Worker giữ model trong memory và dynamic-batch trên T4.

## Chạy pilot

Luôn dry-run một partition trước:

```powershell
modal run pipelines/feature_extraction/captioning/modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 `
  --max-images 500 --dry-run
```

Chạy pilot thật bằng cách bỏ `--dry-run`, giữ `--max-images 500` để kiểm tra
chất lượng caption. Sau khi duyệt sample mới chạy toàn bộ dataset:

```powershell
modal run pipelines/feature_extraction/captioning/modal_florence_captioning.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\captioning `
  --batch-index 0 --num-batches 3 `
  --budget-usd 25
```

Các worker độc lập dùng `--batch-index` từ `0` đến `--num-batches - 1`. Không
cho hai process ghi cùng output partition. Chạy lại cùng command sẽ resume
những file còn thiếu; dùng `--overwrite` chỉ khi chủ động regenerate.

## Điều chỉnh throughput và chi phí

- `--batch-size` là submission window local, không phải GPU batch cố định;
- `--max-new-tokens` và `--num-beams` đổi chất lượng/thời gian generation;
- `--max-retries` chỉ nên retry lỗi transient;
- `--budget-usd` là guardrail ước tính theo thời gian remote, không phải hóa
  đơn Modal chính thức;
- `--gpu-rate-usd-per-hour` dùng để hiệu chỉnh ước tính khi giá GPU thay đổi.

Mặc định greedy decoding (`--num-beams 1`) ưu tiên throughput. Tăng beams chỉ
sau khi pilot cho thấy chất lượng cần cải thiện.

## Dịch sang tiếng Việt

Cài dependency dịch local:

```powershell
python -m pip install -r pipelines/feature_extraction/captioning/requirements-translation.txt
```

Translator dùng model pinned `Helsinki-NLP/opus-mt-en-vi`, deduplicate caption
trùng trước inference, giữ nguyên file tiếng Anh và resume file tiếng Việt:

```powershell
python -m pipelines.feature_extraction.captioning.translate_captions `
  --input-dir E:\aic2026\captioning `
  --output-dir E:\aic2026\captioning_vi `
  --batch-size 64 --device auto
```

Có thể chia deterministic partitions bằng `--batch-index` và `--num-batches`.
Dùng `--overwrite` để dịch lại output đã có. CUDA được dùng nếu khả dụng,
ngược lại translator chạy CPU.

## Kiểm tra

```powershell
python -m unittest tests.test_captioning_modal tests.test_translation_captions -v
```

Test local không cần Modal SDK hoặc GPU. Cần một pilot Modal thật để xác nhận
model loading, quota và chất lượng caption trước full run.
