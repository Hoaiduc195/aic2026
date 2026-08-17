"""Idempotently upload the refined embedding matrices to Cloudflare R2."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import pandas as pd

from ...preprocessing.io_utils import write_json_atomic, write_parquet_atomic

PENDING_BLOCKER = "R2 vector artifacts have not been uploaded or verified"
OLD_BLOCKER = "R2 object URIs are not available for vector artifacts"


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name:
            os.environ.setdefault(name, value)


def _bridge_r2_credentials() -> None:
    """Expose R2 names to boto3 without writing credentials to artifacts."""

    for source, destination in (
        ("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        ("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
        ("R2_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
    ):
        value = os.environ.get(source)
        if value:
            os.environ.setdefault(destination, value)


def _r2_client(*, env_file: Path | None, bucket: str):
    if env_file is not None:
        _load_env_file(env_file)
    _bridge_r2_credentials()
    account_id = os.environ.get("R2_ACCOUNT_ID")
    endpoint = os.environ.get("R2_ENDPOINT_URL")
    if endpoint is None and account_id:
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    if not endpoint:
        raise RuntimeError("R2 endpoint is not configured")
    configured_bucket = os.environ.get("R2_BUCKET") or os.environ.get("R2_BUCKET_NAME")
    if configured_bucket and configured_bucket != bucket:
        raise RuntimeError("configured R2 bucket does not match manifest bucket")
    try:
        import boto3
    except ModuleNotFoundError as error:
        raise RuntimeError("boto3 is required for R2 upload") from error
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.environ.get("R2_REGION", "auto"),
    )


def _manifest_bucket(manifest: pd.DataFrame, requested_bucket: str | None) -> str:
    buckets = {
        urlsplit(str(uri)).netloc
        for uri in manifest["embedding_uri"]
        if urlsplit(str(uri)).scheme == "r2"
    }
    if len(buckets) != 1:
        raise ValueError("embedding manifest must contain exactly one R2 bucket")
    bucket = next(iter(buckets))
    if requested_bucket is not None and requested_bucket != bucket:
        raise ValueError("requested bucket does not match embedding manifest")
    return bucket


def _object_matches(client, *, bucket: str, key: str, sha256: str, size_bytes: int) -> bool:
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except Exception as error:  # boto3's ClientError is optional at import time
        response = getattr(error, "response", {})
        code = str(response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise
    metadata = {str(key).lower(): str(value) for key, value in head.get("Metadata", {}).items()}
    return int(head.get("ContentLength", -1)) == size_bytes and metadata.get("sha256") == sha256


def upload_manifest(
    manifest_path: str | Path,
    *,
    env_file: str | Path | None = None,
    bucket: str | None = None,
    dry_run: bool = False,
) -> dict[str, int | str]:
    """Upload each pending matrix and persist verified status/checksums."""

    path = Path(manifest_path)
    manifest = pd.read_parquet(path).copy(deep=True)
    required = {"local_path", "embedding_object_key", "embedding_uri", "sha256", "size_bytes"}
    missing = sorted(required - set(manifest.columns))
    if missing:
        raise ValueError(f"embedding R2 manifest is missing columns: {missing}")
    target_bucket = _manifest_bucket(manifest, bucket)
    client = None if dry_run else _r2_client(
        env_file=Path(env_file) if env_file is not None else None,
        bucket=target_bucket,
    )

    statuses: list[str] = []
    for row in manifest.to_dict("records"):
        local_path = Path(str(row["local_path"]))
        key = str(row["embedding_object_key"])
        sha256 = str(row["sha256"])
        size_bytes = int(row["size_bytes"])
        if dry_run:
            statuses.append("pending")
            continue
        if _object_matches(
            client,
            bucket=target_bucket,
            key=key,
            sha256=sha256,
            size_bytes=size_bytes,
        ):
            statuses.append("already_verified")
            continue
        with local_path.open("rb") as handle:
            client.put_object(
                Bucket=target_bucket,
                Key=key,
                Body=handle,
                ContentType="application/octet-stream",
                Metadata={"sha256": sha256},
            )
        if not _object_matches(
            client,
            bucket=target_bucket,
            key=key,
            sha256=sha256,
            size_bytes=size_bytes,
        ):
            raise RuntimeError(f"R2 upload verification failed for {key}")
        statuses.append("uploaded_verified")

    manifest["upload_status"] = statuses
    if not dry_run:
        write_parquet_atomic(manifest, path)
        metadata_path = path.parent / "embedding_artifacts.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        by_video = manifest.set_index("video_id")["upload_status"].to_dict()
        for artifact in metadata:
            artifact["r2_upload_status"] = str(by_video[str(artifact["video_id"])])
        write_json_atomic(metadata, metadata_path)

        report_path = path.parent / "normalization_report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        all_verified = manifest["upload_status"].isin(
            ["already_verified", "uploaded_verified"]
        ).all()
        report["vector_artifacts"] = {
            **report.get("vector_artifacts", {}),
            "status": "r2_upload_verified" if all_verified else "r2_upload_pending",
            "bucket": target_bucket,
            "artifact_count": len(manifest),
        }
        report["blockers"] = [
            blocker
            for blocker in report.get("blockers", [])
            if blocker not in {OLD_BLOCKER, PENDING_BLOCKER}
        ]
        if not all_verified:
            report["blockers"].append(PENDING_BLOCKER)
        report["status"] = "staging_not_import_ready" if report["blockers"] else "import_ready"
        write_json_atomic(report, report_path)

    return {
        "artifact_count": len(manifest),
        "already_verified": statuses.count("already_verified"),
        "uploaded_verified": statuses.count("uploaded_verified"),
        "pending": statuses.count("pending"),
        "status": "dry_run" if dry_run else "complete",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(r"D:\workspace\aic\data\refined\embedding_r2_manifest.parquet"),
    )
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--bucket")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    print(
        json.dumps(
            upload_manifest(
                manifest_path=args.manifest,
                env_file=args.env_file,
                bucket=args.bucket,
                dry_run=args.dry_run,
            ),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
