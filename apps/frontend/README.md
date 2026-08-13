# AIC 2026 Frontend

Frontend Next.js/TypeScript cho workbench qualification theo hướng `frame-first`.

## Luồng frame-first

Luồng operator hiện được bám theo redesign:

1. Sidebar trái giữ toàn bộ điều khiển truy vấn.
2. Bấm `Tìm frame` để lấy danh sách frame ứng viên.
3. Chọn một frame để mở bằng chứng của kết quả đó.
4. Lazy load `Xem video` hoặc `Xem các frame cùng video` khi thật sự cần xác minh thêm.
5. Thêm lựa chọn vào drawer `Đáp án` để kiểm tra hàng đợi trước khi copy payload.

Spec E2E trong `tests/e2e/qualification.spec.ts` được cập nhật theo đúng flow này.

## Chạy local

```powershell
pnpm install
pnpm dev
```

Frontend gọi `/api/v1/search` theo mặc định. Khi chưa có backend, route này có thể trả fixture deterministic để duyệt UI cục bộ. Để proxy sang backend thật:

```powershell
$env:BACKEND_API_URL = "http://localhost:3001"
```

## Media local

Các route lazy preview cho video và keyframe đọc dữ liệu media cục bộ từ `AIC_MEDIA_ROOT`.

- Windows fallback trong code hiện là `E:\aic2026`.
- Nên đặt `AIC_MEDIA_ROOT=E:\aic2026` một cách tường minh trong `.env.local` hoặc môi trường shell để tránh lệch giữa máy dev, E2E và các môi trường không phải Windows.
- Ở production, đặt `AIC_MEDIA_ACCESS_TOKEN` thành một secret dài và nhập cùng giá trị tại `Cài đặt` trong giao diện. Search thành công sẽ tạo cookie phiên `HttpOnly`, sau đó các route video/keyframe mới cho phép truy cập.
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
- `BACKEND_API_URL=http://localhost:3001`
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

E2E sidecar hiện mock các API search/playback/frame-context để giữ flow frame-first deterministic, trong khi route media thật vẫn phụ thuộc `AIC_MEDIA_ROOT`.
