import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSearchEmbeddingConfig,
  DEFAULT_EMBEDDING_SETTINGS,
  loadEmbeddingSettings,
  saveEmbeddingSettings,
  validateEmbeddingSettings,
} from '@/lib/embedding-settings';

afterEach(() => {
  localStorage.clear();
});

describe('embedding settings', () => {
  it('builds a request override and never persists the browser token', () => {
    const settings = {
      ...DEFAULT_EMBEDDING_SETTINGS,
      enabled: true,
      base_url: 'http://127.0.0.1:8001/embed',
      api_key: 'tab-only-secret',
      timeout_ms: 2500,
    };

    expect(validateEmbeddingSettings(settings)).toBeNull();
    saveEmbeddingSettings(settings);

    expect(loadEmbeddingSettings()).toMatchObject({
      enabled: true,
      base_url: settings.base_url,
      timeout_ms: 2500,
      api_key: '',
    });
    expect(buildSearchEmbeddingConfig(settings)).toEqual({
      base_url: settings.base_url,
      api_key: 'tab-only-secret',
      timeout_ms: 2500,
    });
    expect(localStorage.getItem('aic.embedding.settings')).not.toContain('tab-only-secret');
  });

  it('allows local Docker endpoints but rejects credentials and invalid timeouts', () => {
    expect(validateEmbeddingSettings({
      ...DEFAULT_EMBEDDING_SETTINGS,
      enabled: true,
      base_url: 'http://user:password@localhost:8001/embed',
    })).toContain('không chứa thông tin đăng nhập');
    expect(validateEmbeddingSettings({
      ...DEFAULT_EMBEDDING_SETTINGS,
      enabled: true,
      base_url: 'http://localhost:8001/embed',
      timeout_ms: 50,
    })).toContain('Timeout');
  });
});
