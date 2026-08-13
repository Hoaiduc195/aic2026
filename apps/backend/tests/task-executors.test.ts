import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/common/config';
import type { TaskExecutorInput } from '../src/tasks/task-executor';
import { TaskExecutorRegistry } from '../src/tasks/task-registry';
import { TextualKisExecutor } from '../src/tasks/textual-kis/textual-kis.executor';
import { TrakeExecutor } from '../src/tasks/trake/trake.executor';
import { VqaExecutor } from '../src/tasks/vqa/vqa.executor';

const input = {
  request: { query: 'q', task: 'textual_kis' },
  plan: { query_id: 'q', display_k: 1, index_version: 'v1' },
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
      'trake-retrieval-temporal-ready-v1',
    ]);
    expect(registry.resolve('textual_kis')).toBe(textual);
    expect(() => registry.register(textual)).toThrow('already registered');
    await expect(new TrakeExecutor().execute({ ...input, request: { ...input.request, task: 'trake' } }))
      .resolves.toMatchObject({ task: 'trake', warnings: [expect.stringContaining('temporal_aligner')] });
  });

  it('rejects missing task executors', () => {
    expect(() => new TaskExecutorRegistry().resolve('vqa')).toThrow('no executor');
  });
});
