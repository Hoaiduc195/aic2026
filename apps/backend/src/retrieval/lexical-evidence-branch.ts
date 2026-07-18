import { immutable, immutableArray } from '../common/immutable';
import { BranchCandidate, BranchName, BranchQuery, RetrievalBranch } from './retrieval.types';

export interface EvidenceIndexRecord {
  readonly segmentId: string;
  readonly videoId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export class LexicalEvidenceBranch implements RetrievalBranch {
  readonly name: BranchName;
  private readonly records: readonly EvidenceIndexRecord[];

  constructor(name: BranchName, records: readonly EvidenceIndexRecord[]) {
    this.name = name;
    this.records = immutableArray(records.map((record) => {
      if (!record.segmentId || !record.videoId || record.endMs <= record.startMs || record.startMs < 0) {
        throw new Error('Evidence record has an invalid identity or interval');
      }
      if (!record.text.trim() || record.evidenceIds.length === 0) throw new Error('Evidence record must be searchable and attributable');
      return immutable({ ...record, evidenceIds: immutableArray(record.evidenceIds) });
    }));
  }

  async search(query: BranchQuery): Promise<readonly BranchCandidate[]> {
    const queryTokens = new Set(query.variants.flatMap(tokenize));
    const scored = this.records.map((record) => {
      const recordTokens = new Set(tokenize(record.text));
      const matches = [...queryTokens].filter((token) => recordTokens.has(token)).length;
      return { record, score: queryTokens.size ? matches / queryTokens.size : 0 };
    }).filter(({ score }) => score >= 0.5)
      .sort((left, right) => right.score - left.score || left.record.segmentId.localeCompare(right.record.segmentId))
      .slice(0, query.topK);
    return immutableArray(scored.map(({ record, score }, index) => immutable({
      segmentId: record.segmentId, videoId: record.videoId,
      startMs: record.startMs, endMs: record.endMs, rank: index + 1,
      rawScore: score, evidenceIds: immutableArray(record.evidenceIds),
    })));
  }
}

function tokenize(value: string): string[] {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('vi')
    .split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
}
