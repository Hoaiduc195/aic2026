import type { SearchEmbeddingConfig } from './contracts';

export interface EmbeddingSettings {
  enabled: boolean;
  base_url: string;
  api_key: string;
  timeout_ms: number;
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  enabled: false,
  base_url: '',
  api_key: '',
  timeout_ms: 5000,
};

const STORAGE_KEY = 'aic.embedding.settings';

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadEmbeddingSettings(): EmbeddingSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EMBEDDING_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_EMBEDDING_SETTINGS };
    const value = parsed as Record<string, unknown>;
    return {
      enabled: value.enabled === true,
      base_url: typeof value.base_url === 'string' ? value.base_url : '',
      api_key: typeof value.api_key === 'string' ? value.api_key : '',
      timeout_ms: numberValue(value.timeout_ms, DEFAULT_EMBEDDING_SETTINGS.timeout_ms),
    };
  } catch {
    return { ...DEFAULT_EMBEDDING_SETTINGS };
  }
}

export function saveEmbeddingSettings(settings: EmbeddingSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings }));
}

export function validateEmbeddingSettings(settings: EmbeddingSettings): string | null {
  if (!settings.enabled) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(settings.base_url.trim());
  } catch {
    return 'Embedding service URL phải là URL http hoặc https hợp lệ.';
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return 'Embedding service URL phải là URL http hoặc https, không chứa thông tin đăng nhập hoặc query.';
  }
  if (settings.base_url.trim().length > 2000) return 'Embedding service URL không được dài quá 2000 ký tự.';
  if (!Number.isSafeInteger(settings.timeout_ms) || settings.timeout_ms < 100 || settings.timeout_ms > 120_000) {
    return 'Timeout embedding phải nằm trong khoảng 100–120000 ms.';
  }
  if (settings.api_key.length > 1000) return 'API token embedding không được dài quá 1000 ký tự.';
  return null;
}

export function buildSearchEmbeddingConfig(settings: EmbeddingSettings): SearchEmbeddingConfig | undefined {
  if (!settings.enabled) return undefined;
  return {
    base_url: settings.base_url.trim().replace(/\/+$/, ''),
    ...(settings.api_key.trim() ? { api_key: settings.api_key.trim() } : {}),
    timeout_ms: settings.timeout_ms,
  };
}
