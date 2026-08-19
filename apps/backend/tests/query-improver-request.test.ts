import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseQueryImprovementRequest } from '../src/query-improver/query-improver.request';

describe('parseQueryImprovementRequest', () => {
  it('accepts a bounded query and optional frontend LLM configuration', () => {
    expect(parseQueryImprovementRequest({
      query: 'một người đi bộ',
      task: 'textual_kis',
      llm: {
        base_url: 'http://localhost:20128/v1',
        api_key: 'secret',
        model: 'model-a',
        timeout_ms: 15000,
        max_tokens: 256,
        temperature: 0,
      },
    })).toMatchObject({
      query: 'một người đi bộ',
      task: 'textual_kis',
      llm: { base_url: 'http://localhost:20128/v1', model: 'model-a' },
    });
  });

  it('rejects unsafe model URLs and unsupported tasks', () => {
    expect(() => parseQueryImprovementRequest({
      query: 'query', task: 'textual_kis', llm: {
        base_url: 'http://user:pass@example.com/v1', model: 'm',
        timeout_ms: 1000, max_tokens: 10, temperature: 0,
      },
    })).toThrow(BadRequestException);
    expect(() => parseQueryImprovementRequest({ query: 'query', task: 'video_kis' })).toThrow(BadRequestException);
  });
});
