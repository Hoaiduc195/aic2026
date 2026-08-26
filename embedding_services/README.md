# CLIPA query embedding service

Đây là FastAPI service tạo embedding cho text query và raw image. Text encoder
và image encoder dùng cùng checkpoint CLIPA để vector query nằm trong cùng
không gian 1024 chiều với visual embedding đã index.

| Thuộc tính | Giá trị mặc định |
|---|---|
| Model | `hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B` |
| Model version | `visual-embedding-clipa-v2-h14` |
| Dimension | `1024` |
| Port | `8001` |
| Device | `auto` (CUDA nếu có, nếu không CPU) |
| Text limit | `2000` ký tự |
| Image limit | `12 MiB` |

Model weights tải ở lần khởi động đầu tiên và được giữ trong Docker volume.
Service không copy API token vào image.

## API

### Health

```http
GET /health
```

Response cho biết `ready`, model name/version, dimension và device.

### Text embedding

```http
POST /embed
Content-Type: application/json

{"text":"người phụ nữ mặc áo dài đỏ"}
```

Response:

```json
{"embedding":[0.0123,-0.0456]}
```

Response thực tế luôn có 1024 số hữu hạn và được L2-normalize. Text rỗng hoặc
dài hơn giới hạn bị từ chối.

### Image embedding

```http
POST /embed/image
Content-Type: image/jpeg

<raw image bytes>
```

Chấp nhận `image/jpeg`, `image/png`, `image/webp` và `image/gif`. Request có
token phải gửi `Authorization: Bearer <token>`; khi `EMBEDDING_TOKEN` rỗng,
service chạy không auth cho local development.

## Chạy bằng Docker

Từ repository root:

```powershell
docker compose -f embedding_services/docker-compose.yml up -d --build
```

Compose map host port `8001`, tạo volume `aic-embedding-model-cache`, drop toàn
bộ Linux capabilities và bật `no-new-privileges`. Sau lần tạo đầu tiên có thể
start lại mà không build:

```powershell
docker compose -f embedding_services/docker-compose.yml start
```

Root Compose cũng có service tên `embedding`:

```powershell
docker compose up -d --build embedding
```

Backend chạy trên host dùng `http://127.0.0.1:8001/embed`; backend chạy trong
Compose dùng `http://embedding:8001/embed`.

Build/run trực tiếp:

```powershell
docker build -f embedding_services/Dockerfile -t aic-embedding:local .
docker run --rm --name aic-embedding `
  -p 8001:8001 `
  -e EMBEDDING_TOKEN=replace-with-a-secret `
  -v aic-embedding-model-cache:/models `
  aic-embedding:local
```

## Cấu hình

| Biến | Mặc định | Mục đích |
|---|---|---|
| `EMBEDDING_HOST` | `0.0.0.0` | Bind host |
| `EMBEDDING_PORT` | `8001` | Listen port |
| `EMBEDDING_TOKEN` | rỗng | Bearer token tùy chọn |
| `EMBEDDING_MODEL_NAME` | CLIPA checkpoint ở trên | Model name |
| `EMBEDDING_MODEL_VERSION` | `visual-embedding-clipa-v2-h14` | Provenance version |
| `EMBEDDING_DEVICE` | `auto` | `auto`, `cpu` hoặc `cuda` |
| `EMBEDDING_MAX_TEXT_CHARS` | `2000` | Giới hạn text, tối đa 2000 |
| `EMBEDDING_MAX_IMAGE_BYTES` | `12582912` | Giới hạn ảnh, tối đa 12 MiB |
| `EMBEDDING_MODEL_CACHE_DIR` | `/models/huggingface` | Nơi lưu model cache |

Dimension cố định ở `1024` để không làm lệch database contract. Nếu đổi
checkpoint/projection/normalization, phải rebuild visual index tương ứng; cùng
dimension không đủ để bảo đảm tương thích.

## Kiểm tra

```powershell
python -m pip install -r embedding_services/requirements-dev.txt
python -m pytest embedding_services/tests -q
```

Các test dùng fake encoder nên không cần GPU hoặc download model. Smoke test
thực tế cần service ready và có thể mất thời gian ở lần tải checkpoint đầu tiên.
