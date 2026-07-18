import { BranchRuntime } from '../src/retrieval/branch-runtime';
import { FusedCandidate, RetrievalBranch } from '../src/retrieval/retrieval.types';
import { weightedRrf } from '../src/retrieval/weighted-rrf';
import { groupTemporalCandidates } from '../src/retrieval/temporal-grouping';
import { LexicalEvidenceBranch } from '../src/retrieval/lexical-evidence-branch';

describe('retrieval primitives', () => {
  it('searches a validated immutable Vietnamese evidence index', async () => {
    const branch = new LexicalEvidenceBranch('ocr_lexical', [{
      segmentId: 's', videoId: 'v', startMs: 0, endMs: 1000,
      text: 'Bến Thành xe buýt 18', evidenceIds: ['ev-ocr'],
    }]);
    const results = await branch.search({ variants: ['ben thanh'], topK: 5 });
    expect(results[0]).toMatchObject({ segmentId: 's', evidenceIds: ['ev-ocr'], rank: 1 });
    expect(await branch.search({ variants: ['không liên quan'], topK: 5 })).toEqual([]);
    expect(() => new LexicalEvidenceBranch('ocr_lexical', [{
      segmentId: 'bad', videoId: 'v', startMs: 5, endMs: 1, text: 'x', evidenceIds: ['e'],
    }])).toThrow('interval');
  });
  it('reports missing, successful, and failed branches independently', async () => {
    const success: RetrievalBranch = { name: 'visual', search: async () => [{
      segmentId: 'ok', videoId: 'v', startMs: 0, endMs: 10, rank: 1, rawScore: 1, evidenceIds: ['ev'],
    }] };
    const failed: RetrievalBranch = { name: 'ocr_lexical', search: async () => { throw new Error('private detail'); } };
    const runtime = new BranchRuntime([success, failed]);
    const results = await runtime.execute(['visual', 'ocr_lexical', 'asr_lexical'], { variants: ['q'], topK: 1 }, 100);
    expect(results.map((value) => value.status)).toEqual(['completed', 'failed', 'unavailable']);
    expect(results[1].errorCode).toBe('BRANCH_FAILED');
  });

  it('contains malformed adapter output as a failed branch', async () => {
    const malformed: RetrievalBranch = { name: 'visual', search: async () => [{
      segmentId: 'bad', videoId: 'v', startMs: 0, endMs: 1, rank: 0, rawScore: Number.NaN, evidenceIds: [],
    }] };
    const [result] = await new BranchRuntime([malformed]).execute(['visual'], { variants: ['q'], topK: 1 }, 100);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'BRANCH_FAILED', candidates: [] });
  });

  it('isolates timeout and returns a degraded branch result', async () => {
    const slow: RetrievalBranch = {
      name: 'visual',
      search: () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
    };
    const runtime = new BranchRuntime([slow]);
    const [result] = await runtime.execute(['visual'], { variants: ['query'], topK: 5 }, 5);
    expect(result.status).toBe('timed_out');
    expect(result.candidates).toEqual([]);
  });

  it('uses deterministic weighted RRF with stable tie breaking', () => {
    const fused = weightedRrf([
      { branch: 'visual', status: 'completed', elapsedMs: 1, candidates: [
        { segmentId: 'b', videoId: 'v', startMs: 0, endMs: 5, rank: 1, rawScore: .9, evidenceIds: [] },
        { segmentId: 'a', videoId: 'v', startMs: 10, endMs: 15, rank: 2, rawScore: .8, evidenceIds: [] },
      ] },
      { branch: 'ocr_lexical', status: 'completed', elapsedMs: 1, candidates: [
        { segmentId: 'a', videoId: 'v', startMs: 10, endMs: 15, rank: 1, rawScore: 10, evidenceIds: ['e1'] },
      ] },
    ], { visual: 1, ocr_lexical: 2 }, 60);
    expect(fused[0].segmentId).toBe('a');
    expect(fused[0].matchedBranches).toEqual(['ocr_lexical', 'visual']);
    expect(fused[0].evidenceIds).toEqual(['e1']);
  });

  it('groups overlapping candidates from one video without mutation', () => {
    const input: readonly FusedCandidate[] = [
      { segmentId: 'a', videoId: 'v', startMs: 0, endMs: 1000, score: 1, matchedBranches: ['visual'], evidenceIds: [] },
      { segmentId: 'b', videoId: 'v', startMs: 900, endMs: 1800, score: .5, matchedBranches: ['ocr_lexical'], evidenceIds: ['e'] },
    ];
    const grouped = groupTemporalCandidates(input, 0.05);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ segmentId: 'a', startMs: 0, endMs: 1000 });
    expect(input[0].endMs).toBe(1000);
  });

  it('keeps disjoint videos and prefers the higher-scored overlapping identity', () => {
    const grouped = groupTemporalCandidates([
      { segmentId: 'low', videoId: 'v', startMs: 0, endMs: 100, score: .1, matchedBranches: ['visual'], evidenceIds: [] },
      { segmentId: 'high', videoId: 'v', startMs: 20, endMs: 120, score: .9, matchedBranches: ['ocr_lexical'], evidenceIds: ['ev'] },
      { segmentId: 'other', videoId: 'v2', startMs: 0, endMs: 100, score: .2, matchedBranches: ['visual'], evidenceIds: ['ev2'] },
    ], .5);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ segmentId: 'high', startMs: 20, endMs: 120 });
  });

  it('ignores failed RRF branches and uses default weights', () => {
    expect(weightedRrf([{ branch: 'visual', status: 'failed', elapsedMs: 1, candidates: [], errorCode: 'x' }])).toEqual([]);
    const fused = weightedRrf([{ branch: 'asr_lexical', status: 'completed', elapsedMs: 1, candidates: [
      { segmentId: 'a', videoId: 'v', startMs: 0, endMs: 1, rank: 1, rawScore: 1, evidenceIds: ['e'] },
    ] }]);
    expect(fused[0].score).toBeCloseTo(1 / 61);
  });
});
