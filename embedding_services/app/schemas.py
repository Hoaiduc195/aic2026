from __future__ import annotations

from pydantic import BaseModel, ConfigDict, field_validator


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
