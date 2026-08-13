import { describe, expect, it } from 'vitest';

import { parseSearchRequest } from '../src/common/request-validation';

describe('parseSearchRequest', () => {
  it('accepts the three preliminary-round tasks and retrieval overrides', () => {
    expect(parseSearchRequest({
      query: 'find a person running',
      task: 'textual_kis',
      top_k: 20,
      retrieval: { branch_k: 200, fusion_k: 500, display_k: 100 },
    })).toEqual({
      query: 'find a person running',
      task: 'textual_kis',
      top_k: 20,
      session_id: undefined,
      retrieval: { branch_k: 200, fusion_k: 500, display_k: 100 },
    });
  });

  it('rejects tasks outside the configured preliminary-round scope', () => {
    expect(() => parseSearchRequest({ query: 'query', task: 'avs' })).toThrow('task must be one of');
  });
});
