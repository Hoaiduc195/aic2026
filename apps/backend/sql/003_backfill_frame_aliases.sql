-- Data migration for databases that already contain canonical frames.
-- New imports should write all occurrences to frame_aliases directly.

INSERT INTO frame_aliases (
  video_id,
  keyframe_no,
  original_frame_id,
  timestamp_ms,
  thumbnail_object_key,
  storage_uri,
  metadata
)
SELECT
  video_id,
  keyframe_no,
  original_frame_id,
  timestamp_ms,
  thumbnail_object_key,
  storage_uri,
  jsonb_build_object('source', 'frames_representative')
FROM frames
ON CONFLICT (video_id, keyframe_no) DO NOTHING;
