"""Build schema-aligned canonical-frame candidates and keyframe aliases.

The sparse map is an occurrence list, not a canonical frame table.  A map can
mention the same source frame more than once, so this module keeps every
``(video_id, keyframe_no)`` occurrence in ``frame_aliases`` and creates one
representative candidate for each ``(video_id, source_frame_idx)`` group.

The source-frame index is intentionally marked as a candidate until a
sequential full-frame manifest verifies it.  This makes the duplicate fix
safe without silently claiming that a sparse map is a complete decode
timeline.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pandas as pd

from ..io_utils import write_csv_atomic, write_json_atomic, write_parquet_atomic

ALIAS_COLUMNS = [
    "video_id",
    "keyframe_no",
    "original_frame_id",
    "timestamp_ms",
    "thumbnail_object_key",
    "storage_uri",
    "metadata",
]

CANONICAL_CANDIDATE_COLUMNS = [
    "video_id",
    "keyframe_no",
    "original_frame_id",
    "timestamp_ms",
    "thumbnail_object_key",
    "storage_uri",
    "alias_count",
    "metadata",
]

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_DIGITS_ONLY = re.compile(r"^\d+$")
PIPELINE_VERSION = "frame-alias-normalization-v1"
SCHEMA_VERSION = "1.0.0"
MAPPING_STATUS = "candidate_source_frame_idx"


def _missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        result = pd.isna(value)
    except (TypeError, ValueError):
        return False
    return bool(result) if isinstance(result, bool) else False


def _nonnegative_int(value: Any, field: str, row_number: int) -> int:
    if _missing(value):
        raise ValueError(f"row {row_number} is missing {field}")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"row {row_number} has a non-numeric {field}") from error
    if not math.isfinite(numeric) or numeric < 0 or not numeric.is_integer():
        raise ValueError(f"row {row_number} has an invalid non-negative integer {field}")
    return int(numeric)


def _timestamp_ms(row: dict[str, Any], row_number: int) -> int:
    value = row.get("timestamp_ms_candidate")
    if _missing(value):
        pts_time = row.get("pts_time")
        if _missing(pts_time):
            raise ValueError(
                f"row {row_number} needs timestamp_ms_candidate or pts_time"
            )
        try:
            value = float(pts_time) * 1000.0
        except (TypeError, ValueError) as error:
            raise ValueError(f"row {row_number} has an invalid pts_time") from error
    try:
        numeric = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"row {row_number} has an invalid timestamp") from error
    if not math.isfinite(numeric) or numeric < 0:
        raise ValueError(f"row {row_number} has an invalid timestamp")
    return round(numeric)


def _optional_json_value(value: Any) -> Any:
    if _missing(value):
        return None
    if isinstance(value, (str, int, bool)):
        return value
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return str(value)
    if not math.isfinite(numeric):
        return None
    return numeric


def _source_map_file(value: Any) -> str | None:
    if _missing(value):
        return None
    return str(value)


def _require_manifest_columns(manifest: pd.DataFrame) -> None:
    required = {"video_id", "keyframe_no", "source_frame_idx"}
    missing = sorted(required - set(manifest.columns))
    if missing:
        raise ValueError(f"keyframe manifest is missing columns: {missing}")


def index_keyframe_objects(keyframe_root: str | Path) -> dict[tuple[str, int], str]:
    """Index local keyframe files and return their credential-free object keys."""

    root = Path(keyframe_root)
    if not root.is_dir():
        raise FileNotFoundError(f"keyframe root does not exist: {root}")

    objects: dict[tuple[str, int], str] = {}
    for video_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        for image_path in sorted(video_dir.iterdir()):
            if image_path.suffix.lower() not in IMAGE_SUFFIXES:
                continue
            if not _DIGITS_ONLY.fullmatch(image_path.stem):
                continue
            keyframe_no = int(image_path.stem)
            if keyframe_no < 1:
                continue
            identity = (video_dir.name, keyframe_no)
            if identity in objects:
                previous = objects[identity]
                raise ValueError(
                    "multiple local images map to the same occurrence "
                    f"{video_dir.name}/{keyframe_no}: {previous}, {image_path.name}"
                )
            objects[identity] = f"keyframes/{video_dir.name}/{image_path.name}"
    return objects


def _validate_manifest_identity(manifest: pd.DataFrame) -> None:
    occurrence_keys = manifest[["video_id", "keyframe_no"]].astype(str)
    if occurrence_keys.duplicated().any():
        raise ValueError("keyframe manifest has duplicate (video_id, keyframe_no)")


def _normalise_rows(
    manifest: pd.DataFrame,
    object_keys: dict[tuple[str, int], str],
    bucket: str,
) -> list[dict[str, Any]]:
    _require_manifest_columns(manifest)
    _validate_manifest_identity(manifest)
    if not bucket or "/" in bucket or " " in bucket:
        raise ValueError("bucket must be a non-empty name without slash or spaces")

    source_rows: list[dict[str, Any]] = []
    ordered = manifest.copy(deep=True)
    if "source_row_index" not in ordered.columns:
        ordered["source_row_index"] = range(len(ordered))
    ordered = ordered.sort_values(
        ["video_id", "keyframe_no", "source_row_index"],
        kind="stable",
    )

    for row_number, raw in enumerate(ordered.to_dict("records")):
        video_id = str(raw.get("video_id", "")).strip()
        if not video_id:
            raise ValueError(f"row {row_number} has an empty video_id")
        keyframe_no = _nonnegative_int(raw.get("keyframe_no"), "keyframe_no", row_number)
        if keyframe_no < 1:
            raise ValueError(f"row {row_number} has keyframe_no < 1")
        source_frame_idx = _nonnegative_int(
            raw.get("source_frame_idx"), "source_frame_idx", row_number
        )
        candidate = raw.get("original_frame_id_candidate")
        if not _missing(candidate):
            candidate_id = _nonnegative_int(
                candidate, "original_frame_id_candidate", row_number
            )
            if candidate_id != source_frame_idx:
                raise ValueError(
                    f"row {row_number} has original_frame_id_candidate != source_frame_idx"
                )

        object_key = object_keys.get((video_id, keyframe_no))
        if object_key is None:
            raise FileNotFoundError(
                "missing keyframe image for occurrence "
                f"{video_id}/{keyframe_no:03d}"
            )

        source_row_index = _nonnegative_int(
            raw.get("source_row_index"), "source_row_index", row_number
        )
        source_map_file = _source_map_file(raw.get("source_map_file"))
        metadata = {
            "mapping_status": MAPPING_STATUS,
            "source_frame_idx": source_frame_idx,
            "source_map_file": source_map_file,
            "source_row_index": source_row_index,
            "pts_time": _optional_json_value(raw.get("pts_time")),
            "fps": _optional_json_value(raw.get("fps")),
        }
        source_rows.append(
            {
                "video_id": video_id,
                "keyframe_no": keyframe_no,
                "original_frame_id": source_frame_idx,
                "timestamp_ms": _timestamp_ms(raw, row_number),
                "thumbnail_object_key": object_key,
                "storage_uri": f"r2://{bucket}/{object_key}",
                "source_frame_idx": source_frame_idx,
                "source_map_file": source_map_file,
                "source_row_index": source_row_index,
                "metadata": metadata,
            }
        )

    counts = Counter((row["video_id"], row["original_frame_id"]) for row in source_rows)
    occurrence_ordinals: Counter[tuple[str, int]] = Counter()
    for row in source_rows:
        group = (row["video_id"], row["original_frame_id"])
        occurrence_ordinals[group] += 1
        row["metadata"] = {
            **row["metadata"],
            "duplicate_group_size": counts[group],
            "duplicate_occurrence_ordinal": occurrence_ordinals[group],
        }
    return source_rows


def build_alias_artifacts(
    manifest: pd.DataFrame,
    *,
    keyframe_root: str | Path,
    bucket: str = "aic",
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, int]]:
    """Return all alias rows, canonical candidates, and normalization stats."""

    object_keys = index_keyframe_objects(keyframe_root)
    source_rows = _normalise_rows(manifest, object_keys, bucket)
    alias_rows = [
        {
            **{column: row[column] for column in ALIAS_COLUMNS if column != "metadata"},
            "metadata": json.dumps(row["metadata"], ensure_ascii=False, sort_keys=True),
        }
        for row in source_rows
    ]
    aliases = pd.DataFrame(alias_rows, columns=ALIAS_COLUMNS)

    grouped_rows: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for row in source_rows:
        identity = (row["video_id"], row["original_frame_id"])
        grouped_rows.setdefault(identity, []).append(row)

    canonical_rows: list[dict[str, Any]] = []
    for group in grouped_rows.values():
        row = group[0]
        source_maps = sorted(
            {
                value
                for value in (candidate["source_map_file"] for candidate in group)
                if value
            }
        )
        metadata = {
            "mapping_status": MAPPING_STATUS,
            "canonical_selection": "lowest_keyframe_no_representative",
            "alias_count": len(group),
            "source_map_files": source_maps,
        }
        canonical_rows.append(
            {
                "video_id": row["video_id"],
                "keyframe_no": row["keyframe_no"],
                "original_frame_id": row["original_frame_id"],
                "timestamp_ms": row["timestamp_ms"],
                "thumbnail_object_key": row["thumbnail_object_key"],
                "storage_uri": row["storage_uri"],
                "alias_count": len(group),
                "metadata": json.dumps(metadata, ensure_ascii=False, sort_keys=True),
            }
        )
    canonical = pd.DataFrame(canonical_rows, columns=CANONICAL_CANDIDATE_COLUMNS)

    validate_alias_artifact(aliases)
    validate_canonical_candidates(canonical)
    duplicate_groups = [len(group) for group in grouped_rows.values() if len(group) > 1]
    stats = {
        "video_count": int(manifest["video_id"].astype(str).nunique()),
        "source_row_count": len(source_rows),
        "alias_row_count": len(aliases),
        "canonical_candidate_count": len(canonical),
        "duplicate_source_frame_idx_group_count": len(duplicate_groups),
        "duplicate_source_frame_idx_row_count": int(sum(duplicate_groups)),
        "duplicate_extra_occurrence_count": int(sum(size - 1 for size in duplicate_groups)),
        "source_map_file_count": len(
            {
                row["source_map_file"]
                for row in source_rows
                if row["source_map_file"]
            }
        ),
    }
    return aliases, canonical, stats


def _validate_columns(frame: pd.DataFrame, expected: Iterable[str], name: str) -> None:
    actual = list(frame.columns)
    expected_list = list(expected)
    if actual != expected_list:
        raise ValueError(f"{name} columns mismatch: expected {expected_list}, got {actual}")


def validate_alias_artifact(aliases: pd.DataFrame) -> None:
    _validate_columns(aliases, ALIAS_COLUMNS, "frame_aliases")
    if aliases.empty:
        return
    if aliases[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("frame_aliases has duplicate (video_id, keyframe_no)")
    if aliases["thumbnail_object_key"].duplicated().any():
        raise ValueError("frame_aliases has duplicate thumbnail_object_key")
    if aliases["storage_uri"].duplicated().any():
        raise ValueError("frame_aliases has duplicate storage_uri")
    for column in ("keyframe_no", "original_frame_id", "timestamp_ms"):
        values = pd.to_numeric(aliases[column], errors="coerce")
        if values.isna().any() or (values < 0).any() or (values % 1 != 0).any():
            raise ValueError(f"frame_aliases has invalid {column}")
    if (pd.to_numeric(aliases["keyframe_no"], errors="coerce") < 1).any():
        raise ValueError("frame_aliases has keyframe_no < 1")
    for key, uri in zip(aliases["thumbnail_object_key"], aliases["storage_uri"]):
        if not isinstance(key, str) or not key.strip() or any(part in {".", ".."} for part in key.split("/")):
            raise ValueError("frame_aliases has an unsafe thumbnail_object_key")
        if not isinstance(uri, str) or not uri.startswith(("r2://", "s3://")):
            raise ValueError("frame_aliases has an invalid storage_uri")
    for encoded in aliases["metadata"]:
        try:
            decoded = json.loads(encoded)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("frame_aliases metadata must be JSON") from error
        if not isinstance(decoded, dict):
            raise TypeError("frame_aliases metadata must encode an object")


def validate_canonical_candidates(canonical: pd.DataFrame) -> None:
    _validate_columns(canonical, CANONICAL_CANDIDATE_COLUMNS, "canonical_frame_candidates")
    if canonical.empty:
        return
    if canonical[["video_id", "original_frame_id"]].duplicated().any():
        raise ValueError("canonical_frame_candidates has duplicate canonical identity")
    if canonical[["video_id", "keyframe_no"]].duplicated().any():
        raise ValueError("canonical_frame_candidates has duplicate representative occurrence")
    if canonical["alias_count"].isna().any() or (canonical["alias_count"] < 1).any():
        raise ValueError("canonical_frame_candidates has invalid alias_count")
    for encoded in canonical["metadata"]:
        decoded = json.loads(encoded)
        if not isinstance(decoded, dict):
            raise TypeError("canonical_frame_candidates metadata must encode an object")


def update_normalization_report(
    report_path: str | Path,
    stats: dict[str, int],
    *,
    aliases_path: str | Path,
    canonical_path: str | Path,
) -> dict[str, Any]:
    """Record that duplicate occurrences are represented without data loss."""

    path = Path(report_path)
    report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    blockers = [
        blocker
        for blocker in report.get("blockers", [])
        if "duplicate source frame_idx" not in str(blocker)
    ]
    blockers = [
        "R2 object URIs are not available for vector artifacts"
        if blocker == "R2 object URIs are not available for videos/keyframes/vector artifacts"
        else blocker
        for blocker in blockers
    ]
    report["blockers"] = blockers
    report["status"] = "staging_not_import_ready" if blockers else "import_ready"
    output_files = list(report.get("output_files", []))
    for output in (
        Path(aliases_path).name,
        Path(canonical_path).name,
        Path(aliases_path).with_suffix(".csv").name,
        Path(canonical_path).with_suffix(".csv").name,
    ):
        if output not in output_files:
            output_files.append(output)
    report["output_files"] = output_files
    report["frame_aliases"] = {
        "status": "complete_for_keyframe_occurrences",
        **stats,
        "mapping_status": MAPPING_STATUS,
        "canonical_mapping_verified": False,
        "ready_for_db": False,
        "schema": "contracts/schemas/frame_alias/schema.json",
        "alias_artifact": Path(aliases_path).name,
        "canonical_candidate_artifact": Path(canonical_path).name,
        "storage": {
            "bucket": "aic",
            "object_prefix": "keyframes",
            "uri_format": "r2://aic/keyframes/<video_id>/<local_filename>",
        },
        "metadata_encoding": "json_string_for_jsonb_import",
    }
    report["updated_at"] = "2026-08-16"
    write_json_atomic(report, path)
    return report


def run(
    *,
    manifest_path: str | Path,
    keyframe_root: str | Path,
    output_dir: str | Path,
    report_path: str | Path | None = None,
    bucket: str = "aic",
    dry_run: bool = False,
) -> dict[str, Any]:
    manifest = pd.read_parquet(manifest_path)
    aliases, canonical, stats = build_alias_artifacts(
        manifest,
        keyframe_root=keyframe_root,
        bucket=bucket,
    )
    output_root = Path(output_dir)
    aliases_path = output_root / "frame_aliases.parquet"
    canonical_path = output_root / "canonical_frame_candidates.parquet"
    if not dry_run:
        write_parquet_atomic(aliases, aliases_path)
        write_csv_atomic(aliases, aliases_path.with_suffix(".csv"))
        write_parquet_atomic(canonical, canonical_path)
        write_csv_atomic(canonical, canonical_path.with_suffix(".csv"))
        if report_path is not None:
            update_normalization_report(
                report_path,
                stats,
                aliases_path=aliases_path,
                canonical_path=canonical_path,
            )
    return {
        **stats,
        "dry_run": dry_run,
        "aliases_path": str(aliases_path),
        "canonical_path": str(canonical_path),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(r"D:\workspace\aic\data\refined\keyframe_manifest.parquet"),
    )
    parser.add_argument(
        "--keyframe-root",
        type=Path,
        default=Path(r"E:\aic2026\keyframes"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(r"D:\workspace\aic\data\refined"),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path(r"D:\workspace\aic\data\refined\normalization_report.json"),
    )
    parser.add_argument("--bucket", default="aic")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    result = run(
        manifest_path=args.manifest,
        keyframe_root=args.keyframe_root,
        output_dir=args.output_dir,
        report_path=args.report,
        bucket=args.bucket,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
