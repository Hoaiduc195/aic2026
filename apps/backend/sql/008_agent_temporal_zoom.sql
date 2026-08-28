ALTER TABLE agent_verification_runs
  DROP CONSTRAINT IF EXISTS agent_verification_runs_scan_mode_check;

ALTER TABLE agent_verification_runs
  ADD CONSTRAINT agent_verification_runs_scan_mode_check
  CHECK (scan_mode IN ('sparse', 'dense', 'temporal_zoom'));
