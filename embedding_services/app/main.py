from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import ServiceSettings
from .model import OpenClipTextEncoder, TextEmbeddingEncoder, validate_embedding
from .schemas import EmbedRequest, EmbedResponse

logger = logging.getLogger(__name__)


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

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = ServiceSettings.from_env()
    uvicorn.run("embedding_services.app.main:app", host=settings.host, port=settings.port)
