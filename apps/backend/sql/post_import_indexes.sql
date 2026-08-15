-- Heavy search indexes are intentionally built after the initial bulk import.
-- This file is not a numbered migration and is executed statement-by-statement
-- by `npm run db:build-indexes` because CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS text_evidence_search_idx
  ON text_evidence USING gin (search_document);

CREATE INDEX CONCURRENTLY IF NOT EXISTS text_evidence_trgm_idx
  ON text_evidence USING gin (lower(text_content) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS object_evidence_label_idx
  ON object_evidence USING gin (normalized_label gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS clip_embeddings_hnsw_idx
  ON clip_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ANALYZE text_evidence;
ANALYZE object_evidence;
ANALYZE clip_embeddings;
