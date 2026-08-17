"""Build credential-free R2 identities for visual embedding artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

import pandas as pd

from ...preprocessing.io_utils import (
    write_csv_atomic,
    write_json_atomic,
    write_parquet_atomic,
)

_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _normalize_prefix(prefix: str) -> str:
    value = str(prefix).replace("\\", "/").strip("/")
    if not value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("embedding R2 prefix must be a safe non-empty path")
    if any(not _SAFE_COMPONENT.fullmatch(part) for part in value.split("/")):
        raise ValueError("embedding R2 prefix contains an unsafe component")
    return value


def build_r2_identity(
    relative_path: str | Path,
    *,
    bucket: str = "aic",
    prefix: str = "embeddings",
) -> tuple[str, str]:
    """Return ``(object_key, r2_uri)`` for one local embedding path."""

    if not _SAFE_COMPONENT.fullmatch(str(bucket)):
        raise ValueError("embedding R2 bucket must be a safe name")
    normalized = str(relative_path).replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or path.is_absolute()
        or ".." in path.parts
        or path.name in {"", ".", ".."}
        or path.suffix.lower() != ".npy"
    ):
        raise ValueError("unsafe embedding object key")
    normalized_prefix = _normalize_prefix(prefix)
    object_key = normalized
    if object_key != normalized_prefix and not object_key.startswith(normalized_prefix + "/"):
        object_key = f"{normalized_prefix}/{object_key}"
    return object_key, f"r2://{bucket}/{object_key}"


def add_r2_identity_columns(
    frame: pd.DataFrame,
    *,
    bucket: str = "aic",
    prefix: str = "embeddings",
) -> pd.DataFrame:
    """Return a copy of an embedding index with stable R2 identities."""

    if "embedding_relative_path" not in frame.columns:
        raise ValueError("embedding index is missing embedding_relative_path")
    result = frame.copy(deep=True)
    identities = [
        build_r2_identity(value, bucket=bucket, prefix=prefix)
        for value in result["embedding_relative_path"]
    ]
    object_keys = [identity[0] for identity in identities]
    uris = [identity[1] for identity in identities]
    for column, values in (("embedding_object_key", object_keys), ("embedding_uri", uris)):
        if column in result.columns:
            existing = result[column].astype(str)
            if not existing.eq(pd.Series(values, index=result.index)).all():
                raise ValueError(f"existing {column} conflicts with derived R2 identity")
        result[column] = values
    return result


def _sha256_and_size(path: Path, chunk_size: int = 8 * 1024 * 1024) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def build_artifact_manifest(
    embedding_index: pd.DataFrame,
    *,
    local_embeddings_dir: str | Path,
    bucket: str = "aic",
    prefix: str = "embeddings",
) -> pd.DataFrame:
    """Build one upload/provenance row per local ``.npy`` artifact."""

    index = add_r2_identity_columns(embedding_index, bucket=bucket, prefix=prefix)
    required = {"video_id", "embedding_relative_path", "embedding_dim", "dtype", "model_name", "model_version"}
    missing = sorted(required - set(index.columns))
    if missing:
        raise ValueError(f"embedding index is missing columns: {missing}")

    root = Path(local_embeddings_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"local embedding directory does not exist: {root}")
    rows: list[dict[str, Any]] = []
    for video_id, group in index.groupby("video_id", sort=True):
        relative = str(group["embedding_relative_path"].iloc[0]).replace("/", "\\")
        local_path = root / Path(relative).name
        if not local_path.is_file():
            raise FileNotFoundError(f"missing local embedding artifact: {local_path}")
        sha256, size_bytes = _sha256_and_size(local_path)
        row = group.iloc[0]
        rows.append(
            {
                "video_id": str(video_id),
                "artifact_type": "npy",
                "local_path": str(local_path.resolve()),
                "embedding_object_key": str(row["embedding_object_key"]),
                "embedding_uri": str(row["embedding_uri"]),
                "sha256": sha256,
                "size_bytes": size_bytes,
                "record_count": len(group),
                "embedding_dim": int(row["embedding_dim"]),
                "dtype": str(row["dtype"]),
                "normalized": bool(row["normalized"]),
                "model_name": str(row["model_name"]),
                "model_version": str(row["model_version"]),
                "upload_status": "pending",
            }
        )
    return pd.DataFrame(rows).sort_values("video_id", kind="stable").reset_index(drop=True)


def prepare_embedding_r2_manifest(
    *,
    data_root: str | Path,
    bucket: str = "aic",
    prefix: str = "embeddings",
) -> dict[str, Any]:
    """Add R2 identities to refined embedding artifacts and write an upload manifest."""

    root = Path(data_root)
    refined = root / "refined"
    index_path = refined / "embedding_index.parquet"
    index = pd.read_parquet(index_path)
    enriched = add_r2_identity_columns(index, bucket=bucket, prefix=prefix)
    write_parquet_atomic(enriched, index_path)
    write_csv_atomic(enriched, index_path.with_suffix(".csv"))

    artifact_manifest = build_artifact_manifest(
        enriched,
        local_embeddings_dir=refined / "embeddings",
        bucket=bucket,
        prefix=prefix,
    )
    manifest_path = refined / "embedding_r2_manifest.parquet"
    write_parquet_atomic(artifact_manifest, manifest_path)
    write_csv_atomic(artifact_manifest, manifest_path.with_suffix(".csv"))

    metadata_path = refined / "embedding_artifacts.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    by_video = artifact_manifest.set_index("video_id").to_dict("index")
    for artifact in metadata:
        current = by_video[str(artifact["video_id"])]
        artifact.update(
            {
                "embedding_object_key": current["embedding_object_key"],
                "embedding_uri": current["embedding_uri"],
                "sha256": current["sha256"],
                "size_bytes": current["size_bytes"],
                "r2_upload_status": "pending",
            }
        )
    write_json_atomic(metadata, metadata_path)

    report_path = refined / "normalization_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    old_blocker = "R2 object URIs are not available for vector artifacts"
    pending_blocker = "R2 vector artifacts have not been uploaded or verified"
    report["blockers"] = [
        pending_blocker if blocker == old_blocker else blocker
        for blocker in report.get("blockers", [])
    ]
    if pending_blocker not in report["blockers"]:
        report["blockers"].append(pending_blocker)
    report["vector_artifacts"] = {
        "status": "r2_upload_pending",
        "bucket": bucket,
        "object_prefix": prefix,
        "artifact_count": len(artifact_manifest),
        "total_bytes": int(artifact_manifest["size_bytes"].sum()),
        "manifest": "embedding_r2_manifest.parquet",
    }
    report["status"] = "staging_not_import_ready"
    write_json_atomic(report, report_path)
    return {
        "artifact_count": len(artifact_manifest),
        "total_bytes": int(artifact_manifest["size_bytes"].sum()),
        "manifest_path": str(manifest_path),
        "status": "r2_upload_pending",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\workspace\aic\data"))
    parser.add_argument("--bucket", default="aic")
    parser.add_argument("--prefix", default="embeddings")
    return parser


def main() -> None:
    args = _parser().parse_args()
    print(
        json.dumps(
            prepare_embedding_r2_manifest(
                data_root=args.data_root,
                bucket=args.bucket,
                prefix=args.prefix,
            ),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
