CREATE TABLE IF NOT EXISTS agent_verification_runs (
  run_id text PRIMARY KEY,
  query_id text NOT NULL,
  task text NOT NULL CHECK (task IN ('textual_kis', 'vqa', 'trake')),
  query_text text NOT NULL CHECK (length(btrim(query_text)) > 0),
  index_version text NOT NULL,
  video_budget integer NOT NULL CHECK (video_budget BETWEEN 1 AND 50),
  frame_batch_size integer NOT NULL CHECK (frame_batch_size BETWEEN 1 AND 32),
  video_rank jsonb NOT NULL CHECK (jsonb_typeof(video_rank) = 'array'),
  current_video_index integer NOT NULL DEFAULT 0 CHECK (current_video_index >= 0),
  current_frame_cursor integer CHECK (current_frame_cursor IS NULL OR current_frame_cursor >= 0),
  pending_batch jsonb NOT NULL DEFAULT 'null'::jsonb
    CHECK (jsonb_typeof(pending_batch) IN ('null', 'object')),
  judgments jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(judgments) = 'array'),
  videos_examined integer NOT NULL DEFAULT 0 CHECK (videos_examined >= 0),
  frames_examined integer NOT NULL DEFAULT 0 CHECK (frames_examined >= 0),
  frames_total integer NOT NULL DEFAULT 0 CHECK (frames_total >= 0),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_verification_runs_status_idx
  ON agent_verification_runs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_verification_runs_query_idx
  ON agent_verification_runs (query_id, created_at DESC);
