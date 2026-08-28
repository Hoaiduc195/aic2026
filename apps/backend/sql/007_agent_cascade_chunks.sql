-- Dense cascade workers commit larger chunks so one video stream can stay open.
-- Sparse/MCP callers may continue using small batches.
ALTER TABLE agent_verification_runs
  DROP CONSTRAINT IF EXISTS agent_verification_runs_frame_batch_size_check;

ALTER TABLE agent_verification_runs
  ADD CONSTRAINT agent_verification_runs_frame_batch_size_check
  CHECK (frame_batch_size BETWEEN 1 AND 512);
