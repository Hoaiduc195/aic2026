-- Read-only verification after `npm run db:migrate` and after each import.
-- Expected baseline: vector + pg_trgm installed, every table present, vector(1024).

SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('vector', 'pg_trgm')
ORDER BY extname;

SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
FROM pg_attribute AS a
JOIN pg_class AS c ON c.oid = a.attrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'clip_embeddings'
  AND a.attname = 'embedding'
  AND NOT a.attisdropped;

SELECT
  (SELECT count(*) FROM videos) AS videos,
  (SELECT count(*) FROM segments) AS segments,
  (SELECT count(*) FROM frames) AS frames,
  (SELECT count(*) FROM feature_sets) AS feature_sets,
  (SELECT count(*) FROM feature_artifacts) AS feature_artifacts,
  (SELECT count(*) FROM index_releases) AS index_releases,
  (SELECT count(*) FROM evidence) AS evidence,
  (SELECT count(*) FROM text_evidence) AS text_evidence,
  (SELECT count(*) FROM object_evidence) AS object_evidence,
  (SELECT count(*) FROM clip_embeddings) AS clip_embeddings;

SELECT
  min(vector_dims(embedding)) AS min_dimensions,
  max(vector_dims(embedding)) AS max_dimensions,
  bool_and(fs.embedding_normalized) AS all_normalized,
  count(DISTINCT fs.model_name || ':' || fs.model_version) AS model_spaces
FROM clip_embeddings AS c
JOIN evidence AS e ON e.evidence_id = c.evidence_id
JOIN feature_sets AS fs ON fs.feature_set_id = e.feature_set_id;

SELECT feature_set_id, modality, dataset_version, producer, model_name, model_version,
       embedding_dimensions, embedding_dtype, embedding_normalized
FROM feature_sets
ORDER BY modality, feature_set_id;

SELECT ir.index_version, ir.dataset_version, ir.index_checksum, ir.status,
       irf.modality, irf.feature_set_id
FROM index_releases AS ir
LEFT JOIN index_release_features AS irf
  ON irf.index_version = ir.index_version
 AND irf.dataset_version = ir.dataset_version
ORDER BY ir.index_version, irf.modality;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'text_evidence_search_idx',
    'text_evidence_trgm_idx',
    'object_evidence_label_idx',
    'clip_embeddings_hnsw_idx'
  )
ORDER BY indexname;

SELECT status, count(*) AS runs
FROM ingestion_runs
GROUP BY status
ORDER BY status;
