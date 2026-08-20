import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VQA_BATCH_SETTINGS,
  loadVqaBatchSettings,
  saveVqaBatchSettings,
  validateVqaBatchSettings,
  type VqaBatchSettings,
} from '@/lib/vqa-batch-settings';

afterEach(() => {
  localStorage.clear();
});

describe('frontend VQA batch settings', () => {
  it('persists and restores the request delay', () => {
    const settings: VqaBatchSettings = { request_delay_ms: 25 };

    saveVqaBatchSettings(settings);

    expect(loadVqaBatchSettings()).toEqual(settings);
  });

  it('uses a short default delay and validates the supported range', () => {
    expect(DEFAULT_VQA_BATCH_SETTINGS.request_delay_ms).toBe(100);
    expect(validateVqaBatchSettings({ request_delay_ms: 0 })).toBeNull();
    expect(validateVqaBatchSettings({ request_delay_ms: 5_000 })).toBeNull();
    expect(validateVqaBatchSettings({ request_delay_ms: -1 })).toContain('0–5000');
    expect(validateVqaBatchSettings({ request_delay_ms: 5_001 })).toContain('0–5000');
  });
});
