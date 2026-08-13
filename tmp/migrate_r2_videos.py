#!/usr/bin/env python3
"""Safely normalize root R2 video objects under the ``videos/`` prefix.

The script is intentionally dry-run by default. It recognizes only objects
whose basename matches ``L<digits>_V<digits>.mp4``. In apply mode those objects
are copied to ``videos/<basename>`` and verified. Objects that do not match the
allow-list are deleted only when both ``--apply`` and ``--delete-extra`` are
provided.

Credentials are read from environment variables rather than command-line
arguments so they do not appear in shell history or process listings:

    R2_ENDPOINT_URL
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET
    R2_REGION (optional, defaults to ``auto``)

The implementation uses the S3-compatible API exposed by Cloudflare R2. The
module can be imported without boto3 installed; the dependency is required
only when the CLI needs to connect to R2.
"""

from __future__ import annotations

import argparse
import ast
import json
import logging
import os
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

LOGGER = logging.getLogger("migrate_r2_videos")
VIDEO_NAME_PATTERN = re.compile(r"^L\d+_V\d+\.mp4$")
DEFAULT_TARGET_PREFIX = "videos/"
DEFAULT_REPORT_PATH = Path(__file__).resolve().parent / "r2_migration_report.json"
DEFAULT_ENV_PATHS = (
    Path(__file__).resolve().with_name(".env"),
    Path(__file__).resolve().parents[1] / ".env",
    Path.cwd() / ".env",
)
ENV_ASSIGNMENT_PATTERN = re.compile(
    r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$"
)


class S3Client(Protocol):
    """Small subset of the boto3 S3 client used by this migration."""

    def list_objects_v2(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def head_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def copy_object(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def delete_object(self, **kwargs: Any) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class MigrationConfig:
    """Validated, side-effect-free configuration for one migration run."""

    bucket: str
    target_prefix: str = DEFAULT_TARGET_PREFIX
    apply: bool = False
    delete_extra: bool = False
    report_path: Path = DEFAULT_REPORT_PATH

    def __post_init__(self) -> None:
        normalized_prefix = self.target_prefix.strip("/") + "/"
        object.__setattr__(self, "target_prefix", normalized_prefix)

        if not self.bucket.strip():
            raise ValueError("R2 bucket must not be empty")
        if self.delete_extra and not self.apply:
            raise ValueError("--delete-extra requires --apply")


@dataclass
class MigrationReport:
    """Serializable summary of a migration run."""

    started_at: str
    bucket: str
    target_prefix: str
    dry_run: bool
    delete_extra_requested: bool
    listed_objects: int = 0
    recognized_videos: int = 0
    copied: list[str] = field(default_factory=list)
    already_migrated: list[str] = field(default_factory=list)
    collisions: list[str] = field(default_factory=list)
    invalid_or_extra: list[str] = field(default_factory=list)
    deletion_candidates: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    failed: list[dict[str, str]] = field(default_factory=list)


def is_video_key(key: str) -> bool:
    """Return whether the basename is an allowed competition video name."""

    return VIDEO_NAME_PATTERN.fullmatch(Path(key).name) is not None


def _parse_env_value(raw_value: str) -> str:
    """Parse a small, safe dotenv value without evaluating shell syntax."""

    value = raw_value.strip()
    if not value:
        return ""

    quote: str | None = None
    escaped = False
    for index, character in enumerate(value):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
            continue
        if (
            character == "#"
            and quote is None
            and index > 0
            and value[index - 1].isspace()
        ):
            value = value[:index].rstrip()
            break

    if value[0] in {"'", '"'} and value[-1:] == value[0]:
        try:
            parsed = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            return value[1:-1]
        return parsed if isinstance(parsed, str) else value[1:-1]

    return value


def load_env_file(path: Path, *, override: bool = False) -> None:
    """Load dotenv assignments without overriding existing environment values."""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ValueError(f"cannot read env file {path}: {error}") from error

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        match = ENV_ASSIGNMENT_PATTERN.fullmatch(stripped)
        if match is None:
            raise ValueError(f"invalid dotenv assignment at {path}:{line_number}")

        key, raw_value = match.groups()
        if override or key not in os.environ:
            os.environ[key] = _parse_env_value(raw_value)


def resolve_env_file(explicit_path: Path | None = None) -> Path | None:
    """Resolve an explicit dotenv path or the repository's conventional paths."""

    if explicit_path is not None:
        path = explicit_path.expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"env file does not exist: {path}")
        return path

    seen: set[Path] = set()
    for candidate in DEFAULT_ENV_PATHS:
        path = candidate.expanduser().resolve()
        if path in seen:
            continue
        seen.add(path)
        if path.is_file():
            return path
    return None


def destination_key(key: str, target_prefix: str = DEFAULT_TARGET_PREFIX) -> str:
    """Return the canonical object key for an allowed video."""

    normalized_prefix = target_prefix.strip("/") + "/"
    return f"{normalized_prefix}{Path(key).name}"


def iter_objects(client: S3Client, bucket: str) -> Iterable[dict[str, Any]]:
    """Yield every object in a bucket, following S3 pagination."""

    request: dict[str, Any] = {"Bucket": bucket}
    while True:
        response = client.list_objects_v2(**request)
        yield from response.get("Contents", [])

        if not response.get("IsTruncated"):
            return

        continuation_token = response.get("NextContinuationToken")
        if not continuation_token:
            raise RuntimeError(
                "R2 returned a truncated listing without a continuation token"
            )
        request["ContinuationToken"] = continuation_token


def _error_code(error: Exception) -> str | None:
    """Extract an optional boto-style error code without exposing credentials."""

    response = getattr(error, "response", None)
    if isinstance(response, Mapping):
        error_data = response.get("Error")
        if isinstance(error_data, Mapping):
            code = error_data.get("Code")
            return str(code) if code else None
    return None


def _is_not_found(error: Exception) -> bool:
    return _error_code(error) in {"404", "NoSuchKey", "NotFound"}


def _same_size(source: Mapping[str, Any], destination: Mapping[str, Any]) -> bool:
    source_size = source.get("Size", source.get("ContentLength"))
    destination_size = destination.get("ContentLength", destination.get("Size"))
    return source_size is not None and source_size == destination_size


def _same_identity(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    """Return whether two listed objects plausibly contain the same content."""

    if not _same_size(first, second):
        return False
    first_etag = first.get("ETag")
    second_etag = second.get("ETag")
    return not first_etag or not second_etag or first_etag == second_etag


def verify_destination(
    client: S3Client,
    bucket: str,
    source: Mapping[str, Any],
    target_key: str,
) -> tuple[bool, str]:
    """Verify an existing destination using object size and available ETags.

    ETags are treated as an additional check only when both sides provide one.
    R2/S3 ETags are not universally MD5 checksums, especially for multipart
    objects, so size remains the mandatory portable check.
    """

    destination = client.head_object(Bucket=bucket, Key=target_key)
    if not _same_size(source, destination):
        return False, "destination size differs from source"

    source_etag = source.get("ETag")
    destination_etag = destination.get("ETag")
    if source_etag and destination_etag and source_etag != destination_etag:
        return False, "destination ETag differs from source"

    return True, "size and available ETag match"


def copy_and_verify(
    client: S3Client,
    bucket: str,
    source: Mapping[str, Any],
    target_key: str,
) -> tuple[str, str]:
    """Copy one object and verify the destination, returning action/reason."""

    source_key = str(source["Key"])
    if source_key == target_key:
        return "already_migrated", "object already has the canonical key"

    try:
        existing_ok, existing_reason = verify_destination(
            client, bucket, source, target_key
        )
    except Exception as error:
        if not _is_not_found(error):
            raise
        existing_ok = False
        existing_reason = "destination does not exist"

    if existing_ok:
        return "already_migrated", existing_reason
    if existing_reason != "destination does not exist":
        raise RuntimeError(f"refusing collision at {target_key}: {existing_reason}")

    client.copy_object(
        Bucket=bucket,
        Key=target_key,
        CopySource={"Bucket": bucket, "Key": source_key},
        MetadataDirective="COPY",
    )

    verified, reason = verify_destination(client, bucket, source, target_key)
    if not verified:
        raise RuntimeError(f"copy verification failed for {target_key}: {reason}")
    return "copied", reason


def migrate(client: S3Client, config: MigrationConfig) -> MigrationReport:
    """Plan or execute the migration against an injected S3-compatible client."""

    report = MigrationReport(
        started_at=datetime.now(timezone.utc).isoformat(),
        bucket=config.bucket,
        target_prefix=config.target_prefix,
        dry_run=not config.apply,
        delete_extra_requested=config.delete_extra,
    )
    objects = list(iter_objects(client, config.bucket))
    report.listed_objects = len(objects)

    recognized_groups: dict[str, list[dict[str, Any]]] = {}
    for object_info in objects:
        key = str(object_info.get("Key", ""))
        if not key:
            report.failed.append({"key": "", "error": "object listing had no Key"})
            continue

        if is_video_key(key):
            target_key = destination_key(key, config.target_prefix)
            recognized_groups.setdefault(target_key, []).append(object_info)
            report.recognized_videos += 1
        else:
            report.invalid_or_extra.append(key)

    recognized_sources: dict[str, dict[str, Any]] = {}
    source_cleanup: list[str] = []
    for target_key, sources in recognized_groups.items():
        canonical_source = next(
            (source for source in sources if source["Key"] == target_key),
            None,
        )
        noncanonical_sources = [
            source for source in sources if source["Key"] != target_key
        ]

        if canonical_source is not None:
            mismatched_sources = [
                str(source["Key"])
                for source in noncanonical_sources
                if not _same_identity(canonical_source, source)
            ]
            if mismatched_sources:
                report.collisions.append(
                    f"canonical object {target_key} differs from "
                    f"{', '.join(mismatched_sources)}"
                )
                continue
            recognized_sources[target_key] = canonical_source
            source_cleanup.extend(str(source["Key"]) for source in noncanonical_sources)
            continue

        if len(sources) > 1:
            report.collisions.append(
                f"multiple sources map to {target_key}: "
                f"{', '.join(str(source['Key']) for source in sources)}"
            )
            continue

        source = sources[0]
        recognized_sources[target_key] = source
        source_cleanup.append(str(source["Key"]))

    report.deletion_candidates = [*report.invalid_or_extra, *source_cleanup]

    # A collision must stop the entire run before any copy or deletion occurs.
    if report.collisions:
        return report

    for target_key, source in recognized_sources.items():
        source_key = str(source["Key"])
        if not config.apply:
            if source_key == target_key:
                report.already_migrated.append(target_key)
            else:
                report.copied.append(f"{source_key} -> {target_key}")
            continue

        try:
            action, reason = copy_and_verify(
                client, config.bucket, source, target_key
            )
            if action == "copied":
                report.copied.append(f"{source_key} -> {target_key} ({reason})")
            else:
                report.already_migrated.append(f"{target_key} ({reason})")
        except Exception as error:  # noqa: BLE001 - isolate one external object
            LOGGER.error("Failed to migrate %s: %s", source_key, error)
            report.failed.append({"key": source_key, "error": str(error)})

    if config.apply and config.delete_extra:
        # Never delete anything if a copy/verification failed. This preserves
        # the source objects so the run can be retried safely.
        if report.failed:
            LOGGER.warning(
                "skipping deletion because %d migration operation(s) failed",
                len(report.failed),
            )
            return report

        for key in report.deletion_candidates:
            try:
                client.delete_object(Bucket=config.bucket, Key=key)
                report.deleted.append(key)
            except Exception as error:  # noqa: BLE001 - continue other deletes
                LOGGER.error("Failed to delete %s: %s", key, error)
                report.failed.append({"key": key, "error": str(error)})

    return report


def load_config(args: argparse.Namespace) -> MigrationConfig:
    """Build validated configuration from CLI flags and environment."""

    bucket = args.bucket or os.getenv("R2_BUCKET", "")
    if not bucket:
        raise ValueError("R2_BUCKET is required (or pass --bucket)")
    return MigrationConfig(
        bucket=bucket,
        target_prefix=args.target_prefix,
        apply=args.apply,
        delete_extra=args.delete_extra,
        report_path=args.report,
    )


def build_client() -> S3Client:
    """Create an R2 S3 client from environment variables."""

    endpoint_url = os.getenv("R2_ENDPOINT_URL", "")
    access_key_id = os.getenv("R2_ACCESS_KEY_ID", "")
    secret_access_key = os.getenv("R2_SECRET_ACCESS_KEY", "")
    region_name = os.getenv("R2_REGION", "auto")

    if not endpoint_url or not access_key_id or not secret_access_key:
        raise ValueError(
            "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required"
        )
    parsed_endpoint = urlparse(endpoint_url)
    if parsed_endpoint.scheme != "https" or not parsed_endpoint.netloc:
        raise ValueError("R2_ENDPOINT_URL must be a valid https URL")

    try:
        import boto3
    except ImportError as error:
        raise RuntimeError(
            "boto3 is required to connect to R2; install it in the active environment"
        ) from error

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name=region_name,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", help="R2 bucket; defaults to R2_BUCKET")
    parser.add_argument(
        "--env-file",
        type=Path,
        help="dotenv file; defaults to tmp/.env, then repository .env",
    )
    parser.add_argument(
        "--target-prefix",
        default=DEFAULT_TARGET_PREFIX,
        help=f"canonical video prefix (default: {DEFAULT_TARGET_PREFIX})",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform copies; without this flag the command is dry-run only",
    )
    parser.add_argument(
        "--delete-extra",
        action="store_true",
        help="delete non-matching objects; requires --apply",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT_PATH,
        help="JSON report path",
    )
    return parser


def write_report(report: MigrationReport, path: Path) -> None:
    """Write a UTF-8 JSON report without exposing credentials."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(asdict(report), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = build_parser().parse_args(argv)
    try:
        env_path = resolve_env_file(args.env_file)
        if env_path is not None:
            load_env_file(env_path)
            LOGGER.info("loaded environment from %s", env_path)
        config = load_config(args)
        client = build_client()
        report = migrate(client, config)
        write_report(report, config.report_path)
    except (ValueError, RuntimeError) as error:
        LOGGER.error("%s", error)
        return 2

    LOGGER.info(
        "listed=%d recognized=%d copied=%d already_migrated=%d deleted=%d failed=%d",
        report.listed_objects,
        report.recognized_videos,
        len(report.copied),
        len(report.already_migrated),
        len(report.deleted),
        len(report.failed),
    )
    LOGGER.info("report written to %s", config.report_path)
    if report.failed or report.collisions:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
