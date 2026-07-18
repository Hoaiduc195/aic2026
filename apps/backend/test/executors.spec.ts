import { ExecutorRegistry } from '../src/executors/executor-registry';
import { FusedCandidate } from '../src/retrieval/retrieval.types';

const candidates: readonly FusedCandidate[] = [
  { segmentId: 'a', videoId: 'v1', startMs: 0, endMs: 1000, score: 1, matchedBranches: ['visual'], evidenceIds: [] },
  { segmentId: 'b', videoId: 'v1', startMs: 1100, endMs: 2000, score: .9, matchedBranches: ['visual'], evidenceIds: [] },
  { segmentId: 'c', videoId: 'v2', startMs: 0, endMs: 1000, score: .8, matchedBranches: ['visual'], evidenceIds: [] },
];

describe('ExecutorRegistry', () => {
  const registry = new ExecutorRegistry();

  it.each(['textual_kis', 'video_kis', 'avs', 'vqa', 'kisc'] as const)('supports %s', (task) => {
    expect(registry.execute(task, candidates, 2).executor).toBeDefined();
  });

  it('diversifies AVS across videos', () => {
    const result = registry.execute('avs', candidates, 2);
    expect(result.results.map((candidate) => candidate.videoId)).toEqual(['v1', 'v2']);
  });

  it('makes VQA and KISC evidence-safe', () => {
    expect(registry.execute('vqa', [], 5).state).toBe('needs_more_evidence');
    expect(registry.execute('kisc', candidates, 5).state).toBe('clarification_available');
  });

  it('fills AVS from an already represented video and completes small KISC sets', () => {
    expect(registry.execute('avs', candidates, 3).results).toHaveLength(3);
    expect(registry.execute('kisc', candidates.slice(0, 1), 5).state).toBe('completed');
    expect(registry.execute('kisc', [], 5).state).toBe('needs_more_evidence');
  });
});
