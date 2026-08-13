BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS videos (
  video_id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE CHECK (object_key LIKE 'videos/%'),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  fps double precision NOT NULL CHECK (fps > 0),
  frame_count integer CHECK (frame_count IS NULL OR frame_count > 0),
  mime_type text NOT NULL DEFAULT 'video/mp4' CHECK (mime_type IN ('video/mp4', 'video/webm', 'video/ogg')),
  dataset_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segments (
  segment_id text PRIMARY KEY,
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms > start_ms),
  segment_ordinal integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (video_id, start_ms, end_ms)
);
CREATE INDEX IF NOT EXISTS segments_video_time_idx ON segments (video_id, start_ms, end_ms);

CREATE TABLE IF NOT EXISTS frames (
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  keyframe_no integer NOT NULL CHECK (keyframe_no >= 0),
  original_frame_id integer NOT NULL CHECK (original_frame_id >= 0),
  timestamp_ms integer NOT NULL CHECK (timestamp_ms >= 0),
  thumbnail_object_key text NOT NULL CHECK (thumbnail_object_key LIKE 'keyframes/%'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (video_id, original_frame_id),
  UNIQUE (video_id, keyframe_no)
);
CREATE INDEX IF NOT EXISTS frames_video_timestamp_idx ON frames (video_id, timestamp_ms);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id text PRIMARY KEY,
  evidence_type text NOT NULL CHECK (evidence_type IN ('frame', 'ocr', 'asr', 'caption', 'object', 'track', 'audio', 'temporal')),
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  segment_id text NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  original_frame_id integer,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms > start_ms),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  producer text NOT NULL,
  model_version text,
  artifact_object_key text CHECK (artifact_object_key IS NULL OR artifact_object_key LIKE 'features/%'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (video_id, original_frame_id) REFERENCES frames(video_id, original_frame_id)
);
CREATE INDEX IF NOT EXISTS evidence_video_time_idx ON evidence (video_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS evidence_segment_idx ON evidence (segment_id);
CREATE INDEX IF NOT EXISTS evidence_type_idx ON evidence (evidence_type);

CREATE TABLE IF NOT EXISTS text_evidence (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
  language text NOT NULL DEFAULT 'unknown',
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', text_content)) STORED
);
CREATE INDEX IF NOT EXISTS text_evidence_search_idx ON text_evidence USING gin (search_document);
CREATE INDEX IF NOT EXISTS text_evidence_trgm_idx ON text_evidence USING gin (lower(text_content) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS object_evidence (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  normalized_label text GENERATED ALWAYS AS (lower(btrim(label))) STORED,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  bbox jsonb,
  track_id text
);
CREATE INDEX IF NOT EXISTS object_evidence_label_idx ON object_evidence USING gin (normalized_label gin_trgm_ops);

CREATE TABLE IF NOT EXISTS clip_embeddings (
  evidence_id text PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  embedding vector(512) NOT NULL,
  model_version text NOT NULL
);
CREATE INDEX IF NOT EXISTS clip_embeddings_hnsw_idx ON clip_embeddings USING hnsw (embedding vector_cosine_ops);

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
  segment_id text NOT NULL,
  video_id text NOT NULL,
  original_frame_id integer,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms > start_ms),
  preview_uri text,
  score double precision NOT NULL,
  evidence_ids text[] NOT NULL DEFAULT '{}',
  matched_modalities text[] NOT NULL DEFAULT '{}',
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

COMMIT;
