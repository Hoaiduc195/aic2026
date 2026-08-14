# AIC 2026 Frontend

Frontend Next.js/TypeScript cho workbench qualification theo hướng `frame-first`.

## Luồng frame-first

Luồng operator hiện được bám theo redesign:

1. Sidebar trái giữ toàn bộ điều khiển truy vấn.
2. Bấm `Tìm frame` để lấy danh sách frame ứng viên.
3. Chọn một frame để mở bằng chứng của kết quả đó.
4. Lazy load `Xem video` hoặc `Xem các frame cùng video` khi thật sự cần xác minh thêm.
5. Thêm lựa chọn vào drawer `Đáp án`, lưu selection và tạo submission preview.

Spec E2E trong `tests/e2e/qualification.spec.ts` được cập nhật theo đúng flow này.

## Chạy local

```powershell
pnpm install
pnpm dev
```

Browser chỉ gọi các route `/api/v1/*` của Next.js. Khi `BACKEND_API_URL` được cấu hình,
Next.js BFF sẽ gọi NestJS server-to-server và forward `BACKEND_OPERATOR_TOKEN` mà
không đưa token xuống browser:

```powershell
$env:BACKEND_API_URL = "http://localhost:4000"
$env:BACKEND_OPERATOR_TOKEN = "same-value-as-backend-OPERATOR_TOKEN"
```

Khi chưa có backend, search vẫn dùng fixture deterministic; các manual API trả
`503` để tránh ghi dữ liệu giả.

## Media backend và local fallback

Khi backend được cấu hình, playback và keyframe metadata lấy từ backend, còn
video/keyframe được phục vụ bằng signed URL từ R2. Khi backend chưa cấu hình,
các route lazy preview mới dùng dữ liệu local từ `AIC_MEDIA_ROOT`.

- Windows fallback trong code hiện là `E:\aic2026`.
- Nên đặt `AIC_MEDIA_ROOT=E:\aic2026` một cách tường minh trong `.env.local` hoặc môi trường shell để tránh lệch giữa máy dev, E2E và các môi trường không phải Windows.
- `BACKEND_OPERATOR_TOKEN` và `AIC_MEDIA_ACCESS_TOKEN` chỉ được cấu hình ở server; không nhập hoặc lưu secret trong browser.
- Search thành công tạo cookie phiên `HttpOnly` khi local media session được bật.
- Dev local không yêu cầu token. Không bật `AIC_ALLOW_UNAUTHENTICATED_MEDIA=true` ở máy có thể truy cập từ mạng ngoài.

Ví dụ:

```powershell
$env:AIC_MEDIA_ROOT = "E:\aic2026"
$env:AIC_MEDIA_ACCESS_TOKEN = "thay-bang-secret-dai"
```

Thư mục root này cần chứa tối thiểu các nhánh mà frontend lazy-load đang dùng:

- `videos`
- `keyframes`
- `map-keyframes-aic25-b1\map-keyframes`
- `media-info-aic25-b1\media-info`

## Biến môi trường

Tham khảo `apps/frontend/.env.example`:

- `AIC_MEDIA_ROOT=E:\aic2026`
- `AIC_MEDIA_ACCESS_TOKEN=replace-with-a-long-random-secret`
- `AIC_ALLOW_UNAUTHENTICATED_MEDIA=false`
- `BACKEND_API_URL=http://localhost:4000`
- `BACKEND_OPERATOR_TOKEN=replace-with-backend-operator-token`
- `NEXT_PUBLIC_API_BASE_URL=/api`

## Kiểm tra

```powershell
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

E2E sidecar hiện mock các API để giữ flow frame-first deterministic. Khi chạy
integration thật, cấu hình `BACKEND_API_URL`, `BACKEND_OPERATOR_TOKEN`, Neon và
R2 ở backend; frontend không cần `AIC_MEDIA_ROOT` cho media production.
