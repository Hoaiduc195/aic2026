"""FastAPI adapter for the internal inference service."""

from __future__ import annotations

import os
from dataclasses import asdict

from apps.inference.src.service import EncodeTextRequest, InferenceService

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict, Field
except ImportError as exc:  # pragma: no cover - clear startup error in minimal environments
    raise RuntimeError("Install the inference runtime dependencies") from exc


class EncodeTextPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    request_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=4096)
    model_family: str = Field(min_length=1, max_length=128)
    model_revision: str = Field(min_length=1, max_length=128)
    deadline_ms: int = Field(ge=1, le=30_000)


MODEL_FAMILY = os.getenv("AIC_INFERENCE_MODEL_FAMILY", "mock-multilingual")
MODEL_REVISION = os.getenv("AIC_INFERENCE_MODEL_REVISION", "2026-07")
MODEL_DIMENSION = int(os.getenv("AIC_INFERENCE_MODEL_DIMENSION", "64"))

service = InferenceService(
    allowed_models={MODEL_FAMILY: MODEL_REVISION},
    dimensions={MODEL_FAMILY: MODEL_DIMENSION},
)
app = FastAPI(title="AIC 2026 internal inference", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "model_family": MODEL_FAMILY, "model_revision": MODEL_REVISION}


@app.post("/v1/encode/text")
def encode_text(payload: EncodeTextPayload) -> dict[str, object]:
    try:
        response = service.encode_text(EncodeTextRequest(**payload.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return asdict(response)
