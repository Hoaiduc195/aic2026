from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("text must contain at least one non-whitespace character")
        return normalized


class EmbedResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    embedding: list[float]


class EmbedImageItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mime_type: str
    data_base64: str


class EmbedImagesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    images: list[EmbedImageItem] = Field(min_length=1, max_length=32)


class EmbedImagesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    embeddings: list[list[float]]
