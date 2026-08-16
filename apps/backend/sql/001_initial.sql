CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS videos (
  video_id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE CHECK (
    object_key ~ '^[^/[:space:]][^?#[:space:]]+$'
    AND object_key !~ '(^|/)\.\.?(/|$)'
  ),
  original_filename text NOT NULL,
  storage_uri text NOT NULL UNIQUE CHECK (storage_uri ~ '^(r2|s3)://[^?#[:space:]]+$'),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  fps_str text NOT NULL CHECK (fps_str ~ '^[1-9][0-9]*/[1-9][0-9]*$'),
  fps double precision NOT NULL CHECK (fps > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  etag text,
  version_id text,
  frame_count integer CHECK (frame_count IS NULL OR frame_count > 0),
  mime_type text NOT NULL DEFAULT 'video/mp4' CHECK (mime_type IN ('video/mp4', 'video/webm', 'video/ogg')),
  dataset_version text NOT NULL,
  pipeline_version text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_sets (
  feature_set_id text PRIMARY KEY,
  modality text NOT NULL CHECK (modality IN (
    'visual_embedding', 'caption', 'ocr', 'asr', 'object', 'track', 'audio', 'temporal'
  )),
  dataset_version text NOT NULL,
  pipeline_version text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  producer text NOT NULL CHECK (length(btrim(producer)) > 0),
  model_name text,
  model_version text,
  embedding_dimensions integer,
  embedding_dtype text,
  embedding_normalized boolean,
  manifest_uri text NOT NULL CHECK (manifest_uri ~ '^(r2|s3|file|https?)://[^?#[:space:]]+$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    modality <> 'visual_embedding'
    OR (
      embedding_dimensions = 1024
      AND embedding_dtype IN ('float16', 'float32')
      AND embedding_normalized IS TRUE
      AND model_name IS NOT NULL
      AND model_version IS NOT NULL
      AND length(btrim(model_name)) > 0
      AND length(btrim(model_version)) > 0
    )
  ),
  CHECK (
    modality = 'visual_embedding'
    OR (
      embedding_dimensions IS NULL
      AND embedding_dtype IS NULL
      AND embedding_normalized IS NULL
    )
  ),
  UNIQUE (feature_set_id, dataset_version, modality)
);
CREATE INDEX IF NOT EXISTS feature_sets_dataset_modality_idx
  ON feature_sets (dataset_version, modality);

CREATE TABLE IF NOT EXISTS index_releases (
  index_version text PRIMARY KEY,
  dataset_version text NOT NULL,
  index_checksum text CHECK (index_checksum IS NULL OR index_checksum ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'retired')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (index_version, dataset_version),
  CHECK (
    (status = 'staged' AND activated_at IS NULL)
    OR (status IN ('active', 'retired') AND activated_at IS NOT NULL AND index_checksum IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS index_releases_one_active_idx
  ON index_releases ((status))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS index_release_features (
  index_version text NOT NULL,
  dataset_version text NOT NULL,
  modality text NOT NULL,
  feature_set_id text NOT NULL,
  PRIMARY KEY (index_version, modality),
  FOREIGN KEY (index_version, dataset_version)
    REFERENCES index_releases(index_version, dataset_version) ON DELETE CASCADE,
  FOREIGN KEY (feature_set_id, dataset_version, modality)
    REFERENCES feature_sets(feature_set_id, dataset_version, modality) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS index_release_features_set_idx
  ON index_release_features (feature_set_id);

CREATE TABLE IF NOT EXISTS feature_artifacts (
  artifact_id text PRIMARY KEY,
  feature_set_id text NOT NULL REFERENCES feature_sets(feature_set_id) ON DELETE CASCADE,
  video_id text REFERENCES videos(video_id) ON DELETE CASCADE,
  artifact_type text NOT NULL CHECK (artifact_type IN ('parquet', 'json', 'jsonl', 'npy', 'other')),
  storage_uri text NOT NULL CHECK (storage_uri ~ '^(r2|s3|file|https?)://[^?#[:space:]]+$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  record_count bigint CHECK (record_count IS NULL OR record_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_set_id, storage_uri),
  UNIQUE (artifact_id, feature_set_id)
);
CREATE INDEX IF NOT EXISTS feature_artifacts_video_idx
  ON feature_artifacts (video_id, feature_set_id);

CREATE TABLE IF NOT EXISTS frames (
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  keyframe_no integer NOT NULL CHECK (keyframe_no > 0),
  original_frame_id integer NOT NULL CHECK (original_frame_id >= 0),
  timestamp_ms integer NOT NULL CHECK (timestamp_ms >= 0),
  thumbnail_object_key text NOT NULL CHECK (
    thumbnail_object_key ~ '^[^/[:space:]][^?#[:space:]]+$'
    AND thumbnail_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  storage_uri text NOT NULL CHECK (storage_uri ~ '^(r2|s3)://[^?#[:space:]]+$'),
  retrieval_roles text[] NOT NULL DEFAULT '{}',
  quality_route text NOT NULL CHECK (quality_route IN ('retrieval_embedding', 'temporal_only')),
  eligible_for_embedding boolean NOT NULL,
  pipeline_version text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (video_id, original_frame_id),
  UNIQUE (video_id, keyframe_no),
  UNIQUE (thumbnail_object_key),
  UNIQUE (storage_uri)
);
CREATE INDEX IF NOT EXISTS frames_video_timestamp_idx ON frames (video_id, timestamp_ms);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id text PRIMARY KEY,
  evidence_type text NOT NULL CHECK (evidence_type IN ('frame', 'ocr', 'asr', 'caption', 'object', 'track', 'audio', 'temporal')),
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  feature_set_id text NOT NULL REFERENCES feature_sets(feature_set_id) ON DELETE RESTRICT,
  artifact_id text,
  source_record_index bigint CHECK (source_record_index IS NULL OR source_record_index >= 0),
  original_frame_id integer,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms > start_ms),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (video_id, original_frame_id) REFERENCES frames(video_id, original_frame_id),
  FOREIGN KEY (artifact_id, feature_set_id) REFERENCES feature_artifacts(artifact_id, feature_set_id)
);
CREATE INDEX IF NOT EXISTS evidence_video_time_idx ON evidence (video_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS evidence_type_idx ON evidence (evidence_type);
CREATE INDEX IF NOT EXISTS evidence_feature_set_idx ON evidence (feature_set_id, evidence_type);

CREATE TABLE IF NOT EXISTS text_evidence (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
  normalized_text text NOT NULL CHECK (length(btrim(normalized_text)) > 0),
  language text NOT NULL DEFAULT 'unknown',
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', normalized_text)) STORED
);

CREATE TABLE IF NOT EXISTS object_evidence (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  class_id integer CHECK (class_id IS NULL OR class_id >= 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  normalized_label text GENERATED ALWAYS AS (lower(btrim(label))) STORED,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  bbox real[],
  normalized_bbox real[],
  track_id text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (bbox IS NULL OR cardinality(bbox) = 4),
  CHECK (
    normalized_bbox IS NULL
    OR (
      cardinality(normalized_bbox) = 4
      AND normalized_bbox[1] BETWEEN 0 AND 1
      AND normalized_bbox[2] BETWEEN 0 AND 1
      AND normalized_bbox[3] BETWEEN 0 AND 1
      AND normalized_bbox[4] BETWEEN 0 AND 1
    )
  )
);

CREATE TABLE IF NOT EXISTS clip_embeddings (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  embedding_id text NOT NULL UNIQUE,
  embedding vector(1024) NOT NULL,
  CHECK (vector_dims(embedding) = 1024)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  ingestion_id text PRIMARY KEY,
  feature_set_id text REFERENCES feature_sets(feature_set_id) ON DELETE RESTRICT,
  artifact_id text,
  source_artifact_uri text NOT NULL CHECK (source_artifact_uri ~ '^(r2|s3|file|https?)://[^?#[:space:]]+$'),
  source_checksum_sha256 text NOT NULL CHECK (source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  target_table text NOT NULL,
  dataset_version text NOT NULL,
  pipeline_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  records_seen bigint NOT NULL DEFAULT 0 CHECK (records_seen >= 0),
  records_inserted bigint NOT NULL DEFAULT 0 CHECK (records_inserted >= 0),
  records_updated bigint NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
  records_skipped bigint NOT NULL DEFAULT 0 CHECK (records_skipped >= 0),
  records_failed bigint NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (source_artifact_uri, source_checksum_sha256, target_table),
  FOREIGN KEY (artifact_id, feature_set_id) REFERENCES feature_artifacts(artifact_id, feature_set_id) ON DELETE RESTRICT,
  CHECK (records_inserted + records_updated + records_skipped + records_failed <= records_seen),
  CHECK (
    (status IN ('pending', 'running') AND finished_at IS NULL)
    OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  query_id text PRIMARY KEY,
  session_id text,
  task text NOT NULL CHECK (task IN ('textual_kis', 'vqa', 'trake')),
  query_text text NOT NULL CHECK (length(btrim(query_text)) > 0),
  plan jsonb NOT NULL,
  dataset_version text NOT NULL,
  index_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieval_candidates (
  query_id text NOT NULL REFERENCES retrieval_runs(query_id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank > 0),
  video_id text NOT NULL,
  original_frame_id integer,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms > start_ms),
  preview_uri text,
  score double precision NOT NULL,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  matched_modalities text[] NOT NULL DEFAULT '{}',
  fusion_trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (query_id, rank)
);
CREATE INDEX IF NOT EXISTS retrieval_candidates_query_score_idx ON retrieval_candidates (query_id, score DESC);

CREATE TABLE IF NOT EXISTS manual_selections (
  selection_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  query_id text NOT NULL REFERENCES retrieval_runs(query_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  task text NOT NULL CHECK (task IN ('textual_kis', 'vqa', 'trake')),
  answers jsonb NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_id, revision)
);
