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

  it('accepts a validated per-request embedding service override', () => {
    expect(parseSearchRequest({
      query: 'find a red car',
      task: 'textual_kis',
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'session-secret',
        timeout_ms: 2500,
      },
    })).toMatchObject({
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'session-secret',
        timeout_ms: 2500,
      },
    });
  });

  it('rejects unsafe or unbounded embedding overrides', () => {
    expect(() => parseSearchRequest({
      query: 'query',
      task: 'textual_kis',
      embedding: { base_url: 'ftp://embedding.local/embed', timeout_ms: 2500 },
    })).toThrow('embedding.base_url');
    expect(() => parseSearchRequest({
      query: 'query',
      task: 'textual_kis',
      embedding: { base_url: 'http://embedding.local/embed', timeout_ms: 50 },
    })).toThrow('embedding.timeout_ms');
  });
});
