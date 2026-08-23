import { describe, expect, it } from 'vitest';

import { SearchSessionStore } from '../src/session-store.js';

describe('SearchSessionStore', () => {
  it('keeps bounded, non-sensitive search state and expires stale sessions', () => {
    let now = 1_000;
    const store = new SearchSessionStore({ maxSessions: 2, ttlMs: 100, now: () => now });
    const first = store.create({ sessionId: 'session-1', task: 'trake', originalQuery: 'main query' });

    store.update(first.sessionId, {
      improvedQuery: 'improved query',
      warnings: ['warning'],
      attemptedFrames: [{ videoId: 'video-1', originalFrameId: 4 }],
      evidence: [{ videoId: 'video-1', originalFrameId: 4, keyframeNo: 2, timestampMs: 100, thumbnailUri: 'https://signed.example/secret', captions: ['caption'], ocr: [], objects: [], asr: [], evidenceIds: ['e-1'] }],
    });

    expect(store.get('session-1')).toMatchObject({
      sessionId: 'session-1',
      improvedQuery: 'improved query',
      attemptedFrames: [{ videoId: 'video-1', originalFrameId: 4 }],
    });
    expect(store.get('session-1')?.evidence[0].thumbnailUri).toBeNull();

    now = 1_101;
    expect(store.get('session-1')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('evicts the oldest session at the configured capacity', () => {
    let now = 1_000;
    const store = new SearchSessionStore({ maxSessions: 2, ttlMs: 10_000, now: () => now });
    store.create({ sessionId: 'session-1', task: 'vqa', originalQuery: 'one' });
    now += 1;
    store.create({ sessionId: 'session-2', task: 'vqa', originalQuery: 'two' });
    now += 1;
    store.create({ sessionId: 'session-3', task: 'vqa', originalQuery: 'three' });

    expect(store.get('session-1')).toBeNull();
    expect(store.get('session-2')).not.toBeNull();
    expect(store.get('session-3')).not.toBeNull();
  });
});
