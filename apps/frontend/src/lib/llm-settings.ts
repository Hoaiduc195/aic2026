import type { VqaLlmConfig } from './contracts';

export interface LlmSettings {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
  temperature: number;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: false,
  base_url: '',
  api_key: '',
  model: '',
  timeout_ms: 15_000,
  max_tokens: 128,
  temperature: 0,
};

const STORAGE_KEY = 'aic.llm.settings';

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadLlmSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LLM_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_LLM_SETTINGS };
    const value = parsed as Record<string, unknown>;
    return {
      enabled: value.enabled === true,
      base_url: typeof value.base_url === 'string' ? value.base_url : '',
      api_key: typeof value.api_key === 'string' ? value.api_key : '',
      model: typeof value.model === 'string' ? value.model : '',
      timeout_ms: numberValue(value.timeout_ms, DEFAULT_LLM_SETTINGS.timeout_ms),
      max_tokens: numberValue(value.max_tokens, DEFAULT_LLM_SETTINGS.max_tokens),
      temperature: numberValue(value.temperature, DEFAULT_LLM_SETTINGS.temperature),
    };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export function saveLlmSettings(settings: LlmSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings }));
}

export function validateLlmSettings(settings: LlmSettings): string | null {
  if (!settings.enabled) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(settings.base_url.trim());
  } catch {
    return 'Endpoint phải là URL http hoặc https hợp lệ.';
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return 'Endpoint phải là URL http hoặc https, không chứa thông tin đăng nhập hoặc query.';
  }
  if (!settings.model.trim() || settings.model.trim().length > 200) return 'Model phải có từ 1 đến 200 ký tự.';
  if (!Number.isSafeInteger(settings.timeout_ms) || settings.timeout_ms < 100 || settings.timeout_ms > 120_000) {
    return 'Timeout phải nằm trong khoảng 100–120000 ms.';
  }
  if (!Number.isSafeInteger(settings.max_tokens) || settings.max_tokens < 1 || settings.max_tokens > 4_096) {
    return 'Max tokens phải nằm trong khoảng 1–4096.';
  }
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) {
    return 'Temperature phải nằm trong khoảng 0–2.';
  }
  if (settings.api_key.length > 1000) return 'API key không được dài quá 1000 ký tự.';
  return null;
}

export function buildVqaLlmConfig(settings: LlmSettings): VqaLlmConfig | undefined {
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
