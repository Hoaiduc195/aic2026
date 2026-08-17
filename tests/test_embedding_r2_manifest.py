from __future__ import annotations

import pandas as pd
import pytest

from pipelines.feature_extraction.embedding import r2_manifest


def test_build_r2_identity_uses_embedding_prefix() -> None:
    assert r2_manifest.build_r2_identity("embeddings/L25_V078.npy") == (
        "embeddings/L25_V078.npy",
        "r2://aic/embeddings/L25_V078.npy",
    )


def test_build_r2_identity_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="unsafe embedding object key"):
        r2_manifest.build_r2_identity("embeddings/../secret.npy")


def test_add_r2_identity_columns_is_immutable() -> None:
    source = pd.DataFrame(
        {
            "video_id": ["L25_V078"],
            "embedding_relative_path": ["embeddings/L25_V078.npy"],
        }
    )

    result = r2_manifest.add_r2_identity_columns(source)

    assert "embedding_object_key" not in source.columns
    assert result.loc[0, "embedding_object_key"] == "embeddings/L25_V078.npy"
    assert result.loc[0, "embedding_uri"] == "r2://aic/embeddings/L25_V078.npy"
