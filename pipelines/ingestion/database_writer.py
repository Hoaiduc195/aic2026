"""PostgreSQL writer for the refined AIC artifact importer."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Sequence
from typing import Any

import numpy as np

from .import_refined import (
    FRAME_PIPELINE_VERSION,
    IMPORTER_VERSION,
    DatasetState,
    ImportBundle,
    ImportOptions,
    _alias_for_row,
    _as_float,
    _as_int,
    _is_missing,
    _json_object,
    _json_text,
    _parquet_rows,
    _stable_id,
    build_evidence_id,
    build_import_bundle,
    local_file_uri,
    to_pgvector_literal,
)


def _execute_batches(
    cursor: Any,
    sql: str,
    rows: Iterable[Sequence[Any]],
    *,
    batch_size: int,
) -> int:
    batch: list[Sequence[Any]] = []
    total = 0
    for row in rows:
        batch.append(row)
        if len(batch) >= batch_size:
            cursor.executemany(sql, batch)
            total += len(batch)
            batch = []
    if batch:
        cursor.executemany(sql, batch)
        total += len(batch)
    return total


def _run_phase(connection: Any, operation: Callable[[Any], int | None]) -> int | None:
    with connection.transaction():
        return operation(connection)


def _import_videos(connection: Any, state: DatasetState, options: ImportOptions) -> int:
    sql = """
        INSERT INTO videos (
          video_id, object_key, original_filename, storage_uri, duration_ms,
          fps_str, fps, width, height, size_bytes, sha256, etag, version_id,
          frame_count, mime_type, dataset_version, pipeline_version,
          schema_version, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s)
        ON CONFLICT (video_id) DO UPDATE SET
          object_key = EXCLUDED.object_key,
          original_filename = EXCLUDED.original_filename,
          storage_uri = EXCLUDED.storage_uri,
          duration_ms = EXCLUDED.duration_ms,
          fps_str = EXCLUDED.fps_str,
          fps = EXCLUDED.fps,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          size_bytes = EXCLUDED.size_bytes,
          sha256 = EXCLUDED.sha256,
          etag = EXCLUDED.etag,
          version_id = EXCLUDED.version_id,
          frame_count = EXCLUDED.frame_count,
          mime_type = EXCLUDED.mime_type,
          dataset_version = EXCLUDED.dataset_version,
          pipeline_version = EXCLUDED.pipeline_version,
          schema_version = EXCLUDED.schema_version,
          metadata = EXCLUDED.metadata
    """

    def rows() -> Iterator[Sequence[Any]]:
        for video_id in state.selected_video_ids:
            row = state.videos[video_id]
            yield (
                video_id,
                str(row["object_key"]),
                str(row["original_filename"]),
                str(row["storage_uri"]),
                _as_int(row["duration_ms"], "duration_ms"),
                str(row["fps_str"]),
                _as_float(row["fps"], "fps"),
                _as_int(row["width"], "width"),
                _as_int(row["height"], "height"),
                None if _is_missing(row.get("size_bytes")) else _as_int(row["size_bytes"], "size_bytes"),
                None if _is_missing(row.get("sha256")) else str(row["sha256"]),
                None if _is_missing(row.get("etag")) else str(row["etag"]),
                None if _is_missing(row.get("version_id")) else str(row["version_id"]),
                None if _is_missing(row.get("frame_count")) else _as_int(row["frame_count"], "frame_count"),
                str(row.get("mime_type") or "video/mp4"),
                str(row.get("dataset_version") or state.dataset_version),
                str(row.get("pipeline_version") or "video-manifest-import"),
                str(row.get("schema_version") or "1.0.0"),
                _json_text({
                    "path": row.get("path"),
                    "duration_s": row.get("duration_s"),
                    "codec": row.get("codec"),
                    "n_frames_est": row.get("n_frames_est"),
                }),
            )

    with connection.cursor() as cursor:
        return _execute_batches(cursor, sql, rows(), batch_size=options.batch_size)


def _import_frames(connection: Any, state: DatasetState, options: ImportOptions) -> int:
    sql = """
        INSERT INTO frames (
          video_id, keyframe_no, original_frame_id, timestamp_ms,
          thumbnail_object_key, storage_uri, retrieval_roles, quality_route,
          eligible_for_embedding, pipeline_version, schema_version, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (video_id, original_frame_id) DO UPDATE SET
          keyframe_no = EXCLUDED.keyframe_no,
          timestamp_ms = EXCLUDED.timestamp_ms,
          thumbnail_object_key = EXCLUDED.thumbnail_object_key,
          storage_uri = EXCLUDED.storage_uri,
          retrieval_roles = EXCLUDED.retrieval_roles,
          quality_route = EXCLUDED.quality_route,
          eligible_for_embedding = EXCLUDED.eligible_for_embedding,
          pipeline_version = EXCLUDED.pipeline_version,
          schema_version = EXCLUDED.schema_version,
          metadata = EXCLUDED.metadata
    """

    def rows() -> Iterator[Sequence[Any]]:
        for key in sorted(state.canonical_frames):
            video_id, original_frame_id = key
            row = state.canonical_frames[key]
            eligible = key in state.embedding_canonical_keys
            metadata = _json_object(row.get("metadata"))
            metadata["canonical_mapping_verified"] = True
            yield (
                video_id,
                _as_int(row["keyframe_no"], "keyframe_no"),
                original_frame_id,
                _as_int(row["timestamp_ms"], "timestamp_ms"),
                str(row["thumbnail_object_key"]),
                str(row["storage_uri"]),
                ["visual_embedding"] if eligible else ["temporal_only"],
                "retrieval_embedding" if eligible else "temporal_only",
                eligible,
                FRAME_PIPELINE_VERSION,
                "1.0.0",
                _json_text(metadata),
            )

    with connection.cursor() as cursor:
        return _execute_batches(cursor, sql, rows(), batch_size=options.batch_size)


def _import_aliases(connection: Any, state: DatasetState, options: ImportOptions) -> int:
    sql = """
        INSERT INTO frame_aliases (
          video_id, keyframe_no, original_frame_id, timestamp_ms,
          thumbnail_object_key, storage_uri, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (video_id, keyframe_no) DO UPDATE SET
          original_frame_id = EXCLUDED.original_frame_id,
          timestamp_ms = EXCLUDED.timestamp_ms,
          thumbnail_object_key = EXCLUDED.thumbnail_object_key,
          storage_uri = EXCLUDED.storage_uri,
          metadata = EXCLUDED.metadata
    """

    def rows() -> Iterator[Sequence[Any]]:
        for key in sorted(state.aliases):
            video_id, keyframe_no = key
            row = state.aliases[key]
            yield (
                video_id,
                keyframe_no,
                _as_int(row["original_frame_id"], "original_frame_id"),
                _as_int(row["timestamp_ms"], "timestamp_ms"),
                str(row["thumbnail_object_key"]),
                str(row["storage_uri"]),
                _json_text(row.get("metadata")),
            )

    with connection.cursor() as cursor:
        return _execute_batches(cursor, sql, rows(), batch_size=options.batch_size)


def _insert_feature_metadata(
    connection: Any,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    feature_sql = """
        INSERT INTO feature_sets (
          feature_set_id, modality, dataset_version, pipeline_version,
          schema_version, producer, model_name, model_version,
          embedding_dimensions, embedding_dtype, embedding_normalized,
          manifest_uri, manifest_sha256, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (feature_set_id) DO UPDATE SET
          modality = EXCLUDED.modality,
          dataset_version = EXCLUDED.dataset_version,
          pipeline_version = EXCLUDED.pipeline_version,
          schema_version = EXCLUDED.schema_version,
          producer = EXCLUDED.producer,
          model_name = EXCLUDED.model_name,
          model_version = EXCLUDED.model_version,
          embedding_dimensions = EXCLUDED.embedding_dimensions,
          embedding_dtype = EXCLUDED.embedding_dtype,
          embedding_normalized = EXCLUDED.embedding_normalized,
          manifest_uri = EXCLUDED.manifest_uri,
          manifest_sha256 = EXCLUDED.manifest_sha256,
          metadata = EXCLUDED.metadata
    """
    artifact_sql = """
        INSERT INTO feature_artifacts (
          artifact_id, feature_set_id, video_id, artifact_type, storage_uri,
          sha256, size_bytes, record_count, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (artifact_id) DO UPDATE SET
          feature_set_id = EXCLUDED.feature_set_id,
          video_id = EXCLUDED.video_id,
          artifact_type = EXCLUDED.artifact_type,
          storage_uri = EXCLUDED.storage_uri,
          sha256 = EXCLUDED.sha256,
          size_bytes = EXCLUDED.size_bytes,
          record_count = EXCLUDED.record_count,
          metadata = EXCLUDED.metadata
    """
    with connection.cursor() as cursor:
        feature_rows = [
            (
                spec.feature_set_id,
                spec.modality,
                spec.feature_set_id.split(":", 1)[0],
                spec.pipeline_version,
                spec.schema_version,
                spec.producer,
                spec.model_name,
                spec.model_version,
                spec.embedding_dimensions,
                spec.embedding_dtype,
                spec.embedding_normalized,
                local_file_uri(spec.manifest_path),
                spec.manifest_sha256,
                _json_text(spec.metadata),
            )
            for spec in bundle.feature_specs
        ]
        cursor.executemany(feature_sql, feature_rows)
        artifact_rows = [
            (
                artifact.artifact_id,
                artifact.feature_set_id,
                artifact.video_id,
                artifact.artifact_type,
                artifact.storage_uri,
                artifact.sha256,
                artifact.size_bytes,
                artifact.record_count,
                _json_text(artifact.metadata),
            )
            for artifact in bundle.artifact_specs
        ]
        cursor.executemany(artifact_sql, artifact_rows)
    return len(feature_rows) + len(artifact_rows)


EVIDENCE_SQL = """
    INSERT INTO evidence (
      evidence_id, evidence_type, video_id, feature_set_id, artifact_id,
      source_record_index, original_frame_id, start_ms, end_ms, confidence,
      payload
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (evidence_id) DO UPDATE SET
      evidence_type = EXCLUDED.evidence_type,
      video_id = EXCLUDED.video_id,
      feature_set_id = EXCLUDED.feature_set_id,
      artifact_id = EXCLUDED.artifact_id,
      source_record_index = EXCLUDED.source_record_index,
      original_frame_id = EXCLUDED.original_frame_id,
      start_ms = EXCLUDED.start_ms,
      end_ms = EXCLUDED.end_ms,
      confidence = EXCLUDED.confidence,
      payload = EXCLUDED.payload
"""

TEXT_EVIDENCE_SQL = """
    INSERT INTO text_evidence (evidence_id, text_content, normalized_text, language)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT (evidence_id) DO UPDATE SET
      text_content = EXCLUDED.text_content,
      normalized_text = EXCLUDED.normalized_text,
      language = EXCLUDED.language
"""


def _insert_caption_evidence(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    if not options.include_captions:
        return 0
    path = state.data_root / "captions_en.parquet"
    feature_set_id = next(spec.feature_set_id for spec in bundle.feature_specs if spec.modality == "caption")
    artifact = bundle.primary_artifacts["caption"]
    count = 0
    with connection.cursor() as cursor:
        evidence_rows: list[Sequence[Any]] = []
        text_rows: list[Sequence[Any]] = []
        for row in _parquet_rows(path, batch_size=options.batch_size):
            video_id = str(row["video_id"])
            if video_id not in state.videos:
                continue
            key, alias = _alias_for_row(state, row, keyframe_column="keyframe_no")
            evidence_id = build_evidence_id("caption", video_id, key[1])
            start_ms = _as_int(alias["timestamp_ms"], "timestamp_ms")
            evidence_rows.append(
                (
                    evidence_id,
                    "caption",
                    video_id,
                    feature_set_id,
                    artifact.artifact_id,
                    _as_int(row.get("source_row_index", 0), "source_row_index"),
                    _as_int(alias["original_frame_id"], "original_frame_id"),
                    start_ms,
                    start_ms + 1,
                    None,
                    _json_text({
                        "producer": row.get("producer"),
                        "source_model": row.get("source_model"),
                        "task": row.get("task"),
                        "source_caption_path": row.get("source_caption_path"),
                    }),
                )
            )
            text = str(row["text_content"])
            text_rows.append((evidence_id, text, str(row.get("normalized_text") or text), "en"))
            count += 1
            if len(evidence_rows) >= options.batch_size:
                cursor.executemany(EVIDENCE_SQL, evidence_rows)
                cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
                evidence_rows, text_rows = [], []
        if evidence_rows:
            cursor.executemany(EVIDENCE_SQL, evidence_rows)
            cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
    return count


def _insert_ocr_evidence(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    if not options.include_ocr:
        return 0
    path = state.data_root / "ocr.parquet"
    feature_set_id = next(spec.feature_set_id for spec in bundle.feature_specs if spec.modality == "ocr")
    artifact = bundle.primary_artifacts["ocr"]
    count = 0
    with connection.cursor() as cursor:
        evidence_rows: list[Sequence[Any]] = []
        text_rows: list[Sequence[Any]] = []
        for row in _parquet_rows(path, batch_size=options.batch_size):
            video_id = str(row["video_id"])
            if video_id not in state.videos:
                continue
            _, alias = _alias_for_row(state, row, keyframe_column="keyframe_no")
            source_record_index = _as_int(row["source_record_index"], "source_record_index")
            source_detection_index = _as_int(row["source_detection_index"], "source_detection_index")
            evidence_id = build_evidence_id(
                "ocr",
                video_id,
                source_record_index,
                source_detection_index,
            )
            start_ms = _as_int(alias["timestamp_ms"], "timestamp_ms")
            evidence_rows.append(
                (
                    evidence_id,
                    "ocr",
                    video_id,
                    feature_set_id,
                    artifact.artifact_id,
                    source_record_index,
                    _as_int(alias["original_frame_id"], "original_frame_id"),
                    start_ms,
                    start_ms + 1,
                    _as_float(row["confidence"], "confidence"),
                    _json_text({
                        "source": row.get("source"),
                        "model_version": row.get("model_version"),
                        "pipeline_version": row.get("pipeline_version"),
                        "source_frame_path": row.get("source_frame_path"),
                        "source_frame_id": row.get("source_frame_id"),
                        "source_detection_index": source_detection_index,
                        "detection_confidence": row.get("detection_confidence"),
                        "bbox": row.get("bbox"),
                        "image_width": row.get("image_width"),
                        "image_height": row.get("image_height"),
                    }),
                )
            )
            text_rows.append(
                (
                    evidence_id,
                    str(row["text_content"]),
                    str(row["normalized_text"]),
                    "vi",
                )
            )
            count += 1
            if len(evidence_rows) >= options.batch_size:
                cursor.executemany(EVIDENCE_SQL, evidence_rows)
                cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
                evidence_rows, text_rows = [], []
        if evidence_rows:
            cursor.executemany(EVIDENCE_SQL, evidence_rows)
            cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
    return count


def _insert_asr_evidence(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    if not options.include_asr:
        return 0
    path = state.data_root / "asr_spans.parquet"
    feature_set_id = next(spec.feature_set_id for spec in bundle.feature_specs if spec.modality == "asr")
    artifact = bundle.primary_artifacts["asr"]
    count = 0
    with connection.cursor() as cursor:
        evidence_rows: list[Sequence[Any]] = []
        text_rows: list[Sequence[Any]] = []
        for row in _parquet_rows(path, batch_size=options.batch_size):
            video_id = str(row["video_id"])
            if video_id not in state.videos:
                continue
            source_span_index = _as_int(row["source_span_index"], "source_span_index")
            evidence_id = build_evidence_id("asr", video_id, source_span_index)
            start_ms = _as_int(row["start_ms"], "start_ms")
            end_ms = _as_int(row["end_ms"], "end_ms")
            evidence_rows.append(
                (
                    evidence_id,
                    "asr",
                    video_id,
                    feature_set_id,
                    artifact.artifact_id,
                    _as_int(row.get("source_row_index", source_span_index), "source_row_index"),
                    None,
                    start_ms,
                    end_ms,
                    None,
                    _json_text({
                        "producer": row.get("producer"),
                        "model_version": row.get("model_version"),
                        "source_file": row.get("source_file"),
                        "source_span_index": source_span_index,
                    }),
                )
            )
            text = str(row["text_raw"])
            text_rows.append(
                (
                    evidence_id,
                    text,
                    str(row["text_normalized"]),
                    str(row.get("language") or "unknown"),
                )
            )
            count += 1
            if len(evidence_rows) >= options.batch_size:
                cursor.executemany(EVIDENCE_SQL, evidence_rows)
                cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
                evidence_rows, text_rows = [], []
        if evidence_rows:
            cursor.executemany(EVIDENCE_SQL, evidence_rows)
            cursor.executemany(TEXT_EVIDENCE_SQL, text_rows)
    return count


def _insert_object_evidence(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    if not options.include_objects:
        return 0
    path = state.data_root / "objects.parquet"
    feature_set_id = next(spec.feature_set_id for spec in bundle.feature_specs if spec.modality == "object")
    artifact = bundle.primary_artifacts["object"]
    object_sql = """
        INSERT INTO object_evidence (
          evidence_id, class_id, label, confidence, bbox, normalized_bbox,
          track_id, attributes
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (evidence_id) DO UPDATE SET
          class_id = EXCLUDED.class_id,
          label = EXCLUDED.label,
          confidence = EXCLUDED.confidence,
          bbox = EXCLUDED.bbox,
          normalized_bbox = EXCLUDED.normalized_bbox,
          track_id = EXCLUDED.track_id,
          attributes = EXCLUDED.attributes
    """
    count = 0
    with connection.cursor() as cursor:
        evidence_rows: list[Sequence[Any]] = []
        object_rows: list[Sequence[Any]] = []
        for row in _parquet_rows(path, batch_size=options.batch_size):
            video_id = str(row["video_id"])
            if video_id not in state.videos:
                continue
            _, alias = _alias_for_row(state, row, keyframe_column="keyframe_no")
            object_row_id = str(row["object_row_id"])
            evidence_id = build_evidence_id("object", object_row_id)
            start_ms = _as_int(alias["timestamp_ms"], "timestamp_ms")
            evidence_rows.append(
                (
                    evidence_id,
                    "object",
                    video_id,
                    feature_set_id,
                    artifact.artifact_id,
                    _as_int(row.get("source_row_index", 0), "source_row_index"),
                    _as_int(alias["original_frame_id"], "original_frame_id"),
                    start_ms,
                    start_ms + 1,
                    _as_float(row["confidence"], "confidence"),
                    _json_text({
                        "detection_index": row.get("detection_index"),
                        "raw_label": row.get("raw_label"),
                        "source_object_path": row.get("source_object_path"),
                        "source_frame_path": row.get("source_frame_path"),
                        "model_version": row.get("model_version"),
                    }),
                )
            )
            object_rows.append(
                (
                    evidence_id,
                    None if _is_missing(row.get("class_id")) else _as_int(row["class_id"], "class_id"),
                    str(row["label"]),
                    _as_float(row["confidence"], "confidence"),
                    [_as_float(value, "bbox") for value in row["bbox"]],
                    [_as_float(value, "normalized_bbox") for value in row["normalized_bbox"]],
                    None if _is_missing(row.get("track_id")) else str(row["track_id"]),
                    _json_text(row.get("attributes_json")),
                )
            )
            count += 1
            if len(evidence_rows) >= options.batch_size:
                cursor.executemany(EVIDENCE_SQL, evidence_rows)
                cursor.executemany(object_sql, object_rows)
                evidence_rows, object_rows = [], []
        if evidence_rows:
            cursor.executemany(EVIDENCE_SQL, evidence_rows)
            cursor.executemany(object_sql, object_rows)
    return count


def _insert_embedding_evidence(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    if not options.include_embeddings:
        return 0
    spec = next(spec for spec in bundle.feature_specs if spec.modality == "visual_embedding")
    clip_sql = """
        INSERT INTO clip_embeddings (evidence_id, embedding_id, embedding)
        VALUES (%s, %s, %s)
        ON CONFLICT (evidence_id) DO UPDATE SET
          embedding_id = EXCLUDED.embedding_id,
          embedding = EXCLUDED.embedding
    """
    count = 0
    with connection.cursor() as cursor:
        evidence_rows: list[Sequence[Any]] = []
        clip_rows: list[Sequence[Any]] = []
        for video_id in state.selected_video_ids:
            matrix = np.load(state.embedding_paths[video_id], mmap_mode="r", allow_pickle=False)
            artifact = bundle.embedding_artifacts[video_id]
            for row in sorted(
                state.embedding_rows_by_video[video_id],
                key=lambda value: int(value["embedding_row_index"]),
            ):
                key, alias = _alias_for_row(state, row, keyframe_column="keyframe_no_candidate")
                row_index = _as_int(row["embedding_row_index"], "embedding_row_index")
                evidence_id = build_evidence_id("frame_embedding", video_id, key[1], row_index)
                embedding_id = build_evidence_id("embedding", video_id, key[1], row_index)
                start_ms = _as_int(alias["timestamp_ms"], "timestamp_ms")
                evidence_rows.append(
                    (
                        evidence_id,
                        "frame",
                        video_id,
                        spec.feature_set_id,
                        artifact.artifact_id,
                        row_index,
                        _as_int(alias["original_frame_id"], "original_frame_id"),
                        start_ms,
                        start_ms + 1,
                        None,
                        _json_text({
                            "embedding_id": embedding_id,
                            "embedding_row_index": row_index,
                            "model_name": row.get("model_name"),
                            "model_version": row.get("model_version"),
                            "source_embedding_uri": row.get("source_embedding_uri"),
                            "storage_mode": "local",
                        }),
                    )
                )
                clip_rows.append((evidence_id, embedding_id, to_pgvector_literal(matrix[row_index])))
                count += 1
                if len(evidence_rows) >= options.batch_size:
                    cursor.executemany(EVIDENCE_SQL, evidence_rows)
                    cursor.executemany(clip_sql, clip_rows)
                    evidence_rows, clip_rows = [], []
        if evidence_rows:
            cursor.executemany(EVIDENCE_SQL, evidence_rows)
            cursor.executemany(clip_sql, clip_rows)
    return count


def _record_ingestion_runs(connection: Any, bundle: ImportBundle, options: ImportOptions) -> int:
    sql = """
        INSERT INTO ingestion_runs (
          ingestion_id, feature_set_id, artifact_id, source_artifact_uri,
          source_checksum_sha256, target_table, dataset_version, pipeline_version,
          status, records_seen, records_inserted, records_updated,
          records_skipped, records_failed, checkpoint, errors, started_at, finished_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'completed', %s, 0, %s, 0, 0,
                  %s, '[]'::jsonb, now(), now())
        ON CONFLICT (source_artifact_uri, source_checksum_sha256, target_table)
        DO UPDATE SET
          feature_set_id = EXCLUDED.feature_set_id,
          artifact_id = EXCLUDED.artifact_id,
          status = EXCLUDED.status,
          records_seen = EXCLUDED.records_seen,
          records_inserted = EXCLUDED.records_inserted,
          records_updated = EXCLUDED.records_updated,
          records_skipped = EXCLUDED.records_skipped,
          records_failed = EXCLUDED.records_failed,
          checkpoint = EXCLUDED.checkpoint,
          errors = EXCLUDED.errors,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at
    """
    rows = []
    for artifact in bundle.artifact_specs:
        records = int(artifact.record_count or 0)
        rows.append(
            (
                _stable_id("ingestion", artifact.storage_uri, artifact.target_table),
                artifact.feature_set_id,
                artifact.artifact_id,
                artifact.storage_uri,
                artifact.sha256,
                artifact.target_table,
                artifact.feature_set_id.split(":", 1)[0],
                IMPORTER_VERSION,
                records,
                records,
                _json_text({
                    "mode": "idempotent_upsert",
                    "records_processed": records,
                    "storage_mode": "local",
                }),
            )
        )
    with connection.cursor() as cursor:
        cursor.executemany(sql, rows)
    return len(rows)


def _create_staged_release(
    connection: Any,
    state: DatasetState,
    bundle: ImportBundle,
    options: ImportOptions,
) -> int:
    release_sql = """
        INSERT INTO index_releases (
          index_version, dataset_version, status, metadata
        ) VALUES (%s, %s, 'staged', %s)
        ON CONFLICT (index_version) DO NOTHING
    """
    feature_sql = """
        INSERT INTO index_release_features (
          index_version, dataset_version, modality, feature_set_id
        ) VALUES (%s, %s, %s, %s)
        ON CONFLICT (index_version, modality) DO UPDATE SET
          dataset_version = EXCLUDED.dataset_version,
          feature_set_id = EXCLUDED.feature_set_id
    """
    with connection.cursor() as cursor:
        cursor.execute(
            release_sql,
            (
                options.index_version,
                state.dataset_version,
                _json_text({
                    "source": "data/refined",
                    "importer_version": IMPORTER_VERSION,
                    "status_policy": "staged_until_index_validation",
                    "text_encoder_revision": options.text_encoder_revision,
                }),
            ),
        )
        rows = [
            (options.index_version, state.dataset_version, spec.modality, spec.feature_set_id)
            for spec in bundle.feature_specs
        ]
        cursor.executemany(feature_sql, rows)
    return len(rows)


def import_to_database(state: DatasetState, options: ImportOptions) -> dict[str, Any]:
    """Import a validated dataset into PostgreSQL using idempotent upserts."""

    if not options.database_url:
        raise ValueError("DATABASE_URL or DATABASE_DIRECT_URL is required for import")
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required; install pipelines/ingestion/requirements.txt"
        ) from exc

    bundle = build_import_bundle(state, options)
    connection = psycopg.connect(options.database_url)
    try:
        counts: dict[str, int] = {}
        counts["videos"] = int(_run_phase(connection, lambda conn: _import_videos(conn, state, options)) or 0)
        counts["frames"] = int(_run_phase(connection, lambda conn: _import_frames(conn, state, options)) or 0)
        counts["frame_aliases"] = int(_run_phase(connection, lambda conn: _import_aliases(conn, state, options)) or 0)
        counts["feature_metadata"] = int(
            _run_phase(connection, lambda conn: _insert_feature_metadata(conn, bundle, options)) or 0
        )
        counts["captions"] = int(
            _run_phase(connection, lambda conn: _insert_caption_evidence(conn, state, bundle, options)) or 0
        )
        counts["ocr"] = int(
            _run_phase(connection, lambda conn: _insert_ocr_evidence(conn, state, bundle, options)) or 0
        )
        counts["asr"] = int(
            _run_phase(connection, lambda conn: _insert_asr_evidence(conn, state, bundle, options)) or 0
        )
        counts["objects"] = int(
            _run_phase(connection, lambda conn: _insert_object_evidence(conn, state, bundle, options)) or 0
        )
        counts["embeddings"] = int(
            _run_phase(connection, lambda conn: _insert_embedding_evidence(conn, state, bundle, options)) or 0
        )
        counts["ingestion_runs"] = int(
            _run_phase(connection, lambda conn: _record_ingestion_runs(conn, bundle, options)) or 0
        )
        counts["release_features"] = int(
            _run_phase(connection, lambda conn: _create_staged_release(conn, state, bundle, options)) or 0
        )
        return {
            "status": "imported",
            "importer_version": IMPORTER_VERSION,
            "dataset_version": state.dataset_version,
            "index_version": options.index_version,
            "counts": counts,
            "embedding_upload_to_r2_required": False,
            "text_encoder_revision": options.text_encoder_revision,
        }
    finally:
        connection.close()
