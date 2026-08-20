import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/common/config';
import type { TaskExecutorInput } from '../src/tasks/task-executor';
import { TaskExecutorRegistry } from '../src/tasks/task-registry';
import { TextualKisExecutor } from '../src/tasks/textual-kis/textual-kis.executor';
import { TrakeExecutor } from '../src/tasks/trake/trake.executor';
import { VqaExecutor } from '../src/tasks/vqa/vqa.executor';

const input = {
  request: { query: 'q', task: 'textual_kis' },
  plan: { query_id: 'q', display_k: 1, index_version: 'v1', query_variants: ['q'] },
  branchResults: [], candidates: [], elapsedMs: 1, config: loadConfig(),
} as unknown as TaskExecutorInput;

describe('task executor registry', () => {
  it('registers all three task strategies and prevents duplicates', async () => {
    const registry = new TaskExecutorRegistry();
    const textual = new TextualKisExecutor();
    registry.register(textual);
    registry.register(new VqaExecutor(loadConfig()));
    registry.register(new TrakeExecutor());
    expect(registry.names()).toEqual([
      'textual-kis-retrieval-v1',
      'vqa-retrieval-manual-ready-v1',
      'trake-retrieval-temporal-viterbi-v1',
    ]);
    expect(registry.resolve('textual_kis')).toBe(textual);
    expect(() => registry.register(textual)).toThrow('already registered');
    await expect(new TrakeExecutor().execute({ ...input, request: { ...input.request, task: 'trake' }, candidates: [] }))
      .resolves.toMatchObject({ task: 'trake', warnings: [] });
  });

  it('always returns text warnings for TRAKE when candidates are present', async () => {
    const candidate = {
      video_id: 'video-1',
      original_frame_id: 10,
      timestamp_ms: 1_000,
      start_ms: 1_000,
      end_ms: 1_001,
      score: 0.9,
      evidence_ids: [],
      matched_modalities: ['caption'],
      fusion_trace: [],
    };

    const result = await new TrakeExecutor().execute({
      ...input,
      request: { ...input.request, task: 'trake' },
      candidates: [candidate],
    });

    expect(result.warnings).toEqual([]);
    expect(result.warnings.every((warning) => typeof warning === 'string')).toBe(true);
  });

  it('rejects missing task executors', () => {
    expect(() => new TaskExecutorRegistry().resolve('vqa')).toThrow('no executor');
  });
});
