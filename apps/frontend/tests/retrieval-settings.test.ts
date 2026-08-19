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
      vlm_rerank: { enabled: true, top_k: 10, weight: 0.7 },
    };

    expect(validateRetrievalSettings(settings)).toBeNull();
    saveRetrievalSettings(settings);

    expect(loadRetrievalSettings()).toEqual(settings);
    expect(buildSearchRetrievalConfig(settings)).toEqual({
      display_k: 40,
      branch_k: 150,
      fusion_k: 600,
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
});
