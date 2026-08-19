# AIC query embedding service

This service exposes text embeddings from the same CLIPA checkpoint used for the indexed image vectors:

- model: `hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B`
- model version: `visual-embedding-clipa-v2-h14`
- output: `float32`-compatible, L2-normalized vector with 1024 values
- endpoint: `POST /embed` with `{ "text": "..." }`
- image endpoint: `POST /embed/image` with raw JPEG/PNG/WebP/GIF bytes and the matching `Content-Type`
- response: `{ "embedding": [ ...1024 numbers... ] }`
- image requests are limited to 12 MiB and use the same CLIPA image encoder/checkpoint as the indexed vectors

The model weights are downloaded on first startup and should be kept in a Docker volume. The API token is supplied at runtime and is never copied into the image.

For the normal setup, use the included Compose file. It creates the container with the fixed host mapping `8001:8001`, so starting the `aic-embedding` container from Docker Desktop keeps the same port:

```powershell
docker compose -f embedding_services/docker-compose.yml up -d --build
```

After the first creation, use **Start** for `aic-embedding` in Docker Desktop, or run:

```powershell
docker compose -f embedding_services/docker-compose.yml start
```

The direct Docker equivalent is:

```powershell
docker build -f embedding_services/Dockerfile -t aic-embedding:local .
docker run --rm --name aic-embedding `
  -p 8001:8001 `
  -e EMBEDDING_TOKEN=replace-me `
  -v aic-embedding-model-cache:/models `
  aic-embedding:local
```

The backend calls the configured `/embed` URL for text and automatically uses `/embed/image` for frame-image queries. The frontend may override that URL, token and timeout. `EMBEDDING_DEVICE=auto` selects CUDA when available and otherwise CPU.

For the normal local Docker setup, point the backend to `http://host.docker.internal:8001/embed` when the backend itself runs in a container. If backend and embedding service run directly on the host, use `http://127.0.0.1:8001/embed` instead.
