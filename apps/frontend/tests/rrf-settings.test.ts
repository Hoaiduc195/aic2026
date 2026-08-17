import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSearchRrfConfig,
  DEFAULT_RRF_SETTINGS,
  loadRrfSettings,
  saveRrfSettings,
  validateRrfSettings,
} from '@/lib/rrf-settings';

afterEach(() => {
  localStorage.clear();
});

describe('frontend RRF settings', () => {
  it('persists RRF K and maps modality weights to retrieval branches', () => {
    const settings = {
      ...DEFAULT_RRF_SETTINGS,
      rrf_k: 30,
      weights: { ...DEFAULT_RRF_SETTINGS.weights, object: 0.5, visual: 1.5 },
    };

    expect(validateRrfSettings(settings)).toBeNull();
    saveRrfSettings(settings);

    expect(loadRrfSettings()).toEqual(settings);
    expect(buildSearchRrfConfig(settings)).toEqual({
      rrf_k: 30,
      channel_weights: expect.objectContaining({
        clip: 1.5,
        visual: 1.5,
        object: 0.5,
      }),
    });
  });

  it('rejects unsafe K and weights that would disable every channel', () => {
    expect(validateRrfSettings({ ...DEFAULT_RRF_SETTINGS, rrf_k: 0 })).toContain('RRF K');
    expect(validateRrfSettings({
      ...DEFAULT_RRF_SETTINGS,
      weights: { ...DEFAULT_RRF_SETTINGS.weights, object: 6 },
    })).toContain('trọng số');
    expect(validateRrfSettings({
      ...DEFAULT_RRF_SETTINGS,
      weights: Object.fromEntries(Object.keys(DEFAULT_RRF_SETTINGS.weights).map((key) => [key, 0])),
    })).toContain('ít nhất một');
  });
});
