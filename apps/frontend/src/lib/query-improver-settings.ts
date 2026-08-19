export interface QueryImproverSettings {
  enabled: boolean;
}

export const DEFAULT_QUERY_IMPROVER_SETTINGS: QueryImproverSettings = { enabled: false };

const STORAGE_KEY = 'aic.query-improver.settings';

export function loadQueryImproverSettings(): QueryImproverSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_QUERY_IMPROVER_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_QUERY_IMPROVER_SETTINGS };
    }
    return { enabled: (parsed as Record<string, unknown>).enabled === true };
  } catch {
    return { ...DEFAULT_QUERY_IMPROVER_SETTINGS };
  }
}

export function saveQueryImproverSettings(settings: QueryImproverSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: settings.enabled }));
}
