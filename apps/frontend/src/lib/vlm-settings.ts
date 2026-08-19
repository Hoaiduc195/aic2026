import type { VqaVlmConfig } from './contracts';

export interface VlmSettings {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
  temperature: number;
}

export const DEFAULT_VLM_SETTINGS: VlmSettings = {
  enabled: false,
  base_url: '',
  api_key: '',
  model: '',
  timeout_ms: 4_000,
  max_tokens: 256,
  temperature: 0,
};

const STORAGE_KEY = 'aic.vlm.settings';

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadVlmSettings(): VlmSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VLM_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_VLM_SETTINGS };
    const value = parsed as Record<string, unknown>;
    return {
      enabled: value.enabled === true,
      base_url: typeof value.base_url === 'string' ? value.base_url : '',
      api_key: typeof value.api_key === 'string' ? value.api_key : '',
      model: typeof value.model === 'string' ? value.model : '',
      timeout_ms: numberValue(value.timeout_ms, DEFAULT_VLM_SETTINGS.timeout_ms),
      max_tokens: numberValue(value.max_tokens, DEFAULT_VLM_SETTINGS.max_tokens),
      temperature: numberValue(value.temperature, DEFAULT_VLM_SETTINGS.temperature),
    };
  } catch {
    return { ...DEFAULT_VLM_SETTINGS };
  }
}

export function saveVlmSettings(settings: VlmSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings }));
}

export function validateVlmSettings(settings: VlmSettings): string | null {
  if (!settings.enabled) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(settings.base_url.trim());
  } catch {
    return 'VLM endpoint phải là URL http hoặc https hợp lệ.';
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return 'VLM endpoint phải là URL http hoặc https, không chứa thông tin đăng nhập hoặc query.';
  }
  if (!settings.model.trim() || settings.model.trim().length > 200) return 'VLM model phải có từ 1 đến 200 ký tự.';
  if (!Number.isSafeInteger(settings.timeout_ms) || settings.timeout_ms < 100 || settings.timeout_ms > 120_000) {
    return 'VLM timeout phải nằm trong khoảng 100–120000 ms.';
  }
  if (!Number.isSafeInteger(settings.max_tokens) || settings.max_tokens < 1 || settings.max_tokens > 4_096) {
    return 'VLM Max tokens phải nằm trong khoảng 1–4096.';
  }
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) {
    return 'VLM temperature phải nằm trong khoảng 0–2.';
  }
  if (settings.api_key.length > 1000) return 'VLM API key không được dài quá 1000 ký tự.';
  return null;
}

export function buildVqaVlmConfig(settings: VlmSettings): VqaVlmConfig | undefined {
  if (!settings.enabled) return undefined;
  return {
    base_url: settings.base_url.trim().replace(/\/+$/, ''),
    ...(settings.api_key.trim() ? { api_key: settings.api_key.trim() } : {}),
    model: settings.model.trim(),
    timeout_ms: settings.timeout_ms,
    max_tokens: settings.max_tokens,
    temperature: settings.temperature,
  };
}
