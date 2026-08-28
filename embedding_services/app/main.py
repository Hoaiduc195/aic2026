from __future__ import annotations

import base64
import binascii
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status

from .config import ServiceSettings
from .model import OpenClipTextEncoder, TextEmbeddingEncoder, validate_embedding
from .schemas import EmbedImagesRequest, EmbedImagesResponse, EmbedRequest, EmbedResponse

logger = logging.getLogger(__name__)
SUPPORTED_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def _require_bearer_token(settings: ServiceSettings, authorization: str | None) -> None:
    if not settings.token:
        return
    prefix = "Bearer "
    supplied = authorization[len(prefix):].strip() if authorization and authorization.startswith(prefix) else ""
    if not supplied or not secrets.compare_digest(supplied, settings.token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="embedding service unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


def create_app(
    *,
    settings: ServiceSettings | None = None,
    encoder: TextEmbeddingEncoder | None = None,
) -> FastAPI:
    resolved_settings = settings or ServiceSettings.from_env()
    loaded_encoder = encoder

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal loaded_encoder
        if loaded_encoder is None:
            loaded_encoder = OpenClipTextEncoder.from_settings(resolved_settings)
        yield

    app = FastAPI(
        title="AIC CLIPA query embedding service",
        version=resolved_settings.model_version,
        lifespan=lifespan,
    )

    async def authenticate(authorization: Annotated[str | None, Header()] = None) -> None:
        _require_bearer_token(resolved_settings, authorization)

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "ready": loaded_encoder is not None,
            "model_name": resolved_settings.model_name,
            "model_version": resolved_settings.model_version,
            "dimensions": resolved_settings.dimensions,
            "device": getattr(loaded_encoder, "device", None),
        }

    @app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(authenticate)])
    async def embed(request: EmbedRequest) -> EmbedResponse:
        if len(request.text) > resolved_settings.max_text_chars:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"text must contain at most {resolved_settings.max_text_chars} characters",
            )
        if loaded_encoder is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="embedding service is not ready")
        try:
            values = validate_embedding(
                loaded_encoder.embed_text(request.text),
                resolved_settings.dimensions,
            )
        except Exception:
            logger.exception("embedding inference failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="embedding inference failed") from None
        return EmbedResponse(embedding=values)

    @app.post("/embed/image", response_model=EmbedResponse, dependencies=[Depends(authenticate)])
    async def embed_image(
        request: Request,
        content_type: Annotated[str | None, Header()] = None,
    ) -> EmbedResponse:
        mime_type = (content_type or "").split(";", 1)[0].strip().lower()
        if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="content-type must be a supported image MIME type",
            )
        declared_length = request.headers.get("content-length")
        if declared_length is not None:
            try:
                declared_bytes = int(declared_length)
                if declared_bytes < 0:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="content-length is invalid")
                if declared_bytes > resolved_settings.max_image_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"image must contain between 1 byte and {resolved_settings.max_image_bytes} bytes",
                    )
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="content-length is invalid") from None

        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > resolved_settings.max_image_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"image must contain between 1 byte and {resolved_settings.max_image_bytes} bytes",
                )
            chunks.append(chunk)
        image = b"".join(chunks)
        if not image:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"image must contain between 1 byte and {resolved_settings.max_image_bytes} bytes",
            )
        if loaded_encoder is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="embedding service is not ready")
        try:
            values = validate_embedding(
                loaded_encoder.embed_image(image, mime_type),
                resolved_settings.dimensions,
            )
        except Exception:
            logger.exception("image embedding inference failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="embedding inference failed") from None
        return EmbedResponse(embedding=values)

    @app.post("/embed/images", response_model=EmbedImagesResponse, dependencies=[Depends(authenticate)])
    async def embed_images(request: EmbedImagesRequest) -> EmbedImagesResponse:
        if loaded_encoder is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="embedding service is not ready")
        decoded: list[tuple[bytes, str]] = []
        total_bytes = 0
        for index, item in enumerate(request.images):
            mime_type = item.mime_type.strip().lower()
            if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
                raise HTTPException(
                    status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    detail=f"images[{index}].mime_type is not supported",
                )
            try:
                image = base64.b64decode(item.data_base64, validate=True)
            except (binascii.Error, ValueError):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"images[{index}].data_base64 is invalid",
                ) from None
            if not image or len(image) > resolved_settings.max_image_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"images[{index}] must contain between 1 byte and {resolved_settings.max_image_bytes} bytes",
                )
            total_bytes += len(image)
            if total_bytes > resolved_settings.max_image_bytes * 32:
                raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="image batch is too large")
            decoded.append((image, mime_type))
        try:
            raw_embeddings = loaded_encoder.embed_images(decoded)
            if len(raw_embeddings) != len(decoded):
                raise ValueError("encoder returned the wrong batch size")
            embeddings = [
                validate_embedding(values, resolved_settings.dimensions)
                for values in raw_embeddings
            ]
        except Exception:
            logger.exception("batch image embedding inference failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="embedding inference failed") from None
        return EmbedImagesResponse(embeddings=embeddings)

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = ServiceSettings.from_env()
    uvicorn.run("embedding_services.app.main:app", host=settings.host, port=settings.port)
