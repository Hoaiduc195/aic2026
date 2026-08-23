import { describe, expect, it } from 'vitest';

import {
  frameRefSchema,
  parseToolLimit,
  safeBackendUrl,
  taskSchema,
} from '../src/validation.js';
import { loadConfig } from '../src/config.js';

describe('MCP input validation', () => {
  it('accepts an exact frame reference', () => {
    expect(frameRefSchema.parse({ videoId: 'video-01', originalFrameId: 12 })).toEqual({
      videoId: 'video-01',
      originalFrameId: 12,
    });
  });

  it('accepts a keyframe reference', () => {
    expect(frameRefSchema.parse({ videoId: 'video-01', keyframeNo: 4 })).toEqual({
      videoId: 'video-01',
      keyframeNo: 4,
    });
  });

  it('rejects a reference with both frame identifiers', () => {
    expect(() => frameRefSchema.parse({ videoId: 'video-01', originalFrameId: 12, keyframeNo: 4 })).toThrow();
  });

  it('rejects a reference without a frame identifier', () => {
    expect(() => frameRefSchema.parse({ videoId: 'video-01' })).toThrow();
  });

  it('clamps omitted and oversized limits to the configured maximum', () => {
    expect(parseToolLimit(undefined, 20)).toBe(20);
    expect(parseToolLimit(200, 20)).toBe(20);
    expect(parseToolLimit(3, 20)).toBe(3);
  });

  it('rejects non-http backend URLs and URLs containing credentials', () => {
    expect(() => safeBackendUrl('file:///tmp/backend')).toThrow();
    expect(() => safeBackendUrl('http://user:pass@localhost:4000')).toThrow();
  });

  it('normalizes a valid backend URL and rejects invalid limits', () => {
    expect(safeBackendUrl('http://localhost:4000///')).toBe('http://localhost:4000');
    expect(() => parseToolLimit(0, 20)).toThrow();
    expect(() => parseToolLimit(2.5, 20)).toThrow();
    expect(() => parseToolLimit(undefined, 0)).toThrow();
  });

  it('accepts supported AIC task types', () => {
    expect(taskSchema.parse('trake')).toBe('trake');
    expect(() => taskSchema.parse('web')).toThrow();
  });

  it('loads bounded configuration from environment variables', () => {
    expect(loadConfig({
      AIC_BACKEND_URL: 'https://aic.example.test/api/',
      AIC_OPERATOR_TOKEN: ' operator-token ',
      MCP_REQUEST_TIMEOUT_MS: '3000',
      MCP_MAX_RESULTS: '10',
      MCP_MAX_NEARBY_FRAMES: '12',
      MCP_MAX_IMAGE_BYTES: '1000',
      MCP_MAX_LOOP_ITERATIONS: '6',
      MCP_MAX_LOOP_TOOL_CALLS: '40',
      MCP_LOOP_TIME_BUDGET_MS: '70000',
    })).toEqual({
      backendUrl: 'https://aic.example.test/api',
      operatorToken: 'operator-token',
      requestTimeoutMs: 3000,
      maxResults: 10,
      maxNearbyFrames: 12,
      maxImageBytes: 1000,
      maxLoopIterations: 6,
      maxLoopToolCalls: 40,
      loopTimeBudgetMs: 70000,
    });
    expect(() => loadConfig({ MCP_MAX_RESULTS: '0' })).toThrow();
  });

  it('loads an optional embedding service configuration for backend searches', () => {
    expect(loadConfig({
      MCP_EMBEDDING_SERVICE_URL: 'http://127.0.0.1:8001/embed/',
      MCP_EMBEDDING_SERVICE_TOKEN: ' embedding-token ',
      MCP_EMBEDDING_TIMEOUT_MS: '2500',
    }).embedding).toEqual({
      baseUrl: 'http://127.0.0.1:8001/embed',
      apiKey: 'embedding-token',
      timeoutMs: 2500,
    });

    expect(loadConfig({
      EMBEDDING_SERVICE_URL: 'http://127.0.0.1:8001/embed',
      EMBEDDING_SERVICE_TOKEN: 'legacy-token',
    }).embedding).toEqual({
      baseUrl: 'http://127.0.0.1:8001/embed',
      apiKey: 'legacy-token',
      timeoutMs: 5000,
    });
  });

  it('rejects unsafe or incomplete embedding service configuration', () => {
    expect(() => loadConfig({ MCP_EMBEDDING_SERVICE_URL: 'ftp://embedding.local/embed' })).toThrow();
    expect(() => loadConfig({ MCP_EMBEDDING_SERVICE_URL: 'http://embedding.local/embed?token=secret' })).toThrow();
    expect(() => loadConfig({ MCP_EMBEDDING_SERVICE_TOKEN: 'token' })).toThrow();
    expect(() => loadConfig({
      MCP_EMBEDDING_SERVICE_URL: 'http://embedding.local/embed',
      MCP_EMBEDDING_TIMEOUT_MS: '50',
    })).toThrow();
  });
});
