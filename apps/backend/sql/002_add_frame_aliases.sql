-- Keep every sparse/keyframe occurrence while preserving one canonical row in frames.
-- The canonical identity remains (video_id, original_frame_id); the occurrence
-- identity is (video_id, keyframe_no).

CREATE TABLE IF NOT EXISTS frame_aliases (
  video_id text NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  keyframe_no integer NOT NULL CHECK (keyframe_no > 0),
  original_frame_id integer NOT NULL CHECK (original_frame_id >= 0),
  timestamp_ms integer NOT NULL CHECK (timestamp_ms >= 0),
  thumbnail_object_key text NOT NULL CHECK (
    thumbnail_object_key ~ '^[^/[:space:]][^?#[:space:]]+$'
    AND thumbnail_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  storage_uri text NOT NULL CHECK (storage_uri ~ '^(r2|s3)://[^?#[:space:]]+$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, keyframe_no),
  FOREIGN KEY (video_id, original_frame_id)
    REFERENCES frames(video_id, original_frame_id) ON DELETE CASCADE,
  UNIQUE (thumbnail_object_key),
  UNIQUE (storage_uri)
);

CREATE INDEX IF NOT EXISTS frame_aliases_video_frame_idx
  ON frame_aliases (video_id, original_frame_id, keyframe_no);
