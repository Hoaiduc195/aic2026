export interface VqaBatchSettings {
  request_delay_ms: number;
}

export const DEFAULT_VQA_BATCH_SETTINGS: VqaBatchSettings = {
  request_delay_ms: 100,
};

const STORAGE_KEY = 'aic.vqa.batch.settings';

export function loadVqaBatchSettings(): VqaBatchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VQA_BATCH_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_VQA_BATCH_SETTINGS };
    }
    const value = parsed as Record<string, unknown>;
    return {
      request_delay_ms: typeof value.request_delay_ms === 'number' && Number.isFinite(value.request_delay_ms)
        ? value.request_delay_ms
        : DEFAULT_VQA_BATCH_SETTINGS.request_delay_ms,
    };
  } catch {
    return { ...DEFAULT_VQA_BATCH_SETTINGS };
  }
}

export function saveVqaBatchSettings(settings: VqaBatchSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings }));
}

export function validateVqaBatchSettings(settings: VqaBatchSettings): string | null {
  if (!Number.isSafeInteger(settings.request_delay_ms) || settings.request_delay_ms < 0 || settings.request_delay_ms > 5_000) {
    return 'Khoảng chờ batch VQA phải nằm trong khoảng 0–5000 ms.';
  }
  return null;
}
