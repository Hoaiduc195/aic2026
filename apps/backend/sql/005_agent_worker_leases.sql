ALTER TABLE agent_verification_runs
  ADD COLUMN IF NOT EXISTS query_embedding vector(1024),
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

ALTER TABLE agent_verification_runs
  DROP CONSTRAINT IF EXISTS agent_verification_runs_worker_id_check;

ALTER TABLE agent_verification_runs
  ADD CONSTRAINT agent_verification_runs_worker_id_check
  CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$');

CREATE INDEX IF NOT EXISTS agent_verification_runs_active_lease_idx
  ON agent_verification_runs (lease_expires_at)
  WHERE status = 'running' AND worker_id IS NOT NULL;
