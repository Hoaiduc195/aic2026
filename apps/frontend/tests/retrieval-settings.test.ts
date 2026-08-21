import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSearchRetrievalConfig,
  DEFAULT_RETRIEVAL_SETTINGS,
  loadRetrievalSettings,
  saveRetrievalSettings,
  validateRetrievalSettings,
} from '@/lib/retrieval-settings';

afterEach(() => {
  localStorage.clear();
});

describe('retrieval settings', () => {
  it('persists numeric settings and builds the search retrieval override', () => {
    const settings = {
      ...DEFAULT_RETRIEVAL_SETTINGS,
      display_k: 40,
      branch_k: 150,
      fusion_k: 600,
      near_frame_window_ms: 1000,
      vlm_rerank: { enabled: true, top_k: 10, weight: 0.7 },
    };

    expect(validateRetrievalSettings(settings)).toBeNull();
    saveRetrievalSettings(settings);

    expect(loadRetrievalSettings()).toEqual(settings);
    expect(buildSearchRetrievalConfig(settings)).toEqual({
      display_k: 40,
      branch_k: 150,
      fusion_k: 600,
      near_frame_window_ms: 1000,
      vlm_rerank: { enabled: true, top_k: 10, weight: 0.7 },
    });
  });

  it('rejects unsafe limits and a fusion pool smaller than the displayed result set', () => {
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      display_k: 0,
    })).toContain('frame hiển thị');
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      display_k: 101,
    })).toContain('frame hiển thị');
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      display_k: 40,
      fusion_k: 20,
    })?.toLowerCase()).toContain('fusion');
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      vlm_rerank: { enabled: true, top_k: 0, weight: 0.6 },
    })).toContain('VLM');
  });

  it('accepts a 100-second near-frame window but rejects values above it', () => {
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      near_frame_window_ms: 100_000,
    })).toBeNull();
    expect(validateRetrievalSettings({
      ...DEFAULT_RETRIEVAL_SETTINGS,
      near_frame_window_ms: 100_001,
    })).not.toBeNull();
  });
});
