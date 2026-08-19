import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VLM_SETTINGS,
  buildVqaVlmConfig,
  loadVlmSettings,
  saveVlmSettings,
  validateVlmSettings,
  type VlmSettings,
} from '@/lib/vlm-settings';

afterEach(() => {
  localStorage.clear();
});

describe('frontend MoreVQA settings', () => {
  it('keeps the VLM API key in memory while building a VQA request config', () => {
    const settings: VlmSettings = {
      ...DEFAULT_VLM_SETTINGS,
      enabled: true,
      base_url: 'https://vision.test/v1',
      api_key: 'vision-secret',
      model: 'vision-v1',
      timeout_ms: 2_000,
      max_tokens: 256,
      temperature: 0.1,
    };

    saveVlmSettings(settings);

    const persisted = JSON.parse(localStorage.getItem('aic.vlm.settings') ?? '{}') as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('api_key');
    expect(loadVlmSettings()).toMatchObject({ ...settings, api_key: '' });
    expect(buildVqaVlmConfig(settings)).toMatchObject({
      base_url: settings.base_url, api_key: settings.api_key, model: settings.model,
      timeout_ms: 2_000, max_tokens: 256, temperature: 0.1,
    });
  });

  it('rejects unsafe endpoints and invalid generation limits', () => {
    expect(buildVqaVlmConfig(DEFAULT_VLM_SETTINGS)).toBeUndefined();
    expect(validateVlmSettings({ ...DEFAULT_VLM_SETTINGS, enabled: true, base_url: 'ftp://bad.test', model: 'x' }))
      .toContain('http');
    expect(validateVlmSettings({ ...DEFAULT_VLM_SETTINGS, enabled: true, base_url: 'https://vision.test/v1', model: 'x', max_tokens: 0 }))
      .toContain('Max tokens');
  });
});
