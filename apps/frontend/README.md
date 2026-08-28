# AIC 2026 Frontend Workbench

Frontend là ứng dụng Next.js/React/TypeScript cho operator duyệt kết quả
retrieval và tạo submission preview. UI đi theo mô hình `frame-first`: mỗi kết
quả có một source frame rõ ràng, còn video, frame lân cận và metadata được tải
lazy khi operator cần xác minh.

## Luồng sử dụng

1. Chọn task và nhập query trong sidebar.
2. Bấm `Tìm frame` để lấy các candidate từ `/api/v1/search`.
3. Chọn một frame để xem evidence, canonical frame hoặc video studio.
4. Với VQA/TRAKE, đưa frame vào queue và chỉnh đáp án thủ công.
5. Lưu selection và tạo JSON/CSV submission preview trong drawer `Đáp án`.

Frontend hỗ trợ các task qualification `textual_kis`, `vqa` và `trake`. Search
API còn nhận các task retrieval khác theo contract backend.

## Kiến trúc runtime

```text
Browser
  -> Next.js route handlers (/api/v1/*)
  -> NestJS backend (server-to-server, nếu được cấu hình)
  -> PostgreSQL/pgvector, R2 và các model service tùy chọn
```

Browser chỉ gọi các route `/api/v1/*`. `BACKEND_API_URL` và
`BACKEND_OPERATOR_TOKEN` chỉ được đọc ở server; BFF forward token tới backend
và không gửi token đó xuống browser.

Khi `BACKEND_API_URL` để trống, search dùng fixture deterministic để phát triển
UI. Những route cần persistence hoặc media backend trả `503` thay vì tạo dữ
liệu giả.

## Cài đặt và chạy local

Yêu cầu Node.js `>=20`. Từ thư mục này:

```powershell
corepack enable
pnpm install
pnpm dev
```

Mở <http://localhost:3000>. Để dùng backend thật, tạo `.env.local` từ file
mẫu rồi điền `BACKEND_API_URL` và token tương ứng:

```powershell
Copy-Item .env.example .env.local
```

```env
BACKEND_API_URL=http://localhost:4000
BACKEND_OPERATOR_TOKEN=replace-with-backend-operator-token
NEXT_PUBLIC_API_BASE_URL=/api
```

Backend và database có hướng dẫn riêng tại
[`../backend/README.md`](../backend/README.md). Cách khởi động cả stack nằm ở
[`../../README.md`](../../README.md) và [`../../RUNBOOK_LOCAL_DOCKER.md`](../../RUNBOOK_LOCAL_DOCKER.md).

## Frame lân cận và xuất CSV

Sau khi có kết quả search, panel `Frame lân cận` cho phép:

- chọn frame tâm từ danh sách kết quả hiện tại;
- chọn Top-K từ `1` đến `100`, mặc định `4`; số lượng này **đã gồm frame tâm**;
- chọn `frame_step` từ `1` đến `100.000` frame nguồn, mặc định `1`, để điều khiển khoảng cách bao quát;
- gọi `GET /api/v1/videos/:videoId/frames?center_frame_id=...&limit=...&frame_step=...`;
- xem danh sách frame cùng video theo timeline và đánh dấu frame tâm;
- sau khi tải, các frame mới được chèn ngay dưới frame tâm trong danh sách `Kết quả frame`, loại trùng theo `(video_id, original_frame_id)`; danh sách này có thể vượt số lượng hiển thị ban đầu;
- nút fill answer queue luôn chỉ nạp tối đa `100` frame theo thứ tự hiện tại của danh sách kết quả;
- xuất CSV sau khi tải thành công.

CSV có các cột `video_id`, `original_frame_id`, `keyframe_no`, `timestamp_ms`
và `is_center`. Dữ liệu export chỉ giữ các frame thuộc cùng video với frame
tâm, loại duplicate theo `(video_id, original_frame_id)`, đồng thời bảo vệ
các cell bắt đầu bằng `=`, `+`, `-` hoặc `@` khi mở bằng spreadsheet.

Backend có thể trả frame sparse hoặc decode exact source frame bằng FFmpeg khi
thumbnail chưa tồn tại. Frontend không tự suy ra frame ID từ timestamp.

## Media local và R2

Khi backend/R2 đã cấu hình, playback và thumbnail dùng signed URL do server
cấp. Khi backend chưa cấu hình, các route lazy preview có thể dùng local media
root qua `AIC_MEDIA_ROOT`.

Local media tối thiểu nên có:

```text
<AIC_MEDIA_ROOT>/
├── videos/
├── keyframes/
├── map-keyframes-aic25-b1/map-keyframes/
└── media-info-aic25-b1/media-info/
```

Windows fallback trong code là `E:\aic2026`, nhưng nên đặt giá trị rõ ràng để
local, E2E và máy khác dùng cùng layout. `AIC_MEDIA_ACCESS_TOKEN` là secret
server-only; không bật `AIC_ALLOW_UNAUTHENTICATED_MEDIA=true` trên máy có thể
truy cập từ mạng ngoài.

## Biến môi trường

| Biến | Phạm vi | Bắt buộc | Mục đích |
|---|---|---:|---|
| `BACKEND_API_URL` | Server | Không | URL NestJS; bỏ trống để dùng fixture search |
| `BACKEND_OPERATOR_TOKEN` | Server | Không ở local | Token BFF forward tới backend |
| `NEXT_PUBLIC_API_BASE_URL` | Browser | Không | Base route của browser, mặc định `/api` |
| `AIC_MEDIA_ROOT` | Server | Không | Root media local cho fallback |
| `AIC_MEDIA_ACCESS_TOKEN` | Server | Không | Bảo vệ session media local |
| `AIC_ALLOW_UNAUTHENTICATED_MEDIA` | Server | Không | Chỉ dùng trong môi trường local cô lập |

Không đặt credential, R2 key, LLM/VLM key hoặc backend token dưới tiền tố
`NEXT_PUBLIC_`; mọi biến có tiền tố đó có thể xuất hiện trong bundle browser.

## API routes của Next.js

| Nhóm | Route |
|---|---|
| Search | `/api/v1/search`, `/api/v1/search/exact-frames` |
| Query/VQA | `/api/v1/query/improve`, `/api/v1/vqa/answer` |
| Video/frame | `/api/v1/videos/:videoId/*`, `/api/v1/media/*` |
| Manual review | `/api/v1/queries/:queryId/candidates`, `/selection` |
| Submission | `/api/v1/submissions/preview` |

Contract response được parse và validate ở `src/lib/api.ts` trước khi đưa vào
UI. Thay đổi payload nên cập nhật `src/lib/contracts.ts` và test route tương
ứng cùng lúc.

## Kiểm tra

```powershell
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

E2E trong `tests/e2e/qualification.spec.ts` mock API để flow frame-first ổn
định. Integration với backend thật cần backend, database, embedding service và
R2 (nếu cần playback) được cấu hình riêng.
