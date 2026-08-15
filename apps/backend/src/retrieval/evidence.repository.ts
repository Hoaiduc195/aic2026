import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';

export interface EvidenceView {
  readonly evidence_id: string;
  readonly type: string;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly snippet: string | null;
  readonly producer: string;
}

export interface EvidenceRepository {
  findByIds(evidenceIds: readonly string[]): Promise<ReadonlyMap<string, EvidenceView>>;
}

interface EvidenceRow extends QueryResultRow, EvidenceView {}

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: DatabaseClient) {}

  async findByIds(evidenceIds: readonly string[]): Promise<ReadonlyMap<string, EvidenceView>> {
    if (evidenceIds.length === 0) return new Map();
    const result = await this.database.query<EvidenceRow>(`
      SELECT e.evidence_id, e.evidence_type AS type, e.start_ms, e.end_ms,
             COALESCE(t.text_content, o.label, e.payload->>'snippet') AS snippet,
             fs.producer
      FROM evidence e
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      LEFT JOIN text_evidence t ON t.evidence_id = e.evidence_id
      LEFT JOIN object_evidence o ON o.evidence_id = e.evidence_id
      WHERE e.evidence_id = ANY($1::text[])`, [evidenceIds]);
    return new Map(result.rows.map((row) => [row.evidence_id, {
      evidence_id: row.evidence_id, type: row.type, start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms), snippet: row.snippet, producer: row.producer,
    }]));
  }
}

export class EmptyEvidenceRepository implements EvidenceRepository {
  async findByIds(_evidenceIds: readonly string[]): Promise<ReadonlyMap<string, EvidenceView>> { return new Map(); }
}
