# CLIPA Query Embedding Service

This FastAPI service creates embeddings for text queries and raw images. The
text and image encoders use the same CLIPA checkpoint, so query vectors share
the 1024-dimensional space used by the indexed visual embeddings.

| Property | Default value |
|---|---|
| Model | `hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B` |
| Model version | `visual-embedding-clipa-v2-h14` |
| Dimension | `1024` |
| Port | `8001` |
| Device | `auto` (CUDA when available, otherwise CPU) |
| Text limit | `2000` characters |
| Image limit | `12 MiB` |

Model weights are downloaded on the first startup and kept in a Docker volume.
The service does not copy API tokens into the image.

## API

### Health

```http
GET /health
```

The response reports `ready`, the model name/version, the dimension, and the
device.

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

The actual response always contains 1024 finite values and is L2-normalized.
Empty text or text longer than the configured limit is rejected.

### Image embedding

```http
POST /embed/image
Content-Type: image/jpeg

<raw image bytes>
```

Accepted media types are `image/jpeg`, `image/png`, `image/webp`, and
`image/gif`. When a token is configured, requests must include
`Authorization: Bearer <token>`. When `EMBEDDING_TOKEN` is empty, the service
runs without authentication for local development.

## Run with Docker

From the repository root:

```powershell
docker compose -f embedding_services/docker-compose.yml up -d --build
```

The Compose file maps host port `8001`, creates the
`aic-embedding-model-cache` volume, drops all Linux capabilities, and enables
`no-new-privileges`. After the first creation, you can start it again without a
build:

```powershell
docker compose -f embedding_services/docker-compose.yml start
```

The root Compose file also defines a service named `embedding`:

```powershell
docker compose up -d --build embedding
```

The backend uses `http://127.0.0.1:8001/embed` when running on the host and
`http://embedding:8001/embed` when running inside Compose.

Build and run directly:

```powershell
docker build -f embedding_services/Dockerfile -t aic-embedding:local .
docker run --rm --name aic-embedding `
  -p 8001:8001 `
  -e EMBEDDING_TOKEN=replace-with-a-secret `
  -v aic-embedding-model-cache:/models `
  aic-embedding:local
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EMBEDDING_HOST` | `0.0.0.0` | Bind host |
| `EMBEDDING_PORT` | `8001` | Listen port |
| `EMBEDDING_TOKEN` | empty | Optional bearer token |
| `EMBEDDING_MODEL_NAME` | CLIPA checkpoint above | Model name |
| `EMBEDDING_MODEL_VERSION` | `visual-embedding-clipa-v2-h14` | Provenance version |
| `EMBEDDING_DEVICE` | `auto` | `auto`, `cpu`, or `cuda` |
| `EMBEDDING_MAX_TEXT_CHARS` | `2000` | Text limit, maximum 2000 |
| `EMBEDDING_MAX_IMAGE_BYTES` | `12582912` | Image limit, maximum 12 MiB |
| `EMBEDDING_MODEL_CACHE_DIR` | `/models/huggingface` | Model cache location |

The dimension is fixed at `1024` to preserve the database contract. If the
checkpoint, projection, or normalization changes, rebuild the corresponding
visual index; matching dimensions alone do not guarantee compatibility.

## Verification

```powershell
python -m pip install -r embedding_services/requirements-dev.txt
python -m pytest embedding_services/tests -q
```

Tests use a fake encoder, so they do not require a GPU or a model download. A
real smoke test requires a ready service and may take time while the checkpoint
is downloaded for the first time.
