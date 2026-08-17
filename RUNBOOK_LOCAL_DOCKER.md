# 🚀 Hướng Dẫn Tự Chạy Toàn Bộ Hệ Thống AIC 2026 (Local & Docker)

Tài liệu này hướng dẫn chi tiết từng bước tự khởi động database, nạp dữ liệu từ thư mục `D:\refined`, dựng index tìm kiếm, kết nối Cloudflare R2 streaming và khởi chạy giao diện Web Workbench.

---

## 🏗️ Kiến Trúc Hệ Thống

| Thành phần | Công nghệ | Cổng (Port) | Vai trò |
|---|---|---|---|
| **PostgreSQL + pgvector** | Docker (`pgvector/pgvector:pg16`) | `5433` | Lưu trữ video/frame metadata, text evidence & 1024-D vector |
| **Embedding Service** | Docker (`Python 3.11`, FastAPI, OpenCLIP) | `8001` | Mã hóa câu hỏi text thành vector 1024-D (`ViT-H-14-CLIPA-336`) |
| **Backend Retrieval API** | NestJS, TypeScript | `4000` | BFF API, Hybrid Fusion RRF, sinh Presigned URL Cloudflare R2 |
| **Frontend Workbench** | Next.js 15, React 19, Tailwind/CSS | `3000` | Giao diện Frame-First, phát video R2, duyệt đáp án VQA/KIS |
| **Cloudflare R2 Storage** | AWS S3 Compatible API | Cloud | Lưu trữ video gốc `.mp4` và ảnh keyframe thumbnail `.webp` |

---

## 📋 Yêu Cầu Môi Trường

1. **Docker Desktop** (bắt buộc bật và chuyển sang trạng thái running).
2. **Python 3.11+** (đã cài đặt `numpy`, `pyarrow`, `psycopg[binary]`).
3. **Node.js >= 20** và `npm` / `pnpm`.

---

## ⚙️ Cấu Hình Biến Môi Trường

### 1. Backend (`apps/backend/.env`)
Đảm bảo file `apps/backend/.env` có các thông số sau:

```env
PORT=4000
CORS_ORIGINS=http://localhost:3000
OPERATOR_TOKEN=

# Database PostgreSQL Local (Docker)
DATABASE_URL=postgres://aic:aic_c85d934992674be59c6e39b45af7c450@127.0.0.1:5433/aic_local
DATABASE_DIRECT_URL=postgres://aic:aic_c85d934992674be59c6e39b45af7c450@127.0.0.1:5433/aic_local

# Cloudflare R2 Streaming
R2_ENDPOINT_URL=https://b68fda0e2abb77a69a45b3d0c30b31d5.r2.cloudflarestorage.com
R2_BUCKET=aic
R2_ACCESS_KEY_ID=7452b5fdb06da02717de28f1f8164c71
R2_SECRET_ACCESS_KEY=d1dd8287bf48550243a38072c28d19fc495ba6cad55fa19a330501db772d3974
R2_REGION=auto
R2_SIGNED_URL_TTL_SECONDS=900

# Embedding Service
EMBEDDING_SERVICE_URL=http://127.0.0.1:8001/embed
EMBEDDING_SERVICE_TOKEN=
EMBEDDING_DIMENSIONS=1024

# Version & Config
DATASET_ID=aic2026
DATASET_VERSION=aic2026
PIPELINE_VERSION=preprocessing-artifacts
ARTIFACT_VERSION=preprocessing-artifacts
INDEX_VERSION=aic2026-local-v1
INDEX_CHECKSUM=sha256:0454bae47aed438fdb95d174bd9622ed42702b3f2aca8017eb00114e1dcc31ed
VERSION_STATUS=active
ALLOW_UNAUTHENTICATED_LOCAL=true
```

### 2. Frontend (`apps/frontend/.env.local`)
Tạo file `apps/frontend/.env.local`:

```env
BACKEND_API_URL=http://localhost:4000
BACKEND_OPERATOR_TOKEN=
NEXT_PUBLIC_API_BASE_URL=/api
```

---

## 🛠️ Hướng Dẫn Từng Bước (Chạy Bằng Terminal)

Mở PowerShell tại thư mục gốc của project: `d:\VSCode\AIC\aic2026`

### Bước 1: Khởi động Docker Containers (Postgres + Embedding)

```powershell
# 1. Đảm bảo ứng dụng Docker Desktop đang chạy trên Windows
# 2. Khởi chạy container database và embedding
docker compose up -d --build postgres embedding
```

> **Kiểm tra**: Chạy `docker ps`, bạn sẽ thấy hai container `aic-postgres` (port 5433) và `aic-embedding` (port 8001) ở trạng thái `Up`.

---

### Bước 2: Tạo Schema Database (Migration)

```powershell
cd apps\backend
npm run db:migrate
cd ..\..
```

---

### Bước 3: Ingest Toàn Bộ Dữ Liệu Từ `D:\refined` Vào Database

```powershell
# Đặt biến môi trường và chạy script nạp
$env:PYTHONPATH = "d:\VSCode\AIC\aic2026"
python -m pipelines.ingestion.import_refined `
  --data-root "D:\refined" `
  --database-url "postgres://aic:aic_c85d934992674be59c6e39b45af7c450@127.0.0.1:5433/aic_local" `
  --index-version aic2026-local-v1
```

*Quá trình này nạp 665 video, 27,743 canonical frames, 221,768 frame aliases, toàn bộ Captions/ASR và 27,743 vectors 1024-D.*

---

### Bước 4: Xây Dựng Chỉ Mục Tìm Kiếm (HNSW Vector Index & Full-Text Search)

```powershell
cd apps\backend
npm run db:build-indexes
npm run db:verify
cd ..\..
```

---

### Bước 5: Khởi Chạy Backend API (Port 4000)

Mở một cửa sổ Terminal riêng:

```powershell
cd d:\VSCode\AIC\aic2026\apps\backend
npm run start:dev
```

---

### Bước 6: Khởi Chạy Frontend Workbench (Port 3000)

Mở một cửa sổ Terminal riêng khác:

```powershell
cd d:\VSCode\AIC\aic2026\apps\frontend
npm run dev
```

---

## 🔍 Kiểm Tra & Thử Nghiệm

### 1. Kiểm tra Health Backend:
Truy cập trên trình duyệt hoặc chạy PowerShell:
```powershell
Invoke-RestMethod -Uri "http://localhost:4000/health" -Method Get | ConvertTo-Json -Depth 5
```
*Kết quả phải trả về `"status": "ok"`, `"database": "healthy"`, `"object_storage": "healthy"`.*

### 2. Kiểm tra Health Embedding Service:
```powershell
Invoke-RestMethod -Uri "http://localhost:8001/health" -Method Get
```
*Kết quả trả về `"status": "ok"`, `"model_name": "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"`.*

### 3. Test Truy Vấn Tìm Kiếm Trực Tiếp:
```powershell
$body = @{ query = "người phụ nữ mặc áo dài đỏ"; task = "textual_kis"; top_k = 3 } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/v1/search" `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 4
```

### 4. Mở Giao Diện Người Dùng:
Mở trình duyệt web và truy cập: **`http://localhost:3000`**

---

## 💡 Lưu Ý & Xử Lý Sự Cố Thường Gặp

1. **Lỗi Docker daemon không kết nối (`open //./pipe/dockerDesktopLinuxEngine`)**:
   - Mở ứng dụng Docker Desktop trên Windows và đợi biểu tượng cá voi chuyển màu xanh.
   - Không tắt hoàn toàn cửa sổ Docker Desktop (hãy Minimize xuống Taskbar).
2. **Lỗi Tiếng Việt khi test bằng PowerShell**:
   - Dùng cú pháp `[System.Text.Encoding]::UTF8.GetBytes($body)` như hướng dẫn ở Bước kiểm tra để tránh lỗi font UTF-8 trên Windows PowerShell.
3. **Stream Video R2**:
   - Khi tìm kiếm trên giao diện `http://localhost:3000`, bấm vào frame để xem bằng chứng, bấm `Xem video` để phát video trực tiếp qua presigned URL của Cloudflare R2.
