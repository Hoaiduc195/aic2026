ALTER TABLE agent_verification_runs
  ADD COLUMN IF NOT EXISTS scan_mode text NOT NULL DEFAULT 'sparse';

ALTER TABLE agent_verification_runs
  DROP CONSTRAINT IF EXISTS agent_verification_runs_scan_mode_check;

ALTER TABLE agent_verification_runs
  ADD CONSTRAINT agent_verification_runs_scan_mode_check
  CHECK (scan_mode IN ('sparse', 'dense'));

CREATE TABLE IF NOT EXISTS agent_verification_judgments (
  run_id text NOT NULL REFERENCES agent_verification_runs(run_id) ON DELETE CASCADE,
  video_id text NOT NULL,
  original_frame_id integer NOT NULL CHECK (original_frame_id >= 0),
  relevant boolean NOT NULL,
  score real NOT NULL CHECK (score >= 0 AND score <= 1),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  judged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, video_id, original_frame_id)
);

CREATE INDEX IF NOT EXISTS agent_verification_judgments_matches_idx
  ON agent_verification_judgments (run_id, score DESC, judged_at)
  WHERE relevant;

-- Preserve judgments produced before this normalized table existed.
INSERT INTO agent_verification_judgments (
  run_id, video_id, original_frame_id, relevant, score, reason, judged_at
)
SELECT avr.run_id,
       item->>'video_id',
       (item->>'original_frame_id')::integer,
       (item->>'relevant')::boolean,
       (item->>'score')::real,
       NULLIF(item->>'reason', ''),
       COALESCE((item->>'judged_at')::timestamptz, avr.updated_at)
FROM agent_verification_runs avr
CROSS JOIN LATERAL jsonb_array_elements(avr.judgments) AS item
WHERE jsonb_typeof(avr.judgments) = 'array'
  AND item ? 'video_id'
  AND item ? 'original_frame_id'
  AND item ? 'relevant'
  AND item ? 'score'
ON CONFLICT (run_id, video_id, original_frame_id) DO NOTHING;
