import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LLM_SETTINGS,
  buildVqaLlmConfig,
  loadLlmSettings,
  saveLlmSettings,
  validateLlmSettings,
  type LlmSettings,
} from '@/lib/llm-settings';

afterEach(() => {
  localStorage.clear();
});

describe('frontend LLM settings', () => {
  it('persists the LLM settings and restores the API key', () => {
    const settings: LlmSettings = {
      ...DEFAULT_LLM_SETTINGS,
      enabled: true,
      base_url: 'https://llm.test/v1',
      api_key: 'secret-in-memory',
      model: 'custom-v1',
      timeout_ms: 2500,
      max_tokens: 64,
      temperature: 0.2,
    };

    saveLlmSettings(settings);

    const persisted = JSON.parse(localStorage.getItem('aic.llm.settings') ?? '{}') as Record<string, unknown>;
    expect(persisted).toHaveProperty('api_key', settings.api_key);
    expect(loadLlmSettings()).toMatchObject(settings);
    expect(buildVqaLlmConfig(settings)).toMatchObject({
      base_url: settings.base_url, api_key: settings.api_key, model: settings.model,
      timeout_ms: 2500, max_tokens: 64, temperature: 0.2,
    });
  });

  it('uses backend defaults when disabled and rejects unsafe values', () => {
    expect(buildVqaLlmConfig(DEFAULT_LLM_SETTINGS)).toBeUndefined();
    expect(validateLlmSettings({ ...DEFAULT_LLM_SETTINGS, enabled: true, base_url: 'ftp://bad.test', model: 'x' }))
      .toContain('http');
    expect(validateLlmSettings({ ...DEFAULT_LLM_SETTINGS, enabled: true, base_url: 'https://llm.test/v1', model: 'x', max_tokens: 0 }))
      .toContain('Max tokens');
  });
});
